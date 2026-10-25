// App-shell service worker. The server injects BUILD (content hash of the shell) and
// SHELL (versioned asset URLs) when serving this file, so every deploy gets a fresh cache.
const BUILD = 'dev';
const SHELL = [];
const CACHE = `codex-web-harness-shell-${BUILD}`;
const OWN_CACHES = ['codex-oracle-shell-', 'codex-web-harness-shell-'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => OWN_CACHES.some((prefix) => key.startsWith(prefix)) && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  const scope = new URL(self.registration.scope).pathname;

  // Versioned assets never change: serve from cache first.
  if (url.searchParams.has('v')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)); }
      return response;
    })));
    return;
  }

  // The page itself: network first so a deploy is picked up, cached copy when offline.
  if (request.mode === 'navigate' && (url.pathname === scope || url.pathname === `${scope}index.html`)) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(scope, copy)); }
      return response;
    }).catch(async () => (await caches.match(scope)) || Response.error()));
  }
});
