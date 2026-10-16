'use strict';

const CACHE = 'parole-v71';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'vendor/supabase.js',
  'manifest.webmanifest',
  'icos/icon.svg',
  'icos/library.svg',
  'icos/practice.svg',
  'icos/settings.svg',
  'icos/icon-192.png',
  'icos/icon-512.png',
  'icos/icon-1024.png',
  'icos/icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first so updates show immediately; falls back to the cache when offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
