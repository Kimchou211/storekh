// ═══════════════════════════════════════════════════════
//  NyKa Shop — Service Worker  v1.0
//  Cache Strategy:
//    - Shell (HTML/CSS/JS) → Cache First, fallback network
//    - API calls → Network First, fallback cache
//    - Images → Cache First, long TTL
// ═══════════════════════════════════════════════════════

const CACHE_NAME    = 'nyka-v1';
const API_CACHE     = 'nyka-api-v1';
const IMG_CACHE     = 'nyka-img-v1';

// Files to pre-cache on install (App Shell)
const SHELL_FILES = [
  '/index.html',
  '/dashboard.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── INSTALL — pre-cache shell ──────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache error (ok if dev):', err))
  );
});

// ── ACTIVATE — clean old caches ────────────────────────
self.addEventListener('activate', event => {
  const KEEP = [CACHE_NAME, API_CACHE, IMG_CACHE];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH — routing logic ──────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET & browser-extension requests
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // ── API calls → Network First ──────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE, 10000));
    return;
  }

  // ── Google Fonts → Cache First ─────────────────────
  if (url.hostname.includes('fonts.g') || url.hostname.includes('fonts.gstatic')) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // ── Images → Cache First ───────────────────────────
  if (request.destination === 'image' || /\.(png|jpg|jpeg|webp|svg|gif|ico)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, IMG_CACHE));
    return;
  }

  // ── HTML Pages → Network First (always fresh) ──────
  if (request.destination === 'document') {
    event.respondWith(networkFirst(request, CACHE_NAME, 5000));
    return;
  }

  // ── Everything else → Cache First ─────────────────
  event.respondWith(cacheFirst(request, CACHE_NAME));
});

// ── STRATEGIES ─────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirst(request, cacheName, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    clearTimeout(timer);
    const cached = await caches.match(request);
    if (cached) return cached;
    // Offline fallback for HTML
    if (request.destination === 'document') {
      const fallback = await caches.match('/index.html');
      if (fallback) return fallback;
    }
    return new Response(
      JSON.stringify({ success: false, message: 'Offline — No connection' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── BACKGROUND SYNC (optional: retry failed orders) ────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-orders') {
    event.waitUntil(syncPendingOrders());
  }
});

async function syncPendingOrders() {
  // Placeholder — extend this to retry failed API calls
  console.log('[SW] Background sync triggered');
}

// ── PUSH NOTIFICATIONS (ready for future use) ──────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'NyKa Shop 🌸', {
      body:  data.body  || '',
      icon:  data.icon  || '/icons/icon-192.png',
      badge: data.badge || '/icons/icon-96.png',
      data:  data.url   || '/',
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data || '/')
  );
});