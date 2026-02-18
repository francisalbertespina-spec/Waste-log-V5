// ═══════════════════════════════════════════════════════════════════════════
// HDJV WMS - Service Worker
// Handles push notifications and background sync
// ═══════════════════════════════════════════════════════════════════════════

const SW_VERSION = 'wms-sw-v1';

// Install - cache nothing, just activate immediately
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  self.skipWaiting();
});

// Activate - claim clients immediately
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(self.clients.claim());
});

// ── Push event: fired when a push message arrives from server ──
self.addEventListener('push', event => {
  console.log('[SW] Push received:', event);

  let data = { title: 'WMS Notification', body: 'You have a new notification', type: 'general' };

  if (event.data) {
    try { data = { ...data, ...event.data.json() }; }
    catch (e) { data.body = event.data.text(); }
  }

  const options = {
    body: data.body,
    icon: '/logo.png',
    badge: '/logo.png',
    tag: data.tag || 'wms-notification',
    renotify: true,
    requireInteraction: data.type === 'approval_request',
    data: { url: data.url || '/', type: data.type },
    actions: data.type === 'approval_request'
      ? [
          { action: 'open_admin', title: '👥 Open Admin' },
          { action: 'dismiss',    title: 'Dismiss' }
        ]
      : []
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── Notification click handler ──
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event.action);
  event.notification.close();

  if (event.action === 'dismiss') return;

  // Open or focus the app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing tab if open
      for (const client of clients) {
        if ('focus' in client) {
          client.focus();
          // Send message to app to navigate to admin section
          client.postMessage({ type: 'NAVIGATE_TO_ADMIN', reason: event.notification.data?.type });
          return;
        }
      }
      // Open new tab
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});

// ── Message handler: receive messages from the main app ──
self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);

  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, notifType } = event.data;
    self.registration.showNotification(title || 'WMS Alert', {
      body: body || '',
      icon: '/logo.png',
      badge: '/logo.png',
      tag: tag || 'wms-alert',
      requireInteraction: notifType === 'approval_request',
      data: { type: notifType }
    });
  }

  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Background sync: check for pending approvals ──
self.addEventListener('sync', event => {
  if (event.tag === 'check-pending-users') {
    console.log('[SW] Background sync: check-pending-users');
    // Background sync fires when connectivity is restored
    // The actual check is done in the main thread via polling
  }
});
