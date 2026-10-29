"""2D incompressible Navier-Stokes on a staggered (MAC) grid - projection method.

Unknowns
    u[j, i]  x-velocity on the vertical face   left of cell (i, j)   shape (ny, nx+1)
    v[j, i]  y-velocity on the horizontal face below cell (i, j)     shape (ny+1, nx)
    p[j, i]  pressure at the cell centre                              shape (ny, nx)

One time step (Chorin's projection / "fractional step"):
    1. advect     u* = u transported along itself   (semi-Lagrangian, RK2 backtrace)
    2. diffuse    u* += nu * dt * laplace(u*)       (explicit)
    3. boundary   walls 0, inlets prescribed, outlets copy their inner neighbour
    4. project    solve  laplace(phi) = div(u*),  u = u* - grad(phi)
                  -> div(u) = 0 (mass conservation), p = rho * phi / dt

Boundary conditions come from the rasterized cell types:
    solid / closed opening : u.n = 0      (Neumann for pressure)
    inlet                  : u.n = given  (Neumann for pressure)
    outlet                 : p = 0        (Dirichlet for pressure), u free

Simplifications worth knowing about (and good things to improve later):
  * Walls set the face velocities inside solid cells to 0, so the tangential no-slip
    condition is only approximate.
  * nu is an *effective* viscosity: real air (1.5e-5 m^2/s) on a 5 cm grid would be far
    under-resolved. A larger nu stands in for turbulent mixing we cannot resolve.
  * Semi-Lagrangian advection is unconditionally stable but adds numerical diffusion -
    often more than nu itself. Compare dx = 0.1 and 0.025 to see it.
"""

import time
from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.ndimage import map_coordinates
from scipy.sparse.linalg import splu

SOLID, FLUID, INLET, OUTLET, CLOSED_OPENING = 0, 1, 2, 3, 4

# Order of the per-frame statistics at the start of each binary frame.
FRAME_HEADER = ["time", "step", "dt", "max_div", "max_speed", "steps_per_s", "p_min", "p_max"]
FRAME_FIELDS = ["u", "v", "p"]


class SetupError(ValueError):
    pass


@dataclass
class Settings:
    nu: float = 0.002  # effective kinematic viscosity [m^2/s]
    cfl: float = 1.0  # advection Courant number per step
    max_dt: float = 0.1  # [s]
    rho: float = 1.2  # air density [kg/m^3]


