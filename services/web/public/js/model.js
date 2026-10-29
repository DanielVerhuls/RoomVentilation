// Layout model helpers. The JSON shape mirrors services/api/app/models.py.
import * as G from './geometry.js';

export const SCHEMA_VERSION = 1;

// Rough per-person values (adult). CO2 in L/s, total heat in W.
export const ACTIVITIES = {
  seated: { label: 'Seated / office', co2_lps: 0.005, heat_w: 100 },
  standing: { label: 'Standing / light work', co2_lps: 0.0065, heat_w: 130 },
  active: { label: 'Active / walking', co2_lps: 0.01, heat_w: 200 },
};

export const OPENING_DEFAULTS = {
  door: { width: 0.9, bc: 'closed', velocity: 0.5 },
  window: { width: 1.2, bc: 'inlet', velocity: 0.5 },
};

export const newId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export function rectangle(x0, y0, x1, y1) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  return [[ax, ay], [bx, ay], [bx, by], [ax, by]]; // counter-clockwise
}

export function defaultLayout() {
  return {
    schema_version: SCHEMA_VERSION,
    name: 'office',
    room: { vertices: rectangle(0, 0, 6, 4), height: 2.7 },
    conditions: { initial_temperature: 21, initial_co2_ppm: 600, outdoor_temperature: 10, outdoor_co2_ppm: 420 },
    openings: [
      { id: newId('window'), kind: 'window', wall: 0, offset: 2.4, width: 1.2, bc: 'inlet', velocity: 0.5 },
      { id: newId('door'), kind: 'door', wall: 2, offset: 4.6, width: 0.9, bc: 'outlet', velocity: 0.5 },
    ],
    people: [{ id: newId('person'), x: 3, y: 2, radius: 0.25, activity: 'seated', ...personEmission('seated') }],
  };
}

export function personEmission(activity) {
  const a = ACTIVITIES[activity];
  return { co2_lps: a.co2_lps, heat_w: a.heat_w };
}

export function createPerson(x, y, activity = 'seated') {
  return { id: newId('person'), x, y, radius: 0.25, activity, ...personEmission(activity) };
}

/** New opening centred at `center` metres along wall `wall`. */
export function createOpening(layout, kind, wall, center) {
  const op = { id: newId(kind), kind, wall, offset: 0, ...OPENING_DEFAULTS[kind] };
  op.offset = center - op.width / 2;
  clampOpening(layout.room.vertices, op);
  return op;
}

export function clampOpening(vs, op) {
  const len = G.wallLength(vs, op.wall);
  op.width = Math.min(op.width, len);
  op.offset = G.clamp(op.offset, 0, len - op.width);
}

export function clampAllOpenings(layout) {
  for (const op of layout.openings) if (op.wall < layout.room.vertices.length) clampOpening(layout.room.vertices, op);
}

/** Replace the outline. Openings refer to wall indices, so they cannot survive this. */
export function setOutline(layout, vertices) {
  layout.room.vertices = vertices;
  layout.openings = [];
}

/** Split wall i at point p (assumed to lie on the wall), keeping openings in place. */
export function insertVertex(layout, i, p) {
  const vs = layout.room.vertices;
  const s = G.dist(vs[i], p);
  vs.splice(i + 1, 0, p);
  layout.openings = layout.openings.filter((op) => {
    if (op.wall > i) op.wall += 1;
    else if (op.wall === i) {
      if (op.offset >= s) {
        op.wall = i + 1;
        op.offset -= s;
      } else if (op.offset + op.width > s) {
        return false; // the new corner would cut through it
      }
    }
    return true;
  });
}

/** Remove vertex k; openings on the two walls touching it are dropped. */
export function removeVertex(layout, k) {
  const vs = layout.room.vertices;
  const n = vs.length;
  if (n <= 3) return false;
  const gone = new Set([(k - 1 + n) % n, k]);
  vs.splice(k, 1);
  layout.openings = layout.openings.filter((op) => !gone.has(op.wall));
  // Old wall w (w > k) now starts at the vertex that moved to index w - 1.
  for (const op of layout.openings) if (op.wall > k) op.wall -= 1;
  return true;
}

export function findSelected(layout, sel) {
  if (!sel) return null;
  switch (sel.type) {
    case 'opening':
      return layout.openings.find((o) => o.id === sel.id) ?? null;
    case 'person':
      return layout.people.find((p) => p.id === sel.id) ?? null;
    case 'vertex':
      return layout.room.vertices[sel.index] ?? null;
    case 'wall':
      return sel.index < layout.room.vertices.length ? sel : null;
    default:
      return null;
  }
}

export function deleteSelected(layout, sel) {
  switch (sel?.type) {
    case 'opening':
      layout.openings = layout.openings.filter((o) => o.id !== sel.id);
      return true;
    case 'person':
      layout.people = layout.people.filter((p) => p.id !== sel.id);
      return true;
    case 'vertex':
      return removeVertex(layout, sel.index);
    default:
      return false;
  }
}
