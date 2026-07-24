'use strict';

/* App-shell service worker. SW_VERSION must move with APP_VERSION and the
   index.html ?v= stamps on every release (cycle-check.sh enforces agreement). */

const SW_VERSION = '0.97.64';
const CACHE_STATIC = `respondertx-static-${SW_VERSION}`;
const CACHE_DATA = `respondertx-data-${SW_VERSION}`;

// the LAN-only chat and master clients are deliberately absent: the public mirror strips them
const PRECACHE_PATHS = [
  'css/app.css',
  'css/notes.css',
  'css/team.css',
  'js/vendor/leaflet.css',
  'js/vendor/leaflet.js',
  'js/vendor/MarkerCluster.css',
  'js/vendor/MarkerCluster.Default.css',
  'js/vendor/leaflet.markercluster.js',
  'js/vendor/hls.light.min.js',
  'js/vendor/qrcode.min.js',
  'js/usng.js',
  'js/i18n.js',
  'js/core.js',
  'js/map.js',
  'js/sources.js',
  'js/panels.js',
  'js/board.js',
  'js/boot.js',
  'js/notes.js',
  'js/team.js',
  'assets/brand/logo-lockup.png',
  'assets/brand/logo-lockup-dark.png',
  'assets/brand/icon.svg',
  'assets/brand/favicon-32.png',
  'manifest.webmanifest',
];
// referenced by leaflet.css/js relative to the stylesheet, so requested unstamped
const PRECACHE_UNSTAMPED = [
  'js/vendor/images/marker-icon.png',
  'js/vendor/images/marker-icon-2x.png',
  'js/vendor/images/marker-shadow.png',
  'js/vendor/images/layers.png',
  'js/vendor/images/layers-2x.png',
];
const PRECACHE = ['./']
  .concat(PRECACHE_PATHS.map((p) => `${p}?v=${SW_VERSION}`))
  .concat(PRECACHE_UNSTAMPED);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_STATIC).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.indexOf('respondertx-') === 0 && n !== CACHE_STATIC && n !== CACHE_DATA)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// navigations: freshness first (the board is a live product); cached shell only when offline
async function shellNetworkFirst(request) {
  const cache = await caches.open(CACHE_STATIC);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put('./', fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match('./');
    if (hit) return hit;
    throw err;
  }
}

// clients bust /data/ fetches with ?_=Date.now(); key by bare path so the
// offline fallback matches and only one copy per file is ever cached
function dataCacheKey(rawUrl) {
  const u = new URL(rawUrl, self.location.origin);
  return u.origin + u.pathname;
}

async function dataNetworkFirst(request) {
  const key = dataCacheKey(request.url);
  const cache = await caches.open(CACHE_DATA);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(key, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

// ?v= stamped assets are immutable by stamp: cache hit wins, misses fill the cache
async function stampedCacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    const cache = await caches.open(CACHE_STATIC);
    cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles/radar/vendors pass through untouched
  if (url.pathname.indexOf('/api/') === 0) return; // never intercept first-party APIs
  if (req.mode === 'navigate') {
    event.respondWith(shellNetworkFirst(req));
    return;
  }
  if (url.pathname.indexOf('/data/') === 0 && url.pathname.slice(-5) === '.json') {
    event.respondWith(dataNetworkFirst(req));
    return;
  }
  if (url.pathname.indexOf('/js/vendor/images/') === 0) {
    event.respondWith(stampedCacheFirst(req));
    return;
  }
  if (url.searchParams.has('v')) event.respondWith(stampedCacheFirst(req));
});
