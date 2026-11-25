import type { AccountingAdapterRegistry } from "./accounting/registry";
import { AssistantHub } from "./assistant-hub";
import type { ModuleId } from "@knotworking/core";
import type { DbHandle } from "@knotworking/db";
import { createTestDb } from "@knotworking/db/testing";
import { createApp, type AppOptions } from "./app";
import { createAuth, type AuthConfig } from "./auth";
import type { CalendarDeps } from "./calendar/sync";
import { createMemoryMailer, type Mailer } from "./mailer";
import type { ApiTokenRateLimitOptions } from "./middleware/rate-limit";
import { MemoryStorage, type Storage } from "./storage";

export const APP_URL = "http://localhost:3000";
export const DEMO_PASSWORD = "knotworking-demo";
export const SETUP_TOKEN = "test-setup-token";
export const TEST_SECRET = "test-secret-0123456789abcdef0123456789";

// Responses are asserted structurally in tests; the typed client is covered by typecheck.
export type Res = Omit<Response, "json"> & { json(): Promise<any> };

export async function makeApp(options: {
  seed: boolean;
  calendar?: (db: DbHandle["db"]) => Omit<CalendarDeps, "db">;
  auth?: Partial<Pick<AuthConfig, "google" | "microsoft" | "github">>;
  /** Replace the in-memory mailer (e.g. one that throws). `ctx.mailer` stays the in-memory mailer, which then stays empty. */
  mailer?: Mailer;
  publicRateLimit?: { max: number; windowMs: number };
  apiTokenRateLimit?: ApiTokenRateLimitOptions;
  streamRevalidateMs?: number;
  /** Attachment storage (default: in memory). */
  storage?: Storage;
  uploadMaxBytes?: number;
  /** Modules switched on (default: all). */
  activeModules?: readonly ModuleId[];
  /** Installed accounting adapters (default: none). */
  accountingAdapters?: AccountingAdapterRegistry;
  /** Fake models and MCP tools for the assistant (default: the real ones, which tests never call). */
  assistantDeps?: AppOptions["assistantDeps"];
}) {
  const storage = options.storage ?? new MemoryStorage();
  const handle = await createTestDb({ seed: options.seed });
  const memoryMailer = createMemoryMailer();
  const mailer = options.mailer ?? memoryMailer;
  const auth = createAuth({
    db: handle.db,
    appUrl: APP_URL,
    secret: TEST_SECRET,
    mailer,
    ...options.auth,
  });
  const calendar: CalendarDeps = {
    db: handle.db,
    providers: {},
    getAccessToken: async () => "unused",
    ...options.calendar?.(handle.db),
  };
  const app = createApp({
    db: handle.db,
    auth,
    mailer,
    appUrl: APP_URL,
    calendar,
    setupToken: SETUP_TOKEN,
    publicRateLimit: options.publicRateLimit,
    apiTokenRateLimit: options.apiTokenRateLimit,
    streamRevalidateMs: options.streamRevalidateMs,
    storage,
    uploadMaxBytes: options.uploadMaxBytes,
    activeModules: options.activeModules,
    secret: TEST_SECRET,
    assistantHub: new AssistantHub(handle.db, { sweepMs: 0 }),
    assistantDeps: options.assistantDeps,
    accountingAdapters: options.accountingAdapters,
  });
  const req = (path: string, init: RequestInit & { json?: unknown; cookie?: string } = {}): Promise<Res> =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        origin: APP_URL,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
    }) as Promise<Res>;
  return { handle, mailer: memoryMailer, req, calendar, app, storage };
}

export type TestCtx = Awaited<ReturnType<typeof makeApp>>;

/** Signs in through Better Auth and returns the session cookie. */
export async function signIn(ctx: TestCtx, email: string, password = DEMO_PASSWORD) {
  const res = await ctx.req("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
  if (res.status !== 200) return { status: res.status, cookie: "", body: await res.json() };
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { status: res.status, cookie, body: await res.json() };
}

const HACCP_SCHEDULE_FIELDS = [
  "cleaningFrequency",
  "calibrationFrequency",
  "calibrationTolerance",
  "measurementUnit",
];

/**
 * Adds an area or a piece of equipment to the asset register (`POST /assets`) and, when the body
 * has any, sets its HACCP cleaning and calibration schedule (`PATCH /haccp/assets/:id`): what one
 * `POST /haccp/assets` did before the register moved to the Assets module. Returns the HACCP view
 * (or the asset, without a schedule). Throws on any refusal.
 */
export async function addHaccpAsset(
  send: (method: string, path: string, json?: unknown) => Promise<Res>,
  body: Record<string, unknown>,
): Promise<any> {
  const asset: Record<string, unknown> = {};
  const schedule: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (HACCP_SCHEDULE_FIELDS.includes(key)) schedule[key] = value;
    else asset[key] = value;
  }
  const created = await send("POST", "/assets", asset);
  const createdBody = await created.json();
  if (created.status !== 201)
    throw new Error(`POST /assets: ${created.status} ${JSON.stringify(createdBody)}`);
  if (Object.keys(schedule).length === 0) return createdBody;
  const scheduled = await send("PATCH", `/haccp/assets/${createdBody.id}`, schedule);
  const scheduledBody = await scheduled.json();
  if (scheduled.status !== 200) {
    throw new Error(`PATCH /haccp/assets: ${scheduled.status} ${JSON.stringify(scheduledBody)}`);
  }
  return scheduledBody;
}
