// Service Worker mínimo — sua única função aqui é fazer o navegador
// considerar o site "instalável" como app (critério do Android/Chrome).
// Não guarda nada em cache: o app sempre busca a versão mais recente do
// servidor, então atualizações continuam aparecendo normalmente.

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
