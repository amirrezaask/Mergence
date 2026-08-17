const CACHE_NAME = "yaade-shell-v1"
const SHELL_KEY = "/__yaade-offline-shell__"

async function trimCache(cache, maxEntries = 128) {
  const keys = await cache.keys()
  const removable = keys.filter(request => !request.url.endsWith(SHELL_KEY))
  const excess = Math.max(0, keys.length - maxEntries)
  await Promise.all(removable.slice(0, excess).map(request => cache.delete(request)))
}

function cacheable(request) {
  if (request.method !== "GET") return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  return !url.pathname.startsWith("/api/") &&
    url.pathname !== "/api" &&
    url.pathname !== "/ws" &&
    url.pathname !== "/health"
}

self.addEventListener("install", event => {
  event.waitUntil(Promise.resolve())
})

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("fetch", event => {
  const request = event.request
  if (!cacheable(request)) return

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(
              caches.open(CACHE_NAME).then(async cache => {
                await cache.put(SHELL_KEY, copy)
                await trimCache(cache)
              }),
            )
          }
          return response
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME)
          return (await cache.match(request)) ??
            (await cache.match(SHELL_KEY)) ??
            Response.error()
        }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached
      return fetch(request).then(response => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone()
          event.waitUntil(
            caches.open(CACHE_NAME).then(async cache => {
              await cache.put(request, copy)
              await trimCache(cache)
            }),
          )
        }
        return response
      })
    }),
  )
})
