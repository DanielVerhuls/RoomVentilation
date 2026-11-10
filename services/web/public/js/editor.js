// Canvas editor: rendering, hit-testing and the drawing tools.
import * as G from './geometry.js';
import * as M from './model.js';

const HIT_PX = 8;
const WALL_SNAP_PX = 18;

export const TOOL_GROUPS = ['Room', 'Ventilation', 'Bathroom', 'Kitchen'];

export const TOOLS = {
  select: { group: 'Room', label: 'Select', key: 'v', hint: 'Drag corners, walls and anything placed in the room. Double-click a wall to add a corner. Drag the round handle of a selected fan to turn it.' },
  rect: { group: 'Room', label: 'Rectangle', key: 'r', hint: 'Drag to draw a rectangular room (replaces the outline).' },
  polygon: { group: 'Room', label: 'Polygon', key: 'p', hint: 'Click corners; click the first corner, double-click or press Enter to close. Esc cancels.' },
  door: { group: 'Room', label: 'Door', key: 'd', hint: 'Click on a wall to place a door.' },
  window: { group: 'Room', label: 'Window', key: 'w', hint: 'Click on a wall to place a window.' },
  person: { group: 'Room', label: 'Person', key: 'h', hint: 'Click inside the room to place a person.' },
  vent: { group: 'Ventilation', label: 'Vent unit', key: 'u', hint: 'Click on a wall to place a ventilation unit (supply or exhaust).' },
  fan: { group: 'Ventilation', label: 'Fan', key: 'n', hint: 'Click inside the room to place a free-standing fan. Select it and drag its round handle to turn it.' },
  shower: { group: 'Bathroom', label: 'Shower', key: 's', hint: 'Click inside the room to place a shower (a source of steam and heat).' },
  extract: { group: 'Bathroom', label: 'Extract fan', key: 'e', hint: 'Click to place a ceiling / wall extract fan, as in a bathroom.' },
  hob: { group: 'Kitchen', label: 'Hob', key: 'k', hint: 'Click inside the room to place a hob. Choose what is cooking in the properties.' },
  hood: { group: 'Kitchen', label: 'Cooker hood', key: 'o', hint: 'Click above a hob to place a cooker hood (or use "Add hood above" on a selected hob).' },
};

/** Things placed in the room that are axis-aligned rectangles, topmost first. */
const RECT_TYPES = [['extract', 'extracts'], ['hob', 'hobs'], ['shower', 'showers']];
const CREATE_IN_ROOM = {
  fan: M.createFan,
  shower: M.createShower,
  hob: M.createHob,
  extract: (x, y) => M.createExtract(x, y, 'ceiling'),
  hood: (x, y) => M.createExtract(x, y, 'hood'),
};
const IN_ROOM_COLLECTION = { fan: 'fans', shower: 'showers', hob: 'hobs', extract: 'extracts', hood: 'extracts' };
const SELECTION_TYPE = { hood: 'extract' }; // tool -> type of the object it creates, where they differ
const FAN_HANDLE_PX = 9;

const WALL_TOOLS = new Set(['door', 'window', 'vent']);
/** The layout collection a selection type lives in. */
const WALL_COLLECTION = { opening: 'openings', vent: 'vents' };

