/* Service worker: deixa o app abrir sem internet.
   Ao publicar uma nova versão, aumente o número em CACHE para os celulares baixarem os arquivos novos. */
const CACHE = "diario-pressao-v3";
const CORE = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "ocr.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];
// arquivos de terceiros que podem ficar guardados (fontes e o leitor do aparelho)
const CACHE_FIRST_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // a leitura pela IA (POST ao Worker) sempre vai para a rede
  const url = new URL(req.url);

  // Arquivos do app: rede primeiro (para pegar atualizações), cache se estiver offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
    );
    return;
  }

  // Fontes e leitor do aparelho: versões fixas, então cache primeiro.
  if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
