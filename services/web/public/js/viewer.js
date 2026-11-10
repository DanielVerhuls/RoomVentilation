// Live view: connects to the solver over a WebSocket and renders its frames.
import { api } from './api.js';
import { COLORMAPS, gradientCss, lutIndex } from './colormap.js';
import * as G from './geometry.js';
import * as M from './model.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_KEY = 'roomventilation.layout';
const FLUID = 1;
const BOUNDARY = 2;
const params = new URLSearchParams(location.search);

// What each background shows: which streamed field, colour map, and how to label it.
const BACKGROUNDS = {
  speed: { field: null, lut: 'viridis', label: '|u|  m/s', fmt: (v) => v.toFixed(2) },
  pressure: { field: 'p', lut: 'coolwarm', label: 'p  Pa', fmt: (v) => v.toPrecision(2) },
  temperature: { field: 'T', lut: 'coolwarm', label: 'T  °C', fmt: (v) => v.toFixed(1) },
  co2: { field: 'c', lut: 'inferno', label: 'CO₂  ppm', fmt: (v) => v.toFixed(0) },
  rh: { field: 'rh', lut: 'humidity', label: 'rel. humidity  %', fmt: (v) => v.toFixed(0) },
  fumes: { field: 'f', lut: 'smoke', label: 'fumes  µg/m³', fmt: (v) => v.toFixed(0) },
  none: { field: null },
};

const fieldCanvas = $('field');
const partCanvas = $('particles');
const fctx = fieldCanvas.getContext('2d');
const pctx = partCanvas.getContext('2d');

let layout = null;
let ws = null;
let meta = null; // grid description from the solver
let live = null; // live state of boundaries, fans and conditions (from the solver)
let flows = {}; // m3/h into the room per boundary id
let balance = null; // moisture / fumes budget from the solver
let frame = null; // latest frame: { h: {time, ...}, u, v, p?, T?, c? }
let paused = false;
const view = { scale: 1, ox: 0, oy: 0 };
let size = { w: 0, h: 0 };
let range = {};
let simRate = 0; // simulated seconds per wall-clock second, measured
let lastFrameWall = 0;
let fieldImage = null;
let particles = null;
const colors = {};

// ---- layout source -------------------------------------------------------------

function editorLayout() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return M.migrate(JSON.parse(raw));
  } catch {
    /* storage unavailable */
  }
  return M.defaultLayout();
}

async function loadLayout() {
  const name = $('layout-source').value;
  layout = name ? M.migrate(await api.get(name)) : editorLayout();
}

async function fillLayoutList() {
  try {
    for (const n of await api.list()) $('layout-source').add(new Option(`Server: ${n}`, n));
  } catch {
    /* api offline: only the editor layout is available */
  }
  if (params.get('layout')) $('layout-source').value = params.get('layout');
}

// ---- connection -------------------------------------------------------------------

function solverUrl() {
  if (params.get('solver')) return params.get('solver');
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // Local development without nginx: the api serves this page on :8000, the solver runs on :8001.
  if (location.port === '8000') return `${scheme}://${location.hostname}:8001/sim/ws`;
  return `${scheme}://${location.host}/sim/ws`;
}

function setStatus(text, kind = '') {
  const el = $('conn-status');
  el.textContent = text;
  el.className = `pill ${kind}`;
}

function showMessage(text) {
  const el = $('overlay-msg');
  el.textContent = text ?? '';
  el.hidden = !text;
}

const background = () => document.querySelector('input[name="bg"]:checked').value;
const wantedFields = () => ['u', 'v', BACKGROUNDS[background()].field].filter(Boolean);

async function start() {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  meta = null;
  frame = null;
  live = null;
  flows = {};
  balance = null;
  paused = false;
  $('btn-pause').textContent = 'Pause';
  try {
    await loadLayout();
  } catch (err) {
    showMessage(`Could not load layout: ${err.message}`);
    return;
  }
  setStatus('connecting…');
  showMessage('Starting simulation…');
  const sock = new WebSocket(solverUrl());
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    sock.send(
      JSON.stringify({
        layout,
        dx: +$('dx').value,
        nu: +$('nu').value,
        kappa: +$('kappa').value,
        speed: +$('speed').value,
        fields: wantedFields(),
      }),
    );
  };
  sock.onmessage = (e) => {
    if (typeof e.data === 'string') onJson(JSON.parse(e.data));
    else onFrame(e.data);
  };
  sock.onerror = () => setStatus('connection error', 'bad');
  sock.onclose = () => {
    if (ws !== sock) return;
    setStatus('disconnected', 'bad');
    if (!meta) showMessage(`Could not connect to the solver at ${solverUrl()}. Is it running?`);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onJson(msg) {
  if (msg.type === 'error') {
    setStatus('error', 'bad');
    showMessage(msg.message);
  } else if (msg.type === 'warning') {
    renderNotes([msg.message]);
  } else if (msg.type === 'meta') {
    meta = { ...msg, cell_type: Uint8Array.from(msg.cell_type), boundary_id: Int16Array.from(msg.boundary_id) };
    range = {};
    simRate = 0;
    prepareParticles();
    fitView();
    setStatus('running', 'ok');
    showMessage(null);
  } else if (msg.type === 'state') {
    live = msg;
    renderControls();
    renderNotes(msg.notes);
    drawField();
  } else if (msg.type === 'balance') {
    balance = msg;
    flows = msg.flows;
    renderFlowsInControls();
    renderBalance();
  }
}

function onFrame(buf) {
  if (!meta) return;
  const f = new Float32Array(buf);
  const H = meta.header.length;
  const n = meta.nx * meta.ny;
  const h = Object.fromEntries(meta.header.map((k, i) => [k, f[i]]));
  const fields = {};
  let offset = H;
  meta.fields.forEach((name, i) => {
    if (h.fields_mask & (1 << i)) {
      fields[name] = f.subarray(offset, offset + n);
      offset += n;
    }
  });

  const now = performance.now();
  if (frame && lastFrameWall) {
    const r = (h.time - frame.h.time) / ((now - lastFrameWall) / 1000);
    if (h.time < frame.h.time) particles?.reset(); // the simulation was reset
    else simRate = simRate ? 0.8 * simRate + 0.2 * r : r;
  }
  lastFrameWall = now;
  frame = { h, ...fields };

  updateRanges();
  fieldImage = buildFieldImage();
  drawField();
  updateStats();
}

// ---- live controls ----------------------------------------------------------------------

function update(target, id, changes) {
  send({ cmd: 'update', target, id, ...changes });
}

function controlRow(label, input, unit) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(span, input);
  const u = document.createElement('small');
  u.textContent = unit ?? '';
  wrap.append(u);
  return wrap;
}

