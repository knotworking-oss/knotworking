import { KIOSK_SW_SOURCE } from "../sw-source";

export const dynamic = "force-static";

/**
 * The kiosk's service worker (see `sw-source.ts`). Served from under `/kiosk/` and allowed to
 * control `/kiosk` itself (the default scope of this path would be `/kiosk/`, which excludes the
 * page). It is not cached by the browser, so a new version reaches tablets on their next load.
 */
export function GET() {
  return new Response(KIOSK_SW_SOURCE, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      "service-worker-allowed": "/kiosk",
    },
  });
}
