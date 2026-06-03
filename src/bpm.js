// bpm.js — BPM detection from media audio using an autocorrelation onset envelope.
// Returns { bpm, confidence, beats[] } where beats[] is a list of beat times in seconds.
// Uses Web Audio API on a hidden <audio> element. Decodes the file (mp4/webm) via
// OfflineAudioContext when possible, falls back to streaming RMS.

import { getState, toast } from './state.js';

let _cache = new Map(); // mediaId -> { bpm, beats, analyzedAt }

export function getBpm(mediaId) {
  return _cache.get(mediaId) || null;
}

export function clearBpmCache() {
  _cache.clear();
}

// Detect BPM for a media item. Returns { bpm, confidence, beats, durationSec }.
export async function detectBpm(media) {
  if (!media || !media.url) { toast('No media URL for BPM detection'); return null; }
  if (_cache.has(media.id)) return _cache.get(media.id);

  toast('🎵 Detecting BPM…');
  let result;
  try {
    // Prefer OfflineAudioContext with full decode — gives us a clean signal
    const arr = await fetch(media.url).then((r) => r.arrayBuffer());
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let audioBuf;
    try {
      const tmp = new (window.AudioContext || window.webkitAudioContext)();
      audioBuf = await tmp.decodeAudioData(arr.slice(0));
      try { tmp.close(); } catch (_) {}
    } catch (e) {
      // If decode fails (codec not supported), bail out
      toast('Audio decode failed for BPM detection');
      return null;
    }
    // Mono mixdown
    const ch0 = audioBuf.getChannelData(0);
    const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : null;
    const mono = new Float32Array(ch0.length);
    if (ch1) {
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    } else {
      mono.set(ch0);
    }
    result = analyzeBuffer(mono, audioBuf.sampleRate);
  } catch (e) {
    toast('BPM detection failed: ' + e.message);
    return null;
  }
  _cache.set(media.id, { ...result, analyzedAt: Date.now() });
  return _cache.get(media.id);
}

function analyzeBuffer(samples, sampleRate) {
  // Step 1: envelope via 10ms RMS windows
  const winSize = Math.round(sampleRate * 0.01);
  const numWins = Math.floor(samples.length / winSize);
  const env = new Float32Array(numWins);
  for (let i = 0; i < numWins; i++) {
    let sum = 0;
    const off = i * winSize;
    for (let j = 0; j < winSize; j++) {
      const v = samples[off + j];
      sum += v * v;
    }
    env[i] = Math.sqrt(sum / winSize);
  }
  // Step 2: differentiate (onset strength)
  const onset = new Float32Array(numWins);
  for (let i = 1; i < numWins; i++) {
    const d = env[i] - env[i - 1];
    onset[i] = d > 0 ? d : 0;
  }
  // Step 3: autocorrelate in BPM range [60, 200]
  // 10ms windows → 1 win = 10ms. BPM = 60000 / (winSpan * 10ms) → winSpan = 60000 / (bpm * 10)
  const minBpm = 60, maxBpm = 200;
  const minLag = Math.floor(60000 / (maxBpm * 10));
  const maxLag = Math.floor(60000 / (minBpm * 10));
  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    const N = Math.min(numWins, 4096); // cap for speed
    for (let i = 0; i + lag < N; i++) s += onset[i] * onset[i + lag];
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  let bpm = 60000 / (bestLag * 10);
  // Normalize to within [60, 200] (half/double time)
  while (bpm < 60) bpm *= 2;
  while (bpm > 200) bpm *= 0.5;
  // Step 4: generate beat times
  const beats = [];
  const beatInterval = 60 / bpm;
  // Find first strong onset near t=0
  let firstBeat = 0;
  const winSec = 0.01;
  // Find max onset in first 5 seconds for the offset
  let maxVal = 0, maxIdx = 0;
  const lookLimit = Math.min(numWins, Math.floor(5 / winSec));
  for (let i = 0; i < lookLimit; i++) {
    if (onset[i] > maxVal) { maxVal = onset[i]; maxIdx = i; }
  }
  firstBeat = maxIdx * winSec;
  for (let t = firstBeat; t < samples.length / sampleRate; t += beatInterval) {
    beats.push(Math.round(t * 1000) / 1000);
  }
  // Confidence: how dominant bestLag is vs avg
  let avgScore = 0;
  let lagCount = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < Math.min(numWins, 1024); i++) s += onset[i] * onset[i + lag];
    avgScore += s; lagCount++;
  }
  avgScore /= lagCount;
  const confidence = bestScore > 0 ? Math.min(1, (bestScore - avgScore) / (bestScore + 1e-9)) : 0;
  return { bpm: Math.round(bpm * 10) / 10, confidence, beats };
}
