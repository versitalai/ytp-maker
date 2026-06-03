// transcript.js — sentence / word / phoneme detection
// Browser-only, no server. Two strategies:
//
//   1) Web Speech API (built into Chromium):
//      - Real transcript with timing
//      - Works while audio is playing through a MediaStream
//      - Free, zero install, no model download
//      - Falls back to (2) when unsupported (Firefox/Safari)
//
//   2) Voice-Activity-Detection (VAD) on the decoded audio buffer:
//      - Detects word boundaries by silent gaps
//      - Splits into "chunks" (silence breaks), exposes them as fake words
//      - Always available, no API needed
//      - For files with no transcript: chop by silence is still useful!
import { getState, setState, uid, toast } from './state.js';

// ----- (1) Web Speech API ---------------------------------------------
let _recognition = null;
let _recognitionUnsub = null;

export function webSpeechAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function makeRecognition() {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) return null;
  const rec = new R();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  return rec;
}

/**
 * Start a live transcript session on a MediaStream from the given media element.
 * Returns a function to stop + an onUpdate callback registry.
 */
export function startLiveTranscript(media, onUpdate) {
  if (!webSpeechAvailable()) return null;
  if (_recognition) stopLiveTranscript();
  _recognition = makeRecognition();

  const words = [];
  let segmentIndex = 0;
  let lastEnd = 0;
  let sentenceStart = 0;
  const sentences = [];

  // Pipe the media through WebAudio so we can route it to SpeechRecognition.
  // SpeechRecognition works on a MediaStream (Chrome), so we make a destination.
  const ctx = window.__ytpAudio || (window.__ytpAudio = new (window.AudioContext || window.webkitAudioContext)());
  const src = ctx.createMediaElementSource(media.el);
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  src.connect(ctx.destination); // keep audible

  _recognition.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      const alt = result[0];
      // Use the media's currentTime (account for any offset) as the time stamp
      const t = media.el.currentTime;
      // Split the new text into words
      const newWords = alt.transcript.trim().split(/\s+/);
      if (result.isFinal) {
        newWords.forEach((w) => {
          if (!w) return;
          words.push({
            idx: words.length,
            text: w.replace(/[^a-z0-9']/gi, '').toLowerCase(),
            t0: lastEnd,
            t1: t,
          });
          lastEnd = t;
          // Sentence boundary: ending punctuation
          if (/[.!?]/.test(w)) {
            sentences.push({
              idx: sentences.length,
              t0: sentenceStart,
              t1: t,
              words: words.slice(segmentIndex).map((w2) => w2.idx),
            });
            sentenceStart = t;
            segmentIndex = words.length;
          }
        });
      }
    }
    onUpdate?.({ words, sentences, source: 'webspeech' });
  };

  _recognition.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      console.warn('SpeechRecognition error', e.error);
    }
  };

  try { _recognition.start(); } catch (_) { return null; }

  _recognitionUnsub = () => {
    try { _recognition?.stop(); } catch (_) {}
    try { src.disconnect(); } catch (_) {}
  };
  return _recognitionUnsub;
}

export function stopLiveTranscript() {
  _recognitionUnsub?.();
  _recognitionUnsub = null;
  _recognition = null;
}

// ----- (2) VAD-based word chopping ------------------------------------
/**
 * Split an audio buffer into "words" by detecting silent gaps.
 * Each returned word = a non-silent region between silences.
 * Returns { words: [{t0,t1,text}], sentences: [...] }
 * - 'text' is synthetic ("chunk 0", "chunk 1", …) since we have no ASR.
 */
export function vadChunk(media, opts = {}) {
  const { minSilenceMs = 250, silenceThreshold = 0.015, minChunkMs = 80 } = opts;
  if (!media.waves && !media.file) {
    toast('Load the media first.');
    return null;
  }
  // Use a temporary <audio> element to scan volume over time
  return new Promise((resolve) => {
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.src = media.url;
    el.controls = false;
    el.style.display = 'none';
    document.body.appendChild(el);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    el.oncanplay = async () => {
      const src = ac.createMediaElementSource(el);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      // Don't connect to destination - we don't need to hear it
      const buf = new Float32Array(analyser.fftSize);
      const dur = el.duration;
      const stepMs = 20;
      const samples = Math.ceil((dur * 1000) / stepMs);
      const env = new Float32Array(samples);
      const start = performance.now();
      el.play();
      await new Promise((r) => requestAnimationFrame(r));
      const startWall = performance.now();
      while (performance.now() - startWall < dur * 1000 + 200) {
        analyser.getFloatTimeDomainData(buf);
        let rms = 0;
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
        const idx = Math.min(samples - 1, Math.floor((performance.now() - startWall) / stepMs));
        env[idx] = rms;
        await new Promise((r) => setTimeout(r, stepMs));
        if (el.ended) break;
      }
      el.pause();
      // Threshold + find non-silent runs
      const words = [];
      let inWord = false;
      let wStart = 0;
      const minSilence = minSilenceMs / stepMs;
      for (let i = 0; i < env.length; i++) {
        const loud = env[i] > silenceThreshold;
        if (loud && !inWord) { wStart = i; inWord = true; }
        else if (!loud && inWord) {
          // confirm silence length so far
          let j = i;
          while (j < env.length && env[j] <= silenceThreshold) j++;
          if (j - i >= minSilence) {
            const t0 = (wStart * stepMs) / 1000;
            const t1 = (i * stepMs) / 1000;
            if ((t1 - t0) * 1000 >= minChunkMs) {
              words.push({ idx: words.length, text: `chunk ${words.length}`, t0, t1 });
            }
            i = j - 1;
            inWord = false;
          }
        }
      }
      if (inWord) {
        const t0 = (wStart * stepMs) / 1000;
        const t1 = (env.length * stepMs) / 1000;
        if ((t1 - t0) * 1000 >= minChunkMs) {
          words.push({ idx: words.length, text: `chunk ${words.length}`, t0, t1 });
        }
      }
      // Group chunks into "sentences" of ~5 chunks each (arbitrary)
      const sentences = [];
      const perSentence = 5;
      for (let s = 0; s < words.length; s += perSentence) {
        const slice = words.slice(s, s + perSentence);
        if (!slice.length) continue;
        sentences.push({
          idx: sentences.length,
          t0: slice[0].t0,
          t1: slice[slice.length - 1].t1,
          words: slice.map((w) => w.idx),
        });
      }
      el.remove();
      try { ac.close(); } catch (_) {}
      resolve({ words, sentences, source: 'vad' });
    };
    el.onerror = () => { el.remove(); try { ac.close(); } catch(_){} resolve(null); };
  });
}

