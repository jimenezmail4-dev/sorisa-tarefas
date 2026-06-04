// Service Worker v4 - network first, sem cache
const CACHE = 'sorisa-tarefas-v4';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Sempre vai à rede, nunca serve do cache
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
