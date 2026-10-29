"""Layout API: validate, store and rasterize room layouts.

Run (from services/api):  uvicorn app.main:app --reload
Environment:
  DATA_DIR  where layouts are stored          (default: ./data)
  WEB_DIR   static editor to serve at "/"     (default: ../web/public if it exists)
"""

import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from .models import Layout
from .rasterize import GridTooLarge, rasterize
from .storage import InvalidName, LayoutStore
from .validation import has_errors, validate_layout

HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", HERE.parent / "data"))
WEB_DIR = Path(os.environ.get("WEB_DIR", HERE.parent.parent / "web" / "public"))

app = FastAPI(title="RoomVentilation layout API", version="0.1.0")
store = LayoutStore(DATA_DIR)


class _SkipHealthChecks(logging.Filter):
    """Docker polls the health endpoint every few seconds; keep those out of the access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_SkipHealthChecks())


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/layouts/validate")
def validate(layout: Layout) -> dict:
    issues = validate_layout(layout)
    return {"valid": not has_errors(issues), "issues": [i.to_dict() for i in issues]}


@app.post("/api/rasterize")
def rasterize_layout(layout: Layout, dx: float = Query(0.05, gt=0.005, le=1.0, description="Cell size [m]")) -> dict:
    issues = validate_layout(layout)
    if has_errors(issues):
        raise HTTPException(422, detail={"message": "Layout has errors", "issues": [i.to_dict() for i in issues]})
    try:
        return rasterize(layout, dx).to_dict()
    except GridTooLarge as e:
        raise HTTPException(422, detail={"message": str(e)}) from e


@app.get("/api/layouts")
def list_layouts() -> list[str]:
    return store.list()


@app.get("/api/layouts/{name}")
def get_layout(name: str) -> Layout:
    try:
        layout = store.get(name)
    except InvalidName as e:
        raise HTTPException(400, str(e)) from e
    if layout is None:
        raise HTTPException(404, f"Layout '{name}' not found")
    return layout


@app.put("/api/layouts/{name}")
def put_layout(name: str, layout: Layout) -> dict:
    try:
        store.put(name, layout)
    except InvalidName as e:
        raise HTTPException(400, str(e)) from e
    return {"saved": name}


@app.delete("/api/layouts/{name}")
def delete_layout(name: str) -> dict:
    try:
        if not store.delete(name):
            raise HTTPException(404, f"Layout '{name}' not found")
    except InvalidName as e:
        raise HTTPException(400, str(e)) from e
    return {"deleted": name}


# Serve the editor from the same origin during development. In the Docker step
# this moves to its own nginx container that proxies /api to this service.
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
