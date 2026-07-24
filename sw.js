'use strict';

/* App-shell service worker. SW_VERSION must move with APP_VERSION and the
   index.html ?v= stamps on every release (cycle-check.sh enforces agreement). */

const SW_VERSION = '0.97.74';
const CACHE_STATIC = `respondertx-static-${SW_VERSION}`;
const CACHE_DATA = `respondertx-data-${SW_VERSION}`;
// version-independent: holds the subscriber's language hint so a payload-free push can be
// localized; must survive SW updates (excluded from the activate cleanup)
const CACHE_PUSH = 'respondertx-push';

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
      .filter((n) => n.indexOf('respondertx-') === 0 && n !== CACHE_STATIC && n !== CACHE_DATA && n !== CACHE_PUSH)
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

/* ---------- web push (P2: encrypted localized payloads, payload-free fallback) ---------- */

// P2 pushes carry an encrypted pre-localized payload (title/body/tag/url/lang composed server
// side per the stored subscription language). A payload-free or unparseable push still shows a
// generic localized Flash Flood Emergency notification from this baked table (compat rule). The
// last line is the standing invariant short form: never a WEA/911 replacement.
const PUSH_FALLBACK = {
  en: {
    title: 'Flash Flood Emergency · ResponderTX',
    body: 'New Flash Flood Emergency in the area. Open the board for details. Not a WEA/911 service.',
  },
  es: {
    title: 'Emergencia de inundación repentina · ResponderTX',
    body: 'Nueva emergencia de inundación repentina en la zona. Abra el tablero para más detalles. No sustituye a WEA ni al 911.',
  },
};

async function pushLang() {
  try {
    const hit = await (await caches.open(CACHE_PUSH)).match('/push-lang');
    if (hit && (await hit.text()).trim() === 'es') return 'es';
  } catch (err) { /* cache unavailable — default language */ }
  return 'en';
}

// ALWAYS show exactly one notification, even on empty payload or parse failure — browsers
// punish silent pushes by revoking the subscription
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = null;
    try { data = event.data ? event.data.json() : null; } catch (err) { data = null; }
    // the payload's own language wins (it matches the stored subscription pref); the cached
    // hint only localizes payload-free fallbacks
    const lang = (data && (data.lang === 'es' || data.lang === 'en')) ? data.lang : await pushLang();
    const fb = PUSH_FALLBACK[lang];
    await self.registration.showNotification((data && data.title) || fb.title, {
      body: (data && data.body) || fb.body,
      tag: (data && data.tag) || 'respondertx-push',
      lang,
      icon: 'assets/brand/favicon-180.png',
      badge: 'assets/brand/favicon-32.png',
      data: { url: (data && data.url) || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      try {
        await c.focus();
        if (url !== '/' && c.navigate) await c.navigate(url);
      } catch (err) { /* focus/navigate denied — the board tab still exists */ }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
