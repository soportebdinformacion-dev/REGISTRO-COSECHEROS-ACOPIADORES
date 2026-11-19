/* Service Worker - REPORTE DE COSECHADORES
 * - Precachea el "app shell" para abrir sin internet.
 * - config.js: red primero (para que un cambio de URL/clave se aplique), con respaldo en caché.
 * - Las llamadas a Apps Script (otro origen) NO se interceptan.
 * Suba el número de VERSION cada vez que cambie algún archivo. */
const VERSION = 'v1.0.0';
const CACHE = 'cosechadores-' + VERSION;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
const OPTIONAL = ['LOGO%20HUARMEY.png']; // si aún no existe, no rompe la instalación

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    await Promise.all(OPTIONAL.map(u => c.add(u).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('cosechadores-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r;
    }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    } catch (err) {
      if (req.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});
