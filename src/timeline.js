// timeline.js — drag/drop, cut, trim, snap, zoom
import { getState, setState, patchIn, uid, toast, undo, redo } from './state.js';
import { computePeaks, drawWaveform, getCachedPeaks } from './waveform.js';

let drag = null;       // { mode, clipId, originTrack, originStart, startX, originalIn, originalOut }
let razor = false;

export function initTimeline() {
  const wrap = document.getElementById('timeline');
  const tracks = document.getElementById('tracks');
  const ruler = document.getElementById('ruler');
  const playhead = document.getElementById('playhead');

  document.getElementById('tl-cut').addEventListener('click', () => {
    razor = !razor;
    document.getElementById('tl-cut').classList.toggle('on', razor);
    toast(razor ? 'Razor ON — click clip body to cut' : 'Razor OFF');
  });
  document.getElementById('tl-snap').addEventListener('click', () => {
    setState((st) => ({ ...st, timeline: { ...st.timeline, snap: !st.timeline.snap } }));
    document.getElementById('tl-snap').classList.toggle('on', getState().timeline.snap);
  });
  document.getElementById('toggle-beat-grid').addEventListener('click', () => {
    setState((st) => ({ ...st, timeline: { ...st.timeline, beatGrid: !st.timeline.beatGrid } }));
    document.getElementById('toggle-beat-grid').classList.toggle('on', getState().timeline.beatGrid);
    renderTimeline();
  });
  document.getElementById('tl-zoom-in').addEventListener('click', () => zoomBy(1.25));
  document.getElementById('tl-zoom-out').addEventListener('click', () => zoomBy(0.8));

  // Click ruler to seek
  ruler.addEventListener('mousedown', (e) => {
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left + wrap.scrollLeft - 56;     // 56 = track head
    const t = Math.max(0, x / getState().timeline.zoom);
    setState((s) => ({ ...s, playhead: t, inOut: { in: null, out: null } }), { skipHistory: true });
  });

  // Drop from bin / memes
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dropping'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('dropping'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('dropping');
    const data = e.dataTransfer.getData('application/x-ytp');
    if (!data) return;
    const payload = JSON.parse(data);
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left + wrap.scrollLeft - 56;
    const t = Math.max(0, x / getState().timeline.zoom);
    const trackEl = e.target.closest('.track-body');
    const trackKey = trackEl ? trackEl.dataset.body : pickTrackForKind(payload);
    addClipAt(trackKey, t, payload);
  });

  // Click to select
  tracks.addEventListener('mousedown', (e) => onMouseDown(e));
  document.addEventListener('mousemove', (e) => onMouseMove(e));
  document.addEventListener('mouseup', (e) => onMouseUp(e));

  // Keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); }
    else if (e.key === ' ') { e.preventDefault(); window.dispatchEvent(new Event('ytp:toggle-play')); }
  });
}

function pickTrackForKind(payload) {
  if (payload.kind === 'audio') return 'A1';
  if (payload.kind === 'meme') return 'A2';
  return 'V1';
}

function addClipAt(trackKey, start, payload) {
  const dur = payload.duration || 3;
  const clip = {
    id: uid('clip'),
    mediaId: payload.mediaId || null,
    meme: payload.meme || null,
    name: payload.name || 'clip',
    track: trackKey,
    start,
    inPoint: 0,
    outPoint: dur,
    fx: [],
    transform: { x:0, y:0, s:1, r:0, o:1, v:1, p:0 },
    color: { e:0, c:0, s:1, h:0, g:1 },
  };
  setState((s) => ({
    ...s,
    timeline: {
      ...s.timeline,
      tracks: { ...s.timeline.tracks, [trackKey]: [...s.timeline.tracks[trackKey], clip] },
    },
    selectedClipId: clip.id,
  }));
  toast(`Placed on ${trackKey}`);
}

function zoomBy(k) {
  setState((s) => ({ ...s, timeline: { ...s.timeline, zoom: Math.max(10, Math.min(400, s.timeline.zoom * k)) } }));
}

