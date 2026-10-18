// Service worker: guarda la app (no el juego) para que abra rápido y se pueda
// "instalar" como app en el móvil. El núcleo del emulador lo cachea EmulatorJS.
const CACHE = "mgs-web-v15";
const SHELL = [
  "./", "index.html", "play.html", "pad.html", "test.html", "screen.html", "tv/index.html", "css/style.css",
  "js/console.js", "js/pad.js", "js/padui.js", "js/fetcher.js", "js/stream.js", "js/diag.js", "js/protocol.js", "js/storage.js",
  "manifest.webmanifest", "icons/icon.svg",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Red primero para la app propia (así las actualizaciones llegan al momento),
// con la caché como respaldo sin conexión.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    // Revalidar siempre (ETag): sin esto la caché HTTP de GitHub Pages puede servir
    // versiones de hasta 10 minutos de antigüedad.
    fetch(new Request(e.request.url, { cache: "no-cache" }))
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
