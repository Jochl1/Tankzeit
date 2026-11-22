// Service Worker: App-Shell offline, Daten "stale-while-revalidate", Live-APIs nie cachen.
const VERSION = 'tz-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/api.js', 'js/charts.js', 'js/decision.js', 'js/demo.js', 'js/format.js', 'js/profile.js', 'js/store.js',
  'data/generic-profile.json', 'data/oil-model.json', 'data/events.json',
  'icons/icon.svg', 'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Tankerkönig, Nominatim: immer Netz
  if (url.pathname.includes('/data/')) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const cached = await c.match(e.request);
      const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => cached);
      return cached || net;
    }));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok) caches.open(VERSION).then((c) => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match('index.html'))));
});
