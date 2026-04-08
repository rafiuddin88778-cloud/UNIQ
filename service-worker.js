// ═══════════════════════════════════════════
//  UNIQ  —  Service Worker
//  Handles: caching, push notifications,
//  ringtone sound, vibration patterns
// ═══════════════════════════════════════════

const CACHE_NAME = 'uniq-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ── INSTALL ────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache static assets (non-critical — don't fail install if some are missing)
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Some assets failed to cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ───────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH (Cache-first for static, network-first for Firebase) ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip Firebase / CDN requests — always go network
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('fonts.googleapis')
  ) {
    return; // Let browser handle normally
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for same-origin assets
        if (
          response.ok &&
          event.request.method === 'GET' &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
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

// ── PUSH NOTIFICATION ─────────────────────
//
// How to send a push from your server / Firebase Function:
//
//   const payload = JSON.stringify({
//     title: "John Doe",
//     body: "Hey, what's up?",
//     icon: "/icons/icon-192.png",
//     badge: "/icons/icon-192.png",
//     tag: "chat-message",
//     data: { url: "/", senderId: "uid123" },
//     isCall: false          // set true for incoming call ringtone
//   });
//
//   webpush.sendNotification(subscription, payload);
//
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'UNIQ', body: event.data ? event.data.text() : 'New message' };
  }

  const title   = data.title  || 'UNIQ';
  const body    = data.body   || 'You have a new message';
  const icon    = data.icon   || '/icons/icon-192.png';
  const badge   = data.badge  || '/icons/icon-192.png';
  const tag     = data.tag    || 'uniq-notification';
  const isCall  = data.isCall || false;

  // Vibration pattern: ringtone-like for calls, gentle buzz for messages
  const vibration = isCall
    ? [300, 150, 300, 150, 300, 150, 300]  // phone-ring pattern
    : [200, 100, 200];                       // double buzz

  // Play a notification sound using the Notification API sound field
  // (Chrome/Android supports this via the notification itself)
  const notificationOptions = {
    body,
    icon,
    badge,
    tag,
    vibrate: vibration,
    renotify: true,
    requireInteraction: isCall,   // Keep call notifications on screen
    silent: false,
    data: data.data || { url: '/' },
    actions: isCall
      ? [
          { action: 'accept', title: 'Accept', icon: '/icons/icon-192.png' },
          { action: 'decline', title: 'Decline' }
        ]
      : [
          { action: 'reply', title: 'Open' }
        ]
  };

  // If a notification sound .mp3 is available, use it via an Audio object
  // NOTE: Service workers cannot play Audio directly, but we can
  // post a message to the client to play it.
  event.waitUntil(
    self.registration.showNotification(title, notificationOptions)
      .then(() => {
        // Tell all open clients to play the notification sound
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => {
            client.postMessage({
              type: isCall ? 'PLAY_RINGTONE' : 'PLAY_NOTIFICATION_SOUND'
            });
          });
        });
      })
  );
});

// ── NOTIFICATION CLICK ─────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const action = event.action;
  const data   = event.notification.data || {};

  if (action === 'decline') {
    // Post message to app to decline the call
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(client => client.postMessage({ type: 'DECLINE_CALL' }));
    });
    return;
  }

  // Open or focus the app window
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const targetUrl = data.url || '/';
      // If app is already open, focus it
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ── NOTIFICATION CLOSE ─────────────────────
self.addEventListener('notificationclose', event => {
  // User dismissed notification without tapping
  console.log('[SW] Notification dismissed:', event.notification.tag);
});

// ── PUSH SUBSCRIPTION CHANGE ───────────────
self.addEventListener('pushsubscriptionchange', event => {
  // Re-subscribe when subscription expires
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(self._vapidPublicKey || '')
    }).then(subscription => {
      // Send new subscription to your server here
      console.log('[SW] Re-subscribed:', subscription);
    })
  );
});

// ── HELPER ─────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  const output  = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}
