// Layout model helpers. The JSON shape mirrors services/api/app/models.py.
import * as G from './geometry.js';

export const SCHEMA_VERSION = 3;

// Rough per-person values (adult). CO2 in L/s, total heat in W, water vapour in g/h.
export const ACTIVITIES = {
  seated: { label: 'Seated / office', co2_lps: 0.005, heat_w: 100, moisture_gph: 50 },
  standing: { label: 'Standing / light work', co2_lps: 0.0065, heat_w: 130, moisture_gph: 70 },
  active: { label: 'Active / walking', co2_lps: 0.01, heat_w: 200, moisture_gph: 150 },
};

// Rough emission values while cooking on one hob: the heat that reaches the room air (much of the
// power goes into pan, food and evaporating water), steam, and fine particles.
export const HOB_PRESETS = {
  pasta: { label: 'Boiling pasta', heat_w: 500, moisture_gph: 1200, fumes_mgpm: 0.2 },
  potatoes: { label: 'Frying potatoes', heat_w: 1000, moisture_gph: 350, fumes_mgpm: 3 },
  custom: { label: 'Custom' },
};

export const SHOWER_DEFAULTS = { width: 0.9, depth: 0.9, moisture_gph: 2600, heat_w: 800, on: true };
export const EXTRACT_DEFAULTS = {
  ceiling: { width: 0.3, depth: 0.3, flow_m3h: 60, on: true },
  hood: { width: 0.6, depth: 0.5, flow_m3h: 400, on: true },
};

export const OPENING_DEFAULTS = {
  door: { width: 0.9, height: 2.0, open: true, undercut: 0.01, connects_to: 'indoors' },
  window: { width: 1.2, height: 1.2, open: true, undercut: 0, connects_to: 'outside' },
};

export const VENT_DEFAULTS = { width: 0.3, mode: 'supply', flow_m3h: 100, supply_temperature: 18, on: true };
export const FAN_DEFAULTS = { angle: 0, width: 0.4, speed: 2.5, on: true, oscillate: false, sweep: 45, period: 12 };

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
    conditions: {
      initial_temperature: 21,
      initial_co2_ppm: 600,
      initial_rh: 50,
      outdoor_temperature: 10,
      outdoor_co2_ppm: 420,
      outdoor_rh: 80,
      wind_speed: 2,
      wind_direction: 180,
    },
    openings: [
      { id: newId('window'), kind: 'window', wall: 0, offset: 2.4, ...OPENING_DEFAULTS.window },
      { id: newId('door'), kind: 'door', wall: 2, offset: 4.6, ...OPENING_DEFAULTS.door },
    ],
    vents: [],
    fans: [],
    showers: [],
    hobs: [],
    extracts: [],
    people: [{ id: newId('person'), x: 3, y: 2, radius: 0.25, activity: 'seated', ...personEmission('seated') }],
  };
}

/** Bring older layouts (e.g. from browser storage or an imported file) up to the current schema. */
export function migrate(layout) {
  const l = { openings: [], vents: [], fans: [], showers: [], hobs: [], extracts: [], people: [], ...layout };
  l.conditions = { ...defaultLayout().conditions, wind_speed: 0, ...l.conditions };
  if ((l.schema_version ?? 1) < 2) {
    l.openings = l.openings.map(({ bc, velocity, ...o }) => ({
      ...o,
      open: bc !== 'closed',
      connects_to: o.kind === 'door' ? 'indoors' : 'outside',
    }));
    l.schema_version = 2;
  }
  if (l.schema_version < 3) l.schema_version = 3; // v3 only added fields with defaults
  return l;
}

export function personEmission(activity) {
  const a = ACTIVITIES[activity];
  return { co2_lps: a.co2_lps, heat_w: a.heat_w, moisture_gph: a.moisture_gph };
}

export function hobEmission(activity) {
  const { label, ...values } = HOB_PRESETS[activity];
  return values;
}

export function createPerson(x, y, activity = 'seated') {
  return { id: newId('person'), x, y, radius: 0.25, activity, ...personEmission(activity) };
}

export function createFan(x, y) {
  return { id: newId('fan'), x, y, ...FAN_DEFAULTS };
}

export function createShower(x, y) {
  return { id: newId('shower'), x, y, ...SHOWER_DEFAULTS };
}

export function createHob(x, y) {
  return { id: newId('hob'), x, y, width: 0.6, depth: 0.5, activity: 'pasta', ...hobEmission('pasta'), on: true };
}

export function createExtract(x, y, kind = 'ceiling') {
  return { id: newId(kind === 'hood' ? 'hood' : 'extract'), kind, x, y, ...EXTRACT_DEFAULTS[kind] };
}

