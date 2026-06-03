// media.js — handle file uploads, YouTube fetch (browser-only, no backend)
// Strategy:
//   - Local files: native File API + URL.createObjectURL
//   - YouTube: hit *Piped* (open-source YouTube front-end) which returns
//     a CORS-enabled JSON payload with a streamable URL we can <video src>.
//     Multiple Piped instances are tried in order; if all fail, we offer
//     a "manual URL" paste box the user can grab from a third-party site.
//   - Recording: getUserMedia / getDisplayMedia -> MediaRecorder -> File
import { getState, setState, patchIn, uid, toast } from './state.js';

// ----- Piped API instances (ordered by reliability, fall back on CORS) -----
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.osphost.fi',
  'https://pipedapi.darkness.services',
];

// ----- File <-> URL helpers ------------------------------------------------
export function fileToUrl(file) {
  return URL.createObjectURL(file);
}

function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

// ----- Public: add a File to the media library ----------------------------
export async function addFile(file) {
  if (!file) return;
  const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name);
  const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac)$/i.test(file.name);
  if (!isVideo && !isAudio) {
    toast(`Unsupported file: ${file.name}`);
    return;
  }
  const media = {
    id: uid('med'),
    name: file.name.replace(/\.[^.]+$/, ''),
    kind: isVideo ? 'video' : 'audio',
    url: fileToUrl(file),
    file,
    duration: 0,
    waves: null,
    thumb: null,
    source: 'local',
    transcript: null,
  };
  setState((s) => ({ ...s, media: [...s.media, media], activeMediaId: media.id }));
  toast(`Added: ${file.name}`);
  // Decode metadata async (don't block UI)
  decodeMeta(media).catch((e) => console.warn('decodeMeta failed', e));
}

// ----- Decode duration + thumbnail + waveform ----------------------------
async function decodeMeta(media) {
  return new Promise((resolve) => {
    const el = document.createElement(media.kind === 'video' ? 'video' : 'audio');
    el.preload = 'metadata';
    el.src = media.url;
    el.onloadedmetadata = () => {
      media.duration = el.duration;
      if (media.kind === 'video') {
        el.currentTime = Math.min(0.5, el.duration / 2);
        el.onseeked = async () => {
          const c = document.createElement('canvas');
          c.width = 80; c.height = 48;
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
          media.thumb = c.toDataURL('image/jpeg', 0.6);
          if (isFinite(el.duration) && el.duration > 0.05) {
            media.waves = await computePeaks(media).catch(() => null);
          }
          commitMeta(media);
          resolve();
        };
      } else {
        (async () => {
          if (isFinite(el.duration) && el.duration > 0.05) {
            media.waves = await computePeaks(media).catch(() => null);
          }
          commitMeta(media);
          resolve();
        })();
      }
    };
    el.onerror = () => resolve();
  });
}

function commitMeta(media) {
  setState((s) => ({
    ...s,
    media: s.media.map((m) => (m.id === media.id ? { ...m, ...media } : m)),
  }));
}

