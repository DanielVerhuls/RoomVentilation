// Wires the editor, panel, API and toolbar together.
import { api } from './api.js';
import { Editor, TOOL_GROUPS, TOOLS } from './editor.js';
import * as M from './model.js';
import { Panel } from './panel.js';
import { Store } from './store.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_KEY = 'roomventilation.layout';

const store = new Store(loadAutosave() ?? M.defaultLayout());
const editor = new Editor($('canvas'), store);
new Panel($('panel'), store, editor);

// ---- tools ---------------------------------------------------------------------

// Tools grouped by room type; each group can be folded away.
for (const group of TOOL_GROUPS) {
  const box = document.createElement('details');
  box.className = 'tool-group';
  box.open = true;
  const summary = document.createElement('summary');
  summary.textContent = group;
  box.append(summary);
  for (const [name, t] of Object.entries(TOOLS)) {
    if (t.group !== group) continue;
    const b = document.createElement('button');
    b.dataset.tool = name;
    b.title = t.hint;
    b.innerHTML = `<span>${t.label}</span><kbd>${t.key.toUpperCase()}</kbd>`;
    b.addEventListener('click', () => editor.setTool(name));
    box.append(b);
  }
  $('tools').append(box);
}
editor.onToolChange = (tool) => {
  for (const b of $('tools').querySelectorAll('button[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('tool-hint').textContent = TOOLS[tool].hint;
};
editor.setTool('select');

editor.onCursor = (p) => {
  $('cursor-pos').textContent = p ? `x ${p[0].toFixed(2)} m  y ${p[1].toFixed(2)} m` : '–';
};

$('snap').addEventListener('change', (e) => (editor.snapStep = +e.target.value));
$('btn-zoom-in').addEventListener('click', () => editor.zoom(1.25));
$('btn-zoom-out').addEventListener('click', () => editor.zoom(0.8));
$('btn-fit').addEventListener('click', () => editor.fitView());
$('btn-undo').addEventListener('click', () => store.undo());
$('btn-redo').addEventListener('click', () => store.redo());

const typing = (e) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);

window.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !typing(e)) {
    editor.spaceDown = true;
    e.preventDefault();
  }
  if (typing(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.shiftKey ? store.redo() : store.undo();
    e.preventDefault();
  } else if (mod && e.key.toLowerCase() === 'y') {
    store.redo();
    e.preventDefault();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    const sel = store.selection;
    store.update((l) => M.deleteSelected(l, sel));
    store.select(null);
  } else if (e.key === 'Escape') {
    editor.cancel();
  } else if (e.key === 'Enter' && editor.tool === 'polygon') {
    editor.closePolygon();
  } else if (!mod && e.key.toLowerCase() === 'f') {
    editor.fitView();
  } else if (!mod) {
    const tool = Object.entries(TOOLS).find(([, t]) => t.key === e.key.toLowerCase());
    if (tool) editor.setTool(tool[0]);
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') editor.spaceDown = false;
});

// ---- validation, mesh preview, autosave ----------------------------------------

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let requestSeq = 0;

const validate = debounce(async () => {
  const seq = ++requestSeq;
  const list = $('issues');
  try {
    const res = await api.validate(store.layout);
    if (seq !== requestSeq) return; // a newer request is in flight
    setApiStatus(true);
    renderIssues(res.issues);
  } catch (err) {
    if (seq !== requestSeq) return;
    if (err.status === 422) renderIssues(schemaIssues(err.detail));
    else {
      setApiStatus(false);
      list.innerHTML = '<li class="warning">API not reachable - checks and mesh preview are unavailable.</li>';
    }
  }
}, 250);

function schemaIssues(detail) {
  // FastAPI's 422 for schema violations: [{loc: ['body', 'openings', 0, 'width'], msg}, ...]
  if (!Array.isArray(detail)) return [{ level: 'error', path: '', message: String(detail?.message ?? detail) }];
  return detail.map((d) => ({ level: 'error', path: d.loc.slice(1).join('.'), message: d.msg }));
}