// ----- Auto-chop by silence: detect silence boundaries, bake as clips
export async function chopBySilence(mediaIdOrNull, opts = {}) {
  const { minSilenceMs = 200, minChunkMs = 250, threshold = 0.015 } = opts;
  const s = getState();
  const media = mediaIdOrNull
    ? s.media.find((m) => m.id === mediaIdOrNull)
    : s.activeMediaId
      ? s.media.find((m) => m.id === s.activeMediaId)
      : s.media[0];
  if (!media) { toast('No media to chop'); return; }
  toast('🔪 Detecting silence…');
  const result = await vadChunk(media, { minSilenceMs, silenceThreshold: threshold, minChunkMs });
  if (!result) { toast('Silence detection failed'); return; }
  const words = result.words;
  if (!words.length) { toast('No words found — try a higher threshold'); return; }
  // Bake all detected words as separate clips
  bakeSelectedToTimeline(media.id, words.map((_, i) => i));
  toast(`🔪 Chopped into ${words.length} word-clip(s)`);
}

// ----- Active media transcript glue -----------------------------------
export function getTranscript(mediaId) {
  return getState().transcript?.[mediaId] || null;
}

export function activeMedia() {
  const s = getState();
  return s.media.find((m) => m.id === s.activeMediaId) || null;
}

export async function detectForActive(opts = {}) {
  const m = activeMedia();
  if (!m) { toast('Add a media file first'); return; }
  toast(`Detecting words in "${m.name}"…`);
  let transcript = null;
  // Try VAD first (always works). Web Speech requires a live playhead.
  if (m.file) {
    transcript = await vadChunk(m);
  }
  if (!transcript && m.el) {
    const unsub = startLiveTranscript(m, (t) => setState((s) => ({
      ...s,
      transcript: { ...s.transcript, [m.id]: t },
    })));
    toast('Web Speech running — press Play to transcribe live.');
    return unsub;
  }
  if (transcript) {
    setState((s) => ({
      ...s,
      transcript: { ...s.transcript, [m.id]: transcript },
    }));
    toast(`Detected ${transcript.words.length} chunks in ${m.name}`);
  }
}

// ----- Word → phoneme (very rough; "fake phoneme" boundaries) --------
// Splits a word chunk into 3 equal sub-spans so users can micro-edit.
export function wordToPhonemes(media, wordIdx) {
  const tr = getTranscript(media.id);
  if (!tr) return [];
  const w = tr.words[wordIdx];
  if (!w) return [];
  const dur = w.t1 - w.t0;
  const n = 3;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      idx: i,
      t0: w.t0 + (dur * i) / n,
      t1: w.t0 + (dur * (i + 1)) / n,
    });
  }
  return out;
}

// ----- "Bake selected words to timeline" -------------------------------
export function bakeSelectedToTimeline(mediaIdOrIndices, indicesMaybe) {
  // Accept either (indices) — uses active media — or (mediaId, indices)
  let mediaId, indices;
  if (typeof mediaIdOrIndices === 'string' && Array.isArray(indicesMaybe)) {
    mediaId = mediaIdOrIndices; indices = indicesMaybe;
  } else {
    indices = mediaIdOrIndices;
    const m = activeMedia();
    if (!m) { toast('No active media'); return; }
    mediaId = m.id;
  }
  const s = getState();
  const m = s.media.find((x) => x.id === mediaId);
  if (!m || !m.transcript) { toast('Detect words first'); return; }
  // Pick the V1 video track (canonical schema: timeline.tracks.V1)
  const trackKey = 'V1';
  const newClips = indices
    .map((i) => m.transcript.words[i])
    .filter(Boolean)
    .map((w) => ({
      id: uid('clip'),
      trackId: trackKey,
      mediaId: m.id,
      start: 0,
      inPoint: w.t0,
      outPoint: w.t1,
      transform: { x: 0, y: 0, scale: 1, rot: 0, opacity: 1 },
      fx: [],
      audio: { volume: 1, pan: 0, pitch: 0, muted: false },
    }));
  if (!newClips.length) return;
  setState((s2) => {
    const trk = s2.timeline.tracks[trackKey];
    const end = trk.reduce((mx, c) => Math.max(mx, c.start + (c.outPoint - c.inPoint)), 0);
    const placed = newClips.map((c, i) => ({ ...c, start: end + (c.outPoint - c.inPoint) * i }));
    return {
      ...s2,
      timeline: {
        ...s2.timeline,
        tracks: { ...s2.timeline.tracks, [trackKey]: [...trk, ...placed] },
      },
    };
  });
  toast(`Baked ${newClips.length} clip(s) to ${trackKey}`);
}
