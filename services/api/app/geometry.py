"""Small 2D geometry helpers shared by validation and rasterization."""

import math

import numpy as np

Vec = tuple[float, float]


def signed_area(vertices: list[Vec]) -> float:
    """Shoelace formula. Positive for counter-clockwise polygons."""
    a = 0.0
    n = len(vertices)
    for i in range(n):
        x1, y1 = vertices[i]
        x2, y2 = vertices[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return 0.5 * a


def wall(vertices: list[Vec], i: int) -> tuple[Vec, Vec]:
    return vertices[i], vertices[(i + 1) % len(vertices)]


def wall_length(vertices: list[Vec], i: int) -> float:
    (x1, y1), (x2, y2) = wall(vertices, i)
    return math.hypot(x2 - x1, y2 - y1)


def wall_frame(vertices: list[Vec], i: int) -> tuple[Vec, Vec, Vec]:
    """Start point, unit tangent and unit *outward* normal of wall i."""
    (x1, y1), (x2, y2) = wall(vertices, i)
    length = math.hypot(x2 - x1, y2 - y1)
    tx, ty = (x2 - x1) / length, (y2 - y1) / length
    # For a CCW polygon the interior is on the left, so outward is the right-hand normal.
    sign = 1.0 if signed_area(vertices) > 0 else -1.0
    nx, ny = sign * ty, -sign * tx
    return (x1, y1), (tx, ty), (nx, ny)


def point_segment_distance(p: Vec, a: Vec, b: Vec) -> float:
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _orient(a: Vec, b: Vec, c: Vec) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_intersect(p1: Vec, p2: Vec, q1: Vec, q2: Vec) -> bool:
    """Proper or touching intersection of two closed segments."""
    d1, d2 = _orient(q1, q2, p1), _orient(q1, q2, p2)
    d3, d4 = _orient(p1, p2, q1), _orient(p1, p2, q2)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and 0 not in (d1, d2, d3, d4):
        return True

    def on_seg(a: Vec, b: Vec, c: Vec, d: float) -> bool:
        return d == 0 and min(a[0], b[0]) <= c[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= c[1] <= max(a[1], b[1])

    return on_seg(q1, q2, p1, d1) or on_seg(q1, q2, p2, d2) or on_seg(p1, p2, q1, d3) or on_seg(p1, p2, q2, d4)


def self_intersections(vertices: list[Vec]) -> list[tuple[int, int]]:
    """Pairs of non-adjacent walls that intersect. O(n^2), fine for room outlines."""
    n = len(vertices)
    hits = []
    for i in range(n):
        for j in range(i + 1, n):
            if j == i + 1 or (i == 0 and j == n - 1):
                continue  # neighbours share a vertex
            if segments_intersect(*wall(vertices, i), *wall(vertices, j)):
                hits.append((i, j))
    return hits


def points_in_polygon(px: np.ndarray, py: np.ndarray, vertices: list[Vec]) -> np.ndarray:
    """Vectorised even-odd ray casting. px, py: arrays of equal shape."""
    inside = np.zeros(px.shape, dtype=bool)
    n = len(vertices)
    for i in range(n):
        x1, y1 = vertices[i]
        x2, y2 = vertices[(i + 1) % n]
        if y1 == y2:
            continue  # horizontal edges never cross a horizontal ray
        crosses = (y1 > py) != (y2 > py)
        x_at_y = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (px < x_at_y)
    return inside


def point_in_polygon(p: Vec, vertices: list[Vec]) -> bool:
    return bool(points_in_polygon(np.array([p[0]]), np.array([p[1]]), vertices)[0])
