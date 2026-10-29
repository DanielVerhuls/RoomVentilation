// Live view: connects to the solver over a WebSocket and renders its frames.
import { api } from './api.js';
import { COLORMAPS, gradientCss, lutIndex } from './colormap.js';
import * as G from './geometry.js';
import * as M from './model.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_KEY = 'roomventilation.layout';
const FLUID = 1;
const INLET = 2;
const params = new URLSearchParams(location.search);

const fieldCanvas = $('field');
const partCanvas = $('particles');
const fctx = fieldCanvas.getContext('2d');
const pctx = partCanvas.getContext('2d');

let layout = null;
let ws = null;
let meta = null; // grid description from the solver
let frame = null; // latest frame: { h: {time, ...}, u, v, p }
let paused = false;
let view = { scale: 1, ox: 0, oy: 0 };
let size = { w: 0, h: 0 };
let range = { speed: 0.1, pLo: 0, pHi: 0.01 };
let simRate = 0; // simulated seconds per wall-clock second, measured
let lastFrameWall = 0;
let fieldImage = null;
let particles = null;
let colors = {};

// ---- layout source -------------------------------------------------------------

function editorLayout() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return M.defaultLayout();
}

async function loadLayout() {
  const name = $('layout-source').value;
  layout = name ? await api.get(name) : editorLayout();
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

async function start() {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  meta = null;
  frame = null;
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
    sock.send(JSON.stringify({ layout, dx: +$('dx').value, nu: +$('nu').value, speed: +$('speed').value }));
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
  } else if (msg.type === 'meta') {
    meta = { ...msg, cell_type: Uint8Array.from(msg.cell_type) };
    meta.inletSpeed = Math.max(0.05, ...msg.boundaries.map((b) => Math.hypot(...b.inflow_velocity)));
    range = { speed: meta.inletSpeed, pLo: 0, pHi: 0.01 };
    simRate = 0;
    prepareParticles();
    fitView();
    setStatus('running', 'ok');
    showMessage(null);
  }
}

function onFrame(buf) {
  if (!meta) return;
  const f = new Float32Array(buf);
  const H = meta.header.length;
  const n = meta.nx * meta.ny;
  const h = Object.fromEntries(meta.header.map((k, i) => [k, f[i]]));
  const fields = Object.fromEntries(meta.fields.map((k, i) => [k, f.subarray(H + i * n, H + (i + 1) * n)]));

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
  const margin = 24;
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
  for (const k of ['canvas-bg', 'room-fill', 'wall', 'window', 'door', 'person', 'inlet', 'outlet', 'text', 'text-muted']) {
    colors[k] = css.getPropertyValue(`--${k}`).trim();
  }
}

// ---- field rendering ------------------------------------------------------------------------

const background = () => document.querySelector('input[name="bg"]:checked').value;

function updateRanges() {
  // Ranges grow immediately but shrink slowly, so the colours do not flicker.
  const grow = (cur, target) => (target > cur ? target : cur + (target - cur) * 0.05);
  const shrink = (cur, target) => (target < cur ? target : cur + (target - cur) * 0.05);
  range.speed = grow(range.speed, Math.max(frame.h.max_speed, 0.02));
  // Only pressure *differences* matter (the outlet is the 0 Pa reference), so the
  // colour scale spans the actual min..max instead of being centred on zero.
  range.pLo = shrink(range.pLo, frame.h.p_min);
  range.pHi = grow(range.pHi, Math.max(frame.h.p_max, range.pLo + 1e-4));
  updateColorbar();
}

function updateColorbar() {
  const bg = background();
  const bar = document.querySelector('.colorbar');
  bar.hidden = bg === 'none';
  if (bg === 'speed') {
    $('colorbar-gradient').style.background = gradientCss(COLORMAPS.viridis);
    $('cb-min').textContent = '0';
    $('cb-label').textContent = '|u| m/s';
    $('cb-max').textContent = range.speed.toFixed(2);
  } else if (bg === 'pressure') {
    $('colorbar-gradient').style.background = gradientCss(COLORMAPS.coolwarm);
    $('cb-min').textContent = range.pLo.toPrecision(2);
    $('cb-label').textContent = 'p  Pa';
    $('cb-max').textContent = range.pHi.toPrecision(2);
  }
}

