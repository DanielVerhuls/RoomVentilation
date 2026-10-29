// Properties panel for the current selection (or the room when nothing is selected).
import * as G from './geometry.js';
import * as M from './model.js';

export class Panel {
  constructor(el, store, editor) {
    this.el = el;
    this.store = store;
    this.editor = editor;
    this.fields = [];
    this.key = null;
    store.subscribe(() => this.refresh());
    this.refresh();
  }

  refresh() {
    const sel = this.store.selection;
    const obj = M.findSelected(this.store.layout, sel);
    // Rebuild only when *what* is shown changes; otherwise update values in place,
    // so typing into a field is never interrupted by a redraw.
    const key = obj ? `${sel.type}:${sel.id ?? sel.index}:${obj.kind ?? ''}:${obj.bc ?? ''}` : 'room';
    if (key !== this.key) {
      this.key = key;
      this.build(obj ? sel : null);
    } else {
      for (const f of this.fields) {
        if (f.input !== document.activeElement) f.sync();
      }
    }
  }

  build(sel) {
    this.el.replaceChildren();
    this.fields = [];
    const L = () => this.store.layout;
    const find = () => M.findSelected(L(), sel);

    if (!sel) {
      this.heading('Room');
      this.text('Name', () => L().name, (l, v) => (l.name = v));
      this.number('Ceiling height', 'm', () => L().room.height, (l, v) => (l.room.height = v), { min: 0.5, step: 0.1 });
      this.info(() => {
        const vs = L().room.vertices;
        const area = Math.abs(G.signedArea(vs));
        return `${vs.length} walls · area ${area.toFixed(2)} m² · volume ${(area * L().room.height).toFixed(1)} m³`;
      });
      this.heading('Initial & outdoor air');
      const cond = (k) => [() => L().conditions[k], (l, v) => (l.conditions[k] = v)];
      this.number('Room temperature', '°C', ...cond('initial_temperature'), { step: 0.5 });
      this.number('Room CO₂', 'ppm', ...cond('initial_co2_ppm'), { min: 0, step: 50 });
      this.number('Outdoor temperature', '°C', ...cond('outdoor_temperature'), { step: 0.5 });
      this.number('Outdoor CO₂', 'ppm', ...cond('outdoor_co2_ppm'), { min: 0, step: 10 });
      this.hint('Select a corner, wall, opening or person to edit it.');
      return;
    }

    switch (sel.type) {
      case 'vertex': {
        this.heading(`Corner ${sel.index}`);
        const vs = () => L().room.vertices;
        const coord = (c) => (l, v) => {
          l.room.vertices[sel.index][c] = v;
          M.clampAllOpenings(l);
        };
        this.number('x', 'm', () => vs()[sel.index][0], coord(0), { step: 0.1 });
        this.number('y', 'm', () => vs()[sel.index][1], coord(1), { step: 0.1 });
        this.buttons([['Delete corner', () => this.deleteSelection(), vs().length <= 3]]);
        break;
      }
      case 'wall': {
        this.heading(`Wall ${sel.index}`);
        this.info(() => `Length ${G.wallLength(L().room.vertices, sel.index).toFixed(2)} m`);
        const place = (kind) => () => {
          const len = G.wallLength(L().room.vertices, sel.index);
          let op;
          this.store.update((l) => {
            op = M.createOpening(l, kind, sel.index, len / 2);
            l.openings.push(op);
          });
          this.store.select({ type: 'opening', id: op.id });
        };
        this.buttons([
          ['Add window', place('window')],
          ['Add door', place('door')],
          ['Split wall', () => {
            const [a, b] = G.wallEnds(L().room.vertices, sel.index);
            const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2].map((c) => +c.toFixed(4));
            this.store.update((l) => M.insertVertex(l, sel.index, mid));
            this.store.select({ type: 'vertex', index: sel.index + 1 });
          }],
        ]);
        this.hint('Drag a wall to move it. Double-click it to add a corner there.');
        break;
      }
      case 'opening': {
        const op = find();
        this.heading(op.kind === 'door' ? 'Door' : 'Window');
        const set = (k) => [() => find()[k], (l, v) => {
          const o = l.openings.find((x) => x.id === sel.id);
          o[k] = v;
          M.clampOpening(l.room.vertices, o);
        }];
        this.select('Type', { window: 'Window', door: 'Door' }, ...set('kind'));
        this.info(() => `On wall ${find().wall} (${G.wallLength(L().room.vertices, find().wall).toFixed(2)} m)`);
        this.number('Offset from corner', 'm', ...set('offset'), { min: 0, step: 0.05 });
        this.number('Width', 'm', ...set('width'), { min: 0.1, step: 0.05 });
        this.select('Boundary', { closed: 'Closed (wall)', inlet: 'Inlet (air in)', outlet: 'Outlet (air out)' }, ...set('bc'));
        if (op.bc === 'inlet') {
          this.number('Inflow speed', 'm/s', ...set('velocity'), { min: 0, step: 0.05 });
          this.info(() => {
            const o = find();
            const area = Math.abs(G.signedArea(L().room.vertices));
            const ach = (o.velocity * o.width * 3600) / area;
            return `≈ ${ach.toFixed(1)} air changes per hour (2D model: the opening spans the full height)`;
          });
        }
        this.hint(
          op.bc === 'inlet'
            ? 'Inlet = the solver prescribes the velocity here (Dirichlet condition).'
            : op.bc === 'outlet'
              ? 'Outlet = the solver prescribes the pressure here and lets the air leave freely (Neumann on velocity).'
              : 'Closed = treated as a wall (no-slip).',
        );
        this.buttons([['Delete', () => this.deleteSelection()]]);
        break;
      }
      case 'person': {
        this.heading('Person');
        const set = (k) => [() => find()[k], (l, v) => (l.people.find((x) => x.id === sel.id)[k] = v)];
        this.number('x', 'm', ...set('x'), { step: 0.1 });
        this.number('y', 'm', ...set('y'), { step: 0.1 });
        this.number('Radius', 'm', ...set('radius'), { min: 0.05, max: 1, step: 0.05 });
        const acts = Object.fromEntries(Object.entries(M.ACTIVITIES).map(([k, a]) => [k, a.label]));
        this.select('Activity', acts, () => find().activity, (l, v) => {
          Object.assign(l.people.find((x) => x.id === sel.id), { activity: v, ...M.personEmission(v) });
        });
        this.number('CO₂ exhaled', 'L/s', ...set('co2_lps'), { min: 0, step: 0.001 });
        this.number('Heat released', 'W', ...set('heat_w'), { min: 0, step: 5 });
        this.buttons([['Delete', () => this.deleteSelection()]]);
        break;
      }
    }
  }

  deleteSelection() {
    const sel = this.store.selection;
    this.store.update((l) => M.deleteSelected(l, sel));
    this.store.select(null);
  }

  // ---- field builders ---------------------------------------------------------

  heading(text) {
    const h = document.createElement('h3');
    h.textContent = text;
    this.el.append(h);
  }

  hint(text) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = text;
    this.el.append(p);
  }

  info(get) {
    const p = document.createElement('p');
    p.className = 'info';
    const f = { input: null, sync: () => (p.textContent = get()) };
    f.sync();
    this.fields.push(f);
    this.el.append(p);
  }

  row(label, input, unit) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, input);
    if (unit) {
      const u = document.createElement('small');
      u.textContent = unit;
      wrap.append(u);
    }
    this.el.append(wrap);
  }

  bind(input, get, set, parse) {
    const f = { input, sync: () => (input.value = get()) };
    f.sync();
    input.addEventListener('change', () => {
      const v = parse(input.value);
      if (v === null) return f.sync();
      this.store.update((l) => set(l, v));
      f.sync();
    });
    this.fields.push(f);
  }

  number(label, unit, get, set, { min, max, step } = {}) {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    if (step !== undefined) input.step = step;
    const fmt = () => +(+get()).toFixed(4);
    this.bind(input, fmt, set, (s) => {
      const v = parseFloat(s);
      if (!Number.isFinite(v)) return null;
      return G.clamp(v, min ?? -Infinity, max ?? Infinity);
    });
    this.row(label, input, unit);
  }

  text(label, get, set) {
    const input = document.createElement('input');
    input.type = 'text';
    this.bind(input, get, set, (s) => s.trim() || null);
    this.row(label, input);
  }

  select(label, options, get, set) {
    const input = document.createElement('select');
    for (const [value, text] of Object.entries(options)) input.add(new Option(text, value));
    this.bind(input, get, set, (s) => s);
    this.row(label, input);
  }

  buttons(list) {
    const div = document.createElement('div');
    div.className = 'buttons';
    for (const [text, fn, disabled] of list) {
      const b = document.createElement('button');
      b.textContent = text;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      div.append(b);
    }
    this.el.append(div);
  }
}