function numberInput(value, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = step;
  input.value = +(+value).toFixed(3);
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return input;
}

function toggleButton(on, labels, onClick) {
  const b = document.createElement('button');
  b.className = `toggle ${on ? 'on' : ''}`;
  b.textContent = on ? labels[0] : labels[1];
  b.addEventListener('click', onClick);
  return b;
}

/** Readable names like "Window 2" or "Fan 1", numbered per kind in layout order. */
function displayNames() {
  const names = {};
  const count = {};
  const add = (id, kind) => {
    count[kind] = (count[kind] ?? 0) + 1;
    names[id] = `${kind} ${count[kind]}`;
  };
  for (const b of live.boundaries) add(b.id, b.type === 'vent' ? 'Vent' : b.kind === 'door' ? 'Door' : 'Window');
  for (const f of live.fans) add(f.id, 'Fan');
  for (const src of live.sources) add(src.id, src.type === 'hob' ? 'Hob' : 'Shower');
  for (const e of live.extracts) add(e.id, e.kind === 'hood' ? 'Hood' : 'Extract');
  return names;
}

function renderControls() {
  const el = $('controls');
  el.replaceChildren();
  const c = live.conditions;
  const names = displayNames();

  const h = (text) => {
    const e = document.createElement('h3');
    e.textContent = text;
    el.append(e);
  };

  h('Weather');
  el.append(
    controlRow('Wind speed', numberInput(c.wind_speed, 0.5, (v) => update('conditions', null, { wind_speed: v })), 'm/s'),
    controlRow('Wind from', numberInput(c.wind_direction, 15, (v) => update('conditions', null, { wind_direction: ((v % 360) + 360) % 360 })), '°'),
    controlRow('Outdoor temp.', numberInput(c.outdoor_temperature, 1, (v) => update('conditions', null, { outdoor_temperature: v })), '°C'),
  );

  const openings = live.boundaries.filter((b) => b.type === 'opening');
  if (openings.length) h('Doors & windows');
  for (const b of openings) {
    const row = document.createElement('div');
    row.className = 'control-row';
    row.dataset.id = b.id;
    const name = document.createElement('span');
    name.innerHTML = `${names[b.id]} <small>${b.connects_to === 'outside' ? 'to outside' : 'to indoors'}</small>`;
    const flow = document.createElement('small');
    flow.className = 'flow';
    row.append(name, flow, toggleButton(b.open, ['Open', 'Closed'], () => update('boundary', b.id, { open: !b.open })));
    el.append(row);
  }

  const vents = live.boundaries.filter((b) => b.type === 'vent');
  if (vents.length) h('Ventilation units');
  for (const b of vents) {
    const row = document.createElement('div');
    row.className = 'control-row';
    row.dataset.id = b.id;
    const name = document.createElement('span');
    name.innerHTML = `${names[b.id]} <small>${b.mode}</small>`;
    const flow = numberInput(b.flow_m3h, 10, (v) => update('boundary', b.id, { flow_m3h: Math.max(0, v) }));
    flow.title = 'Volume flow [m³/h]';
    row.append(name, flow, toggleButton(b.on, ['On', 'Off'], () => update('boundary', b.id, { on: !b.on })));
    el.append(row);
  }

  if (live.fans.length) h('Fans');
  for (const f of live.fans) {
    const row = document.createElement('div');
    row.className = 'control-row';
    const name = document.createElement('span');
    name.textContent = names[f.id];
    const swing = toggleButton(f.oscillate, ['Swinging', 'Swing'], () => update('fan', f.id, { oscillate: !f.oscillate }));
    row.append(name, swing, toggleButton(f.on, ['On', 'Off'], () => update('fan', f.id, { on: !f.on })));
    el.append(row);
    el.append(
      controlRow('  speed', numberInput(f.speed, 0.5, (v) => update('fan', f.id, { speed: Math.max(0, v) })), 'm/s'),
      controlRow('  direction', numberInput(f.angle, 15, (v) => update('fan', f.id, { angle: v })), '°'),
    );
  }

  const showers = live.sources.filter((src) => src.type === 'shower');
  const hobs = live.sources.filter((src) => src.type === 'hob');
  if (showers.length || hobs.length) h('Showers & cooking');
  for (const src of showers) {
    const row = document.createElement('div');
    row.className = 'control-row';
    const name = document.createElement('span');
    name.innerHTML = `${names[src.id]} <small>${(src.moisture_gph / 1000).toFixed(1)} kg/h steam</small>`;
    row.append(name, document.createElement('span'), toggleButton(src.on, ['Running', 'Off'], () => update('source', src.id, { on: !src.on })));
    el.append(row);
  }
  for (const src of hobs) {
    const row = document.createElement('div');
    row.className = 'control-row';
    const name = document.createElement('span');
    name.textContent = names[src.id];
    const what = document.createElement('select');
    for (const [k, preset] of Object.entries(M.HOB_PRESETS)) {
      if (k !== 'custom' || src.activity === 'custom') what.add(new Option(preset.label, k));
    }
    what.value = src.activity ?? 'custom';
    what.addEventListener('change', () => update('source', src.id, { activity: what.value, ...M.hobEmission(what.value) }));
    row.append(name, what, toggleButton(src.on, ['Cooking', 'Off'], () => update('source', src.id, { on: !src.on })));
    el.append(row);
  }

  if (live.extracts.length) h('Extract fans & hoods');
  for (const e of live.extracts) {
    const row = document.createElement('div');
    row.className = 'control-row';
    const name = document.createElement('span');
    name.textContent = names[e.id];
    const flow = numberInput(e.flow_m3h, 10, (v) => update('extract', e.id, { flow_m3h: Math.max(0, v) }));
    flow.title = 'Volume flow [m³/h]';
    row.append(name, flow, toggleButton(e.on, ['On', 'Off'], () => update('extract', e.id, { on: !e.on })));
    el.append(row);
  }
  renderFlowsInControls();
}

