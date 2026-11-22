/**
 * The kiosk's service worker, served at `/kiosk/sw.js` (`sw.js/route.ts`) as a string so it needs
 * no build step and stays testable. It exists for one reason: a kiosk tablet that restarts or
 * reloads while the network is down must still open the kiosk page, so it can take clock-ins and
 * queue them (`offline-queue.ts`). Everything else is the network's business.
 *
 * - **Scope**: registered for `/kiosk` only (`kiosk-service-worker.ts`). The worker answers a
 *   navigation to exactly `/kiosk`, and the build's hashed files under `/_next/static/` when a
 *   page at `/kiosk` asks for them. Every other request, in particular every `/api/*` call, is
 *   left alone (the worker never calls `respondWith` for it), so the kiosk's own timeouts and its
 *   offline queue see real network failures exactly as before.
 * - **The page** is network-first: always the latest when the server answers (within four
 *   seconds), the stored copy when it doesn't. Only a successful, non-redirected HTML response is
 *   stored, never an error page or a sign-in redirect.
 * - **The files** the page needs (found in its HTML: script, style and font files, and the chunk
 *   names in its data) are stored when the page is stored, and served cache-first (they are
 *   content-hashed, so a stored copy never goes stale). When a new build changes the set, files of
 *   the old build are dropped, but only after every file of the new one is stored.
 * - **No data**: the page is static and holds no pairing, staff or visitor information.
 *
 * Plain script, no imports: it runs in the worker, not in the app.
 */
export const KIOSK_SW_SOURCE = String.raw`"use strict";
const CACHE = "knotworking-kiosk-v1";
const PAGE = "/kiosk";
const META = "/kiosk/.assets";
const STATIC_PREFIX = "/_next/static/";
const NAVIGATION_WAIT_MS = 4000;

const sameOrigin = (url) => url.origin === self.location.origin;
const isKioskPage = (url) => sameOrigin(url) && (url.pathname === "/kiosk" || url.pathname === "/kiosk/");
const isStaticFile = (url) => sameOrigin(url) && url.pathname.startsWith(STATIC_PREFIX);

/** The build's files named in the page's HTML and data: "/_next/static/chunks/x.js", sorted. */
function filesIn(html) {
  const found = new Set();
  const pattern = /(?:\/_next\/)?static\/[A-Za-z0-9_\-./~%]+\.(?:js|css|woff2|woff)/g;
  for (const match of html.matchAll(pattern)) {
    found.add("/_next/" + match[0].slice(match[0].indexOf("static/")));
  }
  return [...found].sort();
}

const storable = (res) =>
  res.ok &&
  !res.redirected &&
  res.type === "basic" &&
  (res.headers.get("content-type") || "").includes("text/html");

/** Stores the page and the files it needs; drops the old build's files once the new ones are in. */
async function remember(cache, res) {
  const html = await res.clone().text();
  await cache.put(PAGE, res);
  const files = filesIn(html);
  const key = files.join("\n");
  const before = await cache.match(META);
  const previous = before ? await before.text() : null;
  const stored = await Promise.all(
    files.map(async (path) => {
      if (await cache.match(path)) return true;
      try {
        const file = await fetch(path);
        if (!file.ok || file.status !== 200) return false;
        await cache.put(path, file);
        return true;
      } catch {
        return false;
      }
    }),
  );
  // Not everything arrived (the network dropped): try again with the next page load.
  if (stored.includes(false)) return;
  if (previous !== null && previous !== key) {
    const keep = new Set(files);
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (isStaticFile(url) && !keep.has(url.pathname)) await cache.delete(request);
    }
  }
  await cache.put(META, new Response(key));
}

async function page(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(PAGE);
  const network = fetch(event.request).then(async (res) => {
    if (!storable(res)) return cached && !res.ok ? cached : res;
    // Stored in the background: the page is not held up by fetching its files.
    event.waitUntil(remember(cache, res.clone()).catch(() => undefined));
    return res;
  });
  if (!cached) return network;
  // The stored page is there to fall back on; the network keeps going to refresh it.
  event.waitUntil(network.catch(() => undefined));
  return Promise.race([
    network.catch(() => cached),
    new Promise((resolve) => setTimeout(() => resolve(cached), NAVIGATION_WAIT_MS)),
  ]);
}

async function staticFile(event) {
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  // Only for the kiosk page: any other page that happens to be under the scope's prefix is left alone.
  if (!client || !isKioskPage(new URL(client.url))) return fetch(event.request);
  const cache = await caches.open(CACHE);
  const hit = await cache.match(event.request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.status === 200 && res.type === "basic") event.waitUntil(cache.put(event.request, res.clone()));
  return res;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch(PAGE, { cache: "reload" });
      if (!storable(res)) throw new Error("The kiosk page can't be stored yet");
      await remember(await caches.open(CACHE), res);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("knotworking-kiosk-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate" && isKioskPage(url)) event.respondWith(page(event));
  else if (isStaticFile(url)) event.respondWith(staticFile(event));
});
`;
