# Roadmap & architecture

The project is built in small steps. Each step adds **one** new technology on top of
something that already works.

## Target architecture

```
 browser (laptop / tablet / phone)
   │  HTTP + WebSocket
   ▼
 ┌──────────────┐   /api/*    ┌──────────────┐  layout → grid  ┌──────────────┐
 │ web (nginx)  │ ──────────► │ api (FastAPI)│ ◄────────────── │ solver       │
 │ static editor│   /ws/*     │ layouts,     │                 │ (NumPy/Numba)│
 │ + viewer     │ ──────────────────────────────────────────►  │ streams      │
 └──────────────┘             │ validation,  │                 │ frames       │
                              │ rasterize    │                 └──────────────┘
                              └──────┬───────┘
                                     │ volume / PVC
                                  layouts
```

| Service  | Job                                                      | Tech                         |
|----------|----------------------------------------------------------|------------------------------|
| `web`    | Layout editor, later the live 2D view with field toggles | HTML/Canvas, ES modules      |
| `api`    | Store, validate and rasterize layouts                    | Python, FastAPI, NumPy       |
| `solver` | Time-stepping simulation, pushes frames over WebSocket   | Python, NumPy (later Numba)  |

The solver is its own service because it is CPU-heavy and long-running. In Kubernetes
you can then scale or pin it separately (e.g. solver on the fast PC, web/api on a Pi).

## Steps

### ✅ 1. Geometry editor (no containers yet)
- Layout JSON schema (`services/api/app/models.py`), validation, rasterizer + tests.
- Canvas editor: rectangle/polygon rooms, doors, windows, people, mesh preview.
- **Learn:** what a structured grid is; staircase boundaries; boundary-condition types.

### ✅ 2. Docker
- `Dockerfile` for `api` (python:3.12-slim) and `web` (nginx serving static files and
  proxying `/api` to the api container).
- `compose.yaml` running both, a named volume for layouts.
- **Learn:** images vs containers, layers & caching, ports, volumes, container networking.

### ✅ 3. Solver v1: isothermal flow
- 2D incompressible Navier–Stokes on a staggered (MAC) grid, projection method
  (Chorin): advect → diffuse → solve pressure Poisson → correct.
- Inlets = velocity Dirichlet, outlets = pressure Dirichlet, walls = no-slip.
- Tests check mass conservation (inflow = outflow, div u ≈ 1e-14). Still to do: verify against the
  lid-driven cavity benchmark (Ghia et al. 1982), which needs a moving-wall BC.
- **Learn:** discretisation, CFL condition, pressure–velocity coupling, why the Poisson
  solve dominates the run time.

### ✅ 4. Real-time view
- Solver as a service: one simulation per WebSocket connection on `/sim/ws`, streaming
  frames (binary Float32 arrays, 15 fps, ~125 kB each at 5 cm; float16 would halve it).
- Viewer in `web`: velocity / pressure background, particles, streamlines, vectors, probe.
- **Learn:** WebSockets, binary protocols, decoupling sim time from render time.

### ✅ 5. Temperature, CO₂, and a realistic boundary model
- Two passive scalars (conservative upwind finite volumes, sub-stepped for stability) with
  sources from people. In a top view buoyancy acts *perpendicular* to the plane, so it
  cannot drive the 2D flow; that is a good argument for a vertical-slice or 3D mode later.
- Effective (turbulent) diffusivity = effective viscosity (turbulent Prandtl/Schmidt = 1).
- Boundary conditions redesigned:
  - Doors and windows are pressure openings (wind Cp model + orifice loss).
  - Ventilation units are fixed-flow boundaries.
  - Fans are momentum sources.
  - Everything can be switched live; the pressure matrix is re-factorized on demand.
- Tests:
  - Exact heat and CO₂ conservation in a closed room.
  - The well-mixed steady state at the exhaust (C = C_in + G/Q).
  - Cross-ventilation against the orifice equation.
- **Learn:** scalar transport, Péclet number, upwind vs. central schemes, conservation checks,
  Dirichlet vs. Neumann vs. source terms, well-posedness of incompressible BCs.

### ✅ 5b. Humidity, bathrooms and kitchens
- Water vapour (g/m³) as a scalar, with relative humidity from the Magnus formula. Vapour
  condenses on surfaces below the dew point and in the air above saturation; the latent
  heat is accounted for.
- Floor, ceiling and walls as heat stores at room temperature (h ≈ 3 W/m²K, Lewis
  analogy for vapour).
- Showers, hobs (pasta / fried potatoes), cooking fumes (PM2.5).
- Extract fans and hoods as volume sinks, with a capture-efficiency model for hoods.
- Implicit (Robin) boundary condition for openings with a flow resistance, so a 1 cm door
  gap can feed a bathroom fan; checked against the orifice equation.
- **Learn:** psychrometrics (dew point, condensation), Robin boundary conditions,
  explicit-vs-implicit stability, source/sink terms in the continuity equation, where a
  2D model needs an engineering sub-model (hood capture, plume spreading).

### 6. Kubernetes
- Local cluster with **k3d** or **kind** on Docker Desktop: Deployments, Services, an
  Ingress, a PersistentVolumeClaim for layouts, a ConfigMap for settings.
- Multi-arch images (`docker buildx`, amd64 + arm64) so the same images run on a
  Raspberry Pi **k3s** node. Later: Helm chart or Kustomize overlays per environment.
- **Learn:** declarative deployment, scheduling, node selectors, rolling updates.

### 7. Extensions
- Furniture as solid obstacles (schema v3), heaters / radiators.
- Heat loss through outer walls and windows to the outside (U-values), and a wall
  temperature that changes over time (thermal mass), plus wet surfaces drying out again.
- A vertical-slice mode, so plumes from hobs and showers can actually rise.
- Fan curves (flow depends on back-pressure) instead of a fixed flow for ventilation units.
- Numba / multigrid pressure solver for speed; GPU (CuPy) as an experiment.
- Vertical-slice mode for buoyancy-driven flow.