function renderBalance() {
  const card = $('balance-card');
  const m = balance?.moisture;
  const f = balance?.fumes;
  const anything = m && (m.emitted_gph > 0 || m.condensate_g > 0 || f.emitted_mgph > 0);
  card.hidden = !anything;
  if (!anything) return;
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
  const names = live ? displayNames() : {};
  // Air coming in also brings vapour: an extract only removes the difference.
  const viaBoundaries = sum(m.boundaries_gph);
  const rows = [
    ['Steam released', `${m.emitted_gph.toFixed(0)} g/h`],
    ['… caught by hoods', `${m.captured_gph.toFixed(0)} g/h`],
    ['… removed by extracts', `${sum(m.extracts_gph).toFixed(0)} g/h`],
    ['Vapour via doors, windows, units', `${viaBoundaries >= 0 ? 'in' : 'out'} ${Math.abs(viaBoundaries).toFixed(0)} g/h`],
    ['Condensed so far', `${m.condensate_g.toFixed(0)} g`],
  ];
  if (f.emitted_mgph > 0) {
    rows.push(
      ['Fumes released', `${f.emitted_mgph.toFixed(1)} mg/h`],
      ['… caught by hoods', `${f.captured_mgph.toFixed(1)} mg/h`],
      ['… removed by extracts', `${sum(f.extracts_mgph).toFixed(1)} mg/h`],
    );
  }
  for (const [id, eta] of Object.entries(balance.capture)) rows.push([`${names[id] ?? id} capture`, `${(eta * 100).toFixed(0)} %`]);
  for (const [id, e] of Object.entries(balance.extracts)) rows.push([`${names[id] ?? id} flow`, `${e.flow_m3h.toFixed(0)} m³/h`]);
  $('balance').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function renderFlowsInControls() {
  for (const row of document.querySelectorAll('#controls .control-row[data-id]')) {
    const q = flows[row.dataset.id];
    const el = row.querySelector('.flow');
    if (el) el.textContent = q === undefined || Math.abs(q) < 0.5 ? '' : `${q > 0 ? 'in' : 'out'} ${Math.abs(q).toFixed(0)} m³/h`;
  }
}

function renderNotes(notes) {
  const el = $('notes');
  el.replaceChildren();
  for (const n of notes ?? []) {
    const li = document.createElement('li');
    li.className = 'warning';
    li.textContent = n;
    el.append(li);
  }
}

/** Current blowing direction of a fan [deg] - the same formula the solver uses for swinging fans. */
function fanAngle(fan) {
  const t = frame?.h.time ?? 0;
  return fan.angle + (fan.oscillate ? fan.sweep * Math.sin((2 * Math.PI * t) / Math.max(fan.period, 0.5)) : 0);
}

/** Layout fan merged with its live state from the solver. */
function liveFan(fan) {
  return { sweep: 45, period: 12, ...fan, ...(live?.fans.find((f) => f.id === fan.id) ?? {}) };
}

const FAN_ARROW_PX = 28;

function fanTip(fan) {
  const ang = (fanAngle(fan) * Math.PI) / 180;
  const [x, y] = toScreen([fan.x, fan.y]);
  return [x + Math.cos(ang) * FAN_ARROW_PX, y - Math.sin(ang) * FAN_ARROW_PX];
}

/**
 * What is under a screen point: something to switch on/off (click) or a fan tip to turn (drag).
 * Returns { kind: 'toggle' | 'rotate', target, id, changes }.
 */
function itemAt(sx, sy) {
  if (!layout || !live) return null;
  const pt = [sx, sy];
  const world = toWorld(sx, sy);
  for (const fan of layout.fans ?? []) {
    if (G.dist(pt, fanTip(liveFan(fan))) <= 10) return { kind: 'rotate', target: 'fan', id: fan.id };
  }
  const inRect = (item) => M.inRect(item, world);
  const sourceHere = [...(layout.hobs ?? []), ...(layout.showers ?? [])].some(inRect);
  for (const ex of layout.extracts ?? []) {
    const s = live.extracts.find((x) => x.id === ex.id);
    if (!s || !inRect(ex)) continue;
    // A hood hangs right above its hob: inside, a click goes to the hob; on its outline, to the hood.
    const edge = 8 / view.scale;
    const onOutline = Math.abs(world[0] - ex.x) > ex.width / 2 - edge || Math.abs(world[1] - ex.y) > ex.depth / 2 - edge;
    if (!sourceHere || onOutline) return { kind: 'toggle', target: 'extract', id: ex.id, changes: { on: !s.on } };
  }
  for (const src of [...(layout.hobs ?? []), ...(layout.showers ?? [])]) {
    const s = live.sources.find((x) => x.id === src.id);
    if (s && inRect(src)) return { kind: 'toggle', target: 'source', id: src.id, changes: { on: !s.on } };
  }
  for (const fan of layout.fans ?? []) {
    const f = live.fans.find((x) => x.id === fan.id);
    if (f && G.dist(pt, toScreen([fan.x, fan.y])) <= Math.max((fan.width / 2) * view.scale, 10)) {
      return { kind: 'toggle', target: 'fan', id: fan.id, changes: { on: !f.on } };
    }
  }
  const vs = layout.room.vertices;
  for (const item of [...layout.openings, ...(layout.vents ?? [])]) {
    if (item.wall >= vs.length) continue;
    const [a, b] = G.openingEnds(vs, item).map(toScreen);
    if (G.projectOnSegment(pt, a, b).dist > 10) continue;
    const s = live.boundaries.find((x) => x.id === item.id);
    if (!s) continue;
    return { kind: 'toggle', target: 'boundary', id: item.id, changes: s.type === 'vent' ? { on: !s.on } : { open: !s.open } };
  }
  return null;
}

// ---- sampling ------------------------------------------------------------------------

function cellAt(x, y) {
  const i = Math.floor((x - meta.origin[0]) / meta.dx);
  const j = Math.floor((y - meta.origin[1]) / meta.dx);
  if (i < 0 || j < 0 || i >= meta.nx || j >= meta.ny) return -1;
  return j * meta.nx + i;
}

function isFluid(x, y) {
  const k = cellAt(x, y);
  return k >= 0 && meta.cell_type[k] === FLUID;
}

/** Bilinear interpolation of cell-centred velocity at world point (x, y). */
function velocity(x, y) {
  const { nx, ny, dx, origin } = meta;
  const fx = Math.min(Math.max((x - origin[0]) / dx - 0.5, 0), nx - 1.001);
  const fy = Math.min(Math.max((y - origin[1]) / dx - 0.5, 0), ny - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const k = j * nx + i;
  const lerp2 = (a) =>
    (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + nx] * (1 - tx) + a[k + nx + 1] * tx) * ty;
  return [lerp2(frame.u), lerp2(frame.v)];
}

// ---- view ----------------------------------------------------------------------------------

function resize() {
  const r = $('stage').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  size = { w: r.width, h: r.height };
  for (const [c, ctx] of [[fieldCanvas, fctx], [partCanvas, pctx]]) {
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  fitView();
}

function fitView() {
  if (!meta || !size.w) return;
  const w = meta.nx * meta.dx;
  const h = meta.ny * meta.dx;
  const margin = 36;
  view.scale = Math.min((size.w - 2 * margin) / w, (size.h - 2 * margin) / h);
  view.ox = size.w / 2 - (meta.origin[0] + w / 2) * view.scale;
  view.oy = size.h / 2 + (meta.origin[1] + h / 2) * view.scale;
  pctx.clearRect(0, 0, size.w, size.h);
  drawField();
}

const toScreen = ([x, y]) => [view.ox + x * view.scale, view.oy - y * view.scale];
const toWorld = (sx, sy) => [(sx - view.ox) / view.scale, (view.oy - sy) / view.scale];

function readColors() {
  const css = getComputedStyle(document.documentElement);
  for (const k of ['canvas-bg', 'room-fill', 'wall', 'window', 'door', 'person', 'inlet', 'outlet', 'text', 'text-muted', 'vent', 'fan', 'solid-cell', 'shower', 'hob', 'extract']) {
    colors[k] = css.getPropertyValue(`--${k}`).trim();
  }
}

// ---- field rendering ------------------------------------------------------------------------

function fieldRange(bg) {
  const h = frame.h;
  switch (bg) {
    case 'speed':
      return [0, Math.max(h.max_speed, 0.02)];
    case 'pressure':
      return [h.p_min, Math.max(h.p_max, h.p_min + 1e-4)];
    case 'temperature':
      return [h.t_min, Math.max(h.t_max, h.t_min + 0.2)];
    case 'co2':
      return [h.c_min, Math.max(h.c_max, h.c_min + 20)];
    case 'rh':
      return [h.rh_min, Math.max(h.rh_max, h.rh_min + 5)];
    case 'fumes':
      return [0, Math.max(h.f_max, 10)];
    default:
      return null;
  }
}

function updateRanges() {
  // Ranges grow immediately but shrink slowly, so the colours do not flicker.
  const bg = background();
  const target = fieldRange(bg);
  if (!target) return updateColorbar();
  const cur = range[bg] ?? target;
  const ease = (c, t, grow) => ((grow ? t > c : t < c) ? t : c + (t - c) * 0.05);
  range[bg] = [ease(cur[0], target[0], false), ease(cur[1], target[1], true)];
  updateColorbar();
}

function updateColorbar() {
  const bg = background();
  const cfg = BACKGROUNDS[bg];
  document.querySelector('.colorbar').hidden = bg === 'none';
  if (bg === 'none') return;
  $('colorbar-gradient').style.background = gradientCss(COLORMAPS[cfg.lut]);
  const r = range[bg];
  $('cb-min').textContent = r ? cfg.fmt(r[0]) : '';
  $('cb-label').textContent = cfg.label;
  $('cb-max').textContent = r ? cfg.fmt(r[1]) : '';
}

function buildFieldImage() {
  const bg = background();
  if (bg === 'none' || !frame || !range[bg]) return null;
  const values = bg === 'speed' ? null : frame[BACKGROUNDS[bg].field];
  if (bg !== 'speed' && !values) return null; // field not streamed yet
  const { nx, ny, cell_type } = meta;
  const img = new ImageData(nx, ny);
  const lut = COLORMAPS[BACKGROUNDS[bg].lut];
  const [lo, hi] = range[bg];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (cell_type[k] !== FLUID) continue; // stays transparent
      const val = values ? values[k] : Math.hypot(frame.u[k], frame.v[k]);
      const c = lutIndex((val - lo) / (hi - lo));
      const o = ((ny - 1 - j) * nx + i) * 4; // image rows go top-down
      img.data[o] = lut[c];
      img.data[o + 1] = lut[c + 1];
      img.data[o + 2] = lut[c + 2];
      img.data[o + 3] = 255;
    }
  }
  const off = new OffscreenCanvas(nx, ny);
  off.getContext('2d').putImageData(img, 0, 0);
  return off;
}

