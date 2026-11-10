"""Turn a vector layout into the uniform Cartesian grid the solver works on.

This is the "meshing" step. We use the simplest possible mesh: square cells of
size dx, and every cell is either fluid or solid depending on whether its
centre lies inside the room polygon ("staircase" / cut-cell-free immersed
boundary). Walls that are not grid-aligned therefore become jagged - a classic
trade-off you can see directly in the editor's mesh preview.

Openings and ventilation units become BOUNDARY cells (the solid cells just
outside the wall). Which boundary condition they get is decided by the solver
from `boundaries[boundary_id]`, so doors can be opened and closed while the
simulation runs without re-meshing.

Arrays are indexed [j, i] = [y, x], j = 0 is the bottom row.
"""

import math
from dataclasses import dataclass, field

import numpy as np

from . import geometry as geo
from .models import Layout

SOLID, FLUID, BOUNDARY = 0, 1, 2
CELL_TYPE_NAMES = {SOLID: "solid", FLUID: "fluid", BOUNDARY: "boundary"}

MAX_CELLS = 1_000_000
PAD = 2  # solid cells around the bounding box, so every wall has an "outside" cell
HOB_PLUME_RADIUS = 1.0  # m, area over which a hob's emissions enter the (depth-averaged) room air


@dataclass
class Grid:
    nx: int
    ny: int
    dx: float
    origin: tuple[float, float]  # world position of the lower-left corner of cell [0, 0]
    cell_type: np.ndarray  # uint8 [ny, nx]
    boundary_id: np.ndarray  # int16 [ny, nx], index into `boundaries` or -1
    heat_source: np.ndarray  # float [ny, nx], W per cell
    co2_source: np.ndarray  # float [ny, nx], L/s per cell
    boundaries: list[dict] = field(default_factory=list)
    extra: dict = field(default_factory=dict)  # passed through to the solver

    def cell_centers(self) -> tuple[np.ndarray, np.ndarray]:
        xs = self.origin[0] + (np.arange(self.nx) + 0.5) * self.dx
        ys = self.origin[1] + (np.arange(self.ny) + 0.5) * self.dx
        return np.meshgrid(xs, ys)

    def to_dict(self) -> dict:
        return {
            "nx": self.nx,
            "ny": self.ny,
            "dx": self.dx,
            "origin": list(self.origin),
            "layout": "row-major, index = j * nx + i, j = 0 is the bottom row",
            "cell_type_names": CELL_TYPE_NAMES,
            "cell_type": self.cell_type.ravel().tolist(),
            "boundary_id": self.boundary_id.ravel().tolist(),
            "heat_source": np.round(self.heat_source, 6).ravel().tolist(),
            "co2_source": np.round(self.co2_source, 9).ravel().tolist(),
            "boundaries": self.boundaries,
            **self.extra,
            "stats": {
                "fluid_cells": int(np.count_nonzero(self.cell_type == FLUID)),
                "total_cells": self.nx * self.ny,
            },
        }


class GridTooLarge(ValueError):
    pass


def grid_shape(layout: Layout, dx: float) -> tuple[int, int, tuple[float, float]]:
    xs = [p[0] for p in layout.room.vertices]
    ys = [p[1] for p in layout.room.vertices]
    nx = math.ceil((max(xs) - min(xs)) / dx - 1e-9) + 2 * PAD
    ny = math.ceil((max(ys) - min(ys)) / dx - 1e-9) + 2 * PAD
    return nx, ny, (min(xs) - PAD * dx, min(ys) - PAD * dx)


def rasterize(layout: Layout, dx: float) -> Grid:
    nx, ny, origin = grid_shape(layout, dx)
    if nx * ny > MAX_CELLS:
        raise GridTooLarge(f"{nx}x{ny} = {nx * ny} cells exceeds the limit of {MAX_CELLS}; increase dx.")

    grid = Grid(
        nx=nx,
        ny=ny,
        dx=dx,
        origin=origin,
        cell_type=np.full((ny, nx), SOLID, dtype=np.uint8),
        boundary_id=np.full((ny, nx), -1, dtype=np.int16),
        heat_source=np.zeros((ny, nx)),
        co2_source=np.zeros((ny, nx)),
    )
    cx, cy = grid.cell_centers()
    v = layout.room.vertices
    grid.cell_type[geo.points_in_polygon(cx, cy, v)] = FLUID

    _mark_wall_items(grid, layout)
    sources = _add_sources(grid, layout, cx, cy)
    grid.extra = {
        "room_height": layout.room.height,
        "conditions": layout.conditions.model_dump(),
        "fans": [f.model_dump() for f in layout.fans],
        "sources": sources,
        "extracts": [
            {**e.model_dump(), "cells": _rect_cells(grid, cx, cy, e.x, e.y, e.width, e.depth).tolist()}
            for e in layout.extracts
        ],
    }
    return grid


def _cell_index(grid: Grid, x: float, y: float) -> tuple[int, int] | None:
    i = math.floor((x - grid.origin[0]) / grid.dx)
    j = math.floor((y - grid.origin[1]) / grid.dx)
    if 0 <= i < grid.nx and 0 <= j < grid.ny:
        return i, j
    return None


def _touches_fluid(grid: Grid, i: int, j: int) -> bool:
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ii, jj = i + di, j + dj
        if 0 <= ii < grid.nx and 0 <= jj < grid.ny and grid.cell_type[jj, ii] == FLUID:
            return True
    return False


