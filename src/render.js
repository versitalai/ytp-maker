// render.js — composes the preview canvas from timeline state at current playhead
// Uses a single HTMLVideoElement (or HTMLAudioElement) per source media, kept hidden,
// and seeks them as needed. The canvas composites all active tracks at time t.
import { getState } from './state.js';
import { resolveSegment, perFrameTransforms, audioRate } from './ytp.js';

const els = {};                    // hidden media elements keyed by mediaId
let lastDraw = 0;
let rafId = null;

export function initRender() {
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d', { alpha: false });

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = (now - lastDraw) / 1000;
    lastDraw = now;
    const s = getState();
    if (s.playing) {
      const newT = s.playhead + dt;
      // stop at end of last clip
      const end = computeProjectEnd();
      if (newT >= end) { setPlayhead(end, false); return; }
      setPlayhead(newT, true);
    }
    drawFrame(ctx, canvas);
  }
  lastDraw = performance.now();
  rafId = requestAnimationFrame(loop);
}

export function togglePlay() {
  const s = getState();
  setPlayhead(s.playhead, !s.playing);
}

function setPlayhead(t, playing) {
  import('./state.js').then(({ setState }) => {
    setState((s) => ({ ...s, playhead: t, playing }), { skipHistory: true });
  });
}

function getMediaEl(media) {
  if (!media) return null;
  if (els[media.id]) return els[media.id];
  const el = document.createElement(media.kind === 'video' ? 'video' : 'audio');
  el.src = media.url;
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  el.muted = true;                // we use Web Audio for output
  el.playsInline = true;
  els[media.id] = el;
  return el;
}

function computeProjectEnd() {
  const s = getState();
  let max = 0;
  for (const k of Object.keys(s.timeline.tracks)) {
    for (const c of s.timeline.tracks[k]) {
      max = Math.max(max, c.start + (c.outPoint - c.inPoint));
    }
  }
  return max || 60;
}

function drawFrame(ctx, canvas) {
  const s = getState();
  const { w, h } = s.project.resolution;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  // black bg
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  // Layered composition: V2 (top), V1, then audio sum (we just draw amplitudes)
  // Audio actually plays from Web Audio nodes — we just trigger them on play.
  for (const trackKey of ['V1', 'V2']) {
    for (const c of s.timeline.tracks[trackKey]) {
      const dur = c.outPoint - c.inPoint;
      const local = s.playhead - c.start;
      if (local < 0 || local > dur) continue;
      drawClip(ctx, canvas, c, local, w, h);
    }
  }
}

function drawClip(ctx, canvas, c, local, w, h) {
  const media = getState().media.find((m) => m.id === c.mediaId);
  if (!media) return;

  const el = getMediaEl(media);
  if (!el) return;

  // resolve which source timestamp
  const { sourceT, seg } = resolveSegment(c, local);
  const freezeFrame = seg?.freeze;

  // Sync element time (only if not playing a frozen frame)
  if (!freezeFrame) {
    const target = Math.max(0, Math.min(media.duration || 1e9, sourceT));
    if (Math.abs(el.currentTime - target) > 0.08) el.currentTime = target;
    if (getState().playing && el.paused) el.play().catch(() => {});
    if (!getState().playing && !el.paused) el.pause();
  }

  // Apply transforms
  const t = perFrameTransforms(c, local);
  ctx.save();
  ctx.globalAlpha = t.o;
  ctx.translate(w / 2 + (t.x * w / 2), h / 2 + (t.y * h / 2));
  ctx.rotate((t.r * Math.PI) / 180);
  ctx.scale(t.s, t.s);

  if (media.kind === 'video') {
    // Compute draw box — fit to canvas preserving aspect
    const vw = el.videoWidth || w;
    const vh = el.videoHeight || h;
    const r = Math.min(w / vw, h / vh);
    const dw = vw * r, dh = vh * r;
    // Apply face-warp filters as a 2D filter chain (cheap browser-side stand-in)
    if (c.fx?.some((f) => f.kind === 'mouth-warp')) {
      ctx.filter = 'contrast(1.4) saturate(2) hue-rotate(-10deg)';
    } else if (c.fx?.some((f) => f.kind === 'eye-distort')) {
      ctx.filter = 'contrast(1.2) saturate(1.5)';
    } else if (c.fx?.some((f) => f.kind === 'liquid-face')) {
      ctx.filter = 'blur(2px) contrast(1.3) saturate(1.8)';
    } else {
      ctx.filter = 'none';
    }
    try { ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh); } catch {}
    ctx.filter = 'none';
  } else {
    // audio clip — visualize peaks
    drawAudioClip(ctx, w, h, media, c);
  }

  // Color grading
  applyColor(ctx, w, h, getState().color);

  ctx.restore();

  // Captions overlay — find the topmost active clip with a transcript
  // whose local time falls inside one of its word windows.
  if (getState().captionsOn) {
    drawCaptions(ctx, w, h, c, local, media);
  }
}

