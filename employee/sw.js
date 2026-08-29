// OHM Employee Portal — Service Worker
// Handles background Web Push so notifications arrive even when the app is closed.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  if (!e.data) return;
  let d;
  try { d = e.data.json(); } catch { d = { title: 'OHM', body: e.data.text() }; }
  const iconBase = self.registration.scope;
  e.waitUntil(
    self.registration.showNotification(d.title || 'OHM Employee Portal', {
      body: d.body || '',
      icon: iconBase + 'logo-192.png',
      badge: iconBase + 'logo-192.png',
      tag: d.tag || 'ohm',
      data: { url: self.registration.scope },
      requireInteraction: !!d.important,
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const match = clients.find(c => c.url.startsWith(self.registration.scope));
      if (match) return match.focus();
      return self.clients.openWindow(url);
    })
  );
});