def _mark_wall_items(grid: Grid, layout: Layout) -> None:
    """Openings and vents become boundary cells: the solid cells just outside the wall."""
    v = layout.room.vertices
    items = [("opening", op) for op in layout.openings] + [("vent", vent) for vent in layout.vents]
    for kind, item in items:
        if item.wall >= len(v):
            continue
        k = len(grid.boundaries)
        (ax, ay), (tx, ty), (nx_, ny_) = geo.wall_frame(v, item.wall)
        marked = 0
        steps = max(2, math.ceil(item.width / (grid.dx / 4)))
        for s in np.linspace(item.offset, item.offset + item.width, steps + 1)[1:-1]:
            px, py = ax + tx * s, ay + ty * s
            # Step outward until we hit a solid cell that borders the fluid.
            for depth in (0.5, 1.0, 1.5):
                idx = _cell_index(grid, px + nx_ * depth * grid.dx, py + ny_ * depth * grid.dx)
                if idx is None:
                    break
                i, j = idx
                if grid.cell_type[j, i] == FLUID:
                    continue
                if grid.boundary_id[j, i] < 0 and _touches_fluid(grid, i, j):
                    grid.cell_type[j, i] = BOUNDARY
                    grid.boundary_id[j, i] = k
                    marked += 1
                break
        info = {
            "index": k,
            "id": item.id,
            "type": kind,
            "kind": item.kind if kind == "opening" else "vent",
            "width": item.width,
            "outward_normal": [nx_, ny_],
            "cells": marked,
        }
        if kind == "opening":
            height = item.height or (2.0 if item.kind == "door" else 1.2)
            undercut = item.undercut if item.undercut is not None else (0.01 if item.kind == "door" else 0.0)
            info.update(
                open=item.open, connects_to=item.connects_to, height=min(height, layout.room.height), undercut=undercut
            )
        else:
            info.update(mode=item.mode, flow_m3h=item.flow_m3h, supply_temperature=item.supply_temperature, on=item.on)
        grid.boundaries.append(info)


def _fallback_cell(grid: Grid, x: float, y: float, mask: np.ndarray) -> np.ndarray:
    """Something smaller than a cell: use the cell containing its centre."""
    idx = _cell_index(grid, x, y)
    if idx is not None and grid.cell_type[idx[1], idx[0]] == FLUID:
        mask = np.zeros_like(mask)
        mask[idx[1], idx[0]] = True
    return mask


def _in_rect(cx, cy, x, y, width, depth):
    """Half-open [x0, x1) x [y0, y1), so a rectangle on cell edges covers exactly width / dx cells."""
    eps = 1e-9
    return (cx >= x - width / 2 - eps) & (cx < x + width / 2 - eps) & (cy >= y - depth / 2 - eps) & (cy < y + depth / 2 - eps)


def _rect_cells(grid: Grid, cx, cy, x, y, width, depth) -> np.ndarray:
    """Flat indices of the fluid cells whose centres lie in an axis-aligned rectangle."""
    mask = _in_rect(cx, cy, x, y, width, depth) & (grid.cell_type == FLUID)
    if not mask.any():
        mask = _fallback_cell(grid, x, y, mask)
    return np.flatnonzero(mask)


def _add_sources(grid: Grid, layout: Layout, cx: np.ndarray, cy: np.ndarray) -> list[dict]:
    """Everything that emits heat, CO2, vapour or fumes, with the fluid cells it covers.

    The solver gets the list (so showers and hobs can be switched while it runs); the
    summed heat/CO2 arrays are kept for the editor's mesh preview.

    Modelling choice: in this top view a person is a source region, not an obstacle
    (think of the slice at breathing height).
    """
    sources = []
    for p in layout.people:
        mask = ((cx - p.x) ** 2 + (cy - p.y) ** 2 <= p.radius**2) & (grid.cell_type == FLUID)
        if not mask.any():
            mask = _fallback_cell(grid, p.x, p.y, mask)
        cells = np.flatnonzero(mask)
        sources.append({"id": p.id, "type": "person", "x": p.x, "y": p.y, "cells": cells.tolist(), "heat_w": p.heat_w,
                        "co2_lps": p.co2_lps, "moisture_gph": p.moisture_gph, "on": True})  # fmt: skip
    for shower in layout.showers:
        cells = _rect_cells(grid, cx, cy, shower.x, shower.y, shower.width, shower.depth)
        sources.append({**shower.model_dump(), "type": "shower", "cells": cells.tolist()})
    for hob in layout.hobs:
        # A hob's hot plume rises and spreads under the ceiling - vertical transport a top view
        # does not have. Releasing its emissions over a disk around it stands in for that spreading;
        # in the hob's own few cells 2 kW would heat the air to absurd temperatures.
        mask = ((cx - hob.x) ** 2 + (cy - hob.y) ** 2 <= HOB_PLUME_RADIUS**2) & (grid.cell_type == FLUID)
        if not mask.any():
            mask = _fallback_cell(grid, hob.x, hob.y, mask)
        sources.append({**hob.model_dump(), "type": "hob", "cells": np.flatnonzero(mask).tolist()})
    for s in sources:
        n = len(s["cells"])
        if n:
            grid.heat_source.ravel()[s["cells"]] += s.get("heat_w", 0.0) / n
            grid.co2_source.ravel()[s["cells"]] += s.get("co2_lps", 0.0) / n
    return sources
