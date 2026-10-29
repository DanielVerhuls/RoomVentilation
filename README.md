# RoomVentilation
This is a small project to create a small tool to simulate airflow in a room with an interface to create a room layout. This is mostly meant to expand my own stack.

The plan and target architecture are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Services

| Service          | What it does                                                            | Port (in container) |
|------------------|-------------------------------------------------------------------------|---------------------|
| `services/web`    | nginx: serves the editor + live viewer, routes `/api` and `/sim`       | 80                  |
| `services/api`    | FastAPI: stores, validates and rasterizes layouts                      | 8000                |
| `services/solver` | FastAPI + NumPy/SciPy: 2D Navier–Stokes, streams frames over WebSocket | 8001                |

```
browser ──► web (nginx :8080) ──/api/──► api ◄──── rasterize ──── solver
                              └─/sim/ (WebSocket) ───────────────► solver
```

## Run with Docker (recommended)

Requires Docker Desktop to be running.

```powershell
docker compose up --build       # attached: shows all logs, Ctrl+C stops everything
docker compose up --build -d    # detached: runs in the background
```

Open http://localhost:8080. To use it from a phone or tablet on the same network, open
`http://<your-pc-ip>:8080` (Windows may ask to allow Docker through the firewall).

Useful commands:

```powershell
docker compose ps                 # running containers and their health
docker compose logs -f solver     # follow one service's logs
docker compose down               # stop (layouts stay in the "layouts" volume)
docker compose down -v            # stop and delete the volume too
```

**Development mode:** this mounts your source code into the containers and reloads on every change.

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

## Run without Docker

```powershell
python -m venv .venv
.venv\Scripts\pip install -r services/api/requirements-dev.txt -r services/solver/requirements-dev.txt
# terminal 1
cd services/api;    ..\..\.venv\Scripts\python -m uvicorn app.main:app --port 8000
# terminal 2
cd services/solver; ..\..\.venv\Scripts\python -m uvicorn app.main:app --port 8001
```

Open http://localhost:8000. Without nginx there is no single entry point; the viewer then
assumes the solver is on port 8001 (override with `?solver=ws://host:port/sim/ws`).

Tests: run `..\..\.venv\Scripts\python -m pytest` inside `services/api` and inside `services/solver`.

## Using it

1. **Editor** (`/`): draw the room, add windows/doors and set them to *inlet* / *outlet*,
   place people. The mesh preview shows the grid the solver will see.
2. **Simulate ▶** (`/simulate.html`): runs the current editor layout, or a layout saved on
   the server. Options:
   - Background: velocity magnitude, pressure, or none.
   - Overlays: particles, streamlines, velocity vectors.
   - Simulation speed, cell size and effective viscosity.
   - A probe shows the values under the mouse.

### Editor keys

| Tool          | Key | Use                                                              |
|---------------|-----|------------------------------------------------------------------|
| Select        | V   | Drag corners, walls, openings, people; double-click a wall to add a corner |
| Rectangle     | R   | Drag a new rectangular room                                      |
| Polygon       | P   | Click corners; click the first one / double-click / Enter to close |
| Door / Window | D/W | Click on a wall                                                  |
| Person        | H   | Click inside the room                                            |

Alt disables snapping, Space or right-drag pans, the wheel zooms, Del deletes, Ctrl+Z/Y undo/redo.

## The solver in one paragraph

[services/solver/app/solver.py](services/solver/app/solver.py) solves the 2D incompressible
Navier–Stokes equations on a staggered (MAC) grid with Chorin's projection method:

1. Semi-Lagrangian advection.
2. Explicit diffusion with an *effective* viscosity.
3. A pressure Poisson equation, factorized once with sparse LU and then reused every step.
4. A velocity correction that makes the flow divergence-free.

Boundary conditions:

- Inlets fix the velocity.
- Outlets fix the pressure at 0.
- Walls are approximately no-slip.

The module docstring lists the simplifications, which are good starting points for improving it.

## Layout format

See [examples/l-shaped-office.json](examples/l-shaped-office.json). Units are metres, with y
pointing up. Wall *i* runs from vertex *i* to vertex *i+1*; openings sit on a wall at an
`offset` from its start vertex. Each opening's `bc` is `closed`, `inlet` (with `velocity`)
or `outlet`.

## API

| Method | Path                         | Purpose                                   |
|--------|------------------------------|-------------------------------------------|
| GET    | `/api/health`                | Liveness (later used by Kubernetes probes) |
| POST   | `/api/layouts/validate`      | Errors & warnings for a layout             |
| POST   | `/api/rasterize?dx=0.05`     | Layout → grid (cell types, sources, boundaries) |
| GET    | `/api/layouts`               | List saved layouts                         |
| GET/PUT/DELETE | `/api/layouts/{name}` | Load / save / delete a layout              |
| GET    | `/sim/health`                | Solver liveness                            |
| WS     | `/sim/ws`                    | Live simulation (protocol in [solver main.py](services/solver/app/main.py)) |
