"""Turn a vector layout into the uniform Cartesian grid the solver works on.

This is the "meshing" step. We use the simplest possible mesh: square cells of
size dx, and every cell is either fluid or solid depending on whether its
centre lies inside the room polygon ("staircase" / cut-cell-free immersed
boundary). Walls that are not grid-aligned therefore become jagged - a classic
trade-off you can see directly in the editor's mesh preview.

Arrays are indexed [j, i] = [y, x], j = 0 is the bottom row.
"""

import math
from dataclasses import dataclass, field

import numpy as np

from . import geometry as geo
from .models import Layout

SOLID, FLUID, INLET, OUTLET, CLOSED_OPENING = 0, 1, 2, 3, 4
CELL_TYPE_NAMES = {SOLID: "solid", FLUID: "fluid", INLET: "inlet", OUTLET: "outlet", CLOSED_OPENING: "closed_opening"}
_BC_TO_TYPE = {"inlet": INLET, "outlet": OUTLET, "closed": CLOSED_OPENING}

MAX_CELLS = 1_000_000
PAD = 2  # solid cells around the bounding box, so every wall has an "outside" cell


@dataclass
class Grid:
    nx: int
    ny: int
    dx: float
    origin: tuple[float, float]  # world position of the lower-left corner of cell [0, 0]
    cell_type: np.ndarray  # uint8 [ny, nx]
    boundary_id: np.ndarray  # int16 [ny, nx], index into layout.openings or -1
    heat_source: np.ndarray  # float [ny, nx], W per cell
    co2_source: np.ndarray  # float [ny, nx], L/s per cell
    boundaries: list[dict] = field(default_factory=list)

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

    _mark_openings(grid, layout)
    _add_people(grid, layout, cx, cy)
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


def _mark_openings(grid: Grid, layout: Layout) -> None:
    """Openings become boundary cells: the solid cells just outside the wall."""
    v = layout.room.vertices
    for k, op in enumerate(layout.openings):
        if op.wall >= len(v):
            continue
        (ax, ay), (tx, ty), (nx_, ny_) = geo.wall_frame(v, op.wall)
        cell_type = _BC_TO_TYPE[op.bc]
        marked = 0
        steps = max(2, math.ceil(op.width / (grid.dx / 4)))
        for s in np.linspace(op.offset, op.offset + op.width, steps + 1)[1:-1]:
            px, py = ax + tx * s, ay + ty * s
            # Step outward until we hit a solid cell that borders the fluid.
            for depth in (0.5, 1.0, 1.5):
                idx = _cell_index(grid, px + nx_ * depth * grid.dx, py + ny_ * depth * grid.dx)
                if idx is None:
                    break
                i, j = idx
                if grid.cell_type[j, i] == FLUID:
                    continue
                if _touches_fluid(grid, i, j):
                    if grid.boundary_id[j, i] != k:
                        marked += 1
                    grid.cell_type[j, i] = cell_type
                    grid.boundary_id[j, i] = k
                break
        grid.boundaries.append(
            {
                "index": k,
                "id": op.id,
                "kind": op.kind,
                "bc": op.bc,
                "cells": marked,
                # Velocity of air entering the room (inward normal * speed).
                "inflow_velocity": [-nx_ * op.velocity, -ny_ * op.velocity] if op.bc == "inlet" else [0.0, 0.0],
                "temperature": layout.conditions.outdoor_temperature,
                "co2_ppm": layout.conditions.outdoor_co2_ppm,
            }
        )


def _add_people(grid: Grid, layout: Layout, cx: np.ndarray, cy: np.ndarray) -> None:
    """Spread each person's heat and CO2 evenly over the fluid cells they cover.

    Modelling choice: in this top view a person is a source region, not an
    obstacle (think of the slice at breathing height). Making them solid is an
    easy experiment for later.
    """
    for p in layout.people:
        footprint = ((cx - p.x) ** 2 + (cy - p.y) ** 2 <= p.radius**2) & (grid.cell_type == FLUID)
        if not footprint.any():
            # Person smaller than a cell: put everything into the cell containing the centre.
            idx = _cell_index(grid, p.x, p.y)
            if idx is None or grid.cell_type[idx[1], idx[0]] != FLUID:
                continue
            footprint = np.zeros_like(footprint)
            footprint[idx[1], idx[0]] = True
        n = np.count_nonzero(footprint)
        grid.heat_source[footprint] += p.heat_w / n
        grid.co2_source[footprint] += p.co2_lps / n
