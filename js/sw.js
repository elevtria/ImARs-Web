const CACHE_NAME = "imars-teacher-v1";
const ASSETS = [
  "/",
  "/sync-offline-results.html",
  "/css/app.css",
  "/js/sync-offline-results.js",
  "/js/html5-qrcode.min.js",
  "/js/firebase-data.js",
  "/js/firebase-auth.js",
  "/js/ui.js",
  "https://cdn.tailwindcss.com"
];

// Install and cache the files
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Serve cached files when offline
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});