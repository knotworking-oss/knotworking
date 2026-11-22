import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./sw.js/route";
import { KIOSK_SW_SOURCE } from "./sw-source";

const ORIGIN = "https://kiosk.example.com";
const abs = (input: string) => new URL(input, ORIGIN).href;

/** A response the worker treats as a normal same-origin one (`Response.type` is read-only). */
function basic(body: string, init: { status?: number; type?: string; redirected?: boolean } = {}) {
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "text/html; charset=utf-8" },
  });
  Object.defineProperty(res, "type", { value: "basic" });
  if (init.redirected) Object.defineProperty(res, "redirected", { value: true });
  return res;
}

const html = (files: string[], lazy: string[] = []) =>
  `<html><head>${files
    .filter((f) => f.endsWith(".css"))
    .map((f) => `<link rel="stylesheet" href="${f}">`)
    .join("")}</head><body>${files
    .filter((f) => f.endsWith(".js"))
    .map((f) => `<script src="${f}" async></script>`)
    .join("")}${files
    .filter((f) => f.endsWith(".woff2"))
    .map((f) => `<link rel="preload" as="font" href="${f}">`)
    .join(
      "",
    )}<script>self.__next_f.push([1,"${lazy.map((l) => `\\"${l}\\"`).join(",")}"])</script></body></html>`;

function makeWorker() {
  const stores = new Map<string, Map<string, Response>>();
  const listeners: Record<string, (event: any) => void> = {};
  const network = { online: true, files: new Map<string, () => Response>(), calls: [] as string[] };
  const clientUrls = new Map<string, string>();
  const waiting: Promise<unknown>[] = [];

  const makeCache = (name: string) => {
    const entries = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, entries);
    const keyOf = (req: Request | string, ignoreSearch = false) => {
      const url = new URL(typeof req === "string" ? abs(req) : req.url);
      return ignoreSearch ? url.origin + url.pathname : url.href;
    };
    return {
      match: async (req: Request | string, options?: { ignoreSearch?: boolean }) => {
        const wanted = keyOf(req, options?.ignoreSearch);
        for (const [key, res] of entries) {
          if ((options?.ignoreSearch ? keyOf(key, true) : key) === wanted) return res.clone();
        }
        return undefined;
      },
      put: async (req: Request | string, res: Response) => void entries.set(keyOf(req), res.clone()),
      keys: async () => [...entries.keys()].map((k) => new Request(k)),
      delete: async (req: Request | string) => entries.delete(keyOf(req)),
    };
  };

  const fetchMock = async (input: Request | string) => {
    const url = typeof input === "string" ? abs(input) : input.url;
    network.calls.push(new URL(url).pathname);
    if (!network.online) throw new TypeError("Failed to fetch");
    const make = network.files.get(new URL(url).pathname);
    if (!make) return basic("not found", { status: 404, type: "text/plain" });
    return make();
  };

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, fn: (event: any) => void) => void (listeners[type] = fn),
      skipWaiting: vi.fn(async () => undefined),
      clients: {
        claim: vi.fn(async () => undefined),
        get: async (id: string) => (clientUrls.has(id) ? { url: clientUrls.get(id) } : undefined),
      },
    },
    caches: {
      open: async (name: string) => makeCache(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: fetchMock,
    Request,
    Response,
    URL,
    Promise,
    Set,
    Error,
    TypeError,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  };
  runInNewContext(KIOSK_SW_SOURCE, sandbox);

  const send = (type: string, init: Record<string, unknown> = {}) => {
    const event: any = {
      ...init,
      waitUntil: (p: Promise<unknown>) => void waiting.push(p),
      respondWith: (p: Promise<Response>) => void (event.responded = p),
    };
    listeners[type]!(event);
    return event;
  };
  const request = (path: string, init: { mode?: string; method?: string } = {}) => {
    const req = new Request(abs(path), { method: init.method ?? "GET" });
    Object.defineProperty(req, "mode", { value: init.mode ?? "cors" });
    return req;
  };
  const settle = async () => {
    await Promise.all(waiting.splice(0));
    await Promise.all(waiting.splice(0));
  };
  const cacheNames = (name = "knotworking-kiosk-v1") =>
    [...(stores.get(name)?.keys() ?? [])].map((k) => new URL(k).pathname);
  return { sandbox, network, stores, clientUrls, send, request, settle, cacheNames, listeners };
}

