/* Offline support: caches the whole app on first visit so it runs with no signal.
 * Only the app's own files are cached; no vehicle or audit data passes through here. */
const VERSION = 'plate-audit-v1.0.0';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/export.js', 'js/ocr.js', 'js/vehicles.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'vendor/tesseract.min.js', 'vendor/worker.min.js',
  'vendor/core/tesseract-core-lstm.wasm.js', 'vendor/core/tesseract-core-simd-lstm.wasm.js', 'vendor/core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'vendor/lang/eng.traineddata.gz',
  'vendor/xlsx.full.min.js', 'vendor/exceljs.min.js', 'vendor/jszip.min.js', 'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    // First install: take over right away so the app works offline immediately.
    // Updates (an older version's cache exists) wait until the user taps "Update now".
    const isUpdate = (await caches.keys()).some((k) => k !== VERSION && k.startsWith('plate-audit-'));
    if (!isUpdate) self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k.startsWith('plate-audit-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch other sites
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (req.mode === 'navigate') {
      const hit = await cache.match('index.html');
      if (hit) return hit;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('Offline and not cached', { status: 503, statusText: 'Offline' });
    }
  })());
});
