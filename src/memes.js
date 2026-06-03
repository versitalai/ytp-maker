// memes.js — built-in meme soundboard. Synthesizes the classic YTP SFX in-browser
// using WebAudio, so we don't have to ship binary assets.
import { uid } from './state.js';

const RECIPES = {
  'vine-boom':     { dur: 0.6, type: 'sine',     freq: 90,  freqEnd: 30,  vol: 0.9, desc: 'deep boom' },
  'metal-pipe':    { dur: 0.4, type: 'square',   freq: 800, freqEnd: 200, vol: 0.7, desc: 'clang' },
  'gnome':         { dur: 0.3, type: 'triangle', freq: 1200, freqEnd: 600, vol: 0.5, desc: 'high tinkle' },
  'airhorn':       { dur: 1.2, type: 'sawtooth', freq: 440, freqEnd: 480, vol: 0.6, desc: 'brap brap' },
  'taco-bell':     { dur: 0.8, type: 'sine',     freq: 660, freqEnd: 880, vol: 0.5, desc: 'bong bong' },
  'bruh':          { dur: 0.5, type: 'sine',     freq: 220, freqEnd: 110, vol: 0.6, desc: 'low fade' },
  'sus':           { dur: 0.4, type: 'triangle', freq: 440, freqEnd: 220, vol: 0.5, desc: 'sus' },
  'curb':          { dur: 0.7, type: 'square',   freq: 200, freqEnd: 60,  vol: 0.7, desc: 'your sound' },
  'wheez':         { dur: 1.5, type: 'sawtooth', freq: 320, freqEnd: 240, vol: 0.4, desc: 'inhale wheeze' },
  'windows-error': { dur: 0.3, type: 'square',   freq: 200, freqEnd: 100, vol: 0.5, desc: 'XP error' },
  'fart':          { dur: 0.6, type: 'sawtooth', freq: 80,  freqEnd: 40,  vol: 0.5, desc: 'reverb fart' },
  'sax':           { dur: 0.8, type: 'sawtooth', freq: 350, freqEnd: 500, vol: 0.5, desc: 'sax' },
};

let cache = {};

function ensureCtx() {
  return window.__ytpAudio || (window.__ytpAudio = new (window.AudioContext || window.webkitAudioContext)());
}

export function makeMemeBlob(name) {
  if (cache[name]) return Promise.resolve(cache[name]);
  const r = RECIPES[name];
  if (!r) return Promise.resolve(null);
  const ctx = ensureCtx();
  const sr = ctx.sampleRate;
  const len = Math.floor(r.dur * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const f = r.freq + (r.freqEnd - r.freq) * t;
    let s;
    const phase = 2 * Math.PI * f * (i / sr);
    if (r.type === 'sine') s = Math.sin(phase);
    else if (r.type === 'square') s = Math.sign(Math.sin(phase));
    else if (r.type === 'triangle') s = (2 / Math.PI) * Math.asin(Math.sin(phase));
    else s = 2 * (phase / (2 * Math.PI) - Math.floor(phase / (2 * Math.PI) + 0.5));
    // envelope
    const env = Math.min(1, t * 8) * Math.pow(1 - t, 0.4);
    data[i] = s * env * r.vol;
  }
  // wav encode
  const wav = encodeWav(buf);
  const blob = new Blob([wav], { type: 'audio/wav' });
  cache[name] = blob;
  return Promise.resolve(blob);
}

function encodeWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const samples = audioBuffer.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    view.setInt16(off, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  }
  return buffer;
}

export async function memeToMedia(name) {
  const blob = await makeMemeBlob(name);
  if (!blob) return null;
  const file = new File([blob], `${name}.wav`, { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  return {
    id: uid('med'),
    name,
    kind: 'audio',
    url,
    file,
    duration: RECIPES[name].dur,
    meme: name,
    waves: null,
  };
}

export function listMemes() {
  return Object.entries(RECIPES).map(([k, v]) => ({ key: k, ...v }));
}
