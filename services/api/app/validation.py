"""Geometric / physical sanity checks that go beyond what the schema can express.

Errors make a layout unusable for the solver; warnings are things that are
legal but probably not what you want (and often have a CFD reason behind them).
"""

import math
from dataclasses import asdict, dataclass
from typing import Literal

from . import geometry as geo
from .models import Layout

MAX_EXTENT_M = 100.0
EPS = 1e-6


@dataclass
class Issue:
    level: Literal["error", "warning"]
    path: str
    message: str

    def to_dict(self) -> dict:
        return asdict(self)


def validate_layout(layout: Layout) -> list[Issue]:
    issues: list[Issue] = []
    err = lambda path, msg: issues.append(Issue("error", path, msg))  # noqa: E731
    warn = lambda path, msg: issues.append(Issue("warning", path, msg))  # noqa: E731

    v = layout.room.vertices
    n = len(v)

    # --- room outline -------------------------------------------------------
    for i in range(n):
        if geo.wall_length(v, i) < EPS:
            err(f"room.vertices[{i}]", "Duplicate consecutive vertex (zero-length wall).")
    if abs(geo.signed_area(v)) < 0.01:
        err("room.vertices", "Room area is (almost) zero.")
    for i, j in geo.self_intersections(v):
        err("room.vertices", f"Walls {i} and {j} intersect: the outline must be a simple polygon.")
    xs, ys = [p[0] for p in v], [p[1] for p in v]
    if max(xs) - min(xs) > MAX_EXTENT_M or max(ys) - min(ys) > MAX_EXTENT_M:
        err("room.vertices", f"Room is larger than {MAX_EXTENT_M:.0f} m in one direction.")
    outline_ok = not any(i.level == "error" for i in issues)

    # --- ids ----------------------------------------------------------------
    seen: set[str] = set()
    for kind, items in (("openings", layout.openings), ("people", layout.people)):
        for k, item in enumerate(items):
            if item.id in seen:
                err(f"{kind}[{k}].id", f"Duplicate id '{item.id}'.")
            seen.add(item.id)

    # --- openings -----------------------------------------------------------
    per_wall: dict[int, list[tuple[float, float, int]]] = {}
    for k, op in enumerate(layout.openings):
        path = f"openings[{k}]"
        if op.wall >= n:
            err(path, f"Wall index {op.wall} does not exist (room has {n} walls).")
            continue
        length = geo.wall_length(v, op.wall)
        if op.offset + op.width > length + EPS:
            err(path, f"Opening ({op.offset:.2f}+{op.width:.2f} m) does not fit on wall {op.wall} ({length:.2f} m).")
        per_wall.setdefault(op.wall, []).append((op.offset, op.offset + op.width, k))
    for w, spans in per_wall.items():
        spans.sort()
        for (a0, a1, ka), (b0, b1, kb) in zip(spans, spans[1:]):
            if b0 < a1 - EPS:
                err(f"openings[{kb}]", f"Overlaps openings[{ka}] on wall {w}.")

    inlets = [op for op in layout.openings if op.bc == "inlet"]
    outlets = [op for op in layout.openings if op.bc == "outlet"]
    if inlets and not outlets:
        warn(
            "openings",
            "There are inlets but no outlet. Air is (nearly) incompressible, so whatever flows in must flow out "
            "somewhere - the pressure equation has no solution without an outlet.",
        )
    if not inlets and not outlets:
        warn("openings", "No open openings: the air stays at rest and heat/CO2 only spread by diffusion.")
    if any(op.bc == "inlet" and op.velocity == 0 for op in inlets):
        warn("openings", "An inlet has zero velocity; it behaves like a wall.")

    # --- people -------------------------------------------------------------
    if outline_ok:
        for k, p in enumerate(layout.people):
            path = f"people[{k}]"
            if not geo.point_in_polygon((p.x, p.y), v):
                err(path, "Person is outside the room.")
                continue
            clearance = min(geo.point_segment_distance((p.x, p.y), *geo.wall(v, i)) for i in range(n))
            if clearance < p.radius:
                warn(path, "Person overlaps a wall.")
    for a in range(len(layout.people)):
        for b in range(a + 1, len(layout.people)):
            pa, pb = layout.people[a], layout.people[b]
            if math.hypot(pa.x - pb.x, pa.y - pb.y) < pa.radius + pb.radius:
                warn(f"people[{b}]", f"Overlaps people[{a}].")

    return issues


def has_errors(issues: list[Issue]) -> bool:
    return any(i.level == "error" for i in issues)
