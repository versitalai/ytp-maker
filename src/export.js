// export.js — Render the canvas to a WebM file using MediaRecorder.
// Frame pacing is offloaded to export-worker.js so the main thread can
// yield to UI updates between frames.
import { getState, toast } from './state.js';

let _pacingWorker = null;
let _cancelFlag = false;

export function cancelExport() {
  _cancelFlag = true;
  if (_pacingWorker) { _pacingWorker.postMessage({ type: 'cancel' }); _pacingWorker.terminate(); _pacingWorker = null; }
}

export async function exportProject() {
  const _result = { ok: false, url: null, size: 0 };
  try {
    return await _exportProjectInner();
  } catch (e) {
    toast('Export failed: ' + (e?.message || e));
    console.error('export failed:', e);
    exportError(e);
    return _result;
  }
}

async function _exportProjectInner() {
  const s = getState();
  const [w, h] = (document.getElementById('ex-res').value || '1280×720').split('×').map(Number);
  const fps = parseInt(document.getElementById('ex-fps').value);
  const br = parseInt(document.getElementById('ex-br').value) * 1_000_000;

  // Set resolution
  const canvas = document.getElementById('preview');
  const orig = [canvas.width, canvas.height];
  canvas.width = w; canvas.height = h;

  // Start from beginning
  toast('Rendering…');
  setPlayhead(0, false);
  await new Promise((r) => setTimeout(r, 100));

  const stream = canvas.captureStream(fps);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: br });
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));
  rec.start();

  const end = computeEnd();
  _cancelFlag = false;

  // Spawn pacing worker (relative to this module URL, must be at the same
  // origin; works in GitHub Pages because the file is in /src/)
  try {
    _pacingWorker = new Worker(new URL('./export-worker.js', import.meta.url));
  } catch (e) {
    // Some embedders (jsdom, file://) block Worker — fall back to main-thread loop
    _pacingWorker = null;
  }

  if (_pacingWorker) {
    await runWithWorker(_pacingWorker, end, fps);
  } else {
    await runOnMainThread(end, fps);
  }

  if (_cancelFlag) {
    rec.stop();
    await done.catch(() => {});
    canvas.width = orig[0]; canvas.height = orig[1];
    setPlayhead(0, false);
    toast('Export cancelled');
    if (_pacingWorker) { _pacingWorker.terminate(); _pacingWorker = null; }
    return;
  }

  rec.stop();
  await done;

  // restore
  canvas.width = orig[0]; canvas.height = orig[1];
  setPlayhead(0, false);
  if (_pacingWorker) { _pacingWorker.terminate(); _pacingWorker = null; }

  const blob = new Blob(chunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (s.project.name || 'ytp') + '.webm';
  a.click();
  // Revoke the URL after a short delay so the download has time to start
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast('Export complete');
  // Notify the render queue (if running). Detail carries the blob URL + size
  // so the queue can attach a download link without re-reading the blob.
  window.dispatchEvent(new CustomEvent('ytp-export-complete', { detail: { url, size: blob.size, name: a.download } }));
}

function exportError(err) {
  window.dispatchEvent(new CustomEvent('ytp-export-error', { detail: { message: err?.message || String(err) } }));
}

function runWithWorker(worker, end, fps) {
  return new Promise((resolve) => {
    let frame = 0;
    let drift = 0;
    let startTs = performance.now();
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'tick') {
        if (_cancelFlag) { resolve(); return; }
        const t = m.frame;
        setPlayhead(t, true);
        const pct = end > 0 ? (t / end * 100) : 100;
        document.getElementById('ex-status').textContent = `Rendering ${pct.toFixed(1)}%`;
        document.querySelector('#ex-progress > div').style.width = pct + '%';
        // Track drift so the worker can compensate
        drift = performance.now() - startTs - (t * 1000 / fps);
        worker.postMessage({ type: 'progress', frame: t + 1 / fps, drift });
        if (t >= end) resolve();
      } else if (m.type === 'eta') {
        const etaEl = document.getElementById('ex-eta');
        if (etaEl) etaEl.textContent = `${((m.frame / end) * 100).toFixed(0)}% • ETA ${formatMs(m.etaMs)} • ${m.speedFactor.toFixed(2)}× realtime`;
      } else if (m.type === 'done') {
        resolve();
      }
    };
    startTs = performance.now();
    worker.postMessage({ type: 'start', fps, end });
  });
}

function runOnMainThread(end, fps) {
  return new Promise((resolve) => {
    const stepMs = 1000 / fps;
    const tStart = performance.now();
    (function loop() {
      let t = 0;
      const tick = () => {
        if (_cancelFlag || t > end) { resolve(); return; }
        setPlayhead(t, true);
        const pct = end > 0 ? (t / end * 100) : 100;
        document.getElementById('ex-status').textContent = `Rendering ${pct.toFixed(1)}%`;
        document.querySelector('#ex-progress > div').style.width = pct + '%';
        if (t > 0.5) {
          const elapsedMs = performance.now() - tStart;
          const totalMs = elapsedMs * (end / t);
          const remainingMs = Math.max(0, totalMs - elapsedMs);
          const speedFactor = t / ((performance.now() - tStart) / 1000);
          const etaEl = document.getElementById('ex-eta');
          if (etaEl) etaEl.textContent = `${pct.toFixed(0)}% • ETA ${formatMs(remainingMs)} • ${speedFactor.toFixed(2)}× realtime`;
        }
        t += 1 / fps;
        setTimeout(tick, stepMs);
      };
      tick();
    })();
  });
}

function setPlayhead(t, playing) {
  import('./state.js').then(({ setState }) => {
    setState((s) => ({ ...s, playhead: t, playing }), { skipHistory: true });
  });
}

function computeEnd() {
  const s = getState();
  let max = 0;
  for (const k of Object.keys(s.timeline.tracks)) {
    for (const c of s.timeline.tracks[k]) max = Math.max(max, c.start + (c.outPoint - c.inPoint));
  }
  return max;
}

function formatMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${r.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}