const FILES = [
  "/_next/static/chunks/app.js",
  "/_next/static/chunks/style.css",
  "/_next/static/media/font.woff2",
];
const LAZY = ["static/chunks/scanner.js"];

function serve(w: ReturnType<typeof makeWorker>, files = FILES, lazy = LAZY) {
  w.network.files.set("/kiosk", () => basic(html(files, lazy)));
  for (const f of [...files, ...lazy.map((l) => `/_next/${l}`)]) {
    w.network.files.set(f, () => basic(`file ${f}`, { type: "text/javascript" }));
  }
}

describe("the kiosk's service worker", () => {
  let w: ReturnType<typeof makeWorker>;
  beforeEach(() => {
    w = makeWorker();
    serve(w);
  });
  afterEach(() => vi.useRealTimers());

  it("stores the page and every file it names, including chunks named in its data, on install", async () => {
    w.send("install");
    await w.settle();
    expect(w.cacheNames().sort()).toEqual(
      ["/kiosk", "/kiosk/.assets", ...FILES, "/_next/static/chunks/scanner.js"].sort(),
    );
  });

  it("takes over open pages on activate and drops caches of older versions", async () => {
    w.stores.set("knotworking-kiosk-v0", new Map());
    w.stores.set("somebody-elses-cache", new Map());
    w.send("activate");
    await w.settle();
    expect([...w.stores.keys()]).toEqual(["somebody-elses-cache"]);
    expect(w.sandbox.self.clients.claim).toHaveBeenCalled();
  });

  it("opens the kiosk page from the stored copy when the network is down", async () => {
    w.send("install");
    await w.settle();
    w.network.online = false;
    const nav = w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) });
    expect(nav.responded).toBeDefined();
    const res: Response = await nav.responded;
    expect(await res.text()).toContain("/_next/static/chunks/app.js");
  });

  it("serves the stored copy when the server errors, and refreshes it when it answers", async () => {
    w.send("install");
    await w.settle();
    w.network.files.set("/kiosk", () => basic("oops", { status: 502 }));
    const bad: Response = await w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) })
      .responded;
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("app.js");

    w.network.files.set("/kiosk", () => basic(html(["/_next/static/chunks/app2.js"], [])));
    w.network.files.set("/_next/static/chunks/app2.js", () => basic("app2", { type: "text/javascript" }));
    const fresh: Response = await w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) })
      .responded;
    expect(await fresh.text()).toContain("app2.js");
    await w.settle();
    // The new build replaced the old files; the stored page is the new one.
    expect(w.cacheNames().sort()).toEqual(
      ["/_next/static/chunks/app2.js", "/kiosk", "/kiosk/.assets"].sort(),
    );
  });

  it("falls back to the stored page when the network is too slow, and passes errors through with none stored", async () => {
    w.send("install");
    await w.settle();
    vi.useFakeTimers();
    w.network.files.set("/kiosk", () => basic("never"));
    const hang = w.sandbox.fetch;
    w.sandbox.fetch = () => new Promise(() => undefined) as never;
    const nav = w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) });
    // Wait for the worker's cache lookups, then the timer.
    await vi.advanceTimersByTimeAsync(5000);
    expect(await ((await nav.responded) as Response).text()).toContain("app.js");
    w.sandbox.fetch = hang;

    const empty = makeWorker();
    empty.network.online = false;
    const offline = empty.send("fetch", { request: empty.request("/kiosk", { mode: "navigate" }) });
    await expect(offline.responded).rejects.toThrow();
  });

  it("stores only a good HTML response: not an error, a redirect or something else", async () => {
    w.network.files.set("/kiosk", () => basic("sign in", { redirected: true }));
    await w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) }).responded;
    w.network.files.set("/kiosk", () => basic("{}", { type: "application/json" }));
    await w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) }).responded;
    w.network.files.set("/kiosk", () => basic("down", { status: 503 }));
    const res: Response = await w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) })
      .responded;
    expect(res.status).toBe(503);
    await w.settle();
    expect(w.cacheNames()).toEqual([]);
  });

  it("leaves everything else alone: the API, other pages, other methods", () => {
    for (const [path, init] of [
      ["/api/v1/kiosk/session", { mode: "cors" }],
      ["/api/v1/kiosk/replay", { mode: "cors", method: "POST" }],
      ["/kiosk", { mode: "cors" }], // not a navigation (a data fetch)
      ["/kiosk", { mode: "navigate", method: "POST" }],
      ["/kiosk-2", { mode: "navigate" }],
      ["/kiosk/sw.js", { mode: "same-origin" }],
      ["/acme/tasks", { mode: "navigate" }],
      ["/", { mode: "navigate" }],
    ] as const) {
      const event = w.send("fetch", { request: w.request(path, init) });
      expect(event.responded, `${init.method ?? "GET"} ${path}`).toBeUndefined();
    }
    const foreign = new Request("https://elsewhere.example.com/_next/static/x.js");
    expect(w.send("fetch", { request: foreign }).responded).toBeUndefined();
  });

  it("serves build files from the store for the kiosk page only", async () => {
    w.send("install");
    await w.settle();
    w.clientUrls.set("kiosk-tab", `${ORIGIN}/kiosk`);
    w.clientUrls.set("other-tab", `${ORIGIN}/acme/tasks`);
    w.network.online = false;
    const hit: Response = await w.send("fetch", {
      request: w.request("/_next/static/chunks/app.js?dpl=abc"),
      clientId: "kiosk-tab",
    }).responded;
    expect(await hit.text()).toBe("file /_next/static/chunks/app.js");

    // A page that isn't the kiosk gets the network, and nothing is stored for it.
    w.network.calls.length = 0;
    await expect(
      w.send("fetch", { request: w.request("/_next/static/chunks/app.js"), clientId: "other-tab" }).responded,
    ).rejects.toThrow();
    expect(w.network.calls).toEqual(["/_next/static/chunks/app.js"]);
  });

  it("stores a build file the kiosk fetched that wasn't named in the page", async () => {
    w.send("install");
    await w.settle();
    w.clientUrls.set("kiosk-tab", `${ORIGIN}/kiosk`);
    w.network.files.set("/_next/static/chunks/late.js", () => basic("late", { type: "text/javascript" }));
    const res: Response = await w.send("fetch", {
      request: w.request("/_next/static/chunks/late.js"),
      clientId: "kiosk-tab",
    }).responded;
    expect(await res.text()).toBe("late");
    await w.settle();
    expect(w.cacheNames()).toContain("/_next/static/chunks/late.js");
  });

  it("keeps the old build's files when the new build's can't all be stored", async () => {
    w.send("install");
    await w.settle();
    w.network.files.set("/kiosk", () =>
      basic(html(["/_next/static/chunks/v2.js", "/_next/static/chunks/v2b.js"])),
    );
    w.network.files.set("/_next/static/chunks/v2.js", () => basic("v2", { type: "text/javascript" }));
    // v2b.js is a 404.
    await w.send("fetch", { request: w.request("/kiosk", { mode: "navigate" }) }).responded;
    await w.settle();
    expect(w.cacheNames()).toContain("/_next/static/chunks/app.js");
    expect(w.cacheNames()).toContain("/_next/static/chunks/v2.js");
  });

  it("is served from /kiosk/sw.js with the scope it needs", async () => {
    const res = GET();
    expect(res.headers.get("service-worker-allowed")).toBe("/kiosk");
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(await res.text()).toBe(KIOSK_SW_SOURCE);
  });
});