function drawField() {
  fctx.fillStyle = colors['canvas-bg'];
  fctx.fillRect(0, 0, size.w, size.h);
  if (!meta || !layout) return;
  const vs = layout.room.vertices;

  pathPolygon(fctx, vs);
  fctx.fillStyle = colors['room-fill'];
  fctx.fill();

  if (fieldImage) {
    // Clip to the room so the smoothed image does not bleed through the walls.
    fctx.save();
    pathPolygon(fctx, vs);
    fctx.clip();
    const [sx, sy] = toScreen([meta.origin[0], meta.origin[1] + meta.ny * meta.dx]);
    fctx.imageSmoothingEnabled = true;
    fctx.drawImage(fieldImage, sx, sy, meta.nx * meta.dx * view.scale, meta.ny * meta.dx * view.scale);
    fctx.restore();
  }
  if (frame && $('show-streamlines').checked) drawStreamlines();
  if (frame && $('show-vectors').checked) drawVectors();
  drawGeometry(vs);
}

function pathPolygon(ctx, vs) {
  ctx.beginPath();
  vs.forEach((p, k) => {
    const [x, y] = toScreen(p);
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath();
}

function segment(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function drawGeometry(vs) {
  pathPolygon(fctx, vs);
  fctx.strokeStyle = colors.wall;
  fctx.lineWidth = 4;
  fctx.stroke();
  const state = (id) => live?.boundaries.find((b) => b.id === id);
  const showFlows = $('show-flows').checked;

  for (const op of layout.openings) {
    if (op.wall >= vs.length) continue;
    const { n } = G.wallFrame(vs, op.wall);
    const [a, b] = G.openingEnds(vs, op).map(toScreen);
    const open = state(op.id)?.open ?? op.open;
    fctx.lineCap = 'butt';
    if (open) {
      // A gap in the wall, with coloured jambs.
      fctx.strokeStyle = colors['canvas-bg'];
      fctx.lineWidth = 6;
      segment(fctx, a, b);
      fctx.strokeStyle = op.kind === 'door' ? colors.door : colors.window;
      fctx.lineWidth = 2;
      for (const p of [a, b]) segment(fctx, [p[0] + n[0] * 6, p[1] - n[1] * 6], [p[0] - n[0] * 6, p[1] + n[1] * 6]);
    } else {
      fctx.strokeStyle = op.kind === 'door' ? colors.door : colors.window;
      fctx.lineWidth = 6;
      segment(fctx, a, b);
    }
    if (showFlows) flowLabel(op.id, a, b, n);
  }

  for (const vent of layout.vents ?? []) {
    if (vent.wall >= vs.length) continue;
    const { n } = G.wallFrame(vs, vent.wall);
    const [a, b] = G.openingEnds(vs, vent).map(toScreen);
    const on = state(vent.id)?.on ?? vent.on;
    fctx.strokeStyle = on ? colors.vent : colors['solid-cell'];
    fctx.lineWidth = 8;
    segment(fctx, a, b);
    if (showFlows) flowLabel(vent.id, a, b, n);
  }

  for (const fan of layout.fans ?? []) {
    const lf = liveFan(fan);
    const f = { ...lf, angle: fanAngle(lf), x: fan.x, y: fan.y, width: fan.width };
    const color = f.on ? colors.fan : colors['solid-cell'];
    fctx.beginPath();
    M.fanCorners(f).map(toScreen).forEach((q, k) => (k ? fctx.lineTo(q[0], q[1]) : fctx.moveTo(q[0], q[1])));
    fctx.closePath();
    fctx.fillStyle = color;
    fctx.fill();
    const [x, y] = toScreen([f.x, f.y]);
    const [tx, ty] = fanTip(lf);
    fctx.strokeStyle = color;
    fctx.fillStyle = color;
    fctx.lineWidth = 2;
    arrowHead(fctx, x, y, tx, ty, 6);
    // Handle to turn it (drag).
    fctx.beginPath();
    fctx.arc(tx, ty, 5, 0, Math.PI * 2);
    fctx.fillStyle = colors['canvas-bg'];
    fctx.fill();
    fctx.stroke();
  }

  const rectPath = (item) => {
    fctx.beginPath();
    M.rectCorners(item).map(toScreen).forEach((q, k) => (k ? fctx.lineTo(q[0], q[1]) : fctx.moveTo(q[0], q[1])));
    fctx.closePath();
  };
  const sourceOn = (item) => live?.sources.find((x) => x.id === item.id)?.on ?? item.on;
  for (const shower of layout.showers ?? []) {
    rectPath(shower);
    fctx.strokeStyle = colors.shower;
    fctx.lineWidth = sourceOn(shower) ? 2.5 : 1;
    fctx.setLineDash(sourceOn(shower) ? [] : [4, 3]);
    fctx.stroke();
  }
  for (const hob of layout.hobs ?? []) {
    rectPath(hob);
    fctx.strokeStyle = sourceOn(hob) ? colors.hob : colors['solid-cell'];
    fctx.lineWidth = 2.5;
    fctx.setLineDash([]);
    fctx.stroke();
  }
  for (const ex of layout.extracts ?? []) {
    const on = live?.extracts.find((x) => x.id === ex.id)?.on ?? ex.on;
    rectPath(ex);
    fctx.strokeStyle = on ? colors.extract : colors['solid-cell'];
    fctx.lineWidth = 2;
    fctx.setLineDash(ex.kind === 'hood' ? [6, 3] : []);
    fctx.stroke();
    const [a, b, c, d] = M.rectCorners(ex).map(toScreen);
    fctx.lineWidth = 1;
    fctx.setLineDash([]);
    segment(fctx, a, c);
    segment(fctx, b, d);
  }
  fctx.setLineDash([]);

  fctx.lineWidth = 2;
  fctx.strokeStyle = colors.person;
  for (const p of layout.people) {
    const [x, y] = toScreen([p.x, p.y]);
    fctx.beginPath();
    fctx.arc(x, y, p.radius * view.scale, 0, Math.PI * 2);
    fctx.stroke();
  }
}

function flowLabel(id, a, b, n) {
  const q = flows[id];
  if (q === undefined || Math.abs(q) < 0.5) return;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const text = `${q > 0 ? '↘ in' : '↗ out'} ${Math.abs(q).toFixed(0)} m³/h`;
  fctx.font = '11px system-ui, sans-serif';
  const w = fctx.measureText(text).width;
  const x = mid[0] + n[0] * (14 + (w / 2) * Math.abs(n[0]));
  const y = mid[1] - n[1] * 14;
  fctx.fillStyle = hexAlpha(colors['canvas-bg'], 0.85);
  fctx.fillRect(x - w / 2 - 3, y - 8, w + 6, 16);
  fctx.fillStyle = q > 0 ? colors.inlet : colors.outlet;
  fctx.textAlign = 'center';
  fctx.textBaseline = 'middle';
  fctx.fillText(text, x, y);
}

function overlayColor(alpha) {
  // Light strokes on top of a colour map, theme text colour on a plain background.
  return background() === 'none' ? hexAlpha(colors.text, alpha) : `rgba(255, 255, 255, ${alpha})`;
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function drawVectors() {
  const { nx, ny, dx, origin, cell_type } = meta;
  const step = Math.max(1, Math.round(26 / (dx * view.scale)));
  const maxLen = step * dx * view.scale * 0.9;
  const vmax = Math.max(frame.h.max_speed, 0.02);
  fctx.strokeStyle = overlayColor(0.85);
  fctx.fillStyle = fctx.strokeStyle;
  fctx.lineWidth = 1.2;
  for (let j = Math.floor(step / 2); j < ny; j += step) {
    for (let i = Math.floor(step / 2); i < nx; i += step) {
      const k = j * nx + i;
      if (cell_type[k] !== FLUID) continue;
      const u = frame.u[k];
      const v = frame.v[k];
      const s = Math.hypot(u, v);
      if (s < 1e-4) continue;
      const len = Math.min(1, s / vmax) * maxLen;
      const [x0, y0] = toScreen([origin[0] + (i + 0.5) * dx, origin[1] + (j + 0.5) * dx]);
      arrowHead(fctx, x0, y0, x0 + (u / s) * len, y0 - (v / s) * len, Math.min(5, len * 0.4));
    }
  }
}

function arrowHead(ctx, x0, y0, x1, y1, head) {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(ang - 0.5), y1 - head * Math.sin(ang - 0.5));
  ctx.lineTo(x1 - head * Math.cos(ang + 0.5), y1 - head * Math.sin(ang + 0.5));
  ctx.closePath();
  ctx.fill();
}

/**
 * Evenly spaced streamlines: seed on a lattice, integrate forwards and backwards
 * (RK2 along the normalised velocity), and stop a line when it runs into a cell
 * already claimed by another line.
 */
function drawStreamlines() {
  const { nx, ny, dx, origin } = meta;
  const spacing = Math.max(4 * dx, 22 / view.scale);
  const ow = Math.ceil((nx * dx) / spacing) * 2;
  const oh = Math.ceil((ny * dx) / spacing) * 2;
  const occ = new Int32Array(ow * oh);
  const occIdx = (x, y) => {
    const a = Math.floor(((x - origin[0]) / spacing) * 2);
    const b = Math.floor(((y - origin[1]) / spacing) * 2);
    return a < 0 || b < 0 || a >= ow || b >= oh ? -1 : b * ow + a;
  };
  const h = dx * 0.5;
  const minSpeed = Math.max(frame.h.max_speed, 0.02) * 0.01;

  const trace = (x, y, dir, id) => {
    const pts = [];
    for (let n = 0; n < 400; n++) {
      const [u1, v1] = velocity(x, y);
      const s1 = Math.hypot(u1, v1);
      if (s1 < minSpeed) break;
      const mx = x + (dir * h * 0.5 * u1) / s1;
      const my = y + (dir * h * 0.5 * v1) / s1;
      const [u2, v2] = velocity(mx, my);
      const s2 = Math.hypot(u2, v2) || 1;
      x += (dir * h * u2) / s2;
      y += (dir * h * v2) / s2;
      if (!isFluid(x, y)) break;
      const c = occIdx(x, y);
      if (c < 0 || (occ[c] !== 0 && occ[c] !== id)) break;
      occ[c] = id;
      pts.push([x, y]);
    }
    return pts;
  };

  fctx.strokeStyle = overlayColor(0.75);
  fctx.fillStyle = fctx.strokeStyle;
  fctx.lineWidth = 1.2;
  let id = 0;
  for (let y = origin[1] + spacing / 2; y < origin[1] + ny * dx; y += spacing) {
    for (let x = origin[0] + spacing / 2; x < origin[0] + nx * dx; x += spacing) {
      if (!isFluid(x, y)) continue;
      const c = occIdx(x, y);
      if (c < 0 || occ[c] !== 0) continue;
      id += 1;
      occ[c] = id;
      const back = trace(x, y, -1, id).reverse();
      const fwd = trace(x, y, 1, id);
      const line = [...back, [x, y], ...fwd];
      if (line.length < 6) continue;
      fctx.beginPath();
      line.forEach((p, k) => {
        const [sx, sy] = toScreen(p);
        k ? fctx.lineTo(sx, sy) : fctx.moveTo(sx, sy);
      });
      fctx.stroke();
      // Direction arrow at the seed point.
      const [ax, ay] = toScreen(line[back.length]);
      const [bx, by] = toScreen(line[Math.min(back.length + 2, line.length - 1)]);
      if (Math.hypot(bx - ax, by - ay) > 0.5) arrowHead(fctx, ax, ay, bx, by, 5);
    }
  }
}

// ---- particles -------------------------------------------------------------------------------

function prepareParticles() {
  const { nx, ny, dx, origin, cell_type } = meta;
  const fluidCells = [];
  const edgeCells = []; // fluid cells next to a door, window or unit
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (cell_type[k] !== FLUID) continue;
      fluidCells.push(k);
      if ([k - 1, k + 1, k - nx, k + nx].some((q) => cell_type[q] === BOUNDARY)) edgeCells.push(k);
    }
  }
  const area = fluidCells.length * dx * dx;
  const n = Math.min(4000, Math.max(300, Math.round(area * 80)));
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const age = new Float32Array(n);
  const life = new Float32Array(n);

  const spawn = (p) => {
    const nearEdge = edgeCells.length && Math.random() < 0.25;
    const cells = nearEdge ? edgeCells : fluidCells;
    const k = cells[Math.floor(Math.random() * cells.length)];
    x[p] = origin[0] + ((k % nx) + Math.random()) * dx;
    y[p] = origin[1] + (Math.floor(k / nx) + Math.random()) * dx;
    age[p] = 0;
    life[p] = 4 + Math.random() * 8; // wall-clock seconds
  };
  const reset = () => {
    for (let p = 0; p < n; p++) {
      spawn(p);
      age[p] = Math.random() * life[p]; // stagger respawns
    }
    pctx.clearRect(0, 0, size.w, size.h);
  };
  particles = { n, x, y, age, life, spawn, reset };
  reset();
}

let lastTick = 0;

function tick(ts) {
  requestAnimationFrame(tick);
  const wallDt = Math.min(0.05, (ts - (lastTick || ts)) / 1000);
  lastTick = ts;
  if (!particles || !frame) return;

  // Fade old trails.
  pctx.globalCompositeOperation = 'destination-out';
  pctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  pctx.fillRect(0, 0, size.w, size.h);
  pctx.globalCompositeOperation = 'source-over';
  if (!$('show-particles').checked) return;

  const dt = paused ? 0 : wallDt * simRate;
  const { n, x, y, age, life, spawn } = particles;
  pctx.strokeStyle = overlayColor(0.9);
  pctx.lineWidth = 1.3;
  pctx.beginPath();
  for (let p = 0; p < n; p++) {
    age[p] += wallDt;
    if (dt === 0) continue;
    const [u1, v1] = velocity(x[p], y[p]);
    const [u2, v2] = velocity(x[p] + 0.5 * dt * u1, y[p] + 0.5 * dt * v1);
    const xn = x[p] + dt * u2;
    const yn = y[p] + dt * v2;
    if (age[p] > life[p] || !isFluid(xn, yn)) {
      spawn(p);
      continue;
    }
    const [sx0, sy0] = toScreen([x[p], y[p]]);
    const [sx1, sy1] = toScreen([xn, yn]);
    pctx.moveTo(sx0, sy0);
    pctx.lineTo(sx1 + 0.01, sy1);
    x[p] = xn;
    y[p] = yn;
  }
  pctx.stroke();
}

// ---- stats & probe -----------------------------------------------------------------------

function updateStats() {
  const h = frame.h;
  const fluid = meta.cell_type.reduce((a, t) => a + (t === FLUID), 0);
  const dl = (rows) => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('air-stats').innerHTML = dl([
    ['Mean temperature', `${h.t_mean.toFixed(2)} °C`],
    ['Temperature range', `${h.t_min.toFixed(1)} – ${h.t_max.toFixed(1)} °C`],
    ['Mean CO₂', `${h.c_mean.toFixed(0)} ppm`],
    ['Max CO₂', `${h.c_max.toFixed(0)} ppm`],
    ['Mean humidity', `${h.rh_mean.toFixed(0)} % RH`],
    ['Max humidity', `${h.rh_max.toFixed(0)} % RH`],
    ['Fumes (mean / max)', `${h.f_mean.toFixed(0)} / ${h.f_max.toFixed(0)} µg/m³`],
    ['Air changes', `${h.ach.toFixed(1)} /h`],
    ['Well-mixed CO₂ (steady)', h.co2_steady < 0 ? '– (no fresh air)' : `${h.co2_steady.toFixed(0)} ppm`],
  ]);
  $('stats').innerHTML = dl([
    ['Simulated time', formatTime(h.time)],
    ['Real-time factor', `${simRate.toFixed(1)}×`],
    ['Solver speed', `${h.steps_per_s.toFixed(0)} steps/s`],
    ['Time step dt', `${(h.dt * 1000).toFixed(1)} ms`],
    ['max |div u|', h.max_div.toExponential(1) + ' 1/s'],
    ['max |u|', `${h.max_speed.toFixed(3)} m/s`],
    ['Grid', `${meta.nx}×${meta.ny} (${fluid.toLocaleString()} fluid)`],
  ]);
}

function formatTime(t) {
  if (t < 120) return `${t.toFixed(1)} s`;
  const m = Math.floor(t / 60);
  return `${m} min ${Math.floor(t - 60 * m)} s`;
}

// Turning a fan by dragging the tip of its arrow. The angle is sent at most every 100 ms.
let rotating = null;
let suppressClick = false;

$('stage').addEventListener('pointerdown', (e) => {
  const r = $('stage').getBoundingClientRect();
  const hit = itemAt(e.clientX - r.left, e.clientY - r.top);
  if (hit?.kind !== 'rotate') return;
  rotating = { id: hit.id, lastSent: 0 };
  $('stage').setPointerCapture(e.pointerId);
  e.preventDefault();
});

$('stage').addEventListener('pointerup', () => {
  if (!rotating) return;
  if (rotating.angle !== undefined) update('fan', rotating.id, { angle: rotating.angle });
  rotating = null;
  suppressClick = true; // the click that ends a drag is not a toggle
});

function rotateFan(sx, sy, alt) {
  const fan = layout.fans.find((f) => f.id === rotating.id);
  const lf = liveFan(fan);
  const [cx, cy] = toScreen([fan.x, fan.y]);
  const pointer = (Math.atan2(cy - sy, sx - cx) * 180) / Math.PI;
  // For a swinging fan the handle shows the current swing; move the centre of the swing with it.
  const swing = fanAngle(lf) - lf.angle;
  const deg = pointer - swing;
  const angle = (((alt ? Math.round(deg) : Math.round(deg / 15) * 15) % 360) + 360) % 360;
  rotating.angle = angle;
  const s = live.fans.find((f) => f.id === fan.id);
  if (s) s.angle = angle; // show it right away; the solver confirms with its next state
  drawField();
  const now = performance.now();
  if (now - rotating.lastSent > 100) {
    rotating.lastSent = now;
    update('fan', fan.id, { angle });
  }
}

$('stage').addEventListener('pointermove', (e) => {
  if (!meta || !frame) return;
  const r = $('stage').getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  if (rotating) return rotateFan(sx, sy, e.altKey);
  const hover = itemAt(sx, sy);
  $('stage').style.cursor = hover ? (hover.kind === 'rotate' ? 'grab' : 'pointer') : '';
  const [x, y] = toWorld(sx, sy);
  const k = cellAt(x, y);
  if (k < 0 || meta.cell_type[k] !== FLUID) {
    $('probe').textContent = `x ${x.toFixed(2)}  y ${y.toFixed(2)} m · not in the air`;
    return;
  }
  const u = frame.u[k];
  const v = frame.v[k];
  const extra = [];
  if (frame.p) extra.push(`p ${frame.p[k].toFixed(3)} Pa`);
  if (frame.T) extra.push(`T ${frame.T[k].toFixed(2)} °C`);
  if (frame.c) extra.push(`CO₂ ${frame.c[k].toFixed(0)} ppm`);
  if (frame.rh) extra.push(`RH ${frame.rh[k].toFixed(0)} %`);
  if (frame.f) extra.push(`fumes ${frame.f[k].toFixed(0)} µg/m³`);
  $('probe').innerHTML =
    `x ${x.toFixed(2)}  y ${y.toFixed(2)} m<br>` +
    `|u| ${Math.hypot(u, v).toFixed(3)} m/s  (u ${u.toFixed(3)}, v ${v.toFixed(3)})` +
    (extra.length ? `<br>${extra.join(' · ')}` : '<br><small>Pick a background to probe p, T, CO₂, humidity or fumes.</small>');
});

$('stage').addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const r = $('stage').getBoundingClientRect();
  const hit = itemAt(e.clientX - r.left, e.clientY - r.top);
  if (hit?.kind === 'toggle') update(hit.target, hit.id, hit.changes);
});

