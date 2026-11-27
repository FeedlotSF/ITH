const CACHE_NAME = 'estres-calorico-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './decision.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './Ícono ganadero de riesgo térmico.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Se guarda cada archivo por separado: si uno falla (por ejemplo el nombre con acentos),
      // el resto igual queda cacheado y la app puede abrir sin conexión.
      return Promise.all(ASSETS_TO_CACHE.map((url) => cache.add(url).catch(() => null)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

function cachePut(request, response) {
  if (response && response.ok && request.method === 'GET') {
    caches.open(CACHE_NAME).then((cache) => cache.put(request, response));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !/^https?:/.test(req.url)) return;
  const url = new URL(req.url);

  // Clima y backend: red directa, sin cachear en el SW (la app guarda su propio pronóstico).
  if (url.hostname.indexOf('open-meteo.com') !== -1 || url.pathname.indexOf('/api/') === 0) {
    event.respondWith(
      fetch(req).catch(() => new Response('', { status: 503, statusText: 'Offline' }))
    );
    return;
  }

  // Navegación: red primero; sin red, se sirve el HTML guardado.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        cachePut(req, res.clone());
        return res;
      }).catch(() => {
        return caches.match('./index.html').then((r) => r || caches.match('./'));
      })
    );
    return;
  }

  // Mismo origen (HTML, manifest, íconos, sw): cache primero.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          cachePut(req, res.clone());
          return res;
        }).catch(() => new Response('', { status: 404, statusText: 'Offline' }));
      })
    );
    return;
  }

  // Terceros (por ejemplo Google Fonts): red; si falla, el navegador usa la fuente de sistema.
  event.respondWith(
    fetch(req).catch(() => new Response('', { status: 503, statusText: 'Offline' }))
  );
});

// Manejador del evento PUSH remoto (cuando llega la notificación con app cerrada)
self.addEventListener('push', (event) => {
  let data = {
    title: '⚠️ Alerta de Estrés Calórico',
    body: 'El ITH superó los niveles de confort en tu lote.',
    icon: 'icon-192.png',
    badge: 'icon-192.png'
  };

  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: data.icon || 'icon-192.png',
    badge: data.badge || 'icon-192.png',
    vibrate: [200, 100, 200, 100, 200],
    data: { url: data.url || './index.html' },
    requireInteraction: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Al tocar la notificación en el celular, abrir la app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data && event.notification.data.url ? event.notification.data.url : './index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('ITH') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
