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

1. **Editor** (`/`): draw the room and add:
   - doors and windows (open or closed, leading outside or indoors);
   - ventilation units (supply or exhaust, in m³/h);
   - free-standing fans;
   - showers and hobs (pasta or fried potatoes), which release steam, heat and cooking fumes;
   - extract fans (bathroom ceiling fan) and cooker hoods;
   - people (who emit heat, CO₂ and water vapour).

   Ready-made examples: [examples/](examples/) has an office, a **bathroom** (shower +
   extract fan, closed door with a 1 cm gap) and a **kitchen** (frying under a hood).

   Set the wind on the room panel. The mesh preview shows the grid the solver will see.
2. **Simulate ▶** (`/simulate.html`): runs the current editor layout, or a layout saved on
   the server. Options:
   - Background: velocity, pressure, temperature, CO₂, relative humidity, cooking fumes, or none.
   - Overlays: particles, streamlines, velocity vectors, flow rates at each opening.
   - **Live controls:** switch anything by clicking it in the view: doors, windows, units,
     fans, showers, hobs, extracts. A click inside a hood goes to the hob below; a click on
     the hood's outline goes to the hood. Turn a fan by dragging the tip of its arrow, and
     let it swing back and forth. The side panel can also change flows, speeds and what is
     cooking, plus wind and outdoor temperature. Live changes only affect the running
     simulation; *Restart* goes back to the layout.
   - **Mixing:** the turbulent diffusivity of heat, CO₂, steam and fumes. In a real room,
     heat sources drive a rising circulation that mixes the air within minutes; a top view
     has no buoyancy, so that mixing is set here (default 0.01 m²/s).
   - Room-air stats: mean temperature, CO₂ and humidity, air changes per hour, and the
     well-mixed steady-state CO₂.
   - Moisture and fumes balance: what is released, caught by the hood, removed by extracts,
     carried in by incoming air, and how much has condensed.
   - Simulation speed, cell size, effective viscosity, and a probe for the values under the mouse.

### Editor keys

The tools are grouped by room type (Room, Ventilation, Bathroom, Kitchen); each group can be folded away.

| Tool          | Key | Use                                                              |
|---------------|-----|------------------------------------------------------------------|
| Select        | V   | Drag corners, walls, openings, people; double-click a wall to add a corner |
| Rectangle     | R   | Drag a new rectangular room                                      |
| Polygon       | P   | Click corners; click the first one / double-click / Enter to close |
| Door / Window | D/W | Click on a wall                                                  |
| Vent unit     | U   | Click on a wall; set supply/exhaust and m³/h in the properties   |
| Fan           | N   | Click inside the room; drag the round handle at the arrow tip to turn it (15° steps, Alt: 1°); "Swing back and forth" in the properties |
| Shower        | S   | Click inside the room                                            |
| Hob           | K   | Click inside the room; pick what is cooking; "Add hood above"    |
| Extract fan   | E   | Click inside the room; ceiling / wall extract fan (bathroom)     |
| Cooker hood   | O   | Click above a hob (or "Add hood above" on a selected hob)       |
| Person        | H   | Click inside the room                                            |

Alt disables snapping, Space or right-drag pans, the wheel zooms, Del deletes, Ctrl+Z/Y undo/redo.

## The solver in one paragraph

[services/solver/app/solver.py](services/solver/app/solver.py) solves the 2D incompressible
Navier–Stokes equations on a staggered (MAC) grid with Chorin's projection method:

1. Semi-Lagrangian advection.
2. Explicit diffusion with an *effective* viscosity.
3. Fans: a momentum source that pushes the air in their footprint towards the set speed.
4. A pressure Poisson equation, factorized with sparse LU and reused every step. It is
   re-factorized (in about 15 ms) whenever a door opens or closes.
5. A velocity correction that makes the flow divergence-free.
6. Temperature, CO₂, water vapour and cooking fumes, transported with conservative upwind
   finite volumes. People, showers and hobs are sources; extract fans and hoods are volume
   sinks, which take air (and what's in it) out inside the room.
7. Floor, ceiling and walls stay at the room temperature. They exchange heat with the air,
   and vapour condenses on them where the air's dew point is above their temperature (the
   fogged-up mirror). Above saturation in the air itself, vapour condenses as fog and
   releases its latent heat.

### Boundary conditions: why doors are pressure boundaries, not flow boundaries

| Object | Boundary condition | Reason |
|---|---|---|
| Open door / window, gap under a closed door | **Pressure with resistance** (Robin condition). Outside: wind pressure Cp·½ρU²; indoors: 0 Pa. The orifice law Δp = ½ρ(u/Cd)² is built into the pressure equation implicitly. | Nobody sets how much air passes through a window; it follows from the pressure difference. Doing this implicitly matters: a 1 cm door gap with an explicit update blows up. |
| Ventilation unit | **Velocity** (fixed volume flow) | A fan delivers a roughly fixed flow, so prescribing it is physically right. |
| Free-standing fan | **Momentum source** inside the room | It moves air around without adding or removing any. |
| Extract fan / cooker hood | **Volume sink** inside the room (div u = s < 0) | Air leaves through the ceiling or hood, not through a wall of the 2D plan. The replacement air has to come from somewhere: the room is at under-pressure, so the air comes in through gaps and windows. |
| Wall, closed opening, unit that is off | No flow through it (no-slip) | |

Things this design gets right automatically:

- An airtight room cannot have unbalanced units: the solver rescales the exhaust or stops
  the units, and says so in the viewer.
- A single open window has no net flow.
- Cross-ventilation matches the hand calculation: the tests check it against
  Q = A_eff·√(2Δp/ρ) for two openings in series.

Cooker hoods work because the hot plume *rises* into them. That's vertical transport, which a
top view can't compute. So a hood takes a share η = 1 − e^(−Q/250 m³/h) of the emissions of
the hob below it straight out (an engineering capture efficiency, about 80% at 400 m³/h). The
rest is released over a disk of 1 m radius around the hob, standing in for the plume spreading
under the ceiling.

Since this is a 2D plan view, everything is uniform over the room height. To keep volume
flows right, an opening's real height scales its discharge coefficient. Warm air also
cannot rise, so temperature does not drive the flow. The module docstring lists these and
the other simplifications, which are good starting points for improving it.

## Layout format

See [examples/](examples/) (schema version 3). Units
are metres, with y pointing up and angles in degrees. Wall *i* runs from vertex *i* to vertex
*i+1*. Openings and `vents` sit on a wall at an `offset` from its start vertex.

- An opening has `open`, `connects_to` (`outside` / `indoors`) and an optional `height`.
- A vent has `mode` (`supply` / `exhaust`), `flow_m3h`, `supply_temperature` and `on`.
- `fans` have a position, `angle`, `width`, `speed` and `on`.
- `showers` and `hobs` (with `activity` `pasta` / `potatoes` / `custom`) have a position, a
  size, `heat_w`, `moisture_gph`, `fumes_mgpm` (hobs) and `on`.
- `extracts` have `kind` (`ceiling` / `hood`), a position, a size, `flow_m3h` and `on`.
- Doors have an `undercut` (gap under the door when closed, 1 cm by default).
- `conditions` holds the initial and outdoor temperature, CO₂ and relative humidity, plus
  `wind_speed` and `wind_direction` (the direction the wind comes *from*; 0° = north = +y).

This is schema version 3. Older layouts are converted automatically when loaded.

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
