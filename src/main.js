// main.js — entrypoint, glues UI to modules
import { getState, setState, subscribe, undo, redo, toast, patchIn } from './state.js';
import { addFile, fetchYouTube, startRecording } from './media.js';
import { activeMedia, detectForActive, bakeSelectedToTimeline, getTranscript, wordToPhonemes, chopBySilence } from './transcript.js';
import { FX, applyEffect, clearEffectsOnSelected, randomFx as _randomFx, ytpify as _ytpify } from './ytp.js';
import { initTimeline, renderTimeline } from './timeline.js';
import { initRender, togglePlay } from './render.js';
import { startMixer } from './audio.js';
import { initAutosave } from './autosave.js';
import { listMemes, memeToMedia, makeMemeBlob } from './memes.js';
import { publishCurrent, forkProject, listCommunity } from './community.js';
import { exportProject } from './export.js';

// =====================================================================
//  UI helpers
// =====================================================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }

// =====================================================================
//  Tabs
// =====================================================================
function setupTabs() {
  for (const root of $$('[data-tabs]')) {
    const tabs = $$('button', root);
    tabs.forEach((t) => t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      // The panes we control are siblings/descendants of THIS tab root's parent panel.
      const panel = root.parentElement;
      panel.querySelectorAll('[data-pane]').forEach((p) => {
        p.classList.toggle('active', p.dataset.pane === t.dataset.tab);
      });
    }));
  }
}

