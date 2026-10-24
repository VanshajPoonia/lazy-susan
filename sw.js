// Offline support. Once the model is cached (transformers.js keeps it in Cache Storage),
// Lazy Susan works with no connection at all: at the table, in a basement restaurant,
// abroad without data. It is also the simplest proof that the photo goes nowhere.
const SHELL = 'ls-shell-v1';
const RUNTIME = 'ls-runtime-v1';
const FILES = [
  './', 'index.html', 'assets/styles.css', 'assets/icon.svg', 'manifest.webmanifest',
  'src/app.js', 'src/check.js', 'src/donut.js', 'src/model.js', 'src/money.js', 'src/ocr.js', 'src/reader.js', 'src/rows.js', 'src/split.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ls-') && k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// GitHub Pages cannot send the cross-origin isolation headers that let the models use
// several CPU threads, so this worker adds them to every page and script it serves.
// (On a host that can send headers, vercel.json does the same job.)
function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && url.hostname !== 'cdn.jsdelivr.net') return; // model files: transformers.js caches those itself

  // Network first for our own files (so deploys show up), cache when offline.
  // Cache first for pinned library builds on jsDelivr.
  e.respondWith((async () => {
    const cache = await caches.open(sameOrigin ? SHELL : RUNTIME);
    if (!sameOrigin) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return sameOrigin ? isolate(res) : res;
    } catch {
      const hit = (await cache.match(e.request, { ignoreSearch: true })) || (await caches.match('index.html'));
      return sameOrigin ? isolate(hit) : hit;
    }
  })());
});
