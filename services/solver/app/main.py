"""Simulation service: runs a solver per WebSocket connection and streams frames.

Protocol on  WS /sim/ws
  client -> {"layout": {...}, "dx": 0.05, "nu": 0.002, "speed": 1}      (first message)
  server -> {"type": "meta", nx, ny, dx, origin, cell_type, header, fields, ...}  (JSON)
  server -> binary frames, little-endian float32:
            len(header) stats, then each field in `fields` as ny*nx values (row-major, j=0 bottom)
  client -> {"cmd": "pause" | "resume" | "reset"} or {"cmd": "set", "speed": 2, "nu": 0.01}
  server -> {"type": "error", "message": "..."} on problems

The grid comes from the api service (POST /api/rasterize), so the solver never needs to
know about the layout format - a nice example of two services talking over the network.

Environment:
  API_URL  base URL of the api service (default: http://localhost:8000)
  FPS      frames per second sent to each client (default: 15)
"""

import asyncio
import logging
import math
import os
from contextlib import suppress

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .solver import FRAME_FIELDS, FRAME_HEADER, Settings, SetupError, Simulation

API_URL = os.environ.get("API_URL", "http://localhost:8000").rstrip("/")
FPS = float(os.environ.get("FPS", "15"))
MAX_SPEED = 50.0

app = FastAPI(title="RoomVentilation solver", version="0.1.0")


class _SkipHealthChecks(logging.Filter):
    """Docker polls the health endpoint every few seconds; keep those out of the access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_SkipHealthChecks())


@app.get("/sim/health")
def health() -> dict:
    return {"status": "ok", "api_url": API_URL}


class ClientError(Exception):
    pass


async def fetch_grid(layout: dict, dx: float) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            r = await client.post(f"{API_URL}/api/rasterize", params={"dx": dx}, json=layout)
        except httpx.HTTPError as e:
            raise ClientError(f"Could not reach the api service at {API_URL}: {e}") from e
    if r.status_code != 200:
        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else r.text
        if isinstance(detail, dict):
            issues = [i["message"] for i in detail.get("issues", []) if i.get("level") == "error"]
            detail = detail.get("message", "") + (": " + " ".join(issues) if issues else "")
        elif isinstance(detail, list):  # schema errors
            detail = "; ".join(f"{'.'.join(map(str, d['loc'][1:]))}: {d['msg']}" for d in detail)
        raise ClientError(f"Layout rejected by the api: {detail}")
    return r.json()


def _number(value, lo, hi, name) -> float:
    try:
        x = float(value)
    except (TypeError, ValueError):
        raise ClientError(f"'{name}' must be a number") from None
    if not math.isfinite(x) or not lo <= x <= hi:
        raise ClientError(f"'{name}' must be between {lo} and {hi}")
    return x


@app.websocket("/sim/ws")
async def simulate(ws: WebSocket) -> None:
    await ws.accept()
    try:
        init = await ws.receive_json()
        dx = _number(init.get("dx", 0.05), 0.01, 0.5, "dx")
        settings = Settings(nu=_number(init.get("nu", Settings.nu), 0, 0.1, "nu"))
        state = {"paused": False, "reset": False, "speed": _number(init.get("speed", 1), 0, MAX_SPEED, "speed")}

        grid = await fetch_grid(init.get("layout"), dx)
        try:
            # Factorising the pressure matrix can take a moment on fine grids.
            sim = await asyncio.to_thread(Simulation, grid, settings)
        except SetupError as e:
            raise ClientError(str(e)) from e

        await ws.send_json(
            {
                "type": "meta",
                "nx": sim.nx,
                "ny": sim.ny,
                "dx": sim.dx,
                "origin": list(sim.origin),
                "cell_type": grid["cell_type"],
                "boundaries": grid["boundaries"],
                "header": FRAME_HEADER,
                "fields": FRAME_FIELDS,
                "fps": FPS,
                "settings": {"nu": settings.nu},
            }
        )
        await run(ws, sim, state)
    except ClientError as e:
        with suppress(Exception):
            await ws.send_json({"type": "error", "message": str(e)})
            await ws.close()
    except WebSocketDisconnect:
        pass


async def run(ws: WebSocket, sim: Simulation, state: dict) -> None:
    receiver = asyncio.create_task(receive_controls(ws, sim, state))
    interval = 1.0 / FPS
    loop = asyncio.get_running_loop()
    try:
        while not receiver.done():
            started = loop.time()
            if state["reset"]:
                state["reset"] = False
                sim.reset()
            if not state["paused"]:
                speed = state["speed"]
                # speed 0 means "as fast as possible": only the compute budget limits it.
                duration = math.inf if speed == 0 else speed * interval
                await asyncio.to_thread(sim.advance, duration, 0.8 * interval)
            await ws.send_bytes(sim.frame_bytes())
            await asyncio.sleep(max(0.0, interval - (loop.time() - started)))
    except (WebSocketDisconnect, RuntimeError):
        pass  # client went away mid-send
    finally:
        receiver.cancel()


async def receive_controls(ws: WebSocket, sim: Simulation, state: dict) -> None:
    while True:
        msg = await ws.receive_json()
        cmd = msg.get("cmd")
        if cmd == "pause":
            state["paused"] = True
        elif cmd == "resume":
            state["paused"] = False
        elif cmd == "reset":
            state["reset"] = True
        elif cmd == "set":
            with suppress(ClientError):
                if "speed" in msg:
                    state["speed"] = _number(msg["speed"], 0, MAX_SPEED, "speed")
                if "nu" in msg:
                    sim.settings.nu = _number(msg["nu"], 0, 0.1, "nu")