/** Corners of an axis-aligned item centred at (x, y) with width (x) and depth (y). */
export function rectCorners(item) {
  const w = item.width / 2;
  const d = item.depth / 2;
  return [[item.x - w, item.y - d], [item.x + w, item.y - d], [item.x + w, item.y + d], [item.x - w, item.y + d]];
}

export const inRect = (item, [x, y]) => Math.abs(x - item.x) <= item.width / 2 && Math.abs(y - item.y) <= item.depth / 2;

/** Is this hob under one of the cooker hoods? (Same rule as the API and solver.) */
export const hoodAbove = (layout, hob) =>
  layout.extracts.find(
    (e) => e.kind === 'hood' && Math.abs(hob.x - e.x) <= e.width / 2 + 0.1 && Math.abs(hob.y - e.y) <= e.depth / 2 + 0.1,
  );

/** New wall item (door, window or vent) centred at `center` metres along wall `wall`. */
export function createWallItem(layout, kind, wall, center) {
  const item =
    kind === 'vent'
      ? { id: newId('vent'), wall, offset: 0, ...VENT_DEFAULTS }
      : { id: newId(kind), kind, wall, offset: 0, ...OPENING_DEFAULTS[kind] };
  item.offset = center - item.width / 2;
  clampWallItem(layout.room.vertices, item);
  return item;
}

/** Openings and ventilation units: everything that sits on a wall. */
export const wallItems = (layout) => [...layout.openings, ...layout.vents];

export function clampWallItem(vs, item) {
  const len = G.wallLength(vs, item.wall);
  item.width = Math.min(item.width, len);
  item.offset = G.clamp(item.offset, 0, len - item.width);
}

export function clampAllWallItems(layout) {
  for (const item of wallItems(layout)) if (item.wall < layout.room.vertices.length) clampWallItem(layout.room.vertices, item);
}

/** Replace the outline. Wall items refer to wall indices, so they cannot survive this. */
export function setOutline(layout, vertices) {
  layout.room.vertices = vertices;
  layout.openings = [];
  layout.vents = [];
}

/** Split wall i at point p (assumed to lie on the wall), keeping wall items in place. */
export function insertVertex(layout, i, p) {
  const vs = layout.room.vertices;
  const s = G.dist(vs[i], p);
  vs.splice(i + 1, 0, p);
  const keep = (item) => {
    if (item.wall > i) item.wall += 1;
    else if (item.wall === i) {
      if (item.offset >= s) {
        item.wall = i + 1;
        item.offset -= s;
      } else if (item.offset + item.width > s) {
        return false; // the new corner would cut through it
      }
    }
    return true;
  };
  layout.openings = layout.openings.filter(keep);
  layout.vents = layout.vents.filter(keep);
}

/** Remove vertex k; wall items on the two walls touching it are dropped. */
export function removeVertex(layout, k) {
  const vs = layout.room.vertices;
  const n = vs.length;
  if (n <= 3) return false;
  const gone = new Set([(k - 1 + n) % n, k]);
  vs.splice(k, 1);
  layout.openings = layout.openings.filter((item) => !gone.has(item.wall));
  layout.vents = layout.vents.filter((item) => !gone.has(item.wall));
  // Old wall w (w > k) now starts at the vertex that moved to index w - 1.
  for (const item of wallItems(layout)) if (item.wall > k) item.wall -= 1;
  return true;
}

const COLLECTIONS = {
  opening: 'openings',
  vent: 'vents',
  fan: 'fans',
  shower: 'showers',
  hob: 'hobs',
  extract: 'extracts',
  person: 'people',
};

export function findSelected(layout, sel) {
  if (!sel) return null;
  if (sel.type in COLLECTIONS) return layout[COLLECTIONS[sel.type]].find((o) => o.id === sel.id) ?? null;
  if (sel.type === 'vertex') return layout.room.vertices[sel.index] ?? null;
  if (sel.type === 'wall') return sel.index < layout.room.vertices.length ? sel : null;
  return null;
}

export function deleteSelected(layout, sel) {
  if (sel?.type in COLLECTIONS) {
    const key = COLLECTIONS[sel.type];
    layout[key] = layout[key].filter((o) => o.id !== sel.id);
    return true;
  }
  if (sel?.type === 'vertex') return removeVertex(layout, sel.index);
  return false;
}

/** Fan footprint corners (world coordinates), for drawing and hit-testing. */
export function fanCorners(fan, depth = 0.15) {
  const a = (fan.angle * Math.PI) / 180;
  const d = [Math.cos(a), Math.sin(a)];
  const n = [-d[1], d[0]];
  const w = fan.width / 2;
  const h = depth / 2;
  return [[-h, -w], [h, -w], [h, w], [-h, w]].map(([s, t]) => [fan.x + d[0] * s + n[0] * t, fan.y + d[1] * s + n[1] * t]);
}