// Snap helper: if snap is on, snap `t` (in seconds) to the nearest magnetic target.
// Targets (in order of priority):
//   1. Frame grid (always-on, fine)
//   2. Other clip edges (start/end of any clip on the timeline, excluding the dragged one)
//   3. Playhead position
// Returns the snapped t.
const SNAP_PX = 8; // pixels of magnetic distance (in timeline units → converted)
function snap(t, excludeClipId) {
  const s = getState();
  if (!s.timeline.snap) return Math.max(0, t);
  // Frame grid is the floor — always-on
  const grid = 1 / s.project.fps;
  let best = Math.max(0, Math.round(t / grid) * grid);
  let bestDist = Math.abs(best - t);
  // Magnet distance: convert pixels to seconds via zoom (pxPerSec)
  const pxPerSec = s.timeline.zoom;
  const magnetSec = SNAP_PX / Math.max(20, pxPerSec);
  const tryBetter = (target) => {
    if (target == null) return;
    const d = Math.abs(target - t);
    if (d < magnetSec && d < bestDist) { best = target; bestDist = d; }
  };
  // Other clip edges
  for (const k of Object.keys(s.timeline.tracks)) {
    for (const c of s.timeline.tracks[k]) {
      if (c.id === excludeClipId) continue;
      tryBetter(c.start);
      tryBetter(c.start + (c.outPoint - c.inPoint));
    }
  }
  // Playhead
  tryBetter(s.playhead);
  // BPM beats: if a bpm cache exists for the dragged clip's media, snap to nearest beat
  if (excludeClipId) {
    const dragged = (() => {
      for (const k of Object.keys(s.timeline.tracks)) {
        const c = s.timeline.tracks[k].find((x) => x.id === excludeClipId);
        if (c) return c;
      }
      return null;
    })();
    if (dragged && dragged._bpmBeats) {
      // Beats are sorted; binary search for nearest
      const beats = dragged._bpmBeats;
      let lo = 0, hi = beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (beats[mid] < t) lo = mid + 1; else hi = mid;
      }
      const candidates = [beats[lo]];
      if (lo > 0) candidates.push(beats[lo - 1]);
      for (const b of candidates) {
        if (b == null) continue;
        const d = Math.abs(b - t);
        if (d < magnetSec && d < bestDist) { best = b; bestDist = d; }
      }
    }
  }
  return Math.max(0, best);
}

function onMouseDown(e) {
  const handle = e.target.closest('.handle');
  const clipEl = e.target.closest('.clip');
  if (!clipEl) return;
  const id = clipEl.dataset.id;
  const track = clipEl.closest('.track-body').dataset.body;
  const s = getState();

  if (razor) {
    const rect = clipEl.getBoundingClientRect();
    const t = (e.clientX - rect.left) / rect.width * (s.timeline.tracks[track].find((c) => c.id === id).outPoint - s.timeline.tracks[track].find((c) => c.id === id).inPoint) + s.timeline.tracks[track].find((c) => c.id === id).inPoint;
    cutClip(track, id, t);
    return;
  }

  setState((st) => ({ ...st, selectedClipId: id }), { skipHistory: true });

  const startX = e.clientX;
  const orig = s.timeline.tracks[track].find((c) => c.id === id);
  drag = {
    mode: handle ? (handle.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move',
    clipId: id, track, originTrack: track,
    startX,
    originStart: orig.start,
    originIn: orig.inPoint,
    originOut: orig.outPoint,
    dur: orig.outPoint - orig.inPoint,
  };
}

function onMouseMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dt = dx / getState().timeline.zoom;
  const s = getState();
  const tracks = s.timeline.tracks;
  const trk = tracks[drag.track];
  const idx = trk.findIndex((c) => c.id === drag.clipId);
  if (idx < 0) return;

  let c = { ...trk[idx] };
  if (drag.mode === 'move') {
    c.start = Math.max(0, snap(drag.originStart + dt, drag.clipId));
    // Auto-track swap if dropped on different track
    const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest('.track-body');
    if (hovered && hovered.dataset.body !== drag.track && !c.meme) {
      const newTrack = hovered.dataset.body;
      const oldTrack = drag.track;
      const old = tracks[oldTrack].filter((x) => x.id !== drag.clipId);
      const next = [...tracks[newTrack], c];
      setState((st) => ({
        ...st,
        timeline: { ...st.timeline, tracks: { ...st.timeline.tracks, [oldTrack]: old, [newTrack]: next } },
        selectedClipId: drag.clipId,
      }), { skipHistory: true });
      drag.track = newTrack;
      return;
    }
  } else if (drag.mode === 'trim-l') {
    const newIn = Math.max(0, Math.min(c.outPoint - 0.1, drag.originIn + dt));
    c.inPoint = newIn;
    c.start = Math.max(0, c.start + (newIn - drag.originIn));
  } else if (drag.mode === 'trim-r') {
    const newOut = Math.max(c.inPoint + 0.1, drag.originOut + dt);
    c.outPoint = newOut;
  }
  const newTrk = trk.map((x, i) => i === idx ? c : x);
  setState((st) => ({
    ...st,
    timeline: { ...st.timeline, tracks: { ...st.timeline.tracks, [drag.track]: newTrk } },
  }), { skipHistory: true });
}

