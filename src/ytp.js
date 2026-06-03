// ytp.js — YTP effect engine
// Each effect is a *function from {clip, t} → transform/override at time t in clip-local seconds*.
// The renderer applies the active effects chain in order. Effects can also *mutate* the clip
// (e.g. loop, stutter) to produce multiple sub-segments — in that case we store them in clip.fx
// and the renderer simply plays them in sequence with the same source media.
//
// Effects that need to bake (generate a list of mini-clips) do so by rewriting clip.fx into
// a 'segments' list consumed by the renderer.

import { getState, setState, patchIn, toast, uid } from './state.js';
import { activeMedia } from './transcript.js';

export const FX = {
  // ---------- REPEAT / LOOP ----------
  stutter: {
    label: 'STUTTER',
    desc: 'Repeats each frame 3× then continues',
    bake(clip) {
      const dur = clip.outPoint - clip.inPoint;
      const newSegs = [];
      const frameDur = 1 / 30;
      for (let t = 0; t < dur; t += frameDur) {
        for (let i = 0; i < 3; i++) {
          newSegs.push({ t0: t, t1: Math.min(t + frameDur, dur), speed: 1 });
        }
      }
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'stutter'), { kind: 'stutter', segs: newSegs }] };
    },
  },
  'loop-sentence': {
    label: 'LOOP-SENT',
    desc: 'Loops the current sentence 4×',
    bake(clip) {
      const tr = getTranscriptFor(clip.mediaId);
      if (!tr) { toast('Detect words first'); return clip; }
      const sentence = tr.sentences.find((s) => s.t0 <= clip.inPoint && s.t1 >= clip.outPoint);
      if (!sentence) { toast('No sentence found in selection'); return clip; }
      const dur = sentence.t1 - sentence.t0;
      const newSegs = [];
      for (let i = 0; i < 4; i++) newSegs.push({ t0: sentence.t0, t1: sentence.t1, speed: 1 });
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'loop-sentence'), { kind: 'loop-sentence', segs: newSegs }] };
    },
  },
  'loop-word': {
    label: 'LOOP-WORD',
    desc: 'Loops first word 5×',
    bake(clip) {
      const tr = getTranscriptFor(clip.mediaId);
      const w = tr?.words.find((w) => w.t0 >= clip.inPoint && w.t1 <= clip.outPoint);
      if (!w) { toast('No word found'); return clip; }
      const newSegs = [];
      for (let i = 0; i < 5; i++) newSegs.push({ t0: w.t0, t1: w.t1, speed: 1 });
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'loop-word'), { kind: 'loop-word', segs: newSegs }] };
    },
  },
  'loop-frame': {
    label: 'LOOP-FRAME',
    desc: 'Freezes on a single frame for 2s',
    bake(clip) {
      const mid = (clip.inPoint + clip.outPoint) / 2;
      const newSegs = [{ t0: mid, t1: mid + 2, speed: 1, freeze: true }];
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'loop-frame'), { kind: 'loop-frame', segs: newSegs }] };
    },
  },
  'infinite-zoom': {
    label: '∞ ZOOM',
    desc: 'Continuous zoom in on the center',
    // This is a *per-frame* transform, baked as scale ramp
    bake(clip) {
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'infinite-zoom'), { kind: 'infinite-zoom' }] };
    },
  },

  // ---------- REVERSE ----------
  'rev-audio': {
    label: 'REV-AUD',
    desc: 'Reverse only the audio',
    bake(clip) {
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'rev-audio'), { kind: 'rev-audio' }] };
    },
  },
  'rev-video': {
    label: 'REV-VID',
    desc: 'Reverse only the video',
    bake(clip) {
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'rev-video'), { kind: 'rev-video' }] };
    },
  },
  'rev-every-other': {
    label: 'REV-EOW',
    desc: 'Reverse every other word',
    bake(clip) {
      const tr = getTranscriptFor(clip.mediaId);
      if (!tr) { toast('Detect words first'); return clip; }
      const inClipWords = tr.words.filter((w) => w.t0 >= clip.inPoint && w.t1 <= clip.outPoint);
      const segs = [];
      inClipWords.forEach((w, i) => {
        if (i % 2 === 1) segs.push({ t0: w.t0, t1: w.t1, speed: -1 });
        else segs.push({ t0: w.t0, t1: w.t1, speed: 1 });
      });
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'rev-every-other'), { kind: 'rev-every-other', segs }] };
    },
  },

  // ---------- FACE WARP ----------
  'mouth-warp': {
    label: 'MOUTH',
    desc: 'Talking mouth stretches',
    bake(clip) {
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'mouth-warp'), { kind: 'mouth-warp' }] };
    },
  },
  'eye-distort': {
    label: 'EYES',
    desc: 'Eye distortion',
    bake(clip) {
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'eye-distort'), { kind: 'eye-distort' }] };
    },
  },
  'liquid-face': {
    label: 'LIQUID',
    desc: 'Liquid face effect',
    bake(clip) {
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'liquid-face'), { kind: 'liquid-face' }] };
    },
  },

  // ---------- CHOP ----------
  'chop-words': {
    label: 'CHOP→WORDS',
    desc: 'Replaces clip with one clip per detected word',
    bake(clip) {
      const tr = getTranscriptFor(clip.mediaId);
      if (!tr) { toast('Detect words first'); return clip; }
      // For chop, we just tag; actual chopping happens via transcript panel
      return { ...clip, fx: [...clip.fx.filter((f) => f.kind !== 'chop-words'), { kind: 'chop-words' }] };
    },
  },
};

