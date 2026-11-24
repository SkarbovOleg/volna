/* Волна — service worker: оболочка приложения кэшируется, данные всегда из сети. */
const CACHE = 'volna-shell-v6';
const SHELL = ['./', './style.css', './manifest.webmanifest', './icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // чат, фото и настройки — только из сети
  if (url.pathname.includes('/api/') || url.pathname.includes('/f/') || url.pathname.endsWith('/config.js')) {
    return;
  }

  // переход по ссылке: свежая страница, при обрыве — сохранённая оболочка
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./')));
    return;
  }

  if (url.origin === self.location.origin) {
    const isCode = /\.(js|css|webmanifest)$/.test(url.pathname);
    event.respondWith(
      isCode
        ? fetch(request)
            .then((response) => {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
              return response;
            })
            .catch(() => caches.match(request))
        : caches.match(request).then((hit) => hit || fetch(request)),
    );
  }
});
