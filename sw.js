// Service worker: makes launches instant on a slow phone or connection.
// - The page (index.html): from the phone's cache, at once; the fresh copy is fetched in the background
//   and saved. When it differs (a new deploy), the open app is told ('sf:update') and reloads itself at a
//   safe moment (js/app.js: never in the middle of a sale). With no saved copy yet, it waits for the network.
// - css/js stamped with ?v=..., images, fonts, the pinned CDN libraries: from the phone's cache.
//   Their URLs change whenever their content does (scripts/bump-version.sh), so the cache never goes stale.
// - Supabase (data, login) and anything that isn't a GET: never touched, always straight to the network.
// VERSION is stamped by scripts/bump-version.sh; a new value drops the old cache.
// Kill switch: replace this whole file with the one in the README ("Service worker") and deploy.
const VERSION = 'sf-3963f660';

const CACHEABLE_HOSTS = ['cdn.jsdelivr.net'];
const PAGE = 'index'; // cache key of the page

// A new version saves its page before taking over, so the launch after a deploy opens from the cache too.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('./', { cache: 'no-cache' });
      if (res.ok) await (await caches.open(VERSION)).put(PAGE, res);
    } catch (_) { /* offline: the first launch fetches it */ }
    await self.skipWaiting();
  })());
});

// The previous version's cache is dropped on the next page load, not here: a page that opened from it a
// moment ago may still be loading its css/js, and must get those old files, never the new ones.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
const dropOldCaches = async () => {
  for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    // Only the app's page; anything else opened directly (README.md, sw.js…) goes to the network as usual
    const root = new URL(self.registration.scope).pathname;
    if (url.origin === self.location.origin && (url.pathname === root || url.pathname === `${root}index.html`)) {
      event.respondWith(cachedPage(event, req));
    }
    return;
  }
  const sameOrigin = url.origin === self.location.origin;
  const staticAsset = sameOrigin
    ? (url.searchParams.has('v') || /\/(img|fonts)\//.test(url.pathname))
    : CACHEABLE_HOSTS.includes(url.hostname);
  if (staticAsset) event.respondWith(cacheFirst(req));
  // everything else (Supabase, sw.js itself, unknown files): default browser behavior
});

async function cacheFirst(req) {
  const hit = await caches.match(req); // any version's cache (see 'activate')
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(VERSION)).put(req, res.clone()).catch(() => {});
  return res;
}

// Fresh page from the network, saved for the next launch. With `cached` (the copy the app just opened
// with), tells the open app when the page changed: a new deploy.
// no-cache: GitHub Pages lets browsers keep the page 10 minutes; this asks the server (a cheap 304 if unchanged).
async function refreshPage(event, cache, req, cached) {
  const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  if (!res.ok || res.redirected) return null;
  const save = cache.put(PAGE, res.clone());
  if (!cached) { event.waitUntil(save.catch(() => {})); return res; } // answer now, save meanwhile
  const [before, after] = await Promise.all([cached.text(), res.text()]);
  await save;
  if (before !== after) for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage('sf:update');
  return null;
}

async function cachedPage(event, req) {
  event.waitUntil(dropOldCaches());
  const cache = await caches.open(VERSION);
  const cached = await cache.match(PAGE);
  if (cached) {
    event.waitUntil(refreshPage(event, cache, req, cached.clone()).catch(() => {})); // after answering
    return cached;
  }
  // First visit, or right after a new version dropped the old cache: wait for the network
  return (await refreshPage(event, cache, req, null).catch(() => null)) || fetch(req);
}
