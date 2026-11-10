"""2D incompressible Navier-Stokes on a staggered (MAC) grid + heat, CO2, humidity and fumes.

Unknowns
    u[j, i]  x-velocity on the vertical face   left of cell (i, j)   shape (ny, nx+1)
    v[j, i]  y-velocity on the horizontal face below cell (i, j)     shape (ny+1, nx)
    p        pressure [Pa] at cell centres                            shape (ny, nx)
    scalars  T [°C], c = CO2 [ppm], w = water vapour [g/m³], f = cooking fumes [µg/m³]

One time step (Chorin's projection / "fractional step"):
    1. advect     u* = u transported along itself   (semi-Lagrangian, RK2 backtrace)
    2. diffuse    u* += nu * dt * laplace(u*)       (explicit)
    3. fans       u* relaxes towards the fan speed inside each fan's footprint
    4. boundary   walls 0, vents prescribed, pressure openings copy their inner neighbour
    5. project    solve  laplace(phi) = div(u*) - s,  u = u* - grad(phi)
                  -> div(u) = s: mass conservation, where s < 0 inside extract footprints
                  (ceiling extract fans and cooker hoods remove air there), p = rho * phi / dt
    6. scalars    conservative first-order upwind finite volumes + diffusion + sources,
                  sub-stepped to stay within their stability limit
    7. surfaces   floor, ceiling and walls exchange heat with the air (they stay at the
                  initial room temperature - heavy thermal mass), and vapour condenses on
                  them where the air's dew point is above the surface temperature
                  (the fogged-up mirror after a shower)
    8. humidity   above saturation in the air itself the excess condenses as fog,
                  releasing its latent heat into the air

Boundary conditions (decided per boundary from its live state, so doors can be
opened and units switched while running):
    wall / closed window / unit off : u.n = 0                    (Neumann for p)
    ventilation unit                : u.n = Q / (H * width)      (Neumann for p)
    open door / window, door gap    : pressure with a flow resistance (Robin condition)
        p_boundary = p_outside - 1/2 rho |u| u / Cd_eff^2   (orifice equation, u = inflow)
        p_outside  = Cp * 1/2 rho U_wind^2 to the outside, 0 indoors
        Cd_eff     = Cd * opening height / room height (the 2D model spreads everything
                     over the full height); a closed door keeps its undercut gap open.
        The resistance is treated *implicitly* in the pressure equation. An explicit
        treatment (fix p, then update it from the new velocity) blows up for small gaps,
        because the room itself offers almost no resistance.
    Scalars entering the room take the value of the air behind the boundary; leaving
    the room (through boundaries or extracts) they take the local value.

Surfaces: each cell sees floor + ceiling (2 dx^2) plus the wall area of neighbouring
walls (dx * H per wall face). Heat flux q = h A (T - T_s) with a natural-convection
h of about 3 W/m^2K; vapour condenses at g = beta A (w - w_sat(T_s)) with
beta = h / (rho cp) (Lewis analogy between heat and mass transfer). Condensate
stays on the surface (it does not evaporate again in this model).

Cooker hoods: in a top view the rising plume - the thing a hood actually catches -
cannot be resolved. So a hood takes a share eta = 1 - exp(-Q / 250 m³/h) of the
emissions of the hobs beneath it straight out of the room (an engineering capture
efficiency); the rest enters the room. On top of that it extracts room air like
any extract fan.

Simplifications worth knowing about (and good things to improve later):
  * 2D plan view: everything is uniform over the room height. Buoyancy acts
    perpendicular to this plane, so warm air cannot rise here - temperature is a
    passive scalar. Vent jets are spread over the full height.
  * Walls set the tangential face velocities inside solid cells to 0 (approximate no-slip).
  * nu is an *effective* viscosity. Heat, CO2, vapour and fumes use their own turbulent
    diffusivity kappa (default: nu), which also stands in for the buoyancy-driven mixing
    a top view cannot produce.
  * First-order schemes add numerical diffusion. Compare dx = 0.1 and 0.025 to see it.
"""

import math
import time
from dataclasses import dataclass

import numpy as np
from scipy import sparse
from scipy.ndimage import label, map_coordinates
from scipy.sparse.linalg import splu

SOLID, FLUID, BOUNDARY = 0, 1, 2
WALL, PRESSURE, VELOCITY = 0, 1, 2  # role a boundary currently plays
CP_AIR = 1005.0  # J/(kg K)
LATENT_HEAT = 2.45e6  # J/kg, condensation of water vapour
HOOD_Q_REF = 250.0  # m³/h, flow at which a hood catches 1 - 1/e = 63 % of the hob emissions
RESISTANCE_UPDATE_STEPS = 10  # how often the opening resistances (and the LU factors) are refreshed

SCALARS = ("T", "c", "w", "f")
FRAME_HEADER = [
    "time", "step", "dt", "max_div", "max_speed", "steps_per_s", "p_min", "p_max",
    "t_min", "t_max", "t_mean", "c_min", "c_max", "c_mean", "ach", "co2_steady",
    "rh_min", "rh_max", "rh_mean", "f_max", "f_mean", "condensate_g", "fields_mask",
]  # fmt: skip
FRAME_FIELDS = ["u", "v", "p", "T", "c", "rh", "f"]

DEFAULT_CONDITIONS = {
    "initial_temperature": 21.0,
    "initial_co2_ppm": 600.0,
    "initial_rh": 50.0,
    "outdoor_temperature": 10.0,
    "outdoor_co2_ppm": 420.0,
    "outdoor_rh": 80.0,
    "wind_speed": 0.0,
    "wind_direction": 180.0,
}


class SetupError(ValueError):
    pass


