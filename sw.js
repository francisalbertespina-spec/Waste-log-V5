// ═══════════════════════════════════════════════════════════════════════════
// HDJV WMS - Service Worker  (cache-first shell + push notifications)
// ═══════════════════════════════════════════════════════════════════════════

const SW_VERSION  = 'wms-sw-v2';
const SHELL_CACHE = `wms-shell-${SW_VERSION}`;

// App shell assets to cache on install
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './logo.png',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&family=DM+Mono:wght@400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// ── Install: cache the app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for shell assets, network-first for API calls ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network-first for Google Apps Script API calls
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('accounts.google.com')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Cache-first for everything else (shell assets, fonts, CDN libs)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Only cache successful same-origin or CDN responses
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }
        const clone = response.clone();
        caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ── Push: show notification ──
self.addEventListener('push', event => {
  let data = { title: 'WMS Notification', body: 'You have a new notification', type: 'general' };
  if (event.data) {
    try { data = { ...data, ...event.data.json() }; }
    catch (e) { data.body = event.data.text(); }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './logo.png',
      badge: './logo.png',
      tag: data.tag || 'wms-notification',
      renotify: true,
      requireInteraction: data.type === 'approval_request',
      data: { url: data.url || './', type: data.type },
      actions: data.type === 'approval_request'
        ? [{ action: 'open_admin', title: '👥 Open Admin' }, { action: 'dismiss', title: 'Dismiss' }]
        : []
    })
  );
});

// ── Notification click ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'NAVIGATE_TO_ADMIN', reason: event.notification.data?.type });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// ── Message handler ──
self.addEventListener('message', event => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, notifType } = event.data;
    self.registration.showNotification(title || 'WMS Alert', {
      body: body || '',
      icon: './logo.png',
      badge: './logo.png',
      tag: tag || 'wms-alert',
      requireInteraction: notifType === 'approval_request',
      data: { type: notifType }
    });
  }
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── Background sync ──
self.addEventListener('sync', event => {
  if (event.tag === 'check-pending-users') {
    // Sync handled in main thread via polling
  }
});
