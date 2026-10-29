// Holds the layout and the current selection, with snapshot-based undo/redo.
//
// Events passed to subscribers:
//   'commit'    - a finished change (validation, mesh preview, autosave react)
//   'live'      - intermediate change while dragging (only redraw)
//   'selection' - selection changed

const MAX_UNDO = 200;

export class Store {
  constructor(layout) {
    this.layout = layout;
    this.selection = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.pending = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
  }

  emit(kind) {
    for (const fn of this.listeners) fn(kind);
  }

  snapshot() {
    return JSON.stringify(this.layout);
  }

  /** Start a multi-step change (e.g. a drag). Undo restores the state from here. */
  begin() {
    if (this.pending === null) this.pending = this.snapshot();
  }

  live(fn) {
    fn(this.layout);
    this.emit('live');
  }

  end() {
    if (this.pending === null) return;
    if (this.pending !== this.snapshot()) {
      this.undoStack.push(this.pending);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
    }
    this.pending = null;
    this.emit('commit');
  }

  update(fn) {
    this.begin();
    fn(this.layout);
    this.end();
  }

  replace(layout) {
    this.begin();
    this.layout = layout;
    this.selection = null;
    this.end();
    this.emit('selection');
  }

  select(sel) {
    this.selection = sel;
    this.emit('selection');
  }

  undo() {
    this.#travel(this.undoStack, this.redoStack);
  }

  redo() {
    this.#travel(this.redoStack, this.undoStack);
  }

  #travel(from, to) {
    if (!from.length) return;
    to.push(this.snapshot());
    this.layout = JSON.parse(from.pop());
    this.selection = null;
    this.emit('commit');
    this.emit('selection');
  }
}
