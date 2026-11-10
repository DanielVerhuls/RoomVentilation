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
    groups = (
        ("openings", layout.openings),
        ("vents", layout.vents),
        ("fans", layout.fans),
        ("showers", layout.showers),
        ("hobs", layout.hobs),
        ("extracts", layout.extracts),
        ("people", layout.people),
    )
    for kind, items in groups:
        for k, item in enumerate(items):
            if item.id in seen:
                err(f"{kind}[{k}].id", f"Duplicate id '{item.id}'.")
            seen.add(item.id)

    # --- things on walls: openings and ventilation units ----------------------
    per_wall: dict[int, list[tuple[float, float, str]]] = {}
    for kind, items in (("openings", layout.openings), ("vents", layout.vents)):
        for k, item in enumerate(items):
            path = f"{kind}[{k}]"
            if item.wall >= n:
                err(path, f"Wall index {item.wall} does not exist (room has {n} walls).")
                continue
            length = geo.wall_length(v, item.wall)
            if item.offset + item.width > length + EPS:
                err(path, f"Does not fit on wall {item.wall} ({item.offset:.2f}+{item.width:.2f} m > {length:.2f} m).")
            per_wall.setdefault(item.wall, []).append((item.offset, item.offset + item.width, path))
    for w, spans in per_wall.items():
        spans.sort()
        for (a0, a1, pa), (b0, b1, pb) in zip(spans, spans[1:]):
            if b0 < a1 - EPS:
                err(pb, f"Overlaps {pa} on wall {w}.")

    # --- things placed in the room ---------------------------------------------
    placed = (("fans", layout.fans), ("showers", layout.showers), ("hobs", layout.hobs), ("extracts", layout.extracts))
    if outline_ok:
        for kind, items in placed:
            for k, item in enumerate(items):
                if not geo.point_in_polygon((item.x, item.y), v):
                    err(f"{kind}[{k}]", f"{kind[:-1].capitalize()} is outside the room.")

    # --- what drives the air? -------------------------------------------------
    open_openings = [o for o in layout.openings if o.open]
    # Paths for replacement air: open openings, and closed doors that keep a gap underneath.
    air_paths = open_openings + [o for o in layout.openings if not o.open and o.kind == "door" and o.undercut != 0]
    extract_flow = sum(e.flow_m3h for e in layout.extracts if e.on)
    supply = sum(u.flow_m3h for u in layout.vents if u.on and u.mode == "supply")
    exhaust = sum(u.flow_m3h for u in layout.vents if u.on and u.mode == "exhaust")
    fans_on = any(f.on and f.speed > 0 for f in layout.fans)
    wind = layout.conditions.wind_speed > 0 and any(o.connects_to == "outside" for o in open_openings)
    if not (supply or exhaust or fans_on or extract_flow):
        if len(open_openings) < 2:
            warn(
                "openings",
                "Fewer than two open openings and no fans or ventilation units: no net flow. (Real single-sided "
                "ventilation is driven by buoyancy and turbulence, which this 2D model does not have.)",
            )
        elif not wind:
            warn("conditions", "No wind on an open window and no fans or ventilation units: the air stays at rest.")
    if extract_flow and not air_paths and supply == 0:
        warn(
            "extracts",
            "Extract fans/hoods run, but no air can come in (closed windows, doors without a gap, no supply unit). "
            "In reality the fan only builds up under-pressure; the solver stops it. Open a window or give a door "
            "an undercut.",
        )
    for k, hob in enumerate(layout.hobs):
        covered = any(
            e.kind == "hood" and abs(hob.x - e.x) <= e.width / 2 + 0.1 and abs(hob.y - e.y) <= e.depth / 2 + 0.1
            for e in layout.extracts
        )
        if not covered:
            warn(f"hobs[{k}]", "No cooker hood above this hob: its steam and fumes all go into the room.")
    if not air_paths and abs(supply - exhaust) > 1e-9:
        warn(
            "vents",
            f"Ventilation is unbalanced (supply {supply:.0f} m³/h, exhaust {exhaust:.0f} m³/h) and no door or window is "
            "open. In an airtight room that cannot work; the solver will balance it by scaling the exhaust "
            "(or stop the units if one side is missing).",
        )

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
