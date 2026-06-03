// waveform.js — Render a small waveform into a canvas for a clip.
// Cache: waveform of [mediaId → peaks Float32Array(1024)].
// Peaks are computed from OfflineAudioContext.decodeAudioData when possible.

const _peaksCache = new Map(); // mediaId → Float32Array

export function getCachedPeaks(mediaId) {
  return _peaksCache.get(mediaId) || null;
}

export async function computePeaks(media) {
  if (!media || !media.url) return null;
  if (_peaksCache.has(media.id)) return _peaksCache.get(media.id);
  let peaks;
  try {
    const arr = await fetch(media.url).then((r) => r.arrayBuffer());
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await tmp.decodeAudioData(arr.slice(0));
    try { tmp.close(); } catch (_) {}
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    peaks = downsamplePeaks(ch0, ch1, 1024);
  } catch (e) {
    return null;
  }
  _peaksCache.set(media.id, peaks);
  return peaks;
}

function downsamplePeaks(ch0, ch1, numBins) {
  const out = new Float32Array(numBins);
  const total = ch0.length;
  const binSize = total / numBins;
  for (let i = 0; i < numBins; i++) {
    const start = Math.floor(i * binSize);
    const end = Math.min(total, Math.floor((i + 1) * binSize));
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = ch1 ? (ch0[j] + ch1[j]) * 0.5 : ch0[j];
      const a = Math.abs(v);
      if (a > max) max = a;
    }
    out[i] = max;
  }
  // Normalize
  let peak = 0;
  for (let i = 0; i < numBins; i++) if (out[i] > peak) peak = out[i];
  if (peak > 0) {
    for (let i = 0; i < numBins; i++) out[i] = out[i] / peak;
  }
  return out;
}

// Draw the waveform into a canvas for a clip's visible range.
export function drawWaveform(canvas, peaks, inPoint, outPoint, duration) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width = canvas.clientWidth || 200;
  const h = canvas.height = canvas.clientHeight || 28;
  ctx.clearRect(0, 0, w, h);
  if (!peaks || !duration) {
    // Fallback: flat line
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    return;
  }
  const startFrac = Math.max(0, Math.min(1, inPoint / duration));
  const endFrac = Math.max(0, Math.min(1, outPoint / duration));
  const startBin = Math.floor(startFrac * peaks.length);
  const endBin = Math.ceil(endFrac * peaks.length);
  const span = Math.max(1, endBin - startBin);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  const mid = h / 2;
  // Render min/max bars per pixel column
  for (let x = 0; x < w; x++) {
    const a = startBin + Math.floor((x / w) * span);
    const b = startBin + Math.floor(((x + 1) / w) * span);
    let max = 0;
    for (let i = a; i <= b && i < peaks.length; i++) {
      if (peaks[i] > max) max = peaks[i];
    }
    const hh = max * (h * 0.45);
    ctx.fillRect(x, mid - hh, 1, Math.max(1, hh * 2));
  }
}
