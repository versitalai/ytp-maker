// export.js — Render the canvas to a WebM file using MediaRecorder
import { getState, toast } from './state.js';

export async function exportProject() {
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

  // step through timeline at real speed
  const end = computeEnd();
  const stepMs = 1000 / fps;
  for (let t = 0; t <= end; t += 1 / fps) {
    setPlayhead(t, true);
    document.getElementById('ex-status').textContent = `Rendering ${(t / end * 100).toFixed(1)}%`;
    document.querySelector('#ex-progress > div').style.width = (t / end * 100) + '%';
    await new Promise((r) => setTimeout(r, stepMs));
  }
  rec.stop();
  await done;

  // restore
  canvas.width = orig[0]; canvas.height = orig[1];
  setPlayhead(0, false);

  const blob = new Blob(chunks, { type: 'video/webm' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (s.project.name || 'ytp') + '.webm';
  a.click();
  toast('Export complete');
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