// ---- controls ----------------------------------------------------------------------------------

$('btn-start').addEventListener('click', start);
$('btn-pause').addEventListener('click', () => {
  paused = !paused;
  send({ cmd: paused ? 'pause' : 'resume' });
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
  setStatus(paused ? 'paused' : 'running', paused ? '' : 'ok');
});
$('btn-reset').addEventListener('click', () => {
  send({ cmd: 'reset' });
  range = {};
});
$('speed').addEventListener('change', (e) => send({ cmd: 'set', speed: +e.target.value }));
$('nu').addEventListener('change', (e) => send({ cmd: 'set', nu: +e.target.value }));
$('kappa').addEventListener('change', (e) => send({ cmd: 'set', kappa: +e.target.value }));
$('dx').addEventListener('change', start);
$('layout-source').addEventListener('change', start);
for (const r of document.querySelectorAll('input[name="bg"]')) {
  r.addEventListener('change', () => {
    send({ cmd: 'fields', fields: wantedFields() });
    updateColorbar();
    fieldImage = buildFieldImage();
    drawField();
  });
}
for (const id of ['show-streamlines', 'show-vectors', 'show-flows']) $(id).addEventListener('change', drawField);
$('show-particles').addEventListener('change', () => pctx.clearRect(0, 0, size.w, size.h));

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  readColors();
  drawField();
});
new ResizeObserver(resize).observe($('stage'));

readColors();
updateColorbar();
requestAnimationFrame(tick);
await fillLayoutList();
start();