export class Editor {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.store = store;
    this.view = { scale: 80, ox: 0, oy: 0 };
    this.tool = 'select';
    this.snapStep = 0.1;
    this.mesh = null;
    this.meshImage = null;
    this.showMesh = false;
    this.drag = null;
    this.draft = null;
    this.hover = null;
    this.mouse = null;
    this.spaceDown = false;
    this.onCursor = () => {};
    this.onToolChange = () => {};
    this.readColors();

    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    canvas.addEventListener('dblclick', (e) => this.doubleClick(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag pans
    canvas.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.hover = null;
      this.onCursor(null);
      this.render();
    });
    new ResizeObserver(() => this.resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.readColors();
      this.render();
    });
    store.subscribe(() => this.render());
  }

  // ---- view -----------------------------------------------------------------

  readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(`--${name}`).trim();
    this.colors = Object.fromEntries(
      ['canvas-bg', 'grid-minor', 'grid-major', 'room-fill', 'wall', 'window', 'door', 'person', 'inlet', 'outlet',
        'select', 'hover', 'text-muted', 'solid-cell', 'heat', 'vent', 'fan', 'shower', 'hob', 'extract'].map((k) => [k, v(k)]),
    );
    if (this.mesh) this.meshImage = this.buildMeshImage(this.mesh);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const first = !this.width;
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (first) this.fitView();
    else this.render();
  }

  fitView() {
    if (!this.width) return;
    const b = G.bbox(this.store.layout.room.vertices);
    const margin = 70;
    const w = Math.max(b.x1 - b.x0, 1);
    const h = Math.max(b.y1 - b.y0, 1);
    this.view.scale = Math.max(5, Math.min((this.width - 2 * margin) / w, (this.height - 2 * margin) / h));
    this.view.ox = this.width / 2 - ((b.x0 + b.x1) / 2) * this.view.scale;
    this.view.oy = this.height / 2 + ((b.y0 + b.y1) / 2) * this.view.scale;
    this.render();
  }

  zoom(factor, sx = this.width / 2, sy = this.height / 2) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.view.scale = G.clamp(this.view.scale * factor, 5, 2000);
    this.view.ox = sx - wx * this.view.scale;
    this.view.oy = sy + wy * this.view.scale;
    this.render();
  }

  toScreen([x, y]) {
    return [this.view.ox + x * this.view.scale, this.view.oy - y * this.view.scale];
  }

  toWorld(sx, sy) {
    return [(sx - this.view.ox) / this.view.scale, (this.view.oy - sy) / this.view.scale];
  }

  snapped(p, e) {
    if (e?.altKey) return p; // hold Alt for free placement
    const s = this.snapStep;
    return [+G.snap(p[0], s).toFixed(4), +G.snap(p[1], s).toFixed(4)];
  }

  setTool(tool) {
    this.tool = tool;
    this.draft = null;
    this.drag = null;
    this.canvas.dataset.tool = tool;
    this.onToolChange(tool);
    this.render();
  }

  setMesh(mesh) {
    this.mesh = mesh;
    this.meshImage = mesh ? this.buildMeshImage(mesh) : null;
    this.render();
  }

  // ---- hit testing ----------------------------------------------------------

  hitTest(sx, sy) {
    const L = this.store.layout;
    const vs = L.room.vertices;
    const s = this.view.scale;
    const p = [sx, sy];

    const sel = this.store.selection;
    const selectedFan = sel?.type === 'fan' && M.findSelected(L, sel);
    if (selectedFan && G.dist(p, this.fanHandle(selectedFan)) <= FAN_HANDLE_PX) return { type: 'fan-rotate', id: selectedFan.id };

    for (let k = L.people.length - 1; k >= 0; k--) {
      const person = L.people[k];
      if (G.dist(p, this.toScreen([person.x, person.y])) <= person.radius * s + 4) return { type: 'person', id: person.id };
    }
    const world = this.toWorld(sx, sy);
    for (const [type, key] of RECT_TYPES) {
      for (let k = L[key].length - 1; k >= 0; k--) {
        if (M.inRect(L[key][k], world)) return { type, id: L[key][k].id };
      }
    }
    for (let k = L.fans.length - 1; k >= 0; k--) {
      const fan = L.fans[k];
      if (G.dist(p, this.toScreen([fan.x, fan.y])) <= Math.max((fan.width / 2) * s, 8)) return { type: 'fan', id: fan.id };
    }
    for (const [type, key] of Object.entries(WALL_COLLECTION)) {
      for (const item of L[key]) {
        if (item.wall >= vs.length) continue;
        const [a, b] = G.openingEnds(vs, item).map((q) => this.toScreen(q));
        if (G.projectOnSegment(p, a, b).dist <= HIT_PX) return { type, id: item.id };
      }
    }
    for (let i = 0; i < vs.length; i++) {
      if (G.dist(p, this.toScreen(vs[i])) <= HIT_PX) return { type: 'vertex', index: i };
    }
    for (let i = 0; i < vs.length; i++) {
      const [a, b] = G.wallEnds(vs, i).map((q) => this.toScreen(q));
      if (G.projectOnSegment(p, a, b).dist <= HIT_PX - 2) return { type: 'wall', index: i };
    }
    return null;
  }

  /** Nearest wall to a world point, if within WALL_SNAP_PX on screen. */
  wallNear(world) {
    const nw = G.nearestWall(world, this.store.layout.room.vertices);
    return nw && nw.dist * this.view.scale <= WALL_SNAP_PX ? nw : null;
  }

  // ---- input ----------------------------------------------------------------

  pointerDown(e) {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not a real pointer (e.g. a synthetic event): dragging still works inside the canvas */
    }
    const sx = e.offsetX;
    const sy = e.offsetY;
    const world = this.toWorld(sx, sy);
    const L = this.store.layout;

    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.drag = { kind: 'pan', sx, sy, ox: this.view.ox, oy: this.view.oy };
      return;
    }
    if (e.button !== 0) return;

    switch (this.tool) {
      case 'select': {
        const hit = this.hitTest(sx, sy);
        this.store.select(hit?.type === 'fan-rotate' ? { type: 'fan', id: hit.id } : hit);
        if (!hit) {
          this.drag = { kind: 'pan', sx, sy, ox: this.view.ox, oy: this.view.oy };
          return;
        }
        this.store.begin();
        this.drag = { kind: hit.type, hit, start: world, orig: structuredClone(L.room.vertices) };
        if (hit.type in WALL_COLLECTION) {
          const op = M.findSelected(L, hit);
          const [a, b] = G.openingEnds(L.room.vertices, op);
          // Remember where on the opening we grabbed it, so it does not jump.
          this.drag.grab = G.dist(a, G.projectOnSegment(world, a, b).point);
        }
        break;
      }
      case 'rect': {
        const a = this.snapped(world, e);
        this.draft = { kind: 'rect', a, b: a };
        this.drag = { kind: 'rect' };
        break;
      }
      case 'polygon': {
        const p = this.snapped(world, e);
        this.draft ??= { kind: 'polygon', points: [] };
        const pts = this.draft.points;
        if (pts.length >= 3 && G.dist(this.toScreen(pts[0]), [sx, sy]) <= HIT_PX + 2) {
          this.closePolygon();
        } else if (!pts.length || G.dist(pts[pts.length - 1], p) > 1e-9) {
          pts.push(p);
        }
        break;
      }
      case 'door':
      case 'window':
      case 'vent': {
        const nw = this.wallNear(world);
        if (!nw) break;
        const len = G.wallLength(L.room.vertices, nw.index);
        const center = G.snap(nw.t * len, this.snapStep / 2);
        const type = this.tool === 'vent' ? 'vent' : 'opening';
        let item;
        this.store.update((l) => {
          item = M.createWallItem(l, this.tool, nw.index, center);
          l[WALL_COLLECTION[type]].push(item);
        });
        this.store.select({ type, id: item.id });
        break;
      }
      case 'fan':
      case 'shower':
      case 'hob':
      case 'extract':
      case 'hood': {
        const p = this.snapped(world, e);
        if (!G.pointInPolygon(p, L.room.vertices)) break;
        const item = CREATE_IN_ROOM[this.tool](p[0], p[1]);
        this.store.update((l) => l[IN_ROOM_COLLECTION[this.tool]].push(item));
        this.store.select({ type: SELECTION_TYPE[this.tool] ?? this.tool, id: item.id });
        break;
      }
      case 'person': {
        const p = this.snapped(world, e);
        if (!G.pointInPolygon(p, L.room.vertices)) break;
        const person = M.createPerson(p[0], p[1]);
        this.store.update((l) => l.people.push(person));
        this.store.select({ type: 'person', id: person.id });
        break;
      }
    }
    this.render();
  }

  pointerMove(e) {
    const sx = e.offsetX;
    const sy = e.offsetY;
    const world = this.toWorld(sx, sy);
    this.mouse = { sx, sy, world, snapped: this.snapped(world, e) };
    this.onCursor(world);

    const d = this.drag;
    if (!d) {
      this.hover = this.tool === 'select' ? this.hitTest(sx, sy) : null;
      this.render();
      return;
    }

    const p = this.snapped(world, e);
    switch (d.kind) {
      case 'pan':
        this.view.ox = d.ox + (sx - d.sx);
        this.view.oy = d.oy + (sy - d.sy);
        this.render();
        break;
      case 'rect':
        this.draft.b = p;
        this.render();
        break;
      case 'vertex':
        this.store.live((l) => {
          l.room.vertices[d.hit.index] = p;
          M.clampAllWallItems(l);
        });
        break;
      case 'wall':
        this.store.live((l) => {
          // Move the wall along its normal only, so rectangles stay rectangles.
          const { n } = G.wallFrame(d.orig, d.hit.index);
          const off = (world[0] - d.start[0]) * n[0] + (world[1] - d.start[1]) * n[1];
          const dn = e.altKey ? off : G.snap(off, this.snapStep);
          const i = d.hit.index;
          const j = (i + 1) % d.orig.length;
          for (const k of [i, j]) {
            l.room.vertices[k] = [+(d.orig[k][0] + n[0] * dn).toFixed(4), +(d.orig[k][1] + n[1] * dn).toFixed(4)];
          }
          M.clampAllWallItems(l);
        });
        break;
      case 'opening':
      case 'vent':
        this.store.live((l) => {
          const op = M.findSelected(l, d.hit);
          const nw = G.nearestWall(world, l.room.vertices);
          op.wall = nw.index;
          const along = nw.t * G.wallLength(l.room.vertices, nw.index);
          op.offset = e.altKey ? along - d.grab : G.snap(along - d.grab, this.snapStep / 2);
          M.clampWallItem(l.room.vertices, op);
          op.offset = +op.offset.toFixed(4);
        });
        break;
      case 'fan-rotate':
        this.store.live((l) => {
          const fan = l.fans.find((f) => f.id === d.hit.id);
          const deg = (Math.atan2(world[1] - fan.y, world[0] - fan.x) * 180) / Math.PI;
          fan.angle = ((e.altKey ? Math.round(deg) : G.snap(deg, 15)) + 360) % 360; // Alt: 1° steps
        });
        break;
      case 'person':
      case 'fan':
      case 'shower':
      case 'hob':
      case 'extract':
        this.store.live((l) => {
          const obj = M.findSelected(l, d.hit);
          [obj.x, obj.y] = p;
        });
        break;
    }
  }

  pointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'rect') {
      const { a, b } = this.draft;
      this.draft = null;
      if (Math.abs(a[0] - b[0]) >= 0.2 && Math.abs(a[1] - b[1]) >= 0.2) {
        this.store.update((l) => {
          M.setOutline(l, M.rectangle(a[0], a[1], b[0], b[1]));
        });
        this.store.select(null);
      }
      this.render();
    } else if (d.kind !== 'pan') {
      this.store.end();
    }
  }

  doubleClick(e) {
    if (this.tool === 'polygon') {
      // The two clicks of the double-click already added a (duplicate) point.
      this.closePolygon();
      return;
    }
    if (this.tool !== 'select') return;
    const hit = this.hitTest(e.offsetX, e.offsetY);
    if (hit?.type !== 'wall') return;
    const vs = this.store.layout.room.vertices;
    const pr = G.projectOnSegment(this.toWorld(e.offsetX, e.offsetY), ...G.wallEnds(vs, hit.index));
    const p = pr.point.map((c) => +c.toFixed(4));
    this.store.update((l) => M.insertVertex(l, hit.index, p));
    this.store.select({ type: 'vertex', index: hit.index + 1 });
  }

  closePolygon() {
    const pts = this.draft?.points ?? [];
    this.draft = null;
    // Drop consecutive duplicates (double-click adds one).
    const clean = pts.filter((p, k) => k === 0 || G.dist(p, pts[k - 1]) > 1e-9);
    if (clean.length >= 3 && Math.abs(G.signedArea(clean)) > 0.05) {
      const ccw = G.signedArea(clean) > 0 ? clean : clean.reverse();
      this.store.update((l) => M.setOutline(l, ccw));
      this.store.select(null);
    }
    this.render();
  }

  cancel() {
    if (this.draft) this.draft = null;
    else this.store.select(null);
    this.render();
  }

  wheel(e) {
    e.preventDefault();
    this.zoom(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
  }

  // ---- rendering ------------------------------------------------------------

  render() {
    if (!this.width) return;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.draw();
    });
  }

  draw() {
    const { ctx } = this;
    const c = this.colors;
    const L = this.store.layout;
    ctx.fillStyle = c['canvas-bg'];
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawGrid();

    const vs = L.room.vertices;
    this.pathPolygon(vs);
    ctx.fillStyle = c['room-fill'];
    ctx.fill();

    if (this.showMesh && this.meshImage) this.drawMesh();

    this.pathPolygon(vs);
    ctx.lineWidth = 5;
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = c.wall;
    ctx.stroke();

    for (const op of L.openings) if (op.wall < vs.length) this.drawOpening(op);
    for (const vent of L.vents) if (vent.wall < vs.length) this.drawVent(vent);
    for (const person of L.people) this.drawPerson(person);
    for (const shower of L.showers) this.drawShower(shower);
    for (const hob of L.hobs) this.drawHob(hob);
    for (const fan of L.fans) this.drawFan(fan);
    for (const ex of L.extracts) this.drawExtract(ex);
    this.drawDimensions(vs);
    if (this.tool === 'select') this.drawVertices(vs);
    this.drawHighlight(this.hover, c.hover);
    this.drawHighlight(this.store.selection, c.select);
    this.drawDraft();
    this.drawToolPreview();
  }

  pathPolygon(vs) {
    const { ctx } = this;
    ctx.beginPath();
    vs.forEach((p, k) => {
      const [x, y] = this.toScreen(p);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
  }

  drawGrid() {
    const { ctx } = this;
    const s = this.view.scale;
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10].find((v) => v * s >= 18) ?? 10;
    const major = step < 1 ? 1 : step * 5;
    const [x0, y1] = this.toWorld(0, 0);
    const [x1, y0] = this.toWorld(this.width, this.height);
    ctx.lineWidth = 1;
    for (const [st, color] of [[step, this.colors['grid-minor']], [major, this.colors['grid-major']]]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let x = Math.ceil(x0 / st) * st; x <= x1; x += st) {
        const sx = Math.round(this.toScreen([x, 0])[0]) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, this.height);
      }
      for (let y = Math.ceil(y0 / st) * st; y <= y1; y += st) {
        const sy = Math.round(this.toScreen([0, y])[1]) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(this.width, sy);
      }
      ctx.stroke();
    }
  }

  buildMeshImage(mesh) {
    const { nx, ny } = mesh;
    const img = new ImageData(nx, ny);
    const rgba = (css, a) => {
      const m = css.match(/^#([0-9a-f]{6})$/i);
      if (!m) return [128, 128, 128, a];
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
    };
    const solid = rgba(this.colors['solid-cell'], 150);
    const fluid = [0, 0, 0, 0];
    const heat = rgba(this.colors.heat, 170);
    // Boundary cells are coloured by what they are: open opening, closed opening, ventilation unit.
    const boundaryColor = mesh.boundaries.map((b) =>
      b.type === 'vent' ? rgba(this.colors.vent, 230) : b.open ? rgba(this.colors.inlet, 230) : rgba(this.colors.window, 200),
    );
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const t = mesh.cell_type[k];
        const col = mesh.heat_source[k] > 0 ? heat : t === 1 ? fluid : t === 2 ? boundaryColor[mesh.boundary_id[k]] : solid;
        img.data.set(col, ((ny - 1 - j) * nx + i) * 4); // image rows go top-down
      }
    }
    const off = new OffscreenCanvas(nx, ny);
    off.getContext('2d').putImageData(img, 0, 0);
    return off;
  }

  drawMesh() {
    const { ctx } = this;
    const m = this.mesh;
    const [sx0, sy1] = this.toScreen([m.origin[0], m.origin[1] + m.ny * m.dx]);
    const w = m.nx * m.dx * this.view.scale;
    const h = m.ny * m.dx * this.view.scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.meshImage, sx0, sy1, w, h);

    const cellPx = m.dx * this.view.scale;
    if (cellPx >= 6) {
      ctx.strokeStyle = this.colors['grid-major'];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= m.nx; i++) {
        const x = sx0 + i * cellPx;
        ctx.moveTo(x, sy1);
        ctx.lineTo(x, sy1 + h);
      }
      for (let j = 0; j <= m.ny; j++) {
        const y = sy1 + j * cellPx;
        ctx.moveTo(sx0, y);
        ctx.lineTo(sx0 + w, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawOpening(op) {
    const { ctx } = this;
    const c = this.colors;
    const vs = this.store.layout.room.vertices;
    const { n } = G.wallFrame(vs, op.wall);
    const [a, b] = G.openingEnds(vs, op).map((q) => this.toScreen(q));
    const ns = [n[0], -n[1]]; // outward normal in screen coordinates
    const s = this.view.scale;

    // Cut the wall.
    ctx.lineCap = 'butt';
    ctx.strokeStyle = c['room-fill'];
    ctx.lineWidth = 7;
    line(ctx, a, b);

    if (op.kind === 'window') {
      // Frame lines; a closed window also shows its pane.
      ctx.strokeStyle = c.window;
      ctx.lineWidth = 1.5;
      for (const k of [-2.5, 2.5]) line(ctx, [a[0] + ns[0] * k, a[1] + ns[1] * k], [b[0] + ns[0] * k, b[1] + ns[1] * k]);
      if (!op.open) {
        ctx.lineWidth = 2.5;
        line(ctx, a, b);
      }
    } else if (!op.open) {
      ctx.strokeStyle = c.door;
      ctx.lineWidth = 4;
      line(ctx, a, b);
    } else {
      // Open door: leaf swung into the room, hinged at the start.
      const r = op.width * s;
      const leaf = [a[0] - ns[0] * r, a[1] - ns[1] * r];
      ctx.strokeStyle = c.door;
      ctx.lineWidth = 2;
      line(ctx, a, leaf);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      const angB = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const angL = Math.atan2(leaf[1] - a[1], leaf[0] - a[0]);
      ctx.arc(a[0], a[1], r, angB, angL, normAngle(angL - angB) < 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Openings to the outside get a small tick on the outer side, to tell them from indoor doors.
    if (op.connects_to === 'outside') {
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      ctx.strokeStyle = c['text-muted'];
      ctx.lineWidth = 1;
      line(ctx, [mid[0] + ns[0] * 6, mid[1] + ns[1] * 6], [mid[0] + ns[0] * 12, mid[1] + ns[1] * 12]);
    }
  }

  drawVent(vent) {
    const { ctx } = this;
    const c = this.colors;
    const vs = this.store.layout.room.vertices;
    const { n } = G.wallFrame(vs, vent.wall);
    const [a, b] = G.openingEnds(vs, vent).map((q) => this.toScreen(q));
    const ns = [n[0], -n[1]];
    const color = vent.on ? c.vent : c['solid-cell'];
    // A small box straddling the wall, with an arrow for the air direction.
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const [q, k] of [[a, -5], [b, -5], [b, 5], [a, 5]]) ctx.lineTo(q[0] + ns[0] * k, q[1] + ns[1] * k);
    ctx.closePath();
    ctx.fill();
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const outside = [mid[0] + ns[0] * 6, mid[1] + ns[1] * 6];
    const inside = [mid[0] - ns[0] * 22, mid[1] - ns[1] * 22];
    if (vent.mode === 'supply') arrow(ctx, outside, inside, color);
    else arrow(ctx, inside, outside, color);
  }

  pathRect(item) {
    const { ctx } = this;
    ctx.beginPath();
    M.rectCorners(item).forEach((q, k) => {
      const [x, y] = this.toScreen(q);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
  }

  drawShower(shower) {
    const { ctx } = this;
    const color = this.colors.shower;
    this.pathRect(shower);
    ctx.fillStyle = color + (shower.on ? '44' : '1a');
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // A few drops.
    const [cx, cy] = this.toScreen([shower.x, shower.y]);
    const r = Math.min(shower.width, shower.depth) * this.view.scale * 0.3;
    ctx.fillStyle = color;
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawHob(hob) {
    const { ctx } = this;
    this.pathRect(hob);
    ctx.fillStyle = this.colors.wall + 'cc';
    ctx.fill();
    // Four burners, glowing while it cooks.
    const r = Math.min(hob.width, hob.depth) * 0.18 * this.view.scale;
    ctx.strokeStyle = hob.on ? this.colors.hob : this.colors['solid-cell'];
    ctx.lineWidth = 2;
    for (const [fx, fy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
      const [x, y] = this.toScreen([hob.x + fx * hob.width, hob.y + fy * hob.depth]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawExtract(ex) {
    const { ctx } = this;
    const color = ex.on ? this.colors.extract : this.colors['solid-cell'];
    this.pathRect(ex);
    ctx.setLineDash(ex.kind === 'hood' ? [6, 3] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    // Crossed like a grille; a hood is drawn dashed because it hangs above the hob.
    const [a, b, c, d] = M.rectCorners(ex).map((q) => this.toScreen(q));
    ctx.lineWidth = 1;
    line(ctx, a, c);
    line(ctx, b, d);
  }

  drawFan(fan) {
    const { ctx } = this;
    const color = fan.on ? this.colors.fan : this.colors['solid-cell'];
    const corners = M.fanCorners(fan).map((q) => this.toScreen(q));
    ctx.beginPath();
    corners.forEach((q, k) => (k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    ctx.closePath();
    ctx.fillStyle = color + '66';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Blowing direction, and the range it sweeps when it swings.
    const from = this.toScreen([fan.x, fan.y]);
    const len = this.fanArrowLength();
    if (fan.oscillate) {
      const a0 = -((fan.angle + fan.sweep) * Math.PI) / 180;
      const a1 = -((fan.angle - fan.sweep) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.arc(from[0], from[1], len, a0, a1);
      ctx.closePath();
      ctx.fillStyle = color + '22';
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const tip = this.fanHandle(fan);
    arrow(ctx, from, tip, color);
    const sel = this.store.selection;
    if (sel?.type === 'fan' && sel.id === fan.id) {
      // Rotation handle.
      ctx.beginPath();
      ctx.arc(tip[0], tip[1], 6, 0, Math.PI * 2);
      ctx.fillStyle = this.colors['canvas-bg'];
      ctx.fill();
      ctx.strokeStyle = this.colors.select;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  fanArrowLength() {
    return Math.max(0.5 * this.view.scale, 28);
  }

  /** Screen position of the tip of a fan's arrow - also its rotation handle. */
  fanHandle(fan) {
    const ang = (fan.angle * Math.PI) / 180;
    const [x, y] = this.toScreen([fan.x, fan.y]);
    const len = this.fanArrowLength();
    return [x + Math.cos(ang) * len, y - Math.sin(ang) * len];
  }

  drawPerson(person) {
    const { ctx } = this;
    const [x, y] = this.toScreen([person.x, person.y]);
    const r = person.radius * this.view.scale;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.person + '55';
    ctx.fill();
    ctx.strokeStyle = this.colors.person;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, r * 0.35), 0, Math.PI * 2);
    ctx.fillStyle = this.colors.person;
    ctx.fill();
  }

  drawDimensions(vs) {
    const { ctx } = this;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = this.colors['text-muted'];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < vs.length; i++) {
      const { a, b, n, len } = G.wallFrame(vs, i);
      if (len * this.view.scale < 40) continue;
      const [mx, my] = this.toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      const text = `${len.toFixed(2)} m`;
      // Clear the wall and the opening / unit markers.
      const off = 28 + (ctx.measureText(text).width / 2) * Math.abs(n[0]);
      ctx.fillText(text, mx + n[0] * off, my - n[1] * off);
    }
  }

  drawVertices(vs) {
    const { ctx } = this;
    ctx.fillStyle = this.colors['canvas-bg'];
    ctx.strokeStyle = this.colors.wall;
    ctx.lineWidth = 1.5;
    for (const p of vs) {
      const [x, y] = this.toScreen(p);
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeRect(x - 4, y - 4, 8, 8);
    }
  }

  drawHighlight(sel, color) {
    const L = this.store.layout;
    const obj = M.findSelected(L, sel);
    if (!obj) return;
    const { ctx } = this;
    const vs = L.room.vertices;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    switch (sel.type) {
      case 'vertex': {
        const [x, y] = this.toScreen(obj);
        ctx.strokeRect(x - 7, y - 7, 14, 14);
        break;
      }
      case 'wall':
        line(ctx, ...G.wallEnds(vs, sel.index).map((q) => this.toScreen(q)));
        break;
      case 'opening':
      case 'vent':
        ctx.lineWidth = 12;
        ctx.globalAlpha = 0.45;
        line(ctx, ...G.openingEnds(vs, obj).map((q) => this.toScreen(q)));
        ctx.globalAlpha = 1;
        break;
      case 'fan': {
        const [x, y] = this.toScreen([obj.x, obj.y]);
        ctx.beginPath();
        ctx.arc(x, y, Math.max((obj.width / 2) * this.view.scale, 8) + 5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'shower':
      case 'hob':
      case 'extract':
        this.pathRect({ ...obj, width: obj.width + 10 / this.view.scale, depth: obj.depth + 10 / this.view.scale });
        ctx.stroke();
        break;
      case 'person': {
        const [x, y] = this.toScreen([obj.x, obj.y]);
        ctx.beginPath();
        ctx.arc(x, y, obj.radius * this.view.scale + 5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
    }
    ctx.lineCap = 'butt';
  }

  drawDraft() {
    const d = this.draft;
    if (!d) return;
    const { ctx } = this;
    ctx.strokeStyle = this.colors.select;
    ctx.fillStyle = this.colors.select + '22';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    if (d.kind === 'rect') {
      const vs = M.rectangle(d.a[0], d.a[1], d.b[0], d.b[1]);
      this.pathPolygon(vs);
      ctx.fill();
      ctx.stroke();
      const w = Math.abs(d.b[0] - d.a[0]);
      const h = Math.abs(d.b[1] - d.a[1]);
      this.label(`${w.toFixed(2)} × ${h.toFixed(2)} m`, this.toScreen(d.b), 12, -12);
    } else if (d.kind === 'polygon' && d.points.length) {
      const pts = [...d.points];
      if (this.mouse) pts.push(this.mouse.snapped);
      ctx.beginPath();
      pts.forEach((p, k) => {
        const [x, y] = this.toScreen(p);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      const [fx, fy] = this.toScreen(d.points[0]);
      ctx.setLineDash([]);
      ctx.strokeRect(fx - 6, fy - 6, 12, 12);
      if (this.mouse) {
        const last = d.points[d.points.length - 1];
        this.label(`${G.dist(last, this.mouse.snapped).toFixed(2)} m`, [this.mouse.sx, this.mouse.sy], 12, -12);
      }
    }
    ctx.setLineDash([]);
  }

  drawToolPreview() {
    if (!this.mouse || this.drag) return;
    const { ctx } = this;
    if (WALL_TOOLS.has(this.tool)) {
      const nw = this.wallNear(this.mouse.world);
      if (!nw) return;
      const vs = this.store.layout.room.vertices;
      const len = G.wallLength(vs, nw.index);
      const ghost = M.createWallItem(this.store.layout, this.tool, nw.index, G.snap(nw.t * len, this.snapStep / 2));
      ctx.strokeStyle = this.colors[this.tool];
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 8;
      line(ctx, ...G.openingEnds(vs, ghost).map((q) => this.toScreen(q)));
      ctx.globalAlpha = 1;
    } else if (this.tool in CREATE_IN_ROOM) {
      const p = this.mouse.snapped;
      if (G.pointInPolygon(p, this.store.layout.room.vertices)) {
        ctx.globalAlpha = 0.5;
        const ghost = CREATE_IN_ROOM[this.tool](p[0], p[1]);
        const draw = { fan: 'drawFan', shower: 'drawShower', hob: 'drawHob', extract: 'drawExtract', hood: 'drawExtract' }[this.tool];
        this[draw](ghost);
        ctx.globalAlpha = 1;
      }
    } else if (this.tool === 'person') {
      const p = this.mouse.snapped;
      if (!G.pointInPolygon(p, this.store.layout.room.vertices)) return;
      const [x, y] = this.toScreen(p);
      ctx.beginPath();
      ctx.arc(x, y, 0.25 * this.view.scale, 0, Math.PI * 2);
      ctx.strokeStyle = this.colors.person;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  label(text, [x, y], dx, dy) {
    const { ctx } = this;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = this.colors['canvas-bg'] + 'dd';
    ctx.fillRect(x + dx - 4, y + dy - 9, w + 8, 18);
    ctx.fillStyle = this.colors.select;
    ctx.fillText(text, x + dx, y + dy);
  }
}

function line(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

function arrow(ctx, from, to, color) {
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  line(ctx, from, to);
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - 8 * Math.cos(ang - 0.45), to[1] - 8 * Math.sin(ang - 0.45));
  ctx.lineTo(to[0] - 8 * Math.cos(ang + 0.45), to[1] - 8 * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();
}

const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
