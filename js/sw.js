const CACHE_NAME = "imars-public-assets-v2";
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith("imars-teacher-") || name.startsWith("imars-public-assets-")) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      !url.pathname.startsWith("/assets/site-") ||
      !["script", "style", "image", "font"].includes(request.destination)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok && !/no-store|private/i.test(response.headers.get("Cache-Control") || "")) {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        if (keys.length > 200) await cache.delete(keys[0]);
      }
      return response;
    } catch (error) {
      const saved = await cache.match(request);
      if (saved) return saved;
      throw error;
    }
  })());
});
