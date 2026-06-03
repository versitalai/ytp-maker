// audio.js — Web Audio mixer that actually plays the timeline
import { getState } from './state.js';

let ctx = null;
const nodes = new Map();        // mediaId -> { source, gain, pan, filter }
let lastPlayhead = 0;
let playing = false;
let loopHandle = null;

export function ensureCtx() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export function startMixer() {
  function tick() {
    loopHandle = requestAnimationFrame(tick);
    const s = getState();
    if (s.playing !== playing) {
      playing = s.playing;
      if (!playing) { stopAll(); lastPlayhead = s.playhead; return; }
    }
    if (!playing) return;
    const t = s.playhead;
    if (t < lastPlayhead - 0.1) stopAll();   // scrub backwards
    lastPlayhead = t;
    for (const trk of ['A1', 'A2', 'V1', 'V2']) {
      for (const c of s.timeline.tracks[trk]) {
        const dur = c.outPoint - c.inPoint;
        const local = t - c.start;
        if (local < 0 || local > dur) continue;
        ensureClipPlaying(c, local, s);
      }
    }
  }
  loopHandle = requestAnimationFrame(tick);
}

function ensureClipPlaying(clip, local, state) {
  const c = ensureCtx();
  if (c.state === 'suspended') c.resume();
  let n = nodes.get(clip.id);
  if (n && n.started) return n;       // already going for this round
  if (!n) {
    const media = state.media.find((m) => m.id === clip.mediaId);
    if (!media) return null;
    const el = document.createElement('audio');
    el.src = media.url;
    el.crossOrigin = 'anonymous';
    el.muted = false;
    const src = c.createMediaElementSource(el);
    const gain = c.createGain();
    gain.gain.value = clip.transform.v * state.audio.gain;
    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    src.connect(gain).connect(pan || c.destination).connect(c.destination);
    n = { el, src, gain, pan, started: false, startLocal: 0, sourceT: 0 };
    nodes.set(clip.id, n);
  }
  // compute source time
  const { sourceT } = resolveLocal(clip, local);
  n.el.currentTime = sourceT;
  n.el.playbackRate = 1;     // we don't yet implement time-stretch; pitch via preservesPitch
  n.el.play().catch(() => {});
  n.started = true;
  n.startLocal = local;
  n.sourceT = sourceT;
  // auto-stop after clip duration
  const dur = clip.outPoint - clip.inPoint;
  setTimeout(() => {
    if (n.started) { n.el.pause(); n.started = false; }
  }, Math.max(50, (dur - local) * 1000 + 50));
}

function resolveLocal(clip, local) {
  // mirrors ytp.js resolveSegment but only for sourceT
  for (const f of clip.fx) {
    if (f.segs) {
      let acc = 0;
      for (const seg of f.segs) {
        const segDur = Math.abs(seg.t1 - seg.t0);
        if (local < acc + segDur) {
          return { sourceT: seg.t0 + (local - acc) * (seg.speed || 1) };
        }
        acc += segDur;
      }
    }
  }
  return { sourceT: clip.inPoint + local };
}

function stopAll() {
  for (const n of nodes.values()) {
    try { n.el.pause(); } catch {}
    n.started = false;
  }
}