class Simulation:
    def __init__(self, grid: dict, settings: Settings | None = None):
        self.settings = settings or Settings()
        self.nx, self.ny, self.dx = grid["nx"], grid["ny"], grid["dx"]
        self.origin = tuple(grid["origin"])
        self.cell_type = np.asarray(grid["cell_type"], dtype=np.uint8).reshape(self.ny, self.nx)
        boundary_id = np.asarray(grid["boundary_id"], dtype=np.int32).reshape(self.ny, self.nx)
        self.fluid = self.cell_type == FLUID

        types = set(np.unique(self.cell_type).tolist())
        if INLET in types and OUTLET not in types:
            raise SetupError("The layout has an inlet but no outlet - incompressible flow has nowhere to go.")
        if not self.fluid.any():
            raise SetupError("The grid has no fluid cells.")

        # Inflow velocity per boundary, looked up through boundary_id.
        inflow = np.zeros((len(grid["boundaries"]) + 1, 2))
        for b in grid["boundaries"]:
            inflow[b["index"]] = b["inflow_velocity"]
        self._build_face_masks(boundary_id, inflow)
        self._build_pressure_matrix()
        self.inlet_speed = float(np.abs(np.concatenate([self.u_inlet_value, self.v_inlet_value])).max(initial=0.0))
        self.reset()

    # ---- setup ----------------------------------------------------------------

    def _build_face_masks(self, boundary_id: np.ndarray, inflow: np.ndarray) -> None:
        T = self.cell_type
        # Cell types on either side of every face; outside the array counts as solid.
        tx = np.pad(T, ((0, 0), (1, 1)), constant_values=SOLID)
        ty = np.pad(T, ((1, 1), (0, 0)), constant_values=SOLID)
        bx = np.pad(boundary_id, ((0, 0), (1, 1)), constant_values=-1)
        by = np.pad(boundary_id, ((1, 1), (0, 0)), constant_values=-1)
        left, right = tx[:, :-1], tx[:, 1:]
        below, above = ty[:-1, :], ty[1:, :]

        def classify(a, b, ba, bb, component):
            fa, fb = a == FLUID, b == FLUID
            free = fa & fb
            inlet = (fa & (b == INLET)) | (fb & (a == INLET))
            # Outlet faces: which side is the fluid (we copy velocity from that side).
            out_after = fa & (b == OUTLET)  # fluid before the face, outlet after it
            out_before = fb & (a == OUTLET)  # outlet before the face, fluid after it
            ids = np.where(b == INLET, bb, ba)
            value = np.where(inlet, inflow[ids, component], 0.0)
            return free, inlet, value, out_after, out_before

        (self.u_free, self.u_inlet, self.u_inlet_full, self.u_out_after, self.u_out_before) = classify(
            left, right, bx[:, :-1], bx[:, 1:], 0
        )
        (self.v_free, self.v_inlet, self.v_inlet_full, self.v_out_after, self.v_out_before) = classify(
            below, above, by[:-1, :], by[1:, :], 1
        )
        self.u_inlet_value = self.u_inlet_full[self.u_inlet]
        self.v_inlet_value = self.v_inlet_full[self.v_inlet]
        # Faces that the pressure correction acts on.
        self.u_corr = self.u_free | self.u_out_after | self.u_out_before
        self.v_corr = self.v_free | self.v_out_after | self.v_out_before

    def _build_pressure_matrix(self) -> None:
        """Assemble -laplace(phi) on fluid cells and LU-factorise it once.

        The geometry never changes during a run, so every time step only needs a
        cheap forward/back substitution instead of a full solve.
        """
        T = self.cell_type
        idx = -np.ones(T.shape, dtype=np.int64)
        fj, fi = np.nonzero(self.fluid)
        n = len(fj)
        idx[fj, fi] = np.arange(n)
        self.fluid_j, self.fluid_i = fj, fi

        tp = np.pad(T, 1, constant_values=SOLID)
        ip = np.pad(idx, 1, constant_values=-1)
        rows, cols, vals = [], [], []
        diag = np.zeros(n)
        for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nb_type = tp[fj + 1 + dj, fi + 1 + di]
            nb_idx = ip[fj + 1 + dj, fi + 1 + di]
            fluid_nb = nb_type == FLUID
            # Fluid neighbour: coupling term. Outlet: phi = 0 (Dirichlet) -> diagonal only.
            # Solid / inlet: velocity fixed -> zero pressure gradient (Neumann) -> nothing.
            diag += fluid_nb | (nb_type == OUTLET)
            rows.append(np.arange(n)[fluid_nb])
            cols.append(nb_idx[fluid_nb])
            vals.append(-np.ones(fluid_nb.sum()))
        # A closed room is a pure-Neumann problem (phi only defined up to a constant);
        # a tiny shift makes the matrix invertible. With an outlet, phi = 0 there pins it.
        if not (T == OUTLET).any():
            diag += 1e-6
        rows.append(np.arange(n))
        cols.append(np.arange(n))
        vals.append(diag)
        A = sparse.csc_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n))
        self.pressure_lu = splu(A)

    def reset(self) -> None:
        self.u = np.zeros((self.ny, self.nx + 1))
        self.v = np.zeros((self.ny + 1, self.nx))
        self.p = np.zeros((self.ny, self.nx))
        self.time = 0.0
        self._target = 0.0
        self.step_count = 0
        self.dt = 0.0
        self.max_div = 0.0
        self.steps_per_s = 0.0
        self._apply_bc(self.u, self.v)
        self._project(self.settings.max_dt)

    # ---- time stepping --------------------------------------------------------

    def compute_dt(self) -> float:
        s = self.settings
        umax = max(np.abs(self.u).max(), np.abs(self.v).max(), self.inlet_speed, 1e-3)
        dt = min(s.cfl * self.dx / umax, s.max_dt)
        if s.nu > 0:
            dt = min(dt, 0.2 * self.dx**2 / s.nu)  # explicit diffusion stability limit
        return dt

    def step(self) -> float:
        dt = self.compute_dt()
        u, v = self._advect(dt)
        self._diffuse(u, v, dt)
        self._apply_bc(u, v)
        self.u, self.v = u, v
        self._project(dt)
        self.time += dt
        self.step_count += 1
        self.dt = dt
        return dt

    def advance(self, duration: float, max_wall: float) -> int:
        """Step until `duration` simulated seconds passed or `max_wall` seconds of compute are used.

        The last step usually overshoots the target; that overshoot is carried into the
        next call so the long-run speed is exact. Time lost to a slow machine is not
        caught up on (that would only make it fall further behind).
        """
        start = time.perf_counter()
        self._target = min(self._target, self.time) + duration
        steps = 0
        while self.time < self._target and time.perf_counter() - start < max_wall:
            self.step()
            steps += 1
        elapsed = time.perf_counter() - start
        if steps:
            self.steps_per_s = steps / max(elapsed, 1e-9)
        return steps

    # Positions are in grid units: x = i means the left edge of cell column i.
    def _sample_u(self, x, y):
        return map_coordinates(self.u, [y - 0.5, x], order=1, mode="nearest")

    def _sample_v(self, x, y):
        return map_coordinates(self.v, [y, x - 0.5], order=1, mode="nearest")

    def _backtrace(self, x, y, dt):
        k = dt / self.dx  # m/s -> cells per step
        xm = x - 0.5 * k * self._sample_u(x, y)
        ym = y - 0.5 * k * self._sample_v(x, y)
        return x - k * self._sample_u(xm, ym), y - k * self._sample_v(xm, ym)

    def _advect(self, dt):
        jj, ii = np.mgrid[0 : self.ny, 0 : self.nx + 1]
        xb, yb = self._backtrace(ii.astype(float), jj + 0.5, dt)
        u_new = self._sample_u(xb, yb).reshape(self.u.shape)

        jj, ii = np.mgrid[0 : self.ny + 1, 0 : self.nx]
        xb, yb = self._backtrace(ii + 0.5, jj.astype(float), dt)
        v_new = self._sample_v(xb, yb).reshape(self.v.shape)
        return u_new, v_new

    def _diffuse(self, u, v, dt):
        nu = self.settings.nu
        if nu <= 0:
            return
        for f, free in ((u, self.u_free), (v, self.v_free)):
            fp = np.pad(f, 1, mode="edge")
            lap = (fp[1:-1, 2:] + fp[1:-1, :-2] + fp[2:, 1:-1] + fp[:-2, 1:-1] - 4 * f) / self.dx**2
            f[free] += nu * dt * lap[free]

    def _apply_bc(self, u, v):
        u[~(self.u_free | self.u_out_after | self.u_out_before)] = 0.0
        v[~(self.v_free | self.v_out_after | self.v_out_before)] = 0.0
        u[self.u_inlet] = self.u_inlet_value
        v[self.v_inlet] = self.v_inlet_value
        # Outlets: zero normal gradient - copy the next face further inside.
        u[:, 1:][self.u_out_after[:, 1:]] = u[:, :-1][self.u_out_after[:, 1:]]
        u[:, :-1][self.u_out_before[:, :-1]] = u[:, 1:][self.u_out_before[:, :-1]]
        v[1:, :][self.v_out_after[1:, :]] = v[:-1, :][self.v_out_after[1:, :]]
        v[:-1, :][self.v_out_before[:-1, :]] = v[1:, :][self.v_out_before[:-1, :]]

    def divergence(self, u=None, v=None) -> np.ndarray:
        u = self.u if u is None else u
        v = self.v if v is None else v
        return (u[:, 1:] - u[:, :-1] + v[1:, :] - v[:-1, :]) / self.dx

    def _project(self, dt):
        div = self.divergence()
        rhs = -self.dx**2 * div[self.fluid_j, self.fluid_i]
        phi = np.zeros((self.ny, self.nx))  # zero in outlets (Dirichlet) and solids (unused)
        phi[self.fluid_j, self.fluid_i] = self.pressure_lu.solve(rhs)

        phx = np.pad(phi, ((0, 0), (1, 1)))
        phy = np.pad(phi, ((1, 1), (0, 0)))
        gx = (phx[:, 1:] - phx[:, :-1]) / self.dx
        gy = (phy[1:, :] - phy[:-1, :]) / self.dx
        self.u[self.u_corr] -= gx[self.u_corr]
        self.v[self.v_corr] -= gy[self.v_corr]

        self.p = self.settings.rho * phi / dt
        self.max_div = float(np.abs(self.divergence()[self.fluid]).max())

    # ---- output -----------------------------------------------------------------

    def cell_velocity(self) -> tuple[np.ndarray, np.ndarray]:
        uc = 0.5 * (self.u[:, 1:] + self.u[:, :-1])
        vc = 0.5 * (self.v[1:, :] + self.v[:-1, :])
        uc[~self.fluid] = 0.0
        vc[~self.fluid] = 0.0
        return uc, vc

    def flux(self, cell_type: int) -> float:
        """Net volume flow per metre of height [m^2/s] *into* the room through cells of a type."""
        T = self.cell_type
        tx = np.pad(T, ((0, 0), (1, 1)), constant_values=SOLID)
        ty = np.pad(T, ((1, 1), (0, 0)), constant_values=SOLID)
        q = self.u[(tx[:, :-1] == cell_type) & (tx[:, 1:] == FLUID)].sum()
        q -= self.u[(tx[:, :-1] == FLUID) & (tx[:, 1:] == cell_type)].sum()
        q += self.v[(ty[:-1, :] == cell_type) & (ty[1:, :] == FLUID)].sum()
        q -= self.v[(ty[:-1, :] == FLUID) & (ty[1:, :] == cell_type)].sum()
        return float(q * self.dx)

    def frame_bytes(self) -> bytes:
        uc, vc = self.cell_velocity()
        p = np.where(self.fluid, self.p, 0.0)
        pf = p[self.fluid]
        header = [
            self.time,
            self.step_count,
            self.dt,
            self.max_div,
            float(np.hypot(uc, vc).max()),
            self.steps_per_s,
            float(pf.min()),
            float(pf.max()),
        ]
        parts = [np.asarray(header, dtype="<f4")] + [a.astype("<f4").ravel() for a in (uc, vc, p)]
        return b"".join(a.tobytes() for a in parts)
