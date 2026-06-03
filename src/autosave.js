// autosave.js — save project state to localStorage every 30s, with restore prompt.
//
// We can't persist media blobs through JSON serialization, so the saved
// state includes metadata (clips, transcript, FX) but NOT the file data.
// On restore, the user is asked "Restore project?" — accepting loads
// the structure; media files must be re-added via file picker (or remain
// if they're already in the bin from this session).

import { getState, setState, subscribe, toast } from './state.js';

const KEY = 'ytp-maker:autosave';
const INTERVAL_MS = 30_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

let timer = null;

export function initAutosave() {
  // Prompt to restore on first load
  const existing = readSave();
  if (existing && existing.state) {
    const ageHrs = (Date.now() - (existing.savedAt || 0)) / 3_600_000;
    if (ageHrs < 168) {
      showRestorePrompt(existing);
    }
  }
  // Periodic save
  if (timer) clearInterval(timer);
  timer = setInterval(autosave, INTERVAL_MS);
  // Save on visibility hidden (closing tab)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave();
  });
}

export function autosave() {
  try {
    const s = getState();
    // Strip media file blobs — they can't survive a JSON round-trip
    const lite = {
      timeline: s.timeline,
      transcripts: s.transcript, // already text-based
      playhead: s.playhead,
      speed: s.speed,
      captionsOn: s.captionsOn,
      master: s.master,
      audio: s.audio,
      color: s.color,
      // bin media metadata only (no File/Blob)
      media: (s.media || []).map((m) => ({
        id: m.id, name: m.name, kind: m.kind, duration: m.duration,
        url: null, // URLs are session-scoped object URLs
        thumb: m.thumb, // data URL is fine
        // keep src if it was a YouTube link (string), drop if it was a blob
        src: m.src && typeof m.src === 'string' ? m.src : null,
      })),
    };
    const payload = { savedAt: Date.now(), state: lite };
    localStorage.setItem(KEY, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn('Autosave failed:', e);
    return false;
  }
}

export function readSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch (_) {}
}

function showRestorePrompt(payload) {
  // Build a modal on the fly
  const dlg = document.createElement('dialog');
  dlg.id = 'restore-modal';
  dlg.style.cssText = 'background:#1c1c1c;color:#e6e6e6;border:1px solid #444;border-radius:6px;padding:20px;max-width:380px;';
  const ageMin = Math.max(1, Math.round((Date.now() - payload.savedAt) / 60_000));
  const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
  const clipCount = Object.values(payload.state.timeline?.tracks || {})
    .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  dlg.innerHTML = `
    <h3 style="margin:0 0 8px;color:#f5a623;">Restore last session?</h3>
    <p style="margin:0 0 16px;color:#aaa;line-height:1.5;">
      We found an autosave from <strong>${ageStr}</strong> with
      <strong>${clipCount} clip(s)</strong> on the timeline. Restore it?
      (You'll need to re-add any media files — but the structure will be back.)
    </p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="restore-discard" class="ghost">Discard</button>
      <button id="restore-accept" class="primary">Restore</button>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('#restore-accept').addEventListener('click', () => {
    applyRestore(payload);
    dlg.close();
    dlg.remove();
  });
  dlg.querySelector('#restore-discard').addEventListener('click', () => {
    clearSave();
    dlg.close();
    dlg.remove();
    toast('Autosave discarded');
  });
}

function applyRestore(payload) {
  const lite = payload.state;
  setState((s) => ({
    ...s,
    timeline: lite.timeline || s.timeline,
    playhead: lite.playhead ?? 0,
    speed: lite.speed ?? 1,
    captionsOn: !!lite.captionsOn,
    master: lite.master || s.master,
    audio: lite.audio || s.audio,
    color: lite.color || s.color,
    // bin: keep existing session media, append restored stubs
    media: [
      ...(s.media || []),
      ...(lite.media || []).filter((m) => !(s.media || []).some((x) => x.id === m.id)),
    ],
  }));
  toast('✓ Session restored');
}
