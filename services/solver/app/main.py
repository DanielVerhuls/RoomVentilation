"""Simulation service: runs a solver per WebSocket connection and streams frames.

Protocol on  WS /sim/ws
  client -> {"layout": {...}, "dx": 0.05, "nu": 0.002, "kappa": 0.01, "speed": 1, "fields": ["u", "v"]}  (first)
  server -> {"type": "meta", nx, ny, dx, origin, cell_type, boundary_id, boundaries, header, fields, ...}
  server -> {"type": "state", boundaries, fans, sources, extracts, conditions, notes}  (after every change)
  server -> {"type": "balance", flows, moisture, fumes, extracts, capture}   (about once a second)
  server -> binary frames, little-endian float32: len(header) stats, then every field whose bit is
            set in the header's fields_mask (bit i = fields[i]), each ny*nx values (row-major, j=0 bottom)
  client -> {"cmd": "pause" | "resume" | "reset"}
            {"cmd": "set", "speed": 2, "nu": 0.01, "kappa": 0.02}
            {"cmd": "fields", "fields": ["u", "v", "c"]}               which fields to stream
            {"cmd": "update", "target": "boundary", "id": "door-1", "open": false}
            {"cmd": "update", "target": "boundary", "id": "vent-1", "on": true, "flow_m3h": 150}
            {"cmd": "update", "target": "fan", "id": "fan-1", "speed": 3, "angle": 90, "on": true,
             "oscillate": true, "sweep": 45, "period": 12}
            {"cmd": "update", "target": "source", "id": "hob-1", "on": true, "activity": "potatoes", "heat_w": 2000}
            {"cmd": "update", "target": "extract", "id": "hood-1", "on": true, "flow_m3h": 400}
            {"cmd": "update", "target": "conditions", "wind_speed": 4, "wind_direction": 270}
  server -> {"type": "error", "message": "..."} on problems

The grid comes from the api service (POST /api/rasterize), so the solver never needs to
know about the layout format - a nice example of two services talking over the network.
Live updates only change the running simulation, never the stored layout.

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


# Limits for live updates: (min, max) for numbers, None for booleans, a tuple of strings for choices.
UPDATE_FIELDS = {
    "boundary": {"open": None, "on": None, "flow_m3h": (0, 10_000), "supply_temperature": (-30, 60)},
    "fan": {"on": None, "speed": (0, 15), "angle": (-3600, 3600), "oscillate": None, "sweep": (0, 90), "period": (2, 120)},
    "source": {
        "on": None,
        "activity": ("pasta", "potatoes", "custom"),
        "heat_w": (0, 20_000),
        "moisture_gph": (0, 20_000),
        "fumes_mgpm": (0, 1000),
    },
    "extract": {"on": None, "flow_m3h": (0, 5000)},
    "conditions": {
        "wind_speed": (0, 30),
        "wind_direction": (0, 360),
        "outdoor_temperature": (-50, 60),
        "outdoor_co2_ppm": (0, 50_000),
        "outdoor_rh": (0, 100),
    },
}


def _clean_update(msg: dict) -> tuple[str, str | None, dict]:
    target = msg.get("target")
    if target not in UPDATE_FIELDS:
        raise ClientError(f"Unknown update target '{target}'")
    changes = {}
    for key, limits in UPDATE_FIELDS[target].items():
        if key not in msg:
            continue
        if limits is None:
            changes[key] = bool(msg[key])
        elif isinstance(limits[0], str):
            if msg[key] not in limits:
                raise ClientError(f"'{key}' must be one of {', '.join(limits)}")
            changes[key] = msg[key]
        else:
            changes[key] = _number(msg[key], *limits, key)
    return target, msg.get("id"), changes


def _clean_fields(value) -> list[str]:
    if not isinstance(value, list):
        return list(FRAME_FIELDS)
    return [f for f in FRAME_FIELDS if f in value]


@app.websocket("/sim/ws")
async def simulate(ws: WebSocket) -> None:
    await ws.accept()
    try:
        init = await ws.receive_json()
        dx = _number(init.get("dx", 0.05), 0.01, 0.5, "dx")
        settings = Settings(nu=_number(init.get("nu", Settings.nu), 0, 0.1, "nu"))
        if init.get("kappa") is not None:
            settings.kappa = _number(init["kappa"], 0, 0.2, "kappa")
        state = {
            "paused": False,
            "reset": False,
            "speed": _number(init.get("speed", 1), 0, MAX_SPEED, "speed"),
            "fields": _clean_fields(init.get("fields")),
            "updates": [],
        }

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
                "room_height": sim.height,
                "cell_type": grid["cell_type"],
                "boundary_id": grid["boundary_id"],
                "boundaries": grid["boundaries"],
                "header": FRAME_HEADER,
                "fields": FRAME_FIELDS,
                "fps": FPS,
                "settings": {"nu": settings.nu},
            }
        )
        await ws.send_json({"type": "state", **sim.state()})
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
    frames = 0
    try:
        while not receiver.done():
            started = loop.time()
            if state["reset"]:
                state["reset"] = False
                sim.reset()
            if state["updates"]:
                # Applied between steps (never while the solver thread is running).
                updates, state["updates"] = state["updates"], []
                errors = await asyncio.to_thread(apply_updates, sim, updates)
                await ws.send_json({"type": "state", **sim.state()})
                for message in errors:
                    await ws.send_json({"type": "warning", "message": message})
            if not state["paused"]:
                speed = state["speed"]
                # speed 0 means "as fast as possible": only the compute budget limits it.
                duration = math.inf if speed == 0 else speed * interval
                await asyncio.to_thread(sim.advance, duration, 0.8 * interval)
            await ws.send_bytes(sim.frame_bytes(state["fields"]))
            if frames % max(1, round(FPS)) == 0:
                await ws.send_json({"type": "balance", **sim.balance()})
            frames += 1
            await asyncio.sleep(max(0.0, interval - (loop.time() - started)))
    except (WebSocketDisconnect, RuntimeError):
        pass  # client went away mid-send
    finally:
        receiver.cancel()


def apply_updates(sim: Simulation, updates: list[tuple[str, str | None, dict]]) -> list[str]:
    errors = []
    for target, item_id, changes in updates:
        try:
            sim.update(target, item_id, **changes)
        except KeyError as e:
            errors.append(str(e.args[0]))
    return errors


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
        elif cmd == "fields":
            state["fields"] = _clean_fields(msg.get("fields"))
        elif cmd == "update":
            try:
                state["updates"].append(_clean_update(msg))
            except ClientError as e:
                await ws.send_json({"type": "warning", "message": str(e)})
        elif cmd == "set":
            with suppress(ClientError):
                if "speed" in msg:
                    state["speed"] = _number(msg["speed"], 0, MAX_SPEED, "speed")
                if "nu" in msg:
                    sim.settings.nu = _number(msg["nu"], 0, 0.1, "nu")
                if "kappa" in msg:
                    sim.settings.kappa = _number(msg["kappa"], 0, 0.2, "kappa")
