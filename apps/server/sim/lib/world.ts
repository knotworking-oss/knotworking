import { vi } from "vitest";
import { createDb, migrateDb, seed } from "@knotworking/db";
import { AssistantHub } from "../../src/assistant-hub";
import { createApp } from "../../src/app";
import { createAuth } from "../../src/auth";
import { createMemoryMailer } from "../../src/mailer";
import { MemoryStorage } from "../../src/storage";
import {
  APP_URL,
  SETUP_TOKEN,
  TEST_SECRET,
  makeApp,
  signIn,
  type Res as TestRes,
  type TestCtx,
} from "../../src/test-utils";
import { Findings } from "./findings";

export const WS = "/v1/workspaces/acme";
export const PASSWORD = "sim-password-12345";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export type Level = "read" | "write" | "manage";
export interface PersonaSpec {
  key: string;
  email: string;
  name: string;
  title: string;
  role: "owner" | "admin" | "member" | "guest";
  access: Partial<Record<string, Level>>;
  /** Seeded demo accounts keep the demo password. */
  password?: string;
}
export interface Persona extends PersonaSpec {
  userId: string;
  cookie: string;
}
export interface Res {
  status: number;
  body: any;
  ok: boolean;
}

export class World {
  ctx!: TestCtx;
  findings = new Findings();
  people = new Map<string, Persona>();
  day = "";
  requests = 0;
  statuses: Record<string, number> = {};

  /** `SIM_PG_URL` runs the same app on a real Postgres database instead of in-memory PGlite. */
  async boot() {
    const url = process.env.SIM_PG_URL;
    if (!url) {
      this.ctx = await makeApp({ seed: true });
      return;
    }
    const handle = createDb(url);
    await migrateDb(handle);
    await seed(handle.db);
    const mailer = createMemoryMailer();
    const auth = createAuth({ db: handle.db, appUrl: APP_URL, secret: TEST_SECRET, mailer });
    const storage = new MemoryStorage();
    const calendar = { db: handle.db, providers: {}, getAccessToken: async () => "unused" };
    const app = createApp({
      db: handle.db,
      auth,
      mailer,
      appUrl: APP_URL,
      calendar: calendar as never,
      setupToken: SETUP_TOKEN,
      storage,
      secret: TEST_SECRET,
      assistantHub: new AssistantHub(handle.db, { sweepMs: 0 }),
    } as never);
    const req = (
      path: string,
      init: RequestInit & { json?: unknown; cookie?: string } = {},
    ): Promise<TestRes> =>
      app.request(path, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin: APP_URL,
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...init.headers,
        },
        body: init.json === undefined ? init.body : JSON.stringify(init.json),
      }) as Promise<TestRes>;
    this.ctx = { handle, mailer, req, calendar, app, storage } as unknown as TestCtx;
  }

  /** Move the application clock to noon on a simulated day. */
  setDay(isoDate: string, hour = 9) {
    this.day = isoDate;
    vi.setSystemTime(new Date(`${isoDate}T${String(hour).padStart(2, "0")}:00:00.000Z`));
  }

  async signInAll() {
    for (const p of this.people.values()) {
      const r = await signIn(this.ctx, p.email, p.password);
      if (r.status !== 200) {
        this.findings.record({
          kind: "scenario",
          day: this.day,
          who: p.key,
          what: `sign-in failed ${r.status}`,
          detail: r.body,
        });
        continue;
      }
      p.cookie = r.cookie;
      // Sign-in is rate limited per client; spread the logins out in application time.
      vi.setSystemTime(new Date(Date.now() + 4_000));
    }
  }

  /** Call the API as a persona. Anything outside `expect` is recorded; 5xx is always a server error. */
  async call(
    who: Persona | string,
    method: string,
    path: string,
    json?: unknown,
    expect: number[] = [200, 201],
  ): Promise<Res> {
    const p = typeof who === "string" ? this.people.get(who)! : who;
    const url = path.startsWith("/v1") || path.startsWith("/api") ? path : `${WS}${path}`;
    const res = await this.ctx.req(url, { method, cookie: p.cookie, json });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    this.requests++;
    const bucket = `${Math.floor(res.status / 100)}xx`;
    this.statuses[bucket] = (this.statuses[bucket] ?? 0) + 1;
    const tpl = `${method} ${path.replace(UUID, ":id").replace(/\?.*/, "")}`;
    if (res.status >= 500) {
      this.findings.record({
        kind: "server_error",
        day: this.day,
        who: p.key,
        what: `${tpl} -> ${res.status}`,
        detail: { body, sent: json },
      });
    } else if (!expect.includes(res.status)) {
      this.findings.record({
        kind: "unexpected_status",
        day: this.day,
        who: p.key,
        what: `${tpl} -> ${res.status} ${body?.error?.code ?? ""}`,
        detail: { body, sent: json },
      });
    }
    return { status: res.status, body, ok: expect.includes(res.status) };
  }
}
