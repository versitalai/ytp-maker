// queue.js — Batch-render a project under multiple preset chains in series.
// For each selected preset, we apply it to a fresh state snapshot of every
// clip's FX, run the full exportProject pipeline, and emit a downloadable
// WebM. The "ORIGINAL" entry skips preset application (so the user gets
// their existing project as a separate file).
import { getState, setState, toast } from './state.js';
import { applyPreset, PRESETS } from './ytp.js';
import { exportProject, cancelExport } from './export.js';

let _running = false;
let _abort = false;
let _presetsOriginalFx = null; // remembered per-clip FX so we can restore between variants

function snapshotFx() {
  const s = getState();
  const tracks = {};
  for (const k of Object.keys(s.timeline.tracks)) {
    tracks[k] = s.timeline.tracks[k].map((c) => ({ id: c.id, fx: structuredClone(c.fx || []) }));
  }
  return tracks;
}

function restoreFx(snapshot) {
  setState((st) => {
    const tracks = { ...st.timeline.tracks };
    for (const k of Object.keys(snapshot)) {
      for (const i = 0; i < tracks[k].length; i++) {
        const f = snapshot[k].find((x) => x.id === tracks[k][i].id);
        if (f) tracks[k] = tracks[k].map((c, idx) => idx === i ? { ...c, fx: structuredClone(f.fx) } : c);
      }
    }
    return { ...st, timeline: { ...st.timeline, tracks } };
  });
}

function applyPresetToAllClips(presetName) {
  if (presetName === 'ORIGINAL') return;
  const preset = PRESETS[presetName];
  if (!preset) return;
  setState((st) => {
    const tracks = { ...st.timeline.tracks };
    for (const k of Object.keys(tracks)) {
      for (let i = 0; i < tracks[k].length; i++) {
        const c = tracks[k][i];
        if (c.meme) continue; // don't pollute meme clips
        const sel = st.selectedClipId === c.id;
        tracks[k] = tracks[k].map((cc, idx) => {
          if (idx !== i) return cc;
          return { ...cc, fx: preset.build({ clip: cc, allClips: tracks, selected: sel }) };
        });
      }
    }
    return { ...st, timeline: { ...st.timeline, tracks } };
  });
}

function addQueueItem(label) {
  const li = document.createElement('li');
  li.dataset.label = label;
  const name = document.createElement('span');
  name.textContent = label;
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = 'queued';
  li.appendChild(name);
  li.appendChild(status);
  document.getElementById('queue-list').appendChild(li);
  return { li, status };
}

function setStatus(handle, text, cls) {
  handle.status.textContent = text;
  handle.li.classList.remove('running', 'done', 'failed');
  if (cls) handle.li.classList.add(cls);
}

export function isQueueRunning() { return _running; }

export async function runQueue(presetList) {
  if (_running) { toast('Queue already running'); return; }
  const list = presetList && presetList.length ? presetList : ['ORIGINAL'];
  // Clear the visible list
  const ul = document.getElementById('queue-list');
  if (ul) ul.innerHTML = '';
  const go = document.getElementById('btn-queue-render');
  const cancel = document.getElementById('btn-queue-cancel');
  if (go) go.style.display = 'none';
  if (cancel) cancel.style.display = '';
  _running = true;
  _abort = false;

  // Snapshot original FX so we can restore at the end
  _presetsOriginalFx = snapshotFx();

  // Hook up global onExportComplete by reading the most-recent blob URL
  // We override window.URL.createObjectURL in export.js — instead, we listen to
  // a custom event the export module already dispatches.
  let results = 0;
  for (const presetName of list) {
    if (_abort) { toast('Queue cancelled'); break; }
    const handle = addQueueItem(presetName);
    setStatus(handle, 'rendering…', 'running');
    applyPresetToAllClips(presetName);
    try {
      const blob = await new Promise((resolve, reject) => {
        // exportProject now emits 'ytp-export-complete' with detail={url,size}
        const onDone = (e) => {
          window.removeEventListener('ytp-export-complete', onDone);
          window.removeEventListener('ytp-export-error', onErr);
          resolve(e.detail);
        };
        const onErr = (e) => {
          window.removeEventListener('ytp-export-complete', onDone);
          window.removeEventListener('ytp-export-error', onErr);
          reject(new Error(e.detail?.message || 'export failed'));
        };
        window.addEventListener('ytp-export-complete', onDone);
        window.addEventListener('ytp-export-error', onErr);
        exportProject().catch((err) => {
          window.removeEventListener('ytp-export-complete', onDone);
          window.removeEventListener('ytp-export-error', onErr);
          reject(err);
        });
      });
      // Save the result as a download link in the list item
      const link = document.createElement('a');
      link.href = blob.url;
      link.download = `ytp-${presetName.toLowerCase().replace(/\s+/g, '-')}.webm`;
      link.textContent = `↓ ${(blob.size / 1024).toFixed(0)} KB`;
      handle.status.innerHTML = '';
      handle.status.appendChild(link);
      handle.li.classList.remove('running');
      handle.li.classList.add('done');
      results++;
    } catch (err) {
      console.error('queue render failed:', err);
      setStatus(handle, 'failed: ' + (err.message || err), 'failed');
    }
    // Always restore FX so the next variant starts from the original
    restoreFx(_presetsOriginalFx);
  }
  if (go) go.style.display = '';
  if (cancel) cancel.style.display = 'none';
  _running = false;
  toast(`Render queue: ${results} of ${list.length} complete`);
}

export function cancelQueue() {
  if (!_running) return;
  _abort = true;
  cancelExport();
  toast('Cancelling queue…');
}