function onMouseUp() {
  if (drag) {
    // Commit to history by triggering a no-op set with history
    setState((s) => ({ ...s }));
    drag = null;
  }
}

function cutClip(track, id, t) {
  const s = getState();
  const c = s.timeline.tracks[track].find((c) => c.id === id);
  if (!c || t <= c.inPoint || t >= c.outPoint) return;
  const left = { ...c, outPoint: t, name: c.name + '·a' };
  const right = {
    ...c,
    id: uid('clip'),
    inPoint: t,
    start: c.start + (t - c.inPoint),
    name: c.name + '·b',
  };
  const newTrk = s.timeline.tracks[track].flatMap((x) => x.id === id ? [left, right] : [x]);
  setState((st) => ({ ...st, timeline: { ...st.timeline, tracks: { ...st.timeline.tracks, [track]: newTrk } } }));
  toast('Cut');
}

function deleteSelected() {
  const s = getState();
  const id = s.selectedClipId;
  if (!id) return;
  const tracks = { ...s.timeline.tracks };
  for (const k of Object.keys(tracks)) tracks[k] = tracks[k].filter((c) => c.id !== id);
  setState((st) => ({ ...st, timeline: { ...st.timeline, tracks }, selectedClipId: null }));
}

// ---------- RENDER ----------
export function renderTimeline() {
  const s = getState();
  const wrap = document.getElementById('timeline');
  const ruler = document.getElementById('ruler');
  const playhead = document.getElementById('playhead');

  // ruler
  const z = s.timeline.zoom;
  const width = Math.max(wrap.clientWidth, s.playhead * z + 800);
  ruler.style.width = width + 'px';
  ruler.innerHTML = '';
  const step = z > 80 ? 1 : (z > 30 ? 5 : 10);
  const total = width / z;
  for (let s2 = 0; s2 < total; s2 += step) {
    const tick = document.createElement('div');
    tick.className = 'tick' + (s2 % (step * 5) === 0 ? ' major' : '');
    tick.style.left = (s2 * z) + 'px';
    tick.textContent = formatTC(s2, s.project.fps, s2 % (step * 5) === 0);
    ruler.appendChild(tick);
  }

  // tracks
  renderBeatGrid(width, z, s);

  // tracks
  for (const key of ['V2', 'V1', 'A1', 'A2', 'M']) {
    const body = document.querySelector(`.track-body[data-body="${key}"]`);
    if (!body) continue;
    body.style.width = width + 'px';
    body.innerHTML = '';
    for (const c of s.timeline.tracks[key]) {
      const el = document.createElement('div');
      el.className = 'clip' + (c.meme ? ' meme' : '') + (key.startsWith('A') ? ' audio' : '') + (s.selectedClipId === c.id ? ' selected' : '');
      el.dataset.id = c.id;
      el.style.left = (c.start * z) + 'px';
      el.style.width = ((c.outPoint - c.inPoint) * z) + 'px';

      const head = document.createElement('div');
      head.className = 'clip-head';
      head.innerHTML = `<span class="clip-name">${escape(c.name)}</span><span class="clip-tc">${(c.outPoint - c.inPoint).toFixed(1)}s</span>`;
      el.appendChild(head);

      const wave = document.createElement('div');
      wave.className = 'clip-wave';
      const cv = document.createElement('canvas');
      cv.width = 200; cv.height = 30;
      wave.appendChild(cv);
      el.appendChild(wave);

      // Render waveform for audio clips (and video clips that have audio)
      const media = s.media.find((m) => m.id === c.mediaId);
      if (media) {
        const peaks = getCachedPeaks(media.id);
        const dur = media.duration || (c.outPoint - c.inPoint);
        // Schedule canvas size after layout
        requestAnimationFrame(() => drawWaveform(cv, peaks, c.inPoint, c.outPoint, dur));
        if (!peaks && (media.kind === 'audio' || media.kind === 'video')) {
          computePeaks(media).then((p) => {
            if (p) requestAnimationFrame(() => drawWaveform(cv, p, c.inPoint, c.outPoint, dur));
          });
        }
      }

      if (c.fx?.length) {
        const fx = document.createElement('div');
        fx.className = 'clip-fx';
        c.fx.forEach((f) => {
          const t = document.createElement('span');
          t.className = 'fx-tag';
          t.textContent = f.kind.toUpperCase();
          fx.appendChild(t);
        });
        el.appendChild(fx);
      }

      const hl = document.createElement('div'); hl.className = 'handle l'; el.appendChild(hl);
      const hr = document.createElement('div'); hr.className = 'handle r'; el.appendChild(hr);
      body.appendChild(el);
    }
  }

  // playhead
  const ph = document.getElementById('playhead');
  ph.style.height = (tracksEl().scrollHeight) + 'px';
  ph.style.left = (s.playhead * z + 56) + 'px';
  ph.style.top = '24px';
  document.getElementById('tl-tc').textContent = formatTC(s.playhead, s.project.fps);
}

