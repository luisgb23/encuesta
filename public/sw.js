// Sube CACHE_NAME (v3, v4…) cada vez que publiques cambios.
const CACHE_NAME = 'encuestas-v4';
const FIREBASE_VERSION = '13.1.0'; // igual que en js/scripts.js
const FIREBASE_CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;

const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/chart.js',
  './js/dexie.js',
  './js/scripts.js',
  './manifest.json',
  './img/logo.png',
  './img/logo.ico',
  FIREBASE_CDN + 'firebase-app.js',
  FIREBASE_CDN + 'firebase-auth.js',
  FIREBASE_CDN + 'firebase-firestore-lite.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function guardarEnCache(request, response) {
  if (response.ok) {
    const copia = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copia));
  }
  return response;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // envíos a Firestore/Auth: siempre por red
  const url = new URL(req.url);

  // Librerías de Firebase (URL con versión fija): caché primero
  if (url.href.startsWith(FIREBASE_CDN)) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => guardarEnCache(req, res))));
    return;
  }

  // Cualquier otro dominio (API de Firestore, Auth, etc.): no se intercepta
  if (url.origin !== self.location.origin) return;

  // Archivos propios: red primero (así llegan las actualizaciones) y caché si no hay conexión
  e.respondWith(
    fetch(req)
      .then((res) => guardarEnCache(req, res))
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