// ----- Compute waveform peaks (downsampled amplitude bars) ----------------
async function computePeaks(media, target = 800) {
  const buf = await fileToArrayBuffer(media.file);
  const ctx = ensureAudioCtx();
  let audio;
  try {
    audio = await ctx.decodeAudioData(buf.slice(0));
  } catch (e) {
    return null; // unsupported codec
  }
  const ch = audio.getChannelData(0);
  const block = Math.max(1, Math.floor(ch.length / target));
  const peaks = new Float32Array(target);
  for (let i = 0; i < target; i++) {
    let max = 0;
    for (let j = 0; j < block; j++) {
      const v = Math.abs(ch[i * block + j] || 0);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

function ensureAudioCtx() {
  return window.__ytpAudio || (window.__ytpAudio = new (window.AudioContext || window.webkitAudioContext)());
}

// =====================================================================
//   YOUTUBE FETCH (no backend — uses public Piped API instances)
// =====================================================================

/**
 * Try each Piped instance in order until one returns a JSON payload
 * with a playable stream. Returns { videoUrl, audioUrl, title, thumb }.
 */
async function fetchFromPiped(videoId) {
  let lastErr = null;
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetch(`${base}/streams/${videoId}`, { method: 'GET' });
      if (!r.ok) { lastErr = new Error(`${base} -> ${r.status}`); continue; }
      const data = await r.json();
      // Pick best progressive (non-DASH) stream with both audio+video,
      // fall back to lowest video-only + separate audio stream.
      const progressive = (data.videoStreams || [])
        .filter((s) => s.url && (!s.format || /video\/mp4|video\/webm/.test(s.format)))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      const audioStream = (data.audioStreams || [])
        .filter((s) => s.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!progressive.length && !audioStream) {
        lastErr = new Error(`${base} -> no streams`);
        continue;
      }
      return {
        title: data.title || videoId,
        thumb: data.thumbnailUrl || data.uploaderAvatarUrl || null,
        duration: data.duration || 0,
        videoUrl: progressive[0]?.url || null,
        audioUrl: audioStream?.url || null,
        instance: base,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Piped instances failed');
}

/**
 * Resolve any YouTube URL (youtu.be, youtube.com/watch, youtube.com/shorts, etc)
 * into a 11-char video ID.
 */
export function extractYouTubeId(url) {
  if (!url) return null;
  // already an ID?
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  try {
    const u = new URL(url.trim());
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.slice(1).split('/')[0] || null;
    }
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2];
      if (u.pathname.startsWith('/embed/'))  return u.pathname.split('/')[2];
      const v = u.searchParams.get('v');
      if (v) return v;
    }
  } catch (_) { /* not a URL */ }
  return null;
}

/**
 * Public: fetch a YouTube URL into the media library, browser-only.
 */
export async function fetchYouTube(urlOrId) {
  const id = extractYouTubeId(urlOrId);
  if (!id) { toast('Not a valid YouTube URL'); return; }
  toast('Fetching from Piped…');
  let info;
  try {
    info = await fetchFromPiped(id);
  } catch (e) {
    toast('All Piped instances blocked. Pasting video URL fallback…');
    // Final fallback: open in new tab so user can right-click "Copy video address"
    // and paste back via the "manual URL" box.
    promptCopy(`https://piped.video/watch?v=${id}`, 'Copy this link, find a stream URL in DevTools, paste it back below');
    return;
  }

  // If the chosen Piped instance is CORS-friendly we can stream directly.
  // Some hosts are CORS-strict; in that case download via blob proxy.
  const media = {
    id: uid('med'),
    name: info.title,
    kind: info.audioUrl && !info.videoUrl ? 'audio' : 'video',
    url: null,
    file: null,
    duration: info.duration,
    waves: null,
    thumb: info.thumb,
    source: 'youtube',
    youtubeId: id,
    youtubeStream: info.videoUrl || info.audioUrl,
    youtubeAudio: info.audioUrl,
    youtubeInstance: info.instance,
  };

  // Try the chosen instance's CORS first
  try {
    const r = await fetch(media.youtubeStream, { method: 'HEAD' });
    if (r.ok) {
      media.url = media.youtubeStream;
    } else {
      throw new Error('HEAD failed');
    }
  } catch (e) {
    // CORS blocked — fetch the whole stream into a Blob
    toast('Proxying through blob (one-time download)…');
    try {
      const r = await fetch(media.youtubeStream);
      if (!r.ok) throw new Error('blob fetch failed');
      const blob = await r.blob();
      const ext = (media.kind === 'video' ? 'mp4' : 'm4a');
      const file = new File([blob], `${info.title}.${ext}`, { type: blob.type || (media.kind === 'video' ? 'video/mp4' : 'audio/mp4') });
      media.file = file;
      media.url = URL.createObjectURL(blob);
    } catch (e2) {
      toast('CORS-blocked and proxy failed. Try a different YouTube mirror.');
      return;
    }
  }

  setState((s) => ({ ...s, media: [...s.media, media], activeMediaId: media.id }));
  toast(`Fetched: ${info.title}`);
  decodeMeta(media).catch(() => {});
}

function promptCopy(text, msg) {
  try {
    window.prompt(msg, text);
  } catch (_) { /* ignore */ }
}

// =====================================================================
//   RECORDING (webcam / mic / screen)
// =====================================================================

export async function startRecording(kind) {
  let stream;
  try {
    stream = kind === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: kind === 'cam' ? { width: 1280, height: 720 } : false,
        });
  } catch (e) {
    toast('Recording permission denied');
    return;
  }
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9,opus' });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start();
  toast(`Recording ${kind}… click again to stop.`);
  const stopAndSave = () => {
    if (recorder.state === 'inactive') return;
    recorder.stop();
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const file = new File([blob], `record-${Date.now()}.webm`, { type: 'video/webm' });
      await addFile(file);
      stream.getTracks().forEach((t) => t.stop());
    };
  };
  return stopAndSave;
}