function buildFieldImage() {
  const bg = background();
  if (bg === 'none' || !frame) return null;
  const { nx, ny, cell_type } = meta;
  const img = new ImageData(nx, ny);
  const lut = bg === 'speed' ? COLORMAPS.viridis : COLORMAPS.coolwarm;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (cell_type[k] !== FLUID) continue; // stays transparent
      const t =
        bg === 'speed'
          ? Math.hypot(frame.u[k], frame.v[k]) / range.speed
          : (frame.p[k] - range.pLo) / (range.pHi - range.pLo);
      const c = lutIndex(t);
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

function drawGeometry(vs) {
  pathPolygon(fctx, vs);
  fctx.strokeStyle = colors.wall;
  fctx.lineWidth = 4;
  fctx.stroke();
  for (const op of layout.openings) {
    if (op.wall >= vs.length) continue;
    const [a, b] = G.openingEnds(vs, op).map(toScreen);
    fctx.strokeStyle = { inlet: colors.inlet, outlet: colors.outlet }[op.bc] ?? (op.kind === 'door' ? colors.door : colors.window);
    fctx.lineWidth = 6;
    fctx.beginPath();
    fctx.moveTo(...a);
    fctx.lineTo(...b);
    fctx.stroke();
  }
  fctx.lineWidth = 2;
  fctx.strokeStyle = colors.person;
  for (const p of layout.people) {
    const [x, y] = toScreen([p.x, p.y]);
    fctx.beginPath();
    fctx.arc(x, y, p.radius * view.scale, 0, Math.PI * 2);
    fctx.stroke();
  }
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
      const len = Math.min(1, s / range.speed) * maxLen;
      const [x0, y0] = toScreen([origin[0] + (i + 0.5) * dx, origin[1] + (j + 0.5) * dx]);
      const ex = x0 + (u / s) * len;
      const ey = y0 - (v / s) * len;
      arrowHead(fctx, x0, y0, ex, ey, Math.min(5, len * 0.4));
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
  const minSpeed = range.speed * 0.01;

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
  const inletCells = []; // fluid cells right next to an inlet
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (cell_type[k] !== FLUID) continue;
      fluidCells.push(k);
      if ([k - 1, k + 1, k - nx, k + nx].some((q) => cell_type[q] === INLET)) inletCells.push(k);
    }
  }
  const area = fluidCells.length * dx * dx;
  const n = Math.min(4000, Math.max(300, Math.round(area * 80)));
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const age = new Float32Array(n);
  const life = new Float32Array(n);

  const spawn = (p) => {
    const fromInlet = inletCells.length && Math.random() < 0.3;
    const cells = fromInlet ? inletCells : fluidCells;
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
  const rows = [
    ['Simulated time', `${h.time.toFixed(1)} s`],
    ['Real-time factor', `${simRate.toFixed(1)}×`],
    ['Solver speed', `${h.steps_per_s.toFixed(0)} steps/s`],
    ['Time step dt', `${(h.dt * 1000).toFixed(1)} ms`],
    ['max |div u|', h.max_div.toExponential(1) + ' 1/s'],
    ['max |u|', `${h.max_speed.toFixed(3)} m/s`],
    ['Grid', `${meta.nx}×${meta.ny} (${fluid.toLocaleString()} fluid)`],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

$('stage').addEventListener('pointermove', (e) => {
  if (!meta || !frame) return;
  const r = $('stage').getBoundingClientRect();
  const [x, y] = toWorld(e.clientX - r.left, e.clientY - r.top);
  const k = cellAt(x, y);
  if (k < 0 || meta.cell_type[k] !== FLUID) {
    $('probe').textContent = `x ${x.toFixed(2)}  y ${y.toFixed(2)} m · not in the air`;
    return;
  }
  const u = frame.u[k];
  const v = frame.v[k];
  $('probe').innerHTML =
    `x ${x.toFixed(2)}  y ${y.toFixed(2)} m<br>` +
    `|u| ${Math.hypot(u, v).toFixed(3)} m/s  (u ${u.toFixed(3)}, v ${v.toFixed(3)})<br>` +
    `p ${frame.p[k].toFixed(4)} Pa`;
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
  range.pLo = 0;
  range.pHi = 0.01;
});
$('speed').addEventListener('change', (e) => send({ cmd: 'set', speed: +e.target.value }));
$('nu').addEventListener('change', (e) => send({ cmd: 'set', nu: +e.target.value }));
$('dx').addEventListener('change', start);
$('layout-source').addEventListener('change', start);
for (const r of document.querySelectorAll('input[name="bg"]')) {
  r.addEventListener('change', () => {
    updateColorbar();
    fieldImage = buildFieldImage();
    drawField();
  });
}
for (const id of ['show-streamlines', 'show-vectors']) $(id).addEventListener('change', drawField);
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
