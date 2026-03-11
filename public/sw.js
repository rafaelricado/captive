/**
 * Service Worker — Captive Portal Admin PWA
 *
 * Estratégia por tipo de recurso:
 *  - Assets estáticos (CSS, JS, ícones, fontes): Cache-first com fallback de rede
 *  - Páginas admin HTML: Network-first com fallback para shell em cache
 *  - Requisições de API e dados (/api/, /admin/*\/data, /admin/*\/export): apenas rede
 *    (dados sensíveis não devem ser cacheados)
 */
'use strict';

const CACHE_VERSION  = 'cp-admin-v1';
const SHELL_CACHE    = `${CACHE_VERSION}-shell`;
const STATIC_CACHE   = `${CACHE_VERSION}-static`;

// Recursos do app shell — cacheados no install
const SHELL_URLS = [
  '/admin/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // não bloqueia install se algum recurso falhar
  );
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('cp-admin-') && k !== SHELL_CACHE && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requests não-GET e cross-origin
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // API, dados dinâmicos e exports — sempre rede, nunca cache
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('/data') ||
    url.pathname.endsWith('/export') ||
    url.pathname.endsWith('/stream')
  ) {
    return; // passa para o browser sem interceptar
  }

  // Assets estáticos (JS, CSS, imagens, fontes) — Cache-first
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Páginas admin — Network-first com fallback para shell
  if (url.pathname.startsWith('/admin')) {
    event.respondWith(networkFirstWithShellFallback(request));
    return;
  }
});

// ─── Helpers de estratégia ───────────────────────────────────────────────────

function isStaticAsset(pathname) {
  return /\.(css|js|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot)(\?.*)?$/.test(pathname);
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Recurso não disponível offline.', { status: 503 });
  }
}

async function networkFirstWithShellFallback(request) {
  try {
    const response = await fetch(request);
    // Armazena páginas admin com sucesso no shell cache
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Sem rede — tenta cache
    const cached = await caches.match(request);
    if (cached) return cached;

    // Fallback para home admin se disponível
    const shell = await caches.match('/admin/');
    if (shell) return shell;

    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Offline</title></head><body style="font-family:sans-serif;text-align:center;padding:48px"><h2>Sem conexão</h2><p>Verifique sua rede e tente novamente.</p><a href="/admin/">Tentar novamente</a></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}