function renderIssues(issues) {
  const list = $('issues');
  list.replaceChildren();
  if (!issues.length) {
    list.innerHTML = '<li class="ok">Layout looks good.</li>';
    return;
  }
  for (const issue of issues) {
    const li = document.createElement('li');
    li.className = issue.level;
    li.textContent = issue.message;
    const target = issueTarget(issue.path);
    if (target) {
      li.dataset.path = issue.path;
      li.title = 'Click to select';
      li.addEventListener('click', () => store.select(target));
    }
    list.append(li);
  }
}

function issueTarget(path) {
  const m = /^(openings|vents|fans|showers|hobs|extracts|people|room\.vertices)[[.](\d+)/.exec(path ?? '');
  if (!m) return null;
  const k = +m[2];
  if (m[1] === 'room.vertices') return { type: 'vertex', index: k };
  const item = store.layout[m[1]][k];
  const types = { openings: 'opening', vents: 'vent', fans: 'fan', showers: 'shower', hobs: 'hob', extracts: 'extract', people: 'person' };
  return item ? { type: types[m[1]], id: item.id } : null;
}

let meshSeq = 0;

const refreshMesh = debounce(async () => {
  if (!$('mesh-toggle').checked) return;
  const seq = ++meshSeq;
  const dx = +$('mesh-dx').value;
  try {
    const mesh = await api.rasterize(store.layout, dx);
    if (seq !== meshSeq) return;
    editor.setMesh(mesh);
    $('mesh-info').textContent =
      `${mesh.nx} × ${mesh.ny} cells · ${mesh.stats.fluid_cells.toLocaleString()} fluid cells`;
  } catch (err) {
    if (seq !== meshSeq) return;
    $('mesh-info').textContent = `Mesh unavailable: ${err.message}`;
  }
}, 300);

$('mesh-toggle').addEventListener('change', (e) => {
  editor.showMesh = e.target.checked;
  if (e.target.checked) refreshMesh();
  else editor.render();
});
$('mesh-dx').addEventListener('change', refreshMesh);

store.subscribe((kind) => {
  if (kind === 'selection') return;
  // Mesh and checks also follow drags; the debounce keeps the request rate low.
  validate();
  refreshMesh();
  if (kind === 'commit') saveAutosave();
});

function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? M.migrate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveAutosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(store.layout));
  } catch {
    /* storage unavailable: nothing to do */
  }
}

// ---- files & server --------------------------------------------------------------

function message(text, isError = false) {
  const el = $('message');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function setApiStatus(ok) {
  const el = $('api-status');
  el.textContent = ok ? 'API online' : 'API offline';
  el.className = `pill ${ok ? 'ok' : 'bad'}`;
}

const slug = (name) => name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'untitled';

function loadLayout(layout) {
  store.replace(layout);
  editor.fitView();
}

async function refreshServerList(selected) {
  try {
    const names = await api.list();
    const sel = $('server-list');
    sel.replaceChildren(new Option('Server layouts…', ''));
    for (const n of names) sel.add(new Option(n, n));
    if (selected) sel.value = selected;
    setApiStatus(true);
  } catch {
    setApiStatus(false);
  }
}

$('btn-new').addEventListener('click', () => loadLayout(M.defaultLayout()));

$('btn-save').addEventListener('click', async () => {
  const name = slug(store.layout.name);
  try {
    await api.put(name, store.layout);
    message(`Saved as "${name}"`);
    refreshServerList(name);
  } catch (err) {
    message(`Save failed: ${err.message}`, true);
  }
});

$('btn-load').addEventListener('click', async () => {
  const name = $('server-list').value;
  if (!name) return message('Pick a layout from the list first.', true);
  try {
    loadLayout(await api.get(name));
    message(`Loaded "${name}"`);
  } catch (err) {
    message(`Load failed: ${err.message}`, true);
  }
});

$('btn-delete').addEventListener('click', async () => {
  const name = $('server-list').value;
  if (!name || !confirm(`Delete "${name}" from the server?`)) return;
  try {
    await api.remove(name);
    message(`Deleted "${name}"`);
    refreshServerList();
  } catch (err) {
    message(`Delete failed: ${err.message}`, true);
  }
});

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.layout, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(store.layout.name)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btn-import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const layout = JSON.parse(await file.text());
    if (!layout?.room?.vertices) throw new Error('not a layout file');
    loadLayout(M.migrate(layout));
    message(`Imported ${file.name}`);
  } catch (err) {
    message(`Import failed: ${err.message}`, true);
  }
});

refreshServerList();
validate();
