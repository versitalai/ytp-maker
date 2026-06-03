// state.js — single source of truth, tiny observable store
// Kept framework-free on purpose. Every mutation goes through set() so
// subscribers can re-render predictably.

let _id = 1;
export const uid = (p = 'id') => `${p}_${_id++}_${Date.now().toString(36)}`;

const initial = {
  project: {
    name: 'Untitled YTP',
    fps: 30,
    resolution: { w: 1280, h: 720 },
  },
  media: [],          // { id, name, kind:'video'|'audio', url, duration, file, waves? }
  activeMediaId: null,
  transcript: {},     // mediaId -> { words:[{t0,t1,text}], sentences:[{t0,t1,text,wordIdx:[]}] }
  timeline: {
    zoom: 60,         // px per second
    snap: true,
    beatGrid: false,  // toggle: show vertical lines at detected beat positions
    tracks: {
      V2: [], V1: [], A1: [], A2: [], M: [],
    },
  },
  playhead: 0,        // seconds
  playing: false,
  selectedClipId: null,
  inOut: { in: null, out: null },  // mark in/out on master clock
  color: { e: 0, c: 0, s: 1, h: 0, g: 1 },
  audio: { gain: 1, lc: 20, hc: 22050 },
  captionsOn: false,
  history: [],        // undo stack (snapshots of timeline.tracks + selection)
  future: [],
};

let state = structuredClone(initial);
const subs = new Set();

export function getState() { return state; }

export function setState(patch, opts = {}) {
  const prev = state;
  state = (typeof patch === 'function') ? patch(state) : { ...state, ...patch };
  if (opts.skipHistory !== true) pushHistory(prev);
  for (const fn of subs) fn(state, prev);
}

export function patchIn(path, updater) {
  // shallow path patcher: patchIn(['timeline','zoom'], 80)
  setState((s) => {
    const next = structuredClone(s);
    let obj = next;
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
    obj[path[path.length - 1]] = updater(obj[path[path.length - 1]]);
    return next;
  });
}

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

// ---------- History ----------
function pushHistory(prev) {
  state.history.push({
    tracks: structuredClone(prev.timeline.tracks),
    selected: prev.selectedClipId,
  });
  if (state.history.length > 100) state.history.shift();
  state.future = [];
}

export function undo() {
  if (!state.history.length) return;
  const last = state.history.pop();
  state.future.push({
    tracks: structuredClone(state.timeline.tracks),
    selected: state.selectedClipId,
  });
  setState((s) => ({
    ...s,
    timeline: { ...s.timeline, tracks: structuredClone(last.tracks) },
    selectedClipId: last.selected,
  }), { skipHistory: true });
  toast('Undo');
}

export function redo() {
  if (!state.future.length) return;
  const next = state.future.pop();
  state.history.push({
    tracks: structuredClone(state.timeline.tracks),
    selected: state.selectedClipId,
  });
  setState((s) => ({
    ...s,
    timeline: { ...s.timeline, tracks: structuredClone(next.tracks) },
    selectedClipId: next.selected,
  }), { skipHistory: true });
  toast('Redo');
}

// ---------- Toast (very small util surfaced from here so any module can fire) ----------
let toastEl;
export function toast(msg, ms = 1800) {
  if (!toastEl) toastEl = document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}
