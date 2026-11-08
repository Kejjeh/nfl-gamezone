// Service worker: offline shell, and the push handler that wakes the phone.
//
// Deliberately network-first for anything same-origin. A cache-first shell
// would be faster, but this project has already lost time twice to a browser
// serving a stale ES module while the source on disk was correct - so the
// cache is a fallback for being offline, never a shortcut when online.
//
// Push: the notification text is NOT carried in the push payload. Encrypting a
// payload (RFC 8291) needs ECDH plus HKDF plus AES-GCM in the sender, which is
// a lot of crypto to get subtly wrong. A push with no payload needs only the
// VAPID signature, so the Worker sends an empty wake-up and this fetches the
// message it prepared. One extra round trip, far less that can break.

const VERSION = 'gz-v1';
const SHELL = [
  './', './index.html', './app.css', './manifest.json',
  './js/main.js', './js/config.js', './js/state.js', './js/store.js',
  './js/espn.js', './js/sleeper.js', './js/bridge.js', './js/feed.js',
  './js/rail.js', './js/matchup.js', './js/alerts.js', './js/boxscore.js',
  './js/panel.js', './js/poller.js', './js/teams.js', './js/scoring.js',
  './js/bets.js', './js/bets-core.js', './js/bets-ui.js', './js/push.js',
  './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One bad URL must not fail the whole install.
    await Promise.allSettled(SHELL.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // ESPN and Sleeper are live data; caching them would be actively wrong.
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      // A navigation with nothing cached still has to render something.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

/* ------------------------------------------------------------------ push */

async function pushConfig() {
  try {
    const res = await fetch('./push-config.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const cfg = await res.json();
    return cfg && cfg.api ? cfg : null;
  } catch (e) {
    return null;
  }
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let title = 'GameZone';
    let body = 'Something moved in your bets.';
    let tag = 'gz-bet';

    // If a payload ever does arrive, prefer it.
    try {
      const data = e.data && e.data.json();
      if (data && (data.title || data.body)) {
        title = data.title || title;
        body = data.body || body;
        tag = data.tag || tag;
      } else throw new Error('no payload');
    } catch (err) {
      try {
        const cfg = await pushConfig();
        const sub = await self.registration.pushManager.getSubscription();
        if (cfg && sub) {
          const res = await fetch(`${cfg.api.replace(/\/$/, '')}/pending`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          if (res.ok) {
            const m = await res.json();
            if (m && m.body) { title = m.title || title; body = m.body; tag = m.tag || tag; }
          }
        }
      } catch (err2) {
        // Fall through to the generic message. A push that shows nothing at
        // all can cost the site its permission, so something must be shown.
      }
    }

    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { url: './' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = new URL((e.notification.data && e.notification.data.url) || './', self.location.href).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of windows) {
      if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
