/**
 * Registers the kiosk's service worker (`sw-source.ts`) so the page can start without the network.
 * Scope is `/kiosk` and nothing else. Browsers only allow service workers on HTTPS (or localhost):
 * on a plain-HTTP LAN address the kiosk works online as before, and sealing offline entries isn't
 * available there either (see the offline queue). Skipped in development, where a worker serving
 * stored files would hide code changes. Never throws: a browser or webview without service
 * workers just loads the page from the network.
 */
export function registerKioskServiceWorker() {
  if (process.env.NODE_ENV !== "production") return;
  if (typeof window === "undefined" || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/kiosk/sw.js", { scope: "/kiosk" }).catch(() => undefined);
}