function getTranscriptFor(mediaId) {
  return getState().transcript[mediaId] || null;
}

export function applyEffect(effectName) {
  const s = getState();
  const id = s.selectedClipId;
  if (!id) { toast('Select a clip on the timeline first'); return; }
  const fx = FX[effectName];
  if (!fx) return;
  const updated = {};
  for (const trk of Object.keys(s.timeline.tracks)) {
    const idx = s.timeline.tracks[trk].findIndex((c) => c.id === id);
    if (idx >= 0) {
      updated[trk] = s.timeline.tracks[trk].map((c) => c.id === id ? fx.bake(c) : c);
      break;
    }
  }
  setState((st) => ({
    ...st,
    timeline: { ...st.timeline, tracks: { ...st.timeline.tracks, ...updated } },
  }));
  toast(`Applied: ${fx.label}`);
}

export function clearEffectsOnSelected() {
  const s = getState();
  const id = s.selectedClipId;
  if (!id) return;
  const updated = {};
  for (const trk of Object.keys(s.timeline.tracks)) {
    if (s.timeline.tracks[trk].some((c) => c.id === id)) {
      updated[trk] = s.timeline.tracks[trk].map((c) => c.id === id ? { ...c, fx: [] } : c);
    }
  }
  setState((st) => ({ ...st, timeline: { ...st.timeline, tracks: { ...st.timeline.tracks, ...updated } } }));
  toast('Cleared FX');
}

// ---------- RUNTIME PER-FRAME TRANSFORMS ----------
// Called by renderer to mutate the frame at local time t in the clip.
// Returns { sourceT, transform, audioT, audioSpeed } overrides.

export function resolveSegment(clip, localT) {
  // Find which baked segment we're in, and resolve to a source timestamp + transform.
  // If no segment effects, just return source = clip.inPoint + localT
  for (const f of clip.fx) {
    if (f.segs) {
      let acc = 0;
      for (const seg of f.segs) {
        const dur = Math.abs(seg.t1 - seg.t0) / (seg.speed || 1);
        if (localT < acc + dur) {
          const local = localT - acc;
          const tIn = seg.t0 + local * (seg.speed || 1);
          return { sourceT: tIn, seg };
        }
        acc += dur;
      }
      // beyond — return last frame held
      const last = f.segs[f.segs.length - 1];
      return { sourceT: last.t1, seg: last };
    }
  }
  return { sourceT: clip.inPoint + localT, seg: null };
}

export function perFrameTransforms(clip, localT) {
  const t = { ...clip.transform };
  // Infinite zoom: scale ramps from 1 → 4 over the clip duration
  if (clip.fx.some((f) => f.kind === 'infinite-zoom')) {
    const dur = (clip.outPoint - clip.inPoint) || 0.5;
    const k = 1 + 3 * (localT / dur);
    t.s *= k;
  }
  return t;
}

