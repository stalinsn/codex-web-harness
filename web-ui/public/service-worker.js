const CACHE = 'codex-web-harness-shell-v34';
const SHELL = [
  '/codex-agent/',
  '/codex-agent/styles.css',
  '/codex-agent/js/activity.js',
  '/codex-agent/js/api.js',
  '/codex-agent/js/app.js',
  '/codex-agent/js/auth.js',
  '/codex-agent/js/composer.js',
  '/codex-agent/js/config.js',
  '/codex-agent/js/conversation.js',
  '/codex-agent/js/deferred-queue.js',
  '/codex-agent/js/dom.js',
  '/codex-agent/js/events.js',
  '/codex-agent/js/format.js',
  '/codex-agent/js/inspector.js',
  '/codex-agent/js/layout.js',
  '/codex-agent/js/markdown.js',
  '/codex-agent/js/messages.js',
  '/codex-agent/js/models.js',
  '/codex-agent/js/projects.js',
  '/codex-agent/js/queue.js',
  '/codex-agent/js/rate-limit.js',
  '/codex-agent/js/sound.js',
  '/codex-agent/js/state.js',
  '/codex-agent/js/thread-list.js',
  '/codex-agent/js/voice.js',
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
