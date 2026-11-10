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
    const key = obj ? `${sel.type}:${sel.id ?? sel.index}:${obj.kind ?? ''}:${obj.mode ?? ''}` : 'room';
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
      this.number('Room humidity', '% RH', () => L().conditions.initial_rh ?? 50, cond('initial_rh')[1], { min: 0, max: 100, step: 5 });
      this.number('Outdoor temperature', '°C', ...cond('outdoor_temperature'), { step: 0.5 });
      this.number('Outdoor CO₂', 'ppm', ...cond('outdoor_co2_ppm'), { min: 0, step: 10 });
      this.number('Outdoor humidity', '% RH', () => L().conditions.outdoor_rh ?? 80, cond('outdoor_rh')[1], { min: 0, max: 100, step: 5 });
      this.hint('Floor, ceiling and walls stay at the room temperature: they take up heat and are where steam condenses.');
      this.heading('Wind');
      this.number('Wind speed', 'm/s', ...cond('wind_speed'), { min: 0, max: 30, step: 0.5 });
      this.number('Coming from', '°', ...cond('wind_direction'), { min: 0, max: 359, step: 15 });
      this.hint(
        'Wind pushes on the facade (+0.6 × ½ρU² facing the wind, −0.35 × ½ρU² elsewhere). Open windows and doors ' +
          'connected to the outside feel that pressure; the flow through them follows from it. 0° = from north (+y), 90° = from east.',
      );
      this.hint('Select a corner, wall, opening, unit, fan, shower, hob, extract or person to edit it.');
      return;
    }

    switch (sel.type) {
      case 'vertex': {
        this.heading(`Corner ${sel.index}`);
        const vs = () => L().room.vertices;
        const coord = (c) => (l, v) => {
          l.room.vertices[sel.index][c] = v;
          M.clampAllWallItems(l);
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
          const type = kind === 'vent' ? 'vent' : 'opening';
          let item;
          this.store.update((l) => {
            item = M.createWallItem(l, kind, sel.index, len / 2);
            l[type === 'vent' ? 'vents' : 'openings'].push(item);
          });
          this.store.select({ type, id: item.id });
        };
        this.buttons([
          ['Add window', place('window')],
          ['Add door', place('door')],
          ['Add vent unit', place('vent')],
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
          M.clampWallItem(l.room.vertices, o);
        }];
        this.select('Type', { window: 'Window', door: 'Door' }, ...set('kind'));
        this.info(() => `On wall ${find().wall} (${G.wallLength(L().room.vertices, find().wall).toFixed(2)} m)`);
        this.number('Offset from corner', 'm', ...set('offset'), { min: 0, step: 0.05 });
        this.number('Width', 'm', ...set('width'), { min: 0.1, step: 0.05 });
        this.number('Height', 'm', () => find().height ?? (find().kind === 'door' ? 2.0 : 1.2), set('height')[1], { min: 0.1, step: 0.1 });
        this.checkbox('Open', ...set('open'));
        if (op.kind === 'door') {
          this.number('Gap under door', 'm', () => find().undercut ?? 0.01, set('undercut')[1], { min: 0, max: 0.2, step: 0.005 });
        }
        this.select('Leads to', { outside: 'Outside (wind, outdoor air)', indoors: 'Indoors (0 Pa, room air)' }, ...set('connects_to'));
        this.hint(
          'An open door or window is a pressure boundary: the solver fixes the pressure there (wind pressure outside, ' +
            '0 Pa indoors) and the flow through it follows from the pressure difference, limited by the orifice ' +
            'equation Q = Cd·w·h·√(2Δp/ρ). Closed = wall. You can open and close it during the simulation.',
        );
        this.buttons([['Delete', () => this.deleteSelection()]]);
        break;
      }
      case 'vent': {
        const vent = find();
        this.heading('Ventilation unit');
        const set = (k) => [() => find()[k], (l, v) => {
          const o = l.vents.find((x) => x.id === sel.id);
          o[k] = v;
          M.clampWallItem(l.room.vertices, o);
        }];
        this.select('Mode', { supply: 'Supply (blows air in)', exhaust: 'Exhaust (sucks air out)' }, ...set('mode'));
        this.checkbox('Running', ...set('on'));
        this.number('Volume flow', 'm³/h', ...set('flow_m3h'), { min: 0, step: 10 });
        if (vent.mode === 'supply') this.number('Supply temperature', '°C', ...set('supply_temperature'), { step: 0.5 });
        this.number('Offset from corner', 'm', ...set('offset'), { min: 0, step: 0.05 });
        this.number('Width', 'm', ...set('width'), { min: 0.05, step: 0.05 });
        this.info(() => {
          const area = Math.abs(G.signedArea(L().room.vertices));
          return `≈ ${(find().flow_m3h / (area * L().room.height)).toFixed(1)} air changes per hour`;
        });
        this.hint(
          'A fan delivers a (nearly) fixed volume flow, so this is a velocity boundary: the solver prescribes the flow. ' +
            'In an airtight room supply and exhaust must balance - otherwise open a door or window.',
        );
        this.buttons([['Delete', () => this.deleteSelection()]]);
        break;
      }
      case 'fan': {
        this.heading('Fan');
        const set = (k) => [() => find()[k], (l, v) => (l.fans.find((x) => x.id === sel.id)[k] = v)];
        this.checkbox('Running', ...set('on'));
        this.number('Air speed', 'm/s', ...set('speed'), { min: 0, max: 15, step: 0.5 });
        this.number('Direction', '°', ...set('angle'), { min: -360, max: 360, step: 15 });
        this.buttons([
          ['⟲ 45°', () => this.store.update((l) => (l.fans.find((x) => x.id === sel.id).angle = (find().angle + 45) % 360))],
          ['⟳ 45°', () => this.store.update((l) => (l.fans.find((x) => x.id === sel.id).angle = (find().angle + 315) % 360))],
        ]);
        this.checkbox('Swing back and forth', () => !!find().oscillate, set('oscillate')[1]);
        this.number('Swing range ±', '°', () => find().sweep ?? 45, set('sweep')[1], { min: 0, max: 90, step: 5 });
        this.number('One swing takes', 's', () => find().period ?? 12, set('period')[1], { min: 2, max: 120, step: 1 });
        this.number('Width', 'm', ...set('width'), { min: 0.1, max: 3, step: 0.05 });
        this.number('x', 'm', ...set('x'), { step: 0.1 });
        this.number('y', 'm', ...set('y'), { step: 0.1 });
        this.hint('Drag the round handle at the tip of the arrow to turn the fan (15° steps, hold Alt for 1°).');
        this.hint('A free-standing fan pushes the air in its footprint towards the set speed - a momentum source. It adds no air, it only moves it around.');
        this.buttons([['Delete', () => this.deleteSelection()]]);
        break;
      }
      case 'shower': {
        this.heading('Shower');
        const set = (k) => [() => find()[k], (l, v) => (l.showers.find((x) => x.id === sel.id)[k] = v)];
        this.checkbox('Running at start', ...set('on'));
        this.number('Steam', 'g/h', ...set('moisture_gph'), { min: 0, step: 100 });
        this.number('Heat to the air', 'W', ...set('heat_w'), { min: 0, step: 50 });
        this.footprint(set);
        this.hint(
          'A hot shower releases roughly 2.6 kg of water vapour per hour (a common planning value). Switch it on and ' +
            'off while the simulation runs to see how long the room stays humid.',
        );
        this.buttons([['Delete', () => this.deleteSelection()]]);
        break;
      }
      case 'hob': {
        this.heading('Hob');
        const set = (k) => [() => find()[k], (l, v) => {
          const hob = l.hobs.find((x) => x.id === sel.id);
          hob[k] = v;
          if (['heat_w', 'moisture_gph', 'fumes_mgpm'].includes(k)) hob.activity = 'custom';
        }];
        const presets = Object.fromEntries(Object.entries(M.HOB_PRESETS).map(([k, a]) => [k, a.label]));
        this.select('Cooking', presets, () => find().activity, (l, v) => {
          Object.assign(l.hobs.find((x) => x.id === sel.id), { activity: v, ...(v === 'custom' ? {} : M.hobEmission(v)) });
        });
        this.checkbox('Cooking at start', ...set('on'));
        this.number('Heat to the air', 'W', ...set('heat_w'), { min: 0, step: 100 });
        this.number('Steam', 'g/h', ...set('moisture_gph'), { min: 0, step: 50 });
        this.number('Fumes (fine particles)', 'mg/min', ...set('fumes_mgpm'), { min: 0, step: 0.1 });
        this.footprint(set);
        this.info(() => (M.hoodAbove(L(), find()) ? 'A cooker hood hangs above this hob.' : 'No cooker hood above this hob.'));
        this.buttons([
          ['Add hood above', () => {
            const hob = find();
            const hood = { ...M.createExtract(hob.x, hob.y, 'hood'), width: hob.width, depth: hob.depth };
            this.store.update((l) => l.extracts.push(hood));
            this.store.select({ type: 'extract', id: hood.id });
          }, !!M.hoodAbove(L(), find())],
          ['Delete', () => this.deleteSelection()],
        ]);
        this.hint('Rough values: boiling pasta ~1.2 kg steam/h, frying potatoes ~0.35 kg/h but far more heat and fine particles.');
        break;
      }
      case 'extract': {
        const ex = find();
        this.heading(ex.kind === 'hood' ? 'Cooker hood' : 'Extract fan');
        const set = (k) => [() => find()[k], (l, v) => (l.extracts.find((x) => x.id === sel.id)[k] = v)];
        this.select('Type', { ceiling: 'Ceiling / wall extract fan', hood: 'Cooker hood (above a hob)' }, ...set('kind'));
        this.checkbox('Running', ...set('on'));
        this.number('Volume flow', 'm³/h', ...set('flow_m3h'), { min: 0, step: 10 });
        this.footprint(set);
        if (ex.kind === 'hood') {
          this.info(() => {
            const eta = 1 - Math.exp(-find().flow_m3h / 250);
            return `Catches ≈ ${(eta * 100).toFixed(0)} % of the steam and fumes of the hob below (η = 1 − e^(−Q / 250 m³/h)).`;
          });
          this.hint(
            'A hood works because the hot plume rises into it - something a top view cannot compute. So it takes a ' +
              'capture efficiency η of the hob emissions straight out, and on top of that extracts room air.',
          );
        } else {
          this.hint('Takes air out of the room. It only works if air can come in: a window, a supply unit, or a gap under a closed door.');
        }
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
        this.number('Water vapour', 'g/h', () => find().moisture_gph ?? 50, set('moisture_gph')[1], { min: 0, step: 10 });
        this.buttons([['Delete', () => this.deleteSelection()]]);
        break;
      }
    }
  }

  /** Position and size fields shared by showers, hobs and extracts. */
  footprint(set) {
    this.number('Width (x)', 'm', ...set('width'), { min: 0.1, step: 0.05 });
    this.number('Depth (y)', 'm', ...set('depth'), { min: 0.1, step: 0.05 });
    this.number('x', 'm', ...set('x'), { step: 0.1 });
    this.number('y', 'm', ...set('y'), { step: 0.1 });
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

  checkbox(label, get, set) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    const f = { input, sync: () => (input.checked = !!get()) };
    f.sync();
    input.addEventListener('change', () => this.store.update((l) => set(l, input.checked)));
    this.fields.push(f);
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
