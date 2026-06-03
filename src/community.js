// community.js — localStorage-backed clip library & "remix mode" (Git-for-YTPs)
import { getState, setState, uid, toast } from './state.js';

const KEY = 'ytp-maker:community:v1';
const PROJ_KEY = 'ytp-maker:projects:v1';

function loadLib() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function saveLib(lib) { localStorage.setItem(KEY, JSON.stringify(lib)); }

export function listCommunity() { return loadLib().sort((a, b) => b.when - a.when); }

export function publishCurrent() {
  const s = getState();
  const proj = {
    id: uid('proj'),
    title: s.project.name,
    when: Date.now(),
    tracks: s.timeline.tracks,
    duration: Math.max(0, ...Object.values(s.timeline.tracks).flat().map((c) => c.start + (c.outPoint - c.inPoint))),
    mediaRefs: s.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, url: m.url })),
  };
  const lib = loadLib();
  lib.unshift(proj);
  saveLib(lib);
  toast('Project published to community library');
}

export function forkProject(id) {
  const lib = loadLib();
  const src = lib.find((p) => p.id === id);
  if (!src) { toast('Not found'); return; }
  // Copy as new local media + clips
  const newMedia = src.mediaRefs.map((m) => ({ ...m, id: uid('med') }));
  setState((s) => ({
    ...s,
    project: { ...s.project, name: src.title + ' (remix)' },
    media: [...s.media, ...newMedia],
    timeline: {
      ...s.timeline,
      tracks: {
        V1: src.tracks.V1.map((c) => remapClip(c, newMedia)),
        V2: src.tracks.V2.map((c) => remapClip(c, newMedia)),
        A1: src.tracks.A1.map((c) => remapClip(c, newMedia)),
        A2: src.tracks.A2.map((c) => remapClip(c, newMedia)),
      },
    },
  }));
  toast('Forked: ' + src.title);
}

function remapClip(c, mediaList) {
  const nm = mediaList.find((m) => m.id === c.mediaId) || mediaList[0];
  return { ...c, id: uid('clip'), mediaId: nm ? nm.id : c.mediaId };
}
