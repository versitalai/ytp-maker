// Cache app shell for offline use. YouTube/Piped requests always go to network.
const CACHE = 'ytp-maker-v3';
const SHELL = [
  './',
  './index.html',
  './styles/main.css',
  './src/state.js',
  './src/media.js',
  './src/transcript.js',
  './src/ytp.js',
  './src/timeline.js',
  './src/render.js',
  './src/audio.js',
  './src/memes.js',
  './src/community.js',
  './src/export.js',
  './src/main.js',
  './assets/favicon.svg',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Always network for cross-origin (Piped, YouTube) and live audio/video
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => cached))
  );
});
