/**
 * Minimal API client for the demo-business loader. Everything goes through the public HTTP API so
 * the data is written exactly as the app would write it (transactions, sync log, audit trails).
 */
export interface Ctx {
  api: Api;
  demoPassword: string;
  today: string;
  /** Named ids collected while loading, e.g. ids.item["MILK-RAW"]. */
  ids: Record<string, Record<string, string>>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: unknown,
  ) {
    super(`${status} ${path} ${JSON.stringify(body).slice(0, 600)}`);
  }
}

export class Api {
  private cookie = "";
  constructor(
    readonly base: string,
    public slug: string,
  ) {}

  async login(email: string, password: string) {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${this.base}/api/auth/sign-in/email`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", origin: this.base },
        body: JSON.stringify({ email, password }),
      });
      if (res.status !== 429 || attempt >= 6) break;
      const wait = Number(res.headers.get("retry-after")) || 20;
      console.log(`… sign-in rate limited, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
    this.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  async raw(method: string, path: string, body?: unknown, ws = true) {
    const url = `${this.base}/api/v1${ws ? `/workspaces/${this.slug}` : ""}${path}`;
    const res = await fetch(url, {
      method,
      redirect: "error",
      headers: { cookie: this.cookie, origin: this.base, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, ok: res.ok, json: json as any };
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.raw(method, path, body);
    if (!r.ok) throw new ApiError(r.status, `${method} ${path}`, r.json);
    return r.json as T;
  }
  get = <T = any>(p: string) => this.call<T>("GET", p);
  post = <T = any>(p: string, b: unknown = {}) => this.call<T>("POST", p, b);
  put = <T = any>(p: string, b: unknown = {}) => this.call<T>("PUT", p, b);
  patch = <T = any>(p: string, b: unknown = {}) => this.call<T>("PATCH", p, b);
}

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Run a step, logging failures without stopping the whole load (so one bad module doesn't block the rest). */
export async function step(name: string, fn: () => Promise<unknown>) {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${name} (${Date.now() - t}ms)${r ? ` — ${r}` : ""}`);
  } catch (e) {
    console.error(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Responses wrap the record under a key that varies by module (`{ order }`, `{ unit }`, …): find it. */
export const pickRecord = (r: any, key?: string) => {
  if (r && typeof r === "object") {
    if (key && r[key]?.id) return r[key];
    if (r.id) return r;
    for (const v of Object.values(r))
      if (v && typeof v === "object" && !Array.isArray(v) && (v as any).id) return v;
  }
  return r;
};