@dataclass
class Settings:
    nu: float = 0.002  # effective kinematic viscosity (and diffusivity) [m^2/s]
    cfl: float = 1.0  # advection Courant number per step
    max_dt: float = 0.1  # [s]
    rho: float = 1.2  # air density [kg/m^3]
    cd: float = 0.6  # discharge coefficient of doors, windows and gaps
    fan_tau: float = 0.1  # how quickly fans accelerate the air in their footprint [s]
    # Turbulent diffusivity of heat, CO2, vapour and fumes [m^2/s]; None = same as nu. In a real room
    # heat sources drive a buoyant circulation that mixes the air within minutes - a top view has
    # no buoyancy, so this is where that missing mixing goes.
    kappa: float | None = None
    h_surface: float = 3.0  # heat transfer coefficient air <-> floor, ceiling, walls [W/m^2K]


def wind_pressure_coefficient(outward_normal, wind_direction_deg: float) -> float:
    """Very simple facade Cp: +0.6 facing the wind, -0.35 on the sides and leeward."""
    a = math.radians(wind_direction_deg)
    towards_wind = (math.sin(a), math.cos(a))  # unit vector pointing to where the wind comes from
    cos_angle = outward_normal[0] * towards_wind[0] + outward_normal[1] * towards_wind[1]
    return -0.35 + 0.95 * max(cos_angle, 0.0)


def saturation_vapour_density(T):
    """Water vapour density at saturation [g/m³] for temperature T [°C] (Magnus formula)."""
    T = np.asarray(T, dtype=float)
    e_sat = 611.2 * np.exp(17.62 * T / (243.12 + T))  # Pa
    return e_sat / (461.5 * (T + 273.15)) * 1000.0


def hood_capture_efficiency(flow_m3h: float) -> float:
    return 1.0 - math.exp(-max(flow_m3h, 0.0) / HOOD_Q_REF)


