// Работа без интернета (веб-версия): все файлы приложения кешируются при установке.
// FILES (файл -> отпечаток SHA-256) и CACHE подставляет publish.py при публикации.
// При обновлении неизменённые файлы переносятся из старого кеша, по сети качаются только изменённые.
// В сборке Android (Capacitor) не используется.
const FILES = {
 "./": "72d5ad89c58bf7a8",
 "index.html": "72d5ad89c58bf7a8",
 "style.css": "24604034df8083bb",
 "app.js": "f9023635fc62a433",
 "strings.js": "e5ef1d0f29427f83",
 "parsers.js": "03ca2449741c3411",
 "telegram.js": "82cffaae1f29a7dc",
 "native.js": "8378a097469a5ea5",
 "version.js": "513daa1971d4a391",
 "lib/jszip.min.js": "acc7e41455a80765",
 "manifest.webmanifest": "f14f622f51b0dd5f",
 "icons/icon-180.png": "10463be18fd60b47",
 "icons/icon-192.png": "d78c89a98f1764dc",
 "icons/icon-512.png": "98913cb2a8da4411",
 "fonts/roboto-condensed-cyrillic.woff2": "c4afc8bd4b188649",
 "fonts/roboto-condensed-latin.woff2": "543c03fff71d1b39",
 "fonts/literata-cyrillic.woff2": "39bb5c343c21e6a4",
 "fonts/literata-latin.woff2": "a60c193b55766b68"
};
const CACHE = 'potok-ea836a5b93';
const META = '__hashes';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const old = [];
    for (const key of await caches.keys()) {
      if (key === CACHE) continue;
      const c = await caches.open(key);
      const meta = await c.match(META);
      if (meta) old.push({ c, hashes: await meta.json() });
    }
    await Promise.all(Object.entries(FILES).map(async ([file, hash]) => {
      let r = null;
      if (hash) {
        for (const o of old) {
          if (o.hashes[file] === hash && (r = await o.c.match(file))) break;
        }
      }
      if (!r) {
        r = await fetch(new Request(file, { cache: 'reload' }));
        if (!r.ok) throw new Error(file + ': ' + r.status);
      }
      await cache.put(file, r);
    }));
    await cache.put(META, new Response(JSON.stringify(FILES)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // запросы к Worker (Telegram-библиотека) и любые чужие адреса не кэшируем
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