// =====================================================================
//  Bin (media pool) rendering
// =====================================================================
function renderBin() {
  const ul = $('#bin'); if (!ul) return;
  const s = getState();
  ul.innerHTML = '';
  $('#bin-count').textContent = s.media.length;
  if (!s.media.length) {
    ul.innerHTML = `<li class="empty">No clips yet — add a file or paste a YouTube URL.</li>`;
    return;
  }
  s.media.filter(Boolean).forEach((m) => {
    const li = document.createElement('li');
    li.draggable = true;
    if (m.id === s.activeMediaId) li.classList.add('active');
    li.innerHTML = `
      <div class="thumb">${m.thumb ? `<img src="${m.thumb}">` : (m.kind === 'audio' ? '♪' : '▸')}</div>
      <div>
        <div class="name">${escape(m.name)}</div>
        <div class="meta">${m.kind} · ${m.duration.toFixed(1)}s</div>
      </div>
      <div class="meta" style="display:flex;gap:6px;align-items:center;">
        <span>${m.id === s.activeMediaId ? '●' : ''}</span>
        <button class="x" data-rm-media="${m.id}" title="Remove from bin">✕</button>
      </div>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-rm-media]')) return; // ignore clicks on delete
      setState((st) => ({ ...st, activeMediaId: m.id }));
      $('#detect-status').textContent = m.name;
    });
    li.querySelector('[data-rm-media]').addEventListener('click', (e) => {
      e.stopPropagation();
      removeMediaFromBin(m.id);
    });
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-ytp', JSON.stringify({
        kind: m.kind, mediaId: m.id, name: m.name, duration: m.duration,
      }));
    });
    ul.appendChild(li);
  });
}

// Revoke the ObjectURL for a media item and remove from bin state.
function removeMediaFromBin(id) {
  const s = getState();
  const m = s.media.find((x) => x.id === id);
  if (m) {
    // Revoke any object URLs to free memory
    try { if (m.url && m.url.startsWith('blob:')) URL.revokeObjectURL(m.url); } catch (_) {}
    try { if (m.thumb && m.thumb.startsWith('blob:')) URL.revokeObjectURL(m.thumb); } catch (_) {}
  }
  setState((st) => ({
    ...st,
    media: st.media.filter((x) => x.id !== id),
    // Also drop any clips on the timeline that referenced this media
    timeline: {
      ...st.timeline,
      tracks: Object.fromEntries(
        Object.entries(st.timeline.tracks).map(([k, arr]) => [k, arr.filter((c) => c.mediaId !== id)])
      ),
    },
    activeMediaId: st.activeMediaId === id ? null : st.activeMediaId,
  }));
  toast('Removed media from bin');
}

// =====================================================================
//  Transcript panel
// =====================================================================
function renderTranscript() {
  const wrap = $('#transcript');
  if (!wrap) return;
  const m = activeMedia();
  if (!m) { wrap.innerHTML = `<div class="empty">Select a clip in the Bin first.</div>`; return; }
  const tr = getTranscript(m.id);
  if (!tr) { wrap.innerHTML = `<div class="empty">Click "Detect Words" to chop this clip.</div>`; return; }
  const showSent = $('#opt-sentences').checked;
  const showWord = $('#opt-words').checked;
  const showPhon = $('#opt-phonemes').checked;
  let html = '';
  const wordToSentence = new Map();
  (tr.sentences || []).forEach((s) => s.words?.forEach((idx) => wordToSentence.set(idx, s)));
  if (showSent && tr.sentences) {
    tr.sentences.forEach((s) => {
      html += `<div class="sent"><div class="sent-label">SENTENCE  ${s.t0.toFixed(2)}s → ${s.t1.toFixed(2)}s</div>`;
      (s.words || []).forEach((wi) => {
        const w = tr.words[wi]; if (!w) return;
        html += `<span class="word" data-word-idx="${wi}" data-t0="${w.t0}" data-t1="${w.t1}">${escape(w.text)}</span>`;
      });
      html += `</div>`;
    });
  } else if (showWord) {
    html += `<div class="sent">`;
    tr.words.forEach((w, i) => {
      html += `<span class="word" data-word-idx="${i}" data-t0="${w.t0}" data-t1="${w.t1}">${escape(w.text)}</span>`;
      if (showPhon) {
        const phs = wordToPhonemes(w);
        phs.forEach((p) => { html += `<span class="word phoneme" data-word-idx="${i}" data-t0="${p.t0}" data-t1="${p.t1}">·</span>`; });
      }
    });
    html += `</div>`;
  }
  wrap.innerHTML = html || `<div class="empty">Nothing to show.</div>`;
  // selection
  let selected = new Set();
  wrap.querySelectorAll('.word').forEach((el) => {
    el.addEventListener('click', () => el.classList.toggle('selected'));
  });
  // seek on word click
  wrap.querySelectorAll('.word').forEach((el) => {
    el.addEventListener('dblclick', () => {
      const t = parseFloat(el.dataset.t0);
      setState((s) => ({ ...s, playhead: t, activeMediaId: m.id }), { skipHistory: true });
    });
  });
}

// =====================================================================
//  Meme grid
// =====================================================================
function renderMemes() {
  const grid = $('#meme-grid');
  if (!grid) return;
  const q = ($('#meme-search').value || '').toLowerCase();
  const all = listMemes().filter((m) => !q || m.key.includes(q) || m.desc.toLowerCase().includes(q));
  grid.innerHTML = '';
  all.forEach((m) => {
    const d = document.createElement('div');
    d.className = 'meme';
    d.draggable = true;
    d.innerHTML = `<div class="icon">${iconFor(m.key)}</div><div>${m.key.replace(/-/g, ' ').toUpperCase()}</div><div class="hint">${m.dur}s</div>`;
    d.addEventListener('click', async () => {
      const media = await memeToMedia(m.key);
      if (!media) return;
      setState((s) => ({ ...s, media: [...s.media, media] }));
      toast(`Meme added: ${m.key}`);
      // preview sound
      makeMemeBlob(m.key).then((blob) => new Audio(URL.createObjectURL(blob)).play().catch(() => {}));
    });
    d.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-ytp', JSON.stringify({
        kind: 'meme', name: m.key, duration: m.dur, mediaId: '__meme__' + m.key,
      }));
    });
    grid.appendChild(d);
  });
}
function iconFor(k) {
  return { 'vine-boom': '💥', 'metal-pipe': '🔧', 'gnome': '🧙', 'airhorn': '📢', 'taco-bell': '🔔', 'bruh': '😑', 'sus': '😐', 'curb': '🛋', 'wheez': '😤', 'windows-error': '🪟', 'fart': '💨', 'sax': '🎷' }[k] || '🔊';
}

// =====================================================================
//  Inspector
// =====================================================================
function renderInspector() {
  const s = getState();
  const id = s.selectedClipId;
  const clip = id ? Object.values(s.timeline.tracks).flat().find((c) => c.id === id) : null;
  if (!clip) {
    $('#i-name').textContent = '—';
    $('#i-src').textContent = '—';
    $('#i-dur').textContent = '—';
    $('#i-inout').textContent = '—';
    $('#fx-stack').innerHTML = `<li class="empty">No effects</li>`;
    $$('[data-tr]').forEach((el) => { el.value = el.dataset.default || defaultFor(el); });
    return;
  }
  $('#i-name').textContent = clip.name;
  const m = s.media.find((mm) => mm.id === clip.mediaId);
  $('#i-src').textContent = m ? m.name : (clip.meme || '—');
  $('#i-dur').textContent = (clip.outPoint - clip.inPoint).toFixed(2) + 's';
  $('#i-inout').textContent = `${clip.inPoint.toFixed(2)}s → ${clip.outPoint.toFixed(2)}s`;

  ['x','y','s','r','o','v','p'].forEach((k) => {
    const el = $(`[data-tr="${k}"]`); if (el) el.value = clip.transform[k];
  });
  const fx = $('#fx-stack');
  fx.innerHTML = '';
  if (!clip.fx.length) { fx.innerHTML = `<li class="empty">No effects</li>`; }
  else clip.fx.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="fx-name">${f.kind.toUpperCase()}</span><button data-rm="${i}">×</button>`;
    fx.appendChild(li);
  });
  fx.querySelectorAll('button[data-rm]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = parseInt(b.dataset.rm);
      const updated = { ...clip, fx: clip.fx.filter((_, j) => j !== i) };
      setState((st) => mutateClipInTracks(st, updated));
    });
  });
}