class Simulation:
    def __init__(self, grid: dict, settings: Settings | None = None):
        self.settings = settings or Settings()
        self.nx, self.ny, self.dx = grid["nx"], grid["ny"], grid["dx"]
        self.origin = tuple(grid["origin"])
        self.height = float(grid.get("room_height", 2.7))
        self.cell_type = np.asarray(grid["cell_type"], dtype=np.uint8).reshape(self.ny, self.nx)
        self.boundary_id = np.asarray(grid["boundary_id"], dtype=np.int32).reshape(self.ny, self.nx)
        self.fluid = self.cell_type == FLUID
        if not self.fluid.any():
            raise SetupError("The grid has no fluid cells.")
        self.boundaries = [dict(b) for b in grid.get("boundaries", [])]
        self.conditions = {**DEFAULT_CONDITIONS, **grid.get("conditions", {})}
        self.fans = [dict(f) for f in grid.get("fans", [])]
        self.extracts = [dict(e) for e in grid.get("extracts", [])]
        self.cell_volume = self.dx * self.dx * self.height
        self.sources = self._read_sources(grid)

        self._precompute_faces()
        self.configure()
        self.reset()

    # ---- setup ----------------------------------------------------------------

    def _read_sources(self, grid: dict) -> list[dict]:
        """Heat/CO2/vapour/fume emitters with the fluid cells they cover (flat indices)."""
        if "sources" in grid:
            return [dict(s, cells=np.asarray(s["cells"], dtype=np.int64)) for s in grid["sources"]]
        # Older grids only carry summed per-cell arrays (W and L/s per cell): one anonymous source per cell.
        shape = (self.ny, self.nx)
        heat = np.asarray(grid.get("heat_source", np.zeros(shape)), dtype=float).ravel()
        co2 = np.asarray(grid.get("co2_source", np.zeros(shape)), dtype=float).ravel()
        cells = np.nonzero((heat != 0) | (co2 != 0))[0]
        return [
            {"id": f"cell-{k}", "type": "person", "cells": np.array([k]), "heat_w": heat[k], "co2_lps": co2[k], "on": True}
            for k in cells
        ]

    def _precompute_faces(self) -> None:
        T, B = self.cell_type, self.boundary_id
        ox, oy, dx = self.origin[0], self.origin[1], self.dx
        self.faces = {}
        for axis in ("u", "v"):
            if axis == "u":  # cells left (a) and right (b) of each vertical face
                tp = np.pad(T, ((0, 0), (1, 1)), constant_values=SOLID)
                bp = np.pad(B, ((0, 0), (1, 1)), constant_values=-1)
                ta, tb, ba, bb = tp[:, :-1], tp[:, 1:], bp[:, :-1], bp[:, 1:]
                jj, ii = np.mgrid[0 : self.ny, 0 : self.nx + 1]
                pos = (ox + ii * dx, oy + (jj + 0.5) * dx)
                fluid_j, fluid_i = jj, np.where(ta == FLUID, ii - 1, ii)  # the fluid cell of a boundary face
            else:  # cells below (a) and above (b) of each horizontal face
                tp = np.pad(T, ((1, 1), (0, 0)), constant_values=SOLID)
                bp = np.pad(B, ((1, 1), (0, 0)), constant_values=-1)
                ta, tb, ba, bb = tp[:-1, :], tp[1:, :], bp[:-1, :], bp[1:, :]
                jj, ii = np.mgrid[0 : self.ny + 1, 0 : self.nx]
                pos = (ox + (ii + 0.5) * dx, oy + jj * dx)
                fluid_j, fluid_i = np.where(ta == FLUID, jj - 1, jj), ii
            fa, fb = ta == FLUID, tb == FLUID
            bnd = (fa & (tb == BOUNDARY)) | (fb & (ta == BOUNDARY))
            self.faces[axis] = {
                "free": fa & fb,
                "bnd": bnd,
                "bnd_idx": np.nonzero(bnd),
                "bnd_k": np.where(tb == BOUNDARY, bb, ba)[bnd],
                # +1 if positive velocity on this face flows *into* the room (boundary cell before the face)
                "bnd_in": np.where(ta == BOUNDARY, 1.0, -1.0)[bnd],
                "bnd_fluid": (fluid_j[bnd], fluid_i[bnd]),
                "pos": pos,
            }
        nb = len(self.boundaries)
        self.faces_per_boundary = np.bincount(
            np.concatenate([self.faces["u"]["bnd_k"], self.faces["v"]["bnd_k"]]), minlength=nb
        )[:nb]
        self.n_fluid = int(self.fluid.sum())
        # Surface area each fluid cell exchanges heat and vapour with: floor + ceiling + adjacent walls.
        tp = np.pad(T, 1, constant_values=SOLID)
        walls = sum((tp[1 + dj : tp.shape[0] - 1 + dj, 1 + di : tp.shape[1] - 1 + di] != FLUID).astype(float)
                    for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0)))  # fmt: skip
        self.surface_area = np.where(self.fluid, 2 * dx * dx + walls * dx * self.height, 0.0)
        fj, fi = np.nonzero(self.fluid)
        self.fluid_j, self.fluid_i = fj, fi
        self.fluid_index = -np.ones(self.cell_type.shape, dtype=np.int64)
        self.fluid_index[fj, fi] = np.arange(len(fj))

    def configure(self) -> None:
        """(Re)build everything that depends on which doors are open and which units/fans run."""
        self.notes: list[str] = []
        nb = len(self.boundaries)
        H = self.height
        role = np.zeros(nb, dtype=int)
        flow = np.zeros(nb)  # m^3/s, + into the room
        cd_eff = np.zeros(nb)
        for k, b in enumerate(self.boundaries):
            if self.faces_per_boundary[k] == 0:
                continue
            if b["type"] == "opening":
                # A closed door still lets air through its undercut gap.
                gap = b.get("height", H) if b.get("open") else b.get("undercut", 0.0) or 0.0
                if gap > 0:
                    role[k] = PRESSURE
                    cd_eff[k] = self.settings.cd * min(1.0, gap / H)
            elif b.get("on") and b.get("flow_m3h", 0) > 0:
                role[k] = VELOCITY
                flow[k] = b["flow_m3h"] / 3600 * (1 if b.get("mode") == "supply" else -1)

        extract_flow = np.array(
            [e["flow_m3h"] / 3600 if e.get("on") and e.get("flow_m3h", 0) > 0 else 0.0 for e in self.extracts]
        )

        # Incompressible + airtight: what the units push in must be pulled out exactly.
        if not (role == PRESSURE).any() and ((role == VELOCITY).any() or extract_flow.any()):
            supply = flow[flow > 0].sum()
            removal = -flow[flow < 0].sum() + extract_flow.sum()
            if supply > 0 and removal > 0:
                if abs(supply - removal) > 1e-12:
                    scale = supply / removal
                    flow[flow < 0] *= scale
                    extract_flow *= scale
                    self.notes.append(
                        f"No door, window or door gap lets air in or out, so exhaust and extracts were scaled to "
                        f"match the supply ({supply * 3600:.0f} m³/h) - an airtight room cannot be unbalanced."
                    )
            else:
                role[role == VELOCITY] = WALL
                flow[:] = 0
                extract_flow[:] = 0
                self.notes.append(
                    "Fans are stalled: the room is airtight (no open door or window, no door gap) and nothing "
                    "replaces the air - in reality the fan would only build up under-pressure. Open a window or "
                    "give the door an undercut."
                )
        self.role, self.flow, self.cd_eff = role, flow, cd_eff

        # Face classification for the current state.
        self.vent_speed = 0.0
        for axis in ("u", "v"):
            f = self.faces[axis]
            r = role[f["bnd_k"]] if nb else np.zeros(0, int)
            pres = np.zeros_like(f["bnd"])
            pres[f["bnd_idx"]] = r == PRESSURE
            fixed_val = np.zeros(f["bnd"].shape)
            if nb:
                # Spread each unit's volume flow evenly over its faces: flux = Q / H.
                speed = flow / (H * self.dx * np.maximum(self.faces_per_boundary, 1))
                vals = np.where(r == VELOCITY, f["bnd_in"] * speed[f["bnd_k"]], 0.0)
                fixed_val[f["bnd_idx"]] = vals
                self.vent_speed = max(self.vent_speed, float(np.abs(vals).max(initial=0)))
            f["pres"] = pres
            f["pres_sel"] = r == PRESSURE  # selects the pressure faces within the boundary-face list
            f["fixed"] = ~(f["free"] | pres)
            f["fixed_val"] = fixed_val

        self._configure_extracts(extract_flow)
        self._configure_fans()
        self._configure_sources()
        self.resistance = np.zeros(nb)  # K in  dp = K * u  per boundary [Pa s/m]
        self._build_pressure_matrix(self.settings.max_dt)

    def _rect_cells(self, item: dict) -> np.ndarray:
        """Flat indices of the fluid cells whose centres lie in an axis-aligned rectangle (at least one)."""
        if "cells" in item:
            return np.asarray(item["cells"], dtype=np.int64)
        xs = self.origin[0] + (np.arange(self.nx) + 0.5) * self.dx
        ys = self.origin[1] + (np.arange(self.ny) + 0.5) * self.dx
        X, Y = np.meshgrid(xs, ys)
        hw, hd, eps = item.get("width", 0.3) / 2, item.get("depth", 0.3) / 2, 1e-9
        inside = (X >= item["x"] - hw - eps) & (X < item["x"] + hw - eps) & (Y >= item["y"] - hd - eps) & (Y < item["y"] + hd - eps)
        inside &= self.fluid
        if not inside.any():
            d = np.where(self.fluid, (X - item["x"]) ** 2 + (Y - item["y"]) ** 2, np.inf)
            inside = d == d.min()
        return np.flatnonzero(inside)

    def _configure_extracts(self, extract_flow: np.ndarray) -> None:
        """Volume sinks: s = -Q / V_footprint [1/s] in each running extract's cells."""
        self.sink = np.zeros(self.cell_type.size)
        self.extract_cells = []
        self.extract_flow = extract_flow  # m^3/s actually extracted (after any airtight balancing)
        for e, q in zip(self.extracts, extract_flow):
            cells = self._rect_cells(e)
            self.extract_cells.append(cells)
            if q > 0:
                self.sink[cells] -= q / (len(cells) * self.cell_volume)
        self.sink = self.sink.reshape(self.cell_type.shape)

    def _configure_sources(self) -> None:
        """Per-cell emission rates of all running sources, after hood capture."""
        V = self.cell_volume
        rates = {name: np.zeros(self.cell_type.size) for name in SCALARS}
        self.capture = {}  # source id -> share caught by a hood
        self.emission = {"w": 0.0, "f": 0.0}  # total emitted (g/s vapour, µg/s fumes), incl. captured
        self.captured = {"w": 0.0, "f": 0.0}
        hoods = [
            (e, q * 3600)
            for e, q in zip(self.extracts, self.extract_flow)
            if e.get("kind") == "hood" and q > 0
        ]
        for s in self.sources:
            if not s.get("on", True) or not len(s["cells"]):
                continue
            eta = 0.0
            if s.get("type") == "hob":
                for e, q in hoods:
                    if abs(s["x"] - e["x"]) <= e.get("width", 0.6) / 2 + 0.1 and abs(s["y"] - e["y"]) <= e.get("depth", 0.5) / 2 + 0.1:
                        eta = max(eta, hood_capture_efficiency(q))
            self.capture[s["id"]] = eta
            n = len(s["cells"])
            vapour = s.get("moisture_gph", 0.0) / 3600  # g/s
            fumes = s.get("fumes_mgpm", 0.0) * 1000 / 60  # µg/s
            self.emission["w"] += vapour
            self.emission["f"] += fumes
            self.captured["w"] += eta * vapour
            self.captured["f"] += eta * fumes
            keep = 1.0 - eta
            np.add.at(rates["T"], s["cells"], keep * s.get("heat_w", 0.0) / (self.settings.rho * CP_AIR * V * n))
            np.add.at(rates["c"], s["cells"], s.get("co2_lps", 0.0) * 1e-3 / (V * n) * 1e6)
            np.add.at(rates["w"], s["cells"], keep * vapour / (V * n))
            np.add.at(rates["f"], s["cells"], keep * fumes / (V * n))
        self.source_rate = {k: r.reshape(self.cell_type.shape) for k, r in rates.items()}
        self.co2_generation = sum(s.get("co2_lps", 0.0) for s in self.sources if s.get("on", True)) * 1e-3

    def _pressure_pairs(self):
        """(fluid row, boundary k, axis, face index, inward sign) for every pressure-boundary face."""
        rows, ks, axes, idx, sign = [], [], [], [], []
        for a, axis in enumerate(("u", "v")):
            f = self.faces[axis]
            sel = f["pres_sel"]
            fj, fi = f["bnd_fluid"]
            rows.append(self.fluid_index[fj[sel], fi[sel]])
            ks.append(f["bnd_k"][sel])
            axes.append(np.full(sel.sum(), a))
            idx.append(np.stack([f["bnd_idx"][0][sel], f["bnd_idx"][1][sel]], axis=1))
            sign.append(f["bnd_in"][sel])
        return (
            np.concatenate(rows),
            np.concatenate(ks),
            np.concatenate(axes),
            np.concatenate(idx) if idx else np.zeros((0, 2), int),
            np.concatenate(sign),
        )

    def _build_pressure_matrix(self, dt: float) -> None:
        """Assemble -laplace(phi) on fluid cells (with Robin rows at openings) and LU-factorise it.

        A pressure-boundary face with resistance K gives  u_in = alpha * (u*_in + (phi_out - phi_c) / dx)
        with alpha = 1 / (1 + dt K / (rho dx)): alpha = 1 is a plain fixed-pressure opening, alpha -> 0 a wall.
        """
        T = self.cell_type
        fj, fi = self.fluid_j, self.fluid_i
        n = len(fj)
        tp = np.pad(T, 1, constant_values=SOLID)
        ip = np.pad(self.fluid_index, 1, constant_values=-1)
        rows, cols, vals = [], [], []
        diag = np.zeros(n)
        for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nb_type = tp[fj + 1 + dj, fi + 1 + di]
            nb_idx = ip[fj + 1 + dj, fi + 1 + di]
            fluid_nb = nb_type == FLUID
            diag += fluid_nb
            rows.append(np.arange(n)[fluid_nb])
            cols.append(nb_idx[fluid_nb])
            vals.append(-np.ones(fluid_nb.sum()))
        rows, cols, vals = np.concatenate(rows), np.concatenate(cols), np.concatenate(vals)

        self.pairs = self._pressure_pairs()
        prow, pk = self.pairs[0], self.pairs[1]
        k_res = dt * self.resistance / (self.settings.rho * self.dx) if len(self.resistance) else np.zeros(0)
        self.alpha = 1.0 / (1.0 + k_res) if len(k_res) else np.zeros(0)
        np.add.at(diag, prow, self.alpha[pk] if len(pk) else 0.0)

        # A region without any pressure boundary is a pure-Neumann problem: phi is only defined up
        # to a constant. Fix it by replacing one equation per such region with phi = 0.
        labels, nlab = label(self.fluid)
        lab = labels[fj, fi]
        has_open = np.zeros(nlab + 1, dtype=bool)
        has_open[lab[prow]] = True
        pinned = np.array([np.argmax(lab == r) for r in range(1, nlab + 1) if not has_open[r]], dtype=np.int64)
        keep = ~np.isin(rows, pinned)
        rows, cols, vals = rows[keep], cols[keep], vals[keep]
        diag[pinned] = 1.0
        self.pinned = pinned

        A = sparse.csc_matrix(
            (np.concatenate([vals, diag]), (np.concatenate([rows, np.arange(n)]), np.concatenate([cols, np.arange(n)]))),
            shape=(n, n),
        )
        self.pressure_lu = splu(A)
        self.matrix_dt = dt

    def fan_angle(self, fan: dict, t: float | None = None) -> float:
        """Current blowing direction [deg]; oscillating fans swing +-sweep around their angle."""
        t = getattr(self, "time", 0.0) if t is None else t
        angle = fan.get("angle", 0.0)
        if fan.get("oscillate"):
            angle += fan.get("sweep", 45.0) * math.sin(2 * math.pi * t / max(fan.get("period", 12.0), 0.5))
        return angle

    def _configure_fans(self) -> None:
        """Faces inside each running fan's footprint (a width x depth rectangle)."""
        self.fan_forcing = []
        self.fan_speed = 0.0
        self.fans_oscillating = False
        for fan in self.fans:
            if not fan.get("on", True) or fan.get("speed", 0) <= 0:
                continue
            self.fans_oscillating |= bool(fan.get("oscillate"))
            a = math.radians(self.fan_angle(fan))
            d = (math.cos(a), math.sin(a))
            half_w = fan.get("width", 0.4) / 2
            half_d = max(0.15, 1.5 * self.dx) / 2
            target = (fan["speed"] * d[0], fan["speed"] * d[1])
            masks = {}
            for axis in ("u", "v"):
                x, y = self.faces[axis]["pos"]
                rx, ry = x - fan["x"], y - fan["y"]
                along = rx * d[0] + ry * d[1]
                across = -rx * d[1] + ry * d[0]
                masks[axis] = (np.abs(along) <= half_d) & (np.abs(across) <= half_w) & self.faces[axis]["free"]
            self.fan_forcing.append((masks["u"], masks["v"], target))
            self.fan_speed = max(self.fan_speed, fan["speed"])

    def reset(self) -> None:
        c = self.conditions
        self.u = np.zeros((self.ny, self.nx + 1))
        self.v = np.zeros((self.ny + 1, self.nx))
        self.p = np.zeros((self.ny, self.nx))
        T0 = float(c["initial_temperature"])
        self.scalar = {
            "T": np.full((self.ny, self.nx), T0),
            "c": np.full((self.ny, self.nx), float(c["initial_co2_ppm"])),
            "w": np.full((self.ny, self.nx), float(saturation_vapour_density(T0)) * c["initial_rh"] / 100),
            "f": np.zeros((self.ny, self.nx)),
        }
        self.condensate = 0.0  # g of water condensed (on surfaces and as fog) so far
        self.p_boundary = self._outside_pressure()
        self.time = 0.0
        self._target = 0.0
        self.step_count = 0
        self.dt = 0.0
        self.max_div = 0.0
        self.steps_per_s = 0.0
        self.resistance[:] = 0.0
        self._build_pressure_matrix(self.settings.max_dt)
        self._apply_bc(self.u, self.v)
        self._project(self.settings.max_dt)

    # Convenient views on the scalars.
    T = property(lambda self: self.scalar["T"])
    c = property(lambda self: self.scalar["c"])
    w = property(lambda self: self.scalar["w"])

    def relative_humidity(self) -> np.ndarray:
        return 100.0 * self.scalar["w"] / saturation_vapour_density(self.scalar["T"])

    # ---- live changes -----------------------------------------------------------

    def update(self, kind: str, item_id: str | None = None, **changes) -> None:
        """Change a boundary, fan, source, extract or the conditions while running."""
        if kind == "conditions":
            for key in ("wind_speed", "wind_direction", "outdoor_temperature", "outdoor_co2_ppm", "outdoor_rh"):
                if key in changes:
                    self.conditions[key] = float(changes[key])
            return
        items, allowed = {
            "boundary": (self.boundaries, {"open", "on", "flow_m3h", "supply_temperature"}),
            "fan": (self.fans, {"on", "speed", "angle", "oscillate", "sweep", "period"}),
            "source": (self.sources, {"on", "heat_w", "moisture_gph", "fumes_mgpm", "activity"}),
            "extract": (self.extracts, {"on", "flow_m3h"}),
        }[kind]
        item = next((x for x in items if x.get("id") == item_id), None)
        if item is None:
            raise KeyError(f"No {kind} with id '{item_id}'")
        item.update({k: v for k, v in changes.items() if k in allowed})
        if kind == "fan":
            self._configure_fans()  # fans do not touch boundaries or the pressure matrix
        else:
            self.configure()

    def state(self) -> dict:
        keys = ("id", "type", "kind", "open", "connects_to", "undercut", "on", "mode", "flow_m3h", "supply_temperature")
        src_keys = ("id", "type", "on", "activity", "heat_w", "moisture_gph", "fumes_mgpm")
        return {
            "boundaries": [{k: b[k] for k in keys if k in b} for b in self.boundaries],
            "fans": [
                {k: f.get(k) for k in ("id", "on", "speed", "angle", "oscillate", "sweep", "period")} for f in self.fans
            ],
            "sources": [{k: s[k] for k in src_keys if k in s} for s in self.sources if s.get("type") != "person"],
            "extracts": [{k: e.get(k) for k in ("id", "kind", "on", "flow_m3h")} for e in self.extracts],
            "conditions": dict(self.conditions),
            "notes": list(self.notes),
        }

    # ---- time stepping --------------------------------------------------------

    def compute_dt(self) -> float:
        s = self.settings
        umax = max(np.abs(self.u).max(), np.abs(self.v).max(), self.vent_speed, self.fan_speed, 1e-3)
        dt = min(s.cfl * self.dx / umax, s.max_dt)
        if s.nu > 0:
            dt = min(dt, 0.2 * self.dx**2 / s.nu)  # explicit diffusion stability limit
        return dt

    def step(self) -> float:
        dt = self.compute_dt()
        if self.step_count % RESISTANCE_UPDATE_STEPS == 0:
            self._update_resistances(dt)
        u, v = self._advect(dt)
        self._diffuse(u, v, dt)
        if self.fans_oscillating:
            self._configure_fans()  # the footprint turns with the fan
        self._apply_fans(u, v, dt)
        self._apply_bc(u, v)
        self.u, self.v = u, v
        self._project(dt)
        self._transport_scalars(dt)
        self._surfaces(dt)
        self._condense()
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
        for f, free in ((u, self.faces["u"]["free"]), (v, self.faces["v"]["free"])):
            fp = np.pad(f, 1, mode="edge")
            lap = (fp[1:-1, 2:] + fp[1:-1, :-2] + fp[2:, 1:-1] + fp[:-2, 1:-1] - 4 * f) / self.dx**2
            f[free] += nu * dt * lap[free]

    def _apply_fans(self, u, v, dt):
        relax = 1.0 - math.exp(-dt / self.settings.fan_tau)
        for mu, mv, (tu, tv) in self.fan_forcing:
            u[mu] += relax * (tu - u[mu])
            v[mv] += relax * (tv - v[mv])

    def _apply_bc(self, u, v):
        for f, a in ((u, self.faces["u"]), (v, self.faces["v"])):
            f[a["fixed"]] = a["fixed_val"][a["fixed"]]
            # Pressure faces: zero normal gradient - take the next face further inside as u*.
            j, i = a["bnd_idx"]
            sel = a["pres_sel"]
            if not sel.any():
                continue
            j, i, s = j[sel], i[sel], a["bnd_in"][sel]
            # Inner neighbour of a face lies one step against the inflow direction... i.e. into the room.
            if f is u:
                f[j, i] = f[j, i + s.astype(int)]
            else:
                f[j, i] = f[j + s.astype(int), i]

    def _outside_pressure(self) -> np.ndarray:
        c = self.conditions
        q = 0.5 * self.settings.rho * c["wind_speed"] ** 2
        out = np.zeros(len(self.boundaries))
        for k, b in enumerate(self.boundaries):
            if b["type"] == "opening" and b.get("connects_to") == "outside":
                out[k] = wind_pressure_coefficient(b["outward_normal"], c["wind_direction"]) * q
        return out

    def _mean_inflow(self) -> np.ndarray:
        """Mean velocity of air entering the room through each boundary (negative = leaving)."""
        nb = len(self.boundaries)
        total = np.zeros(nb)
        for f, a in ((self.u, self.faces["u"]), (self.v, self.faces["v"])):
            total += np.bincount(a["bnd_k"], weights=f[a["bnd_idx"]] * a["bnd_in"], minlength=nb)[:nb]
        return total / np.maximum(self.faces_per_boundary, 1)

    def _update_resistances(self, dt: float) -> None:
        """Re-linearise the orifice law dp = 1/2 rho |u| u / Cd^2 around the current flow."""
        if not len(self.boundaries) or not (self.role == PRESSURE).any():
            return
        u = np.abs(self._mean_inflow())
        cd = np.where(self.cd_eff > 0, self.cd_eff, 1.0)
        target = np.where(self.role == PRESSURE, 0.5 * self.settings.rho * np.maximum(u, 1e-4) / cd**2, 0.0)
        # Plain substitution K <- 1/2 rho |u(K)| / Cd^2 oscillates (K * u stays constant); the geometric
        # mean of old and new converges, for a single orifice even in one update.
        old = self.resistance
        new = np.where(old > 0, np.sqrt(old * target), target)
        # Refactorising costs a few ms, so only do it when something really changed.
        if np.all(np.abs(new - old) <= 0.05 * np.maximum(old, 1e-9)) and abs(dt - self.matrix_dt) < 0.05 * dt:
            return
        self.resistance = new
        self._build_pressure_matrix(dt)

    def divergence(self, u=None, v=None) -> np.ndarray:
        u = self.u if u is None else u
        v = self.v if v is None else v
        return (u[:, 1:] - u[:, :-1] + v[1:, :] - v[:-1, :]) / self.dx

    def _project(self, dt):
        rho, dx = self.settings.rho, self.dx
        prow, pk, paxis, pidx, psign = self.pairs
        phi_out = self._outside_pressure() * dt / rho

        # u*_in on the pressure faces (inflow positive).
        ustar_in = np.zeros(len(prow))
        for a, f in enumerate((self.u, self.v)):
            m = paxis == a
            ustar_in[m] = f[pidx[m, 0], pidx[m, 1]] * psign[m]

        rhs = -dx**2 * (self.divergence()[self.fluid_j, self.fluid_i] - self.sink[self.fluid_j, self.fluid_i])
        if len(prow):
            alpha = self.alpha[pk]
            np.add.at(rhs, prow, alpha * phi_out[pk] + dx * (alpha - 1.0) * ustar_in)
        rhs[self.pinned] = 0.0
        phi = np.zeros((self.ny, self.nx))
        phi[self.fluid_j, self.fluid_i] = self.pressure_lu.solve(rhs)

        # Interior faces: the usual gradient correction.
        phx = np.pad(phi, ((0, 0), (1, 1)))
        phy = np.pad(phi, ((1, 1), (0, 0)))
        cu, cv = self.faces["u"]["free"], self.faces["v"]["free"]
        self.u[cu] -= ((phx[:, 1:] - phx[:, :-1]) / dx)[cu]
        self.v[cv] -= ((phy[1:, :] - phy[:-1, :]) / dx)[cv]

        # Pressure faces: the Robin relation.
        if len(prow):
            phi_c = phi[self.fluid_j[prow], self.fluid_i[prow]]
            u_in = self.alpha[pk] * (ustar_in + (phi_out[pk] - phi_c) / dx)
            for a, f in enumerate((self.u, self.v)):
                m = paxis == a
                f[pidx[m, 0], pidx[m, 1]] = u_in[m] * psign[m]
            nb = len(self.boundaries)
            mean_in = np.bincount(pk, weights=u_in, minlength=nb)[:nb] / np.maximum(np.bincount(pk, minlength=nb)[:nb], 1)
            self.p_boundary = self._outside_pressure() - self.resistance * mean_in

        self.p = rho * phi / dt
        self.max_div = float(np.abs((self.divergence() - self.sink)[self.fluid]).max())

    # ---- heat, CO2, vapour, fumes ------------------------------------------------

    def _boundary_air(self) -> dict[str, np.ndarray]:
        """Scalar values of the air behind each boundary (used where air flows in)."""
        c = self.conditions
        nb = len(self.boundaries)
        T_in, T_out = float(c["initial_temperature"]), float(c["outdoor_temperature"])
        w_in = float(saturation_vapour_density(T_in)) * c["initial_rh"] / 100
        w_out = float(saturation_vapour_density(T_out)) * c["outdoor_rh"] / 100
        air = {"T": np.full(nb, T_in), "c": np.full(nb, float(c["initial_co2_ppm"])), "w": np.full(nb, w_in), "f": np.zeros(nb)}
        for k, b in enumerate(self.boundaries):
            if b["type"] == "vent":
                # Supply air: outdoor air, heated (a heat exchanger does not change its absolute humidity).
                air["T"][k], air["c"][k], air["w"][k] = b.get("supply_temperature", 18.0), c["outdoor_co2_ppm"], w_out
            elif b.get("connects_to") == "outside":
                air["T"][k], air["c"][k], air["w"][k] = T_out, c["outdoor_co2_ppm"], w_out
        return air

    def _transport_scalars(self, dt: float) -> None:
        bmask = self.cell_type == BOUNDARY
        if len(self.boundaries) and bmask.any():
            air = self._boundary_air()
            for name in SCALARS:
                self.scalar[name][bmask] = air[name][self.boundary_id[bmask]]
        kappa = self.settings.nu if self.settings.kappa is None else self.settings.kappa
        # Upwind + explicit diffusion is stable while a cell never sends out more than it has:
        # dt * (outflow / dx + 4 kappa / dx^2) <= 1. Sub-step to stay below 0.9.
        rate = (np.abs(self.u).max() + np.abs(self.v).max()) / self.dx + 4 * kappa / self.dx**2 + np.abs(self.sink).max()
        n = max(1, math.ceil(dt * rate / 0.9))
        h = dt / n
        for _ in range(n):
            for name in SCALARS:
                self._scalar_step(self.scalar[name], self.source_rate[name], h, kappa)

    def _scalar_step(self, f: np.ndarray, source: np.ndarray, h: float, kappa: float) -> None:
        """Finite-volume update: what flows in through the faces minus what flows out."""
        fx = np.pad(f, ((0, 0), (1, 1)), mode="edge")
        a, b = fx[:, :-1], fx[:, 1:]
        flux_x = self.u * np.where(self.u > 0, a, b) - kappa * (b - a) / self.dx * self.faces["u"]["free"]
        fy = np.pad(f, ((1, 1), (0, 0)), mode="edge")
        a, b = fy[:-1, :], fy[1:, :]
        flux_y = self.v * np.where(self.v > 0, a, b) - kappa * (b - a) / self.dx * self.faces["v"]["free"]
        # The sink term: extracts take air - and what is in it - out of their cells, so div(u) = s there.
        change = -(flux_x[:, 1:] - flux_x[:, :-1] + flux_y[1:, :] - flux_y[:-1, :]) / self.dx + self.sink * f + source
        f[self.fluid] += h * change[self.fluid]

    def _surfaces(self, dt: float) -> None:
        """Heat exchange with, and condensation on, floor, ceiling and walls."""
        s = self.settings
        T, w = self.scalar["T"], self.scalar["w"]
        T_s = float(self.conditions["initial_temperature"])
        rate = s.h_surface * self.surface_area / (s.rho * CP_AIR * self.cell_volume)  # 1/s
        T[self.fluid] -= (dt * rate * (T - T_s))[self.fluid]
        # beta * A / V happens to be the same rate (Lewis analogy); exact decay for the stiff case.
        excess = np.maximum(w - float(saturation_vapour_density(T_s)), 0.0)
        condensed = np.where(self.fluid, excess * (1.0 - np.exp(-dt * rate)), 0.0)  # g/m³
        if condensed.any():
            w -= condensed
            self.condensate += float(condensed.sum()) * self.cell_volume

    def _condense(self) -> None:
        """Vapour above saturation condenses in the air (fog); the latent heat warms the air."""
        T, w = self.scalar["T"], self.scalar["w"]
        excess = np.where(self.fluid, w - saturation_vapour_density(T), 0.0)
        excess = np.maximum(excess, 0.0)  # g/m³
        if not excess.any():
            return
        w -= excess
        T += LATENT_HEAT * excess / 1000.0 / (self.settings.rho * CP_AIR)
        self.condensate += float(excess.sum()) * self.cell_volume

    # ---- output -----------------------------------------------------------------

    def cell_velocity(self) -> tuple[np.ndarray, np.ndarray]:
        uc = 0.5 * (self.u[:, 1:] + self.u[:, :-1])
        vc = 0.5 * (self.v[1:, :] + self.v[:-1, :])
        uc[~self.fluid] = 0.0
        vc[~self.fluid] = 0.0
        return uc, vc

    def _face_inflows(self):
        """Per boundary face: inflow velocity [m/s] (negative = out), boundary index, fluid cell."""
        parts = []
        for f, a in ((self.u, self.faces["u"]), (self.v, self.faces["v"])):
            parts.append((f[a["bnd_idx"]] * a["bnd_in"], a["bnd_k"], a["bnd_fluid"]))
        return parts

    def boundary_flows(self) -> np.ndarray:
        """Volume flow into the room through each boundary [m^3/s] (negative = out)."""
        nb = len(self.boundaries)
        total = np.zeros(nb)
        for q, k, _ in self._face_inflows():
            total += np.bincount(k, weights=q, minlength=nb)[:nb]
        return total * self.dx * self.height

    def boundary_scalar_flows(self, name: str) -> np.ndarray:
        """Amount of a scalar carried into the room through each boundary per second (negative = out)."""
        nb = len(self.boundaries)
        air = self._boundary_air()[name] if nb else np.zeros(0)
        f = self.scalar[name]
        total = np.zeros(nb)
        for q, k, (fj, fi) in self._face_inflows():
            carried = np.where(q > 0, air[k] if nb else 0.0, f[fj, fi])
            total += np.bincount(k, weights=q * carried, minlength=nb)[:nb]
        return total * self.dx * self.height

    def extract_scalar_flows(self, name: str) -> np.ndarray:
        """Amount of a scalar removed by each extract per second (air it sucks from the room)."""
        f = self.scalar[name].ravel()
        sink = self.sink.ravel()
        return np.array([float(-(sink[cells] * f[cells]).sum()) * self.cell_volume for cells in self.extract_cells])

    def ventilation_stats(self) -> tuple[float, float]:
        """Air changes per hour and the well-mixed steady-state CO2 for the current flows."""
        nb = len(self.boundaries)
        inflow = np.zeros(nb)
        for q, k, _ in self._face_inflows():
            inflow += np.bincount(k, weights=np.maximum(q, 0.0), minlength=nb)[:nb]
        inflow *= self.dx * self.height  # m^3/s per boundary
        q_total = inflow.sum()
        volume = self.n_fluid * self.cell_volume
        if q_total < 1e-9:
            return 0.0, -1.0
        c_in = self._boundary_air()["c"]
        steady = float((inflow * c_in).sum() / q_total + self.co2_generation / q_total * 1e6)
        return float(q_total / volume * 3600), steady

    def balance(self) -> dict:
        """Moisture and fume budget per second, for the viewer."""
        names = [b["id"] for b in self.boundaries]
        w_b = self.boundary_scalar_flows("w") * 3600  # g/h
        f_b = self.boundary_scalar_flows("f") * 3600 / 1000  # mg/h
        w_e = self.extract_scalar_flows("w") * 3600
        f_e = self.extract_scalar_flows("f") * 3600 / 1000
        return {
            "flows": {n: round(q * 3600, 1) for n, q in zip(names, self.boundary_flows())},
            "moisture": {
                "emitted_gph": round(self.emission["w"] * 3600, 1),
                "captured_gph": round(self.captured["w"] * 3600, 1),
                "boundaries_gph": {n: round(x, 1) for n, x in zip(names, w_b)},
                "extracts_gph": {e["id"]: round(x, 1) for e, x in zip(self.extracts, w_e)},
                "condensate_g": round(self.condensate, 1),
            },
            "fumes": {
                "emitted_mgph": round(self.emission["f"] * 3600 / 1000, 2),
                "captured_mgph": round(self.captured["f"] * 3600 / 1000, 2),
                "boundaries_mgph": {n: round(x, 2) for n, x in zip(names, f_b)},
                "extracts_mgph": {e["id"]: round(x, 2) for e, x in zip(self.extracts, f_e)},
            },
            "extracts": {
                e["id"]: {"flow_m3h": round(q * 3600, 1)} for e, q in zip(self.extracts, self.extract_flow)
            },
            "capture": {k: round(v, 3) for k, v in self.capture.items() if v > 0},
        }

    def frame_bytes(self, fields: list[str] | None = None) -> bytes:
        fields = FRAME_FIELDS if fields is None else [f for f in FRAME_FIELDS if f in fields]
        uc, vc = self.cell_velocity()
        rh = self.relative_humidity()
        data = {"u": uc, "v": vc, "p": self.p, "T": self.T, "c": self.c, "rh": rh, "f": self.scalar["f"]}
        fl = self.fluid
        pf, tf, cf, hf, ff = self.p[fl], self.T[fl], self.c[fl], rh[fl], self.scalar["f"][fl]
        ach, co2_steady = self.ventilation_stats()
        mask = sum(1 << FRAME_FIELDS.index(f) for f in fields)
        header = [
            self.time, self.step_count, self.dt, self.max_div, float(np.hypot(uc, vc).max()), self.steps_per_s,
            pf.min(), pf.max(), tf.min(), tf.max(), tf.mean(), cf.min(), cf.max(), cf.mean(), ach, co2_steady,
            hf.min(), hf.max(), hf.mean(), ff.max(), ff.mean(), self.condensate, mask,
        ]  # fmt: skip
        parts = [np.asarray(header, dtype="<f4")]
        for name in fields:
            parts.append(np.where(fl, data[name], 0.0).astype("<f4").ravel())
        return b"".join(a.tobytes() for a in parts)
