// Service worker: makes repeat launches fast on a slow phone or connection.
// - The page (index.html): network first, so a new deploy shows up right away; if the network is slow
//   (over NAV_TIMEOUT) or offline, the last copy opens instead and the fresh one is saved for next time.
// - css/js stamped with ?v=..., images, the pinned supabase-js and the Google Fonts: from the phone's cache.
//   Their URLs change whenever their content does (scripts/bump-version.sh), so the cache never goes stale.
// - Supabase (data, login) and anything that isn't a GET: never touched, always straight to the network.
// VERSION is stamped by scripts/bump-version.sh; a new value drops the old cache.
// Kill switch: replace this whole file with the one in the README ("Service worker") and deploy.
const VERSION = 'sf-9e2a430c';
const NAV_TIMEOUT = 2500;

const CACHEABLE_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(event, req));
    return;
  }
  const sameOrigin = url.origin === self.location.origin;
  const staticAsset = sameOrigin
    ? (url.searchParams.has('v') || url.pathname.includes('/img/'))
    : CACHEABLE_HOSTS.includes(url.hostname);
  if (staticAsset) event.respondWith(cacheFirst(req));
  // everything else (Supabase, sw.js itself, unknown files): default browser behavior
});

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(event, req) {
  const cache = await caches.open(VERSION);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put('index', res.clone()).catch(() => {});
    return res;
  });
  event.waitUntil(network.catch(() => {})); // keep saving the fresh page even after a cache answer
  const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (_) { /* offline: fall through to the cached page */ }
  const cached = await cache.match('index');
  return cached || network; // first visit with no copy yet: wait for the network
}