function defaultFor(el) {
  return ({ x:0, y:0, s:1, r:0, o:1, v:1, p:0 })[el.dataset.tr] ?? 0;
}

function mutateClipInTracks(state, clip) {
  const tracks = { ...state.timeline.tracks };
  for (const k of Object.keys(tracks)) {
    tracks[k] = tracks[k].map((c) => c.id === clip.id ? clip : c);
  }
  return { ...state, timeline: { ...state.timeline, tracks } };
}

// 🎲 Random FX: 30% chance to add a fresh random effect to the selected clip.
function applyRandomFx() {
  const s = getState();
  const sel = s.selectedClipId;
  if (!sel) { toast('Select a clip first'); return; }
  let clip = null;
  for (const k of Object.keys(s.timeline.tracks)) {
    clip = s.timeline.tracks[k].find((c) => c.id === sel);
    if (clip) break;
  }
  if (!clip) return;
  const updated = _randomFx(clip);
  setState((st) => mutateClipInTracks(st, updated));
  if (updated.fx.length > clip.fx.length) {
    toast(`🎲 Added: ${updated.fx[updated.fx.length - 1].kind}`);
  } else {
    toast('🎲 No effect added this roll (try again)');
  }
}

// 💥 YTP-ify: nuke the FX stack and apply a random YTP effect chain.
function applyYtpify() {
  const s = getState();
  const sel = s.selectedClipId;
  if (!sel) { toast('Select a clip first'); return; }
  let clip = null;
  for (const k of Object.keys(s.timeline.tracks)) {
    clip = s.timeline.tracks[k].find((c) => c.id === sel);
    if (clip) break;
  }
  if (!clip) return;
  const updated = _ytpify(clip);
  setState((st) => mutateClipInTracks(st, updated));
  toast(`💥 YTP-ified! Chain: ${updated.fx.map((f) => f.kind).join(' + ')}`);
}

// =====================================================================
//  Community
// =====================================================================
function renderCommunity() {
  const ul = $('#comm-list');
  if (!ul) return;
  const list = listCommunity();
  ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = `<li class="empty">No projects published yet.</li>`; return; }
  list.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="thumb">🎬</div>
      <div><div class="name">${escape(p.title)}</div><div class="meta">${new Date(p.when).toLocaleString()} · ${p.duration.toFixed(1)}s</div></div>
      <div class="meta"><button class="ghost" data-fork="${p.id}">Fork</button></div>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('button[data-fork]').forEach((b) => {
    b.addEventListener('click', () => forkProject(b.dataset.fork));
  });
}

