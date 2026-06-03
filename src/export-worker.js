// export-worker.js — Off-main-thread export timing.
// The heavy part of export is the canvas draw + effects, which MUST run
// on the main thread (it owns the canvas). MediaRecorder runs off-thread
// internally. What we *can* offload is the render-loop pacing + ETA math,
// so the main thread can yield to UI updates.
//
// Protocol:
//   host → worker: { type: 'start', fps, end, totalEstimateMs }
//   worker → host: { type: 'tick', frame }   // request a step
//   host → worker: { type: 'progress', frame, elapsedMs }
//   worker → host: { type: 'eta', etaMs, speedFactor }
//   worker → host: { type: 'done' }

let timer = null;
let frame = 0;
let fps = 30;
let end = 0;
let firstTs = 0;
let lastProgressMs = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') {
    fps = m.fps;
    end = m.end;
    frame = 0;
    firstTs = performance.now();
    lastProgressMs = firstTs;
    // Schedule the first frame
    tick();
  } else if (m.type === 'progress') {
    frame = m.frame;
    const elapsedMs = performance.now() - firstTs;
    if (frame > 0.5) {
      const totalMs = elapsedMs * (end / frame);
      const etaMs = Math.max(0, totalMs - elapsedMs);
      const speedFactor = frame / (elapsedMs / 1000);
      self.postMessage({ type: 'eta', etaMs, speedFactor, frame });
    }
    if (frame > end) {
      self.postMessage({ type: 'done' });
      return;
    }
    // Schedule next frame at the requested interval
    const interval = 1000 / fps;
    const next = interval - (performance.now() - lastProgressMs) + (m.drift || 0);
    timer = setTimeout(tick, Math.max(0, next));
  } else if (m.type === 'cancel') {
    if (timer) clearTimeout(timer);
    timer = null;
    self.postMessage({ type: 'cancelled' });
  }
};

function tick() {
  self.postMessage({ type: 'tick', frame });
  lastProgressMs = performance.now();
}
