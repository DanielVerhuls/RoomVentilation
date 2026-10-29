// 2D geometry helpers. Points are [x, y] arrays in metres, y up.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const snap = (v, step) => (step > 0 ? Math.round(v / step) * step : v);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function signedArea(vs) {
  let a = 0;
  for (let i = 0; i < vs.length; i++) {
    const [x1, y1] = vs[i];
    const [x2, y2] = vs[(i + 1) % vs.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function perimeter(vs) {
  let p = 0;
  for (let i = 0; i < vs.length; i++) p += wallLength(vs, i);
  return p;
}

export const wallEnds = (vs, i) => [vs[i], vs[(i + 1) % vs.length]];
export const wallLength = (vs, i) => dist(...wallEnds(vs, i));

/** Start point, unit tangent, unit outward normal and length of wall i. */
export function wallFrame(vs, i) {
  const [a, b] = wallEnds(vs, i);
  const len = dist(a, b) || 1e-12;
  const t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const s = signedArea(vs) > 0 ? 1 : -1; // CCW: interior on the left
  return { a, b, t, n: [s * t[1], -s * t[0]], len };
}

export function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1);
  const point = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, dist: dist(p, point) };
}

export function nearestWall(p, vs) {
  let best = null;
  for (let i = 0; i < vs.length; i++) {
    const pr = projectOnSegment(p, ...wallEnds(vs, i));
    if (!best || pr.dist < best.dist) best = { index: i, ...pr };
  }
  return best;
}

export function pointInPolygon(p, vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const [xi, yi] = vs[i];
    const [xj, yj] = vs[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function openingEnds(vs, op) {
  const { a, t } = wallFrame(vs, op.wall);
  return [
    [a[0] + t[0] * op.offset, a[1] + t[1] * op.offset],
    [a[0] + t[0] * (op.offset + op.width), a[1] + t[1] * (op.offset + op.width)],
  ];
}

export function bbox(vs) {
  const xs = vs.map((p) => p[0]);
  const ys = vs.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