// =====================================================================
//  Top-bar timecode
// =====================================================================
function renderTC() {
  const s = getState();
  const t = formatTC(s.playhead, s.project.fps);
  $('#tc-current').textContent = t;
  const end = computeEnd();
  $('#tc-total').textContent = formatTC(end, s.project.fps);
}
function computeEnd() {
  const s = getState();
  let max = 0;
  for (const k of Object.keys(s.timeline.tracks)) for (const c of s.timeline.tracks[k]) max = Math.max(max, c.start + (c.outPoint - c.inPoint));
  return max;
}
function formatTC(t, fps = 30) {
  if (!isFinite(t)) t = 0;
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = Math.floor(t % 60);
  const ff = Math.floor((t % 1) * fps);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}:${String(ff).padStart(2,'0')}`;
}
function escape(s) { return (s || '').toString().replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c])); }

// =====================================================================
//  Top-level re-render
// =====================================================================
function render() {
  renderBin();
  renderTranscript();
  renderMemes();
  renderCommunity();
  renderInspector();
  renderTimeline();
  renderTC();
}

// =====================================================================
//  Init
// =====================================================================
function init() {
  setupTabs();

  // file input
  $('#file-input').addEventListener('change', (e) => {
    [...e.target.files].forEach((f) => addFile(f));
    e.target.value = '';
  });
  $('#yt-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-yt').click(); });
  $('#btn-yt').addEventListener('click', () => {
    const url = $('#yt-url').value.trim();
    if (url) fetchYouTube(url);
  });
  $('#btn-record').addEventListener('click', () => startRecording('mic'));

  // drag-drop files into media area
  const dropZones = [$('#bin'), $('#media-hint')];
  dropZones.forEach((z) => {
    ['dragenter', 'dragover'].forEach((ev) => z.addEventListener(ev, (e) => { e.preventDefault(); }));
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!e.dataTransfer.files.length) return;
      [...e.dataTransfer.files].forEach((f) => addFile(f));
    });
  });

  // detection
  $('#btn-detect').addEventListener('click', () => {
    detectForActive({ words: $('#opt-words').checked, sentences: $('#opt-sentences').checked });
  });
  ['#opt-sentences', '#opt-words', '#opt-phonemes'].forEach((s) => $(s).addEventListener('change', renderTranscript));
  $('#meme-search').addEventListener('input', renderMemes);
  $('#btn-publish').addEventListener('click', publishCurrent);

  // transcript bake
  $('#btn-bake-script').addEventListener('click', () => {
    const m = activeMedia();
    if (!m) return;
    const indices = [...$('#transcript').querySelectorAll('.word.selected')].map((el) => parseInt(el.dataset.wordIdx));
    if (!indices.length) {
      // bake all words
      const tr = getTranscript(m.id);
      if (tr) bakeSelectedToTimeline(tr.words.map((_, i) => i));
    } else {
      bakeSelectedToTimeline(indices);
    }
  });
  $('#btn-chop-silence')?.addEventListener('click', () => chopBySilence());

  // YTP effect buttons
  $$('.ytp-bar [data-effect]').forEach((b) => {
    const kind = b.dataset.effect;
    if (kind === 'random') {
      b.addEventListener('click', () => applyRandomFx());
    } else if (kind === 'ytpify') {
      b.addEventListener('click', () => applyYtpify());
    } else {
      b.addEventListener('click', () => applyEffect(kind));
    }
  });
  $('#btn-clear-fx').addEventListener('click', clearEffectsOnSelected);

  // Transport
  $('#t-play').addEventListener('click', () => togglePlay());
  $('#t-rew').addEventListener('click', () => setState((s) => ({ ...s, playhead: Math.max(0, s.playhead - 5) }), { skipHistory: true }));
  $('#t-end').addEventListener('click', () => setState((s) => ({ ...s, playhead: s.playhead + 5 }), { skipHistory: true }));
  $('#t-back').addEventListener('click', () => setState((s) => ({ ...s, playhead: Math.max(0, s.playhead - 1/30) }), { skipHistory: true }));
  $('#t-fwd').addEventListener('click', () => setState((s) => ({ ...s, playhead: s.playhead + 1/30 }), { skipHistory: true }));
  $('#t-speed').addEventListener('change', (e) => {
    const r = parseFloat(e.target.value);
    setState((s) => ({ ...s, speed: r }), { skipHistory: true });
  });
  $('#t-mark-in').addEventListener('click', () => setState((s) => ({ ...s, inOut: { ...s.inOut, in: s.playhead } }), { skipHistory: true }));
  $('#t-mark-out').addEventListener('click', () => setState((s) => ({ ...s, inOut: { ...s.inOut, out: s.playhead } }), { skipHistory: true }));

  // Inspector ranges
  $$('[data-tr]').forEach((el) => {
    el.addEventListener('input', () => {
      const s = getState();
      const id = s.selectedClipId;
      if (!id) return;
      const k = el.dataset.tr;
      const v = parseFloat(el.value);
      setState((st) => {
        const tracks = { ...st.timeline.tracks };
        for (const tk of Object.keys(tracks)) {
          tracks[tk] = tracks[tk].map((c) => c.id === id ? { ...c, transform: { ...c.transform, [k]: v } } : c);
        }
        return { ...st, timeline: { ...st.timeline, tracks } };
      }, { skipHistory: true });
    });
  });
  $('#audio-gain').addEventListener('input', (e) => patchIn(['audio', 'gain'], () => parseFloat(e.target.value)));
  $('#audio-lc').addEventListener('input', (e) => patchIn(['audio', 'lc'], () => parseFloat(e.target.value)));
  $('#audio-hc').addEventListener('input', (e) => patchIn(['audio', 'hc'], () => parseFloat(e.target.value)));
  $$('[data-cl]').forEach((el) => {
    el.addEventListener('input', () => patchIn(['color'], (c) => ({ ...c, [el.dataset.cl]: parseFloat(el.value) })));
  });
  $('#btn-color-reset').addEventListener('click', () => {
    setState((s) => ({ ...s, color: { e:0, c:0, s:1, h:0, g:1 } }));
    $$('[data-cl]').forEach((el) => el.value = ({ e:0, c:0, s:1, h:0, g:1 })[el.dataset.cl]);
  });

  // ----- File picker + drag/drop + YouTube fetch -----
  function handleFiles(fileList) {
    if (!fileList) return;
    const files = [...fileList].filter((f) => /^(video|audio)\//.test(f.type) || /\.(mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
    if (!files.length) { toast('No video/audio files found'); return; }
    for (const f of files) addFile(f);
    toast(`Loading ${files.length} file${files.length > 1 ? 's' : ''}…`);
  }
  const fi = $('#file-input');
  if (fi) fi.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

  // Body-wide drag/drop overlay
  const dropOverlay = document.createElement('div');
  dropOverlay.id = 'drop-overlay';
  dropOverlay.innerHTML = '<div class="big">Drop video / audio</div><div class="sm">or click + Add File in the Media panel</div>';
  Object.assign(dropOverlay.style, {
    position: 'fixed', inset: '0', display: 'none', zIndex: '9999',
    background: 'rgba(0,0,0,0.78)',
    alignItems: 'center', justifyContent: 'center',
    flexDirection: 'column', gap: '10px',
    pointerEvents: 'none', textAlign: 'center',
    color: 'var(--accent, #e8a04a)', fontFamily: 'var(--mono, monospace)',
  });
  dropOverlay.querySelector('.big').style.fontSize = '32px';
  dropOverlay.querySelector('.sm').style.fontSize = '14px';
  dropOverlay.querySelector('.sm').style.opacity = '0.7';
  document.body.appendChild(dropOverlay);

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.style.display = 'flex';
  });
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.style.display = 'none';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.style.display = 'none';
    handleFiles(e.dataTransfer?.files);
  });

  // YouTube fetch
  const ytBtn = $('#btn-yt');
  const ytInput = $('#yt-url');
  if (ytBtn && ytInput) {
    const doFetch = async () => {
      const url = ytInput.value.trim();
      if (!url) { toast('Paste a YouTube URL first'); return; }
      ytBtn.disabled = true;
      const prev = ytBtn.textContent;
      ytBtn.textContent = 'Fetching…';
      try {
        const media = await fetchYouTube(url);
        ytInput.value = '';
        toast(`Loaded "${media.name}" (${media.duration.toFixed(1)}s)`);
      } catch (err) {
        console.error('YT fetch failed', err);
        toast('YT fetch failed: ' + (err.message || err));
      } finally {
        ytBtn.disabled = false;
        ytBtn.textContent = prev;
      }
    };
    ytBtn.addEventListener('click', doFetch);
    ytInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFetch(); });
  }

  // Record button
  const recBtn = $('#btn-record');
  if (recBtn) {
    recBtn.addEventListener('click', async () => {
      try {
        recBtn.disabled = true;
        await startRecording();
        toast('Recording added to bin');
      } catch (err) {
        toast('Recording failed: ' + (err.message || err));
      } finally {
        recBtn.disabled = false;
      }
    });
  }

  // Captions toggle
  $('#btn-captions')?.addEventListener('click', () => {
    setState((s) => ({ ...s, captionsOn: !s.captionsOn }), { skipHistory: true });
    toast(`Captions ${getState().captionsOn ? 'ON' : 'OFF'}`);
  });

  // Help modal
  $('#btn-help')?.addEventListener('click', () => document.getElementById('help-modal')?.showModal());

  // Save / Export
  $('#btn-save').addEventListener('click', () => {
    const s = getState();
    const data = JSON.stringify({
      project: s.project,
      timeline: s.timeline,
      transcript: s.transcript,
      media: s.media.map((m) => ({ ...m, file: undefined, url: undefined })),
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (s.project.name || 'ytp') + '.ytp.json';
    a.click();
    toast('Project saved');
  });
  $('#btn-export').addEventListener('click', () => $$('[data-tab="export"]').forEach((t) => t.click()));
  $('#btn-do-export').addEventListener('click', exportProject);

  // Global toggle-play
  window.addEventListener('ytp:toggle-play', () => togglePlay());

  // ----- Keyboard shortcuts (skip when typing in inputs) -----
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
      if (k === 'y') { e.preventDefault(); return redo(); }
      if (k === 's') { e.preventDefault(); return $('#btn-save').click(); }
      return;
    }
    if (k === ' ' || k === 'k') { e.preventDefault(); return togglePlay(); }
    if (k === 'j') return setState((s) => ({ ...s, playhead: Math.max(0, s.playhead - 5) }), { skipHistory: true });
    if (k === 'l') return setState((s) => ({ ...s, playhead: s.playhead + 5 }), { skipHistory: true });
    if (k === 'left')  return setState((s) => ({ ...s, playhead: Math.max(0, s.playhead - 1/30) }), { skipHistory: true });
    if (k === 'right') return setState((s) => ({ ...s, playhead: s.playhead + 1/30 }), { skipHistory: true });
    if (k === 'i') return setState((s) => ({ ...s, inOut: { ...s.inOut, in: s.playhead } }), { skipHistory: true });
    if (k === 'o') return setState((s) => ({ ...s, inOut: { ...s.inOut, out: s.playhead } }), { skipHistory: true });
    if (k === 'c') return setState((s) => ({ ...s, captionsOn: !s.captionsOn }), { skipHistory: true });
    if (k === 'delete' || k === 'backspace') {
      // delete selected clip
      const sel = getState().selectedClipId;
      if (!sel) return;
      setState((st) => {
        const tracks = { ...st.timeline.tracks };
        for (const tk of Object.keys(tracks)) {
          tracks[tk] = tracks[tk].filter((c) => c.id !== sel);
        }
        return { ...st, timeline: { ...st.timeline, tracks }, selectedClipId: null };
      });
      toast('Deleted clip');
    }
  });

  // Subscribers
  subscribe(render);
  // initial render + first paint of detection state
  setState((s) => ({ ...s }), { skipHistory: true });
  $('#detect-status').textContent = 'no clip selected';
  initTimeline();
  initRender();
  startMixer();
  initAutosave();
}

window.addEventListener('DOMContentLoaded', init);
