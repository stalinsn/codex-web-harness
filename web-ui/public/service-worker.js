const CACHE = 'codex-web-harness-shell-v31';
const SHELL = [
  '/codex-agent/',
  '/codex-agent/styles.readability-20261025.css',
  '/codex-agent/styles.session-20261025.css',
  '/codex-agent/styles.collaboration-20261025.css',
  '/codex-agent/styles.sidebar-groups-20261025.css',
  '/codex-agent/styles.history-lazy-20261025.css',
  '/codex-agent/styles.sidebar-organization-20261025.css',
  '/codex-agent/styles.activity-width-20261025.css',
  '/codex-agent/styles.rate-limit-20261025.css',
  '/codex-agent/styles.audio-flow-20261025.css',
  '/codex-agent/app.audio-flow-20261025.js',
  '/codex-agent/manifest.webmanifest',
  '/codex-agent/icon.svg',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => (key.startsWith('codex-oracle-shell-') || key.startsWith('codex-web-harness-shell-')) && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/') || url.pathname.includes('/terminal/')) return;
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});