function tracksEl() { return document.getElementById('tracks'); }

function drawWave(canvas, clip, state) {
  const media = state.media.find((m) => m.id === clip.mediaId);
  const ctx = canvas.getContext('2d');
  canvas.width = Math.max(50, (clip.outPoint - clip.inPoint) * state.timeline.zoom);
  canvas.height = 30;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!media?.waves) {
    // synth a placeholder
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, 12, canvas.width, 6);
    return;
  }
  const peaks = media.waves;
  const sr = 100;
  const startI = Math.floor(clip.inPoint * sr);
  const endI = Math.min(peaks.length, Math.floor(clip.outPoint * sr));
  ctx.fillStyle = clip.meme ? '#f5a524' : (clip.track.startsWith('A') ? '#4ade80' : '#60a5fa');
  const n = endI - startI;
  if (n <= 0) return;
  for (let x = 0; x < canvas.width; x++) {
    const i = startI + Math.floor((x / canvas.width) * n);
    const v = peaks[i] || 0;
    const h = v * canvas.height * 0.9;
    ctx.fillRect(x, (canvas.height - h) / 2, 1, h);
  }
}

function escape(s) { return (s || '').toString().replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c])); }

function formatTC(t, fps = 30, withFrames = true) {
  if (!isFinite(t)) t = 0;
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = Math.floor(t % 60);
  const ff = Math.floor((t % 1) * fps);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${withFrames ? ':' + pad(ff) : ''}`;
}

// Render the beat-grid overlay. Looks up the first clip on the timeline
// with attached _bpmBeats, then draws one vertical line per beat inside
// the visible timeline width. Every 4th beat is colored as a "downbeat".
function renderBeatGrid(width, zoom, state) {
  const grid = document.getElementById('beat-grid');
  if (!grid) return;
  if (!state.timeline.beatGrid) { grid.innerHTML = ''; return; }
  // Find any clip with _bpmBeats
  let beats = null;
  for (const k of Object.keys(state.timeline.tracks)) {
    for (const c of state.timeline.tracks[k]) {
      if (c._bpmBeats && c._bpmBeats.length) { beats = c._bpmBeats; break; }
    }
    if (beats) break;
  }
  if (!beats) { grid.innerHTML = ''; return; }
  grid.style.width = width + 'px';
  grid.innerHTML = '';
  const maxX = width;
  // beats[] is in seconds. Draw only those within the visible window.
  for (let i = 0; i < beats.length; i++) {
    const x = beats[i] * zoom;
    if (x < -10 || x > maxX + 10) continue;
    const line = document.createElement('div');
    line.className = 'beat-line' + (i % 4 === 0 ? ' downbeat' : '');
    line.style.left = x + 'px';
    grid.appendChild(line);
  }
}
