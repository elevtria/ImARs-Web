const CACHE_NAME = "imars-public-assets-v3";
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
    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
      const saved = await cache.match(request);
      if (saved) return saved;
    } catch {}
    const response = await fetch(request);
    const policy = response.headers.get("Cache-Control") || "";
    if (cache && response.ok && /\bpublic\b/i.test(policy) && /\bimmutable\b/i.test(policy) && !/no-store|private/i.test(policy)) {
      try {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        if (keys.length > 200) await cache.delete(keys[0]);
      } catch {}
    }
    return response;
  })());
});
