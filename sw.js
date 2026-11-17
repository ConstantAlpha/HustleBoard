/* ============================================================
   Vault — Service Worker
   ------------------------------------------------------------
   Strategy
   • Navigations  → network-first, fall back to cached shell
   • Same-origin  → stale-while-revalidate (fast, self-healing)
   • Cross-origin → passthrough (Stripe.js, analytics, etc.)
   • Any /api/    → passthrough (never cache user data)
   ------------------------------------------------------------
   Bump VERSION on every deploy — old caches are pruned in
   `activate` by name prefix.
   ============================================================ */

const VERSION       = 'vault-v4.0.1';
const SHELL_CACHE   = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const BASE      = self.location.href;                        // .../sw.js
const SHELL_URL = new URL('index.html', BASE).href;

const PRECACHE_URLS = [
  new URL('./',            BASE).href,
  SHELL_URL,
  new URL('manifest.json', BASE).href,
  new URL('icon.svg',      BASE).href
];

/* ---------- install: warm the shell cache ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);

    // Individual fetches instead of addAll() so one 404
    // doesn't abort the entire install.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok || res.type === 'opaque') await cache.put(url, res);
      } catch (err) {
        console.warn('[sw] precache skipped:', url, err);
      }
    }));

    // Deliberately NOT calling skipWaiting() here — the page
    // asks the user before swapping versions.
  })());
});

/* ---------- activate: prune old versions ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => !key.startsWith(VERSION))
        .map((key) => caches.delete(key))
    );

    // Lets the SW start the navigation request in parallel
    // with boot, shaving latency off cold loads.
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }

    await self.clients.claim();
  })());
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GETs are cacheable; never touch writes.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (Stripe.js, CDNs) → let the browser handle it.
  if (url.origin !== self.location.origin) return;

  // Backend routes → always live, never cached.
  if (url.pathname.includes('/api/')) return;

  // Range requests (media) are not handled by these strategies.
  if (req.headers.has('range')) return;

  // SPA navigations
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  // Everything else same-origin
  event.respondWith(staleWhileRevalidate(event, req));
});

/* ---------- network-first navigation ---------- */
async function handleNavigation(event) {
  const req   = event.request;
  const cache = await caches.open(SHELL_CACHE);

  try {
    const preloaded = event.preloadResponse
      ? await event.preloadResponse
      : null;

    const fresh = preloaded || await fetch(req);

    if (fresh && fresh.ok) {
      event.waitUntil(cache.put(SHELL_URL, fresh.clone()));
    }
    return fresh;
  } catch (err) {
    // Offline — serve the cached single-page shell.
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return offlineResponse();
  }
}

/* ---------- stale-while-revalidate ---------- */
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);

  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);   // keep the worker alive to refresh
    return cached;
  }

  const fresh = await network;
  return fresh || offlineResponse();
}

/* ---------- minimal offline page ---------- */
function offlineResponse() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault — Offline</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#0a0d13;color:#e8edf5;
       font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       text-align:center;padding:24px}
  .mark{width:48px;height:48px;border-radius:14px;margin:0 auto 18px;
        background:linear-gradient(140deg,#6c8cff,#8b5cf6 55%,#22d3ee);
        display:grid;place-items:center;font-size:22px}
  h1{font-size:17px;margin:0 0 8px;font-weight:650}
  p{color:#8592a6;font-size:13px;margin:0 0 20px;max-width:32ch;line-height:1.6}
  button{font:inherit;font-size:13px;font-weight:600;padding:10px 18px;border-radius:11px;
         border:1px solid #5570ea;background:linear-gradient(180deg,#6c8cff,#5570ea);
         color:#fff;cursor:pointer}
</style></head>
<body>
  <div>
    <div class="mark">◈</div>
    <h1>You're offline</h1>
    <p>Vault can't reach the network. Your saved data is still on this device.</p>
    <button onclick="location.reload()">Try again</button>
  </div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/* ---------- page ⇄ worker messaging ---------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (data.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: VERSION });
  }

  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      event.ports[0]?.postMessage({ cleared: true });
    })());
  }
});