function drawCaptions(ctx, w, h, clip, local, media) {
  // Look up transcript for this mediaId from global state
  const tr = getState().transcript?.[media.id];
  if (!tr?.words?.length) return;
  // `local` is playhead relative to clip start. Translate to source time
  // by remapping local ∈ [inPoint..outPoint] to source time.
  // The clip's local of 0 corresponds to source time = inPoint, so
  // sourceT = inPoint + local.
  const sourceT = (clip.inPoint || 0) + local;
  const word = tr.words.find((w) => sourceT >= w.t0 && sourceT <= w.t1);
  if (!word) return;
  const text = (word.text || '').toUpperCase();
  if (!text || text === 'CHUNK 0' || text.startsWith('CHUNK ')) return; // skip synthetic
  const cx = w / 2;
  const cy = h - Math.max(60, h * 0.1);
  ctx.save();
  ctx.font = `bold ${Math.floor(h * 0.07)}px Impact, "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // outline
  ctx.lineWidth = Math.max(3, h * 0.012);
  ctx.strokeStyle = 'black';
  ctx.fillStyle = 'white';
  ctx.strokeText(text, cx, cy);
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

function drawAudioClip(ctx, w, h, media, c) {
  if (!media.waves) return;
  const peaks = media.waves;
  const sr = 100;
  const startI = Math.floor(c.inPoint * sr);
  const endI = Math.min(peaks.length, Math.floor(c.outPoint * sr));
  const grad = ctx.createLinearGradient(0, h/2 - 50, 0, h/2 + 50);
  grad.addColorStop(0, 'rgba(74,222,128,0.6)');
  grad.addColorStop(0.5, 'rgba(74,222,128,0.9)');
  grad.addColorStop(1, 'rgba(74,222,128,0.6)');
  ctx.fillStyle = grad;
  for (let x = 0; x < w; x += 2) {
    const t = x / w;
    const i = startI + Math.floor(t * (endI - startI));
    const v = peaks[i] || 0;
    const hh = v * h * 0.4;
    ctx.fillRect(x, h/2 - hh, 1.5, hh * 2);
  }
}

function applyColor(ctx, w, h, c) {
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  const e = Math.exp(c.e);
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * e, g = d[i+1] * e, b = d[i+2] * e;
    // contrast
    r = (r - 128) * (1 + c.c) + 128;
    g = (g - 128) * (1 + c.c) + 128;
    b = (b - 128) * (1 + c.c) + 128;
    // gamma
    r = Math.pow(Math.max(0, r) / 255, 1/c.g) * 255;
    g = Math.pow(Math.max(0, g) / 255, 1/c.g) * 255;
    b = Math.pow(Math.max(0, b) / 255, 1/c.g) * 255;
    // saturation
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * c.s;
    g = lum + (g - lum) * c.s;
    b = lum + (b - lum) * c.s;
    // hue shift
    if (c.h) {
      const a = c.h * Math.PI / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nr = r * ca + g * sa;
      const ng = -r * sa + g * ca;
      const nb = b;
      r = nr; g = ng; b = nb;
    }
    d[i] = Math.max(0, Math.min(255, r));
    d[i+1] = Math.max(0, Math.min(255, g));
    d[i+2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(data, 0, 0);
}