// Audio for a segment — reversed or normal
export function audioRate(seg) {
  if (!seg) return 1;
  if (seg.speed && seg.speed < 0) return -1;
  return 1;
}

// =====================================================================
//   CHAOS ENGINE — 🎲 Random FX + 💥 YTP-ify
// =====================================================================

// All non-mutually-destructive effect kinds (skip chop-words which
// replaces the clip, skip the rev-every-other which is heavy).
const RANDOM_FX_KINDS = [
  'stutter',
  'loop-sentence',
  'loop-word',
  'loop-frame',
  'infinite-zoom',
  'rev-audio',
  'rev-video',
  'mouth-warp',
  'eye-distort',
  'liquid-face',
];

// Weighted rare-fx roll (each fx has a small chance of being added)
export function randomFx(clip) {
  const fx = (clip.fx || []).filter((f) => f.kind !== 'random');
  const kinds = new Set(fx.map((f) => f.kind));
  // 30% chance of adding a fresh random effect
  if (Math.random() < 0.3) {
    let pick;
    let attempts = 0;
    do {
      pick = RANDOM_FX_KINDS[Math.floor(Math.random() * RANDOM_FX_KINDS.length)];
      attempts++;
    } while (kinds.has(pick) && attempts < 6);
    fx.push({ kind: pick, seed: Math.random() });
  }
  return { ...clip, fx };
}

// =====================================================================
//  PRESETS — named YTP effect chains
// =====================================================================
// Each preset is a list of effect kinds applied in order. Inspired by
// classic YTP video creator styles / character tropes.
export const PRESETS = {
  'spadinner': {
    label: 'Spadinner (Discord mod)',
    chain: ['loop-word', 'infinite-zoom', 'stutter', 'rev-every-other', 'mouth-warp', 'eye-distort'],
  },
  'bill-cipher': {
    label: 'Bill Cipher (Gravity Falls)',
    chain: ['infinite-zoom', 'eye-distort', 'stutter', 'liquid-face', 'rev-video', 'loop-frame'],
  },
  'bowser': {
    label: 'Bowser (Mario rage)',
    chain: ['stutter', 'stutter', 'mouth-warp', 'infinite-zoom', 'rev-audio'],
  },
  'mlg': {
    label: 'MLG (MountainDew)',
    chain: ['stutter', 'rev-audio', 'loop-sentence', 'eye-distort'],
  },
  'spongebob': {
    label: 'Spongebob 2 Hours Later',
    chain: ['loop-sentence', 'infinite-zoom', 'loop-word'],
  },
  'deepfried': {
    label: 'Deep Fried',
    chain: ['eye-distort', 'mouth-warp', 'liquid-face', 'infinite-zoom', 'stutter'],
  },
  'goblin': {
    label: 'Goblin Mode',
    chain: ['rev-every-other', 'loop-frame', 'stutter', 'mouth-warp', 'infinite-zoom'],
  },
  'sans': {
    label: 'Sans (Undertale)',
    chain: ['infinite-zoom', 'rev-video', 'stutter', 'eye-distort', 'loop-word'],
  },
};

// Apply a named preset to a clip (replaces its FX stack).
export function applyPreset(clip, presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) return clip;
  const fx = preset.chain.map((kind) => ({ kind, seed: Math.random() }));
  return { ...clip, fx };
}

export function ytpify(clip) {
  const presets = [
    ['stutter', 'mouth-warp', 'rev-audio'],
    ['loop-word', 'infinite-zoom'],
    ['loop-frame', 'liquid-face', 'rev-video'],
    ['loop-sentence', 'eye-distort'],
    ['infinite-zoom', 'stutter', 'rev-video', 'mouth-warp'],
    ['stutter', 'stutter', 'infinite-zoom'],
    ['loop-word', 'rev-every-other'],
    ['eye-distort', 'mouth-warp', 'stutter'],
    ['loop-sentence', 'infinite-zoom', 'rev-audio'],
    ['liquid-face', 'stutter', 'loop-word'],
  ];
  const choice = presets[Math.floor(Math.random() * presets.length)];
  const fx = choice.map((kind) => ({ kind, seed: Math.random() }));
  return { ...clip, fx };
}

