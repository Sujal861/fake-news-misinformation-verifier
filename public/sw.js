/**
 * Service worker: the app shell, cached for offline use.
 *
 * ForwardCheck's promise is that the engine works with no network. A service
 * worker is what makes that true of the *page* as well — once it has been opened
 * on a phone, the whole thing opens and runs offline, and the installed app can
 * be a share target so a forwarded message can go straight from WhatsApp here.
 *
 * Deliberately conservative:
 *   - /api/* is never cached. A verdict is not a static asset and a stale one
 *     would be a lie.
 *   - Everything is network-first, falling back to the cache only when the
 *     network is gone. Not stale-while-revalidate: engine.js decides what a
 *     message is flagged for, so serving the previous deploy's engine alongside
 *     this deploy's page is a wrong answer rather than a slow one. Every file
 *     here is tens of kilobytes; correctness is worth the round trip.
 *   - Cache names are versioned and older caches are deleted on activate.
 */

const VERSION = 'v2';
const SHELL_CACHE = `forwardcheck-shell-${VERSION}`;
const RUNTIME_CACHE = `forwardcheck-runtime-${VERSION}`;

/** The app shell. engine.js is the offline engine — the page is useless without it. */
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/engine.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/space-grotesk.woff2',
  '/fonts/jetbrains-mono.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is atomic: one 404 would discard the whole precache. Each entry is
      // added individually so a missing optional file cannot break the app.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live lookups always go to the network.
  if (url.pathname.startsWith('/api/')) return;

  const isNavigation = request.mode === 'navigate';
  event.respondWith(networkFirst(request, isNavigation ? '/index.html' : null));
});

/**
 * Fresh when there is a network, cached when there is not.
 *
 * `fallbackUrl` is the offline document for a navigation — a shared link such as
 * `/?text=…` is not itself a cached entry, so it needs a known page to land on.
 */
async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Read through every cache: the shell precache and anything picked up since.
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const document = await caches.match(fallbackUrl);
      if (document) return document;
    }
    return Response.error();
  }
}
