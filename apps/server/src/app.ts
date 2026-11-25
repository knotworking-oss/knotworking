import { DEFAULT_UPLOAD_MAX_BYTES, moduleIds, type ModuleId } from "@knotworking/core";
import type { Database } from "@knotworking/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { AssistantHub } from "./assistant-hub";
import { deriveAssistantKeyKey } from "./services/assistant-crypto";
import { createProviderRegistry } from "./services/assistant-providers";
import { AssistantTurnRunner, mcpTools, type AssistantTurnDeps } from "./services/assistant-turn";
import type { Auth } from "./auth";
import type { CalendarDeps } from "./calendar/sync";
import type { AppEnv, WorkspaceEnv } from "./env";
import { ApiError, isPrimaryKeyViolation } from "./errors";
import type { Mailer } from "./mailer";
import { bearerValue, forbidTokens, requireSession } from "./middleware/auth";
import { requestBodyLimit } from "./middleware/body-limit";
import {
  DEFAULT_TOKEN_READS_PER_MINUTE,
  DEFAULT_TOKEN_WRITES_PER_MINUTE,
  apiTokenRateLimit,
  rateLimit,
  type ApiTokenRateLimitOptions,
} from "./middleware/rate-limit";
import { moduleGuard } from "./middleware/modules";
import { tokenActionAudit } from "./middleware/token-actions";
import { workspaceAccess } from "./middleware/workspace";
import { accessRoutes, publicRoutes } from "./routes/access";
import { attachmentLinkRoutes } from "./routes/attachment-links";
import { assistantKeyRoutes, assistantRoutes } from "./routes/assistant";
import { apiTokenRoutes } from "./routes/api-tokens";
import { calendarConnectionRoutes, meetingRoutes } from "./routes/calendar";
import { docRoutes } from "./routes/docs";
import { itemRoutes } from "./routes/items";
import { peopleRoutes } from "./routes/people";
import { trainingRoutes } from "./routes/training";
import { attendanceRoutes } from "./routes/attendance";
import { kioskPairRoutes, kioskRoutes, requireDevice } from "./routes/kiosk";
import { recipeRoutes } from "./routes/recipes";
import { sopRoutes } from "./routes/sops";
import { stockRoutes } from "./routes/stock";
import { customerRoutes } from "./routes/customers";
import { despatchOperationRoutes } from "./routes/despatch-operations";
import { hseRoutes, hseIncidentRoutes } from "./routes/hse";
import { workforceRoutes } from "./routes/workforce";
import { biRoutes } from "./routes/bi";
import { xeroCallbackRoutes } from "./routes/xero";
import { xeroCallbackPath } from "./accounting/xero-http";
import type { XeroConnectionService } from "./accounting/xero-connection";
import { accountingRoutes } from "./routes/accounting";
import { salesRoutes } from "./routes/sales";
import { despatchRoutes } from "./routes/despatch";
import { demandRoutes } from "./routes/demand";
import { productionRoutes } from "./routes/production";
import { haccpRoutes } from "./routes/haccp";
import { incidentRoutes } from "./routes/incidents";
import { authenticityRoutes } from "./routes/authenticity";
import { qualityRoutes } from "./routes/quality";
import { purchaseCreditNoteRoutes } from "./routes/purchase-credit-notes";
import { purchaseInvoiceRoutes } from "./routes/purchase-invoices";
import { purchasingRoutes } from "./routes/purchasing";
import { costingRoutes } from "./routes/costing";
import { maintenanceRoutes } from "./routes/maintenance";
import { checklistRoutes } from "./routes/checklists";
import { siteRoutes } from "./routes/site";
import { labelRoutes } from "./routes/labels";
import { specificationRoutes } from "./routes/specifications";
import { testingRoutes } from "./routes/testing";
import { npdRoutes } from "./routes/npd";
import { defenceRoutes } from "./routes/defence";
import { concernRoutes, governanceRoutes } from "./routes/governance";
import { purchaseRequestRoutes } from "./routes/purchase-requests";
import { clientServicesRoutes } from "./routes/client-services";
import { assetRoutes } from "./routes/assets";
import { notificationRoutes } from "./routes/notifications";
import { registerNotificationDelivery } from "./services/notifications";
import { structureRoutes } from "./routes/structure";
import { taskRoutes } from "./routes/tasks";
import { timeRoutes } from "./routes/time";
import { tokenActionRoutes } from "./routes/token-actions";
import { DEFAULT_STREAM_REVALIDATE_MS, workspaceRoutes } from "./routes/workspace";
import { isApiToken } from "./services/api-tokens";
import { deriveAttachmentLinkKey } from "./services/attachment-links";
import { deriveStaffPinKey } from "./services/people";
import { listMyWorkspaces } from "./services/workspace";
import type { Storage } from "./storage";
import { SyncHub } from "./sync-hub";
import { createAccountingAdapterRegistry, type AccountingAdapterRegistry } from "./accounting/registry";

export interface AppOptions {
  db: Database;
  auth: Auth;
  mailer: Mailer;
  /** Public URL of the web app (cookies, links in emails, CORS). */
  appUrl: string;
  trustedOrigins?: string[];
  providers?: ("google" | "github" | "microsoft")[];
  calendar: CalendarDeps;
  /** One-time code required to run first-run setup (printed in the API log). */
  setupToken?: string;
  /** Defaults to one that watches `db`. */
  syncHub?: SyncHub;
  log?: boolean;
  /** Per-client limit on the unauthenticated `/v1/public/*` endpoints (default 30 per minute). */
  publicRateLimit?: { max: number; windowMs: number };
  /**
   * Per-token request budgets for personal API tokens (sessions are not limited). Defaults to 600
   * reads and 120 writes per minute; `0` turns a budget off. Counted per API process.
   */
  apiTokenRateLimit?: ApiTokenRateLimitOptions;
  /** How often an open `/events` stream re-checks its credential (default 30 s). Tests shorten it. */
  streamRevalidateMs?: number;
  /** Attachment storage (see `./storage`). */
  storage: Storage;
  /** Largest accepted upload in bytes (default 10 MB). */
  uploadMaxBytes?: number;
  /** Modules switched on in this environment (default: all). See `parseActiveModules`. */
  activeModules?: readonly ModuleId[];
  /** The server secret (`BETTER_AUTH_SECRET`); kiosk PINs are hashed under a key derived from it. */
  secret: string;
  /** Defaults to one on `db` (docs/assistant.md). */
  assistantHub?: AssistantHub;
  /**
   * What the assistant uses to reach models and tools. Defaults: the real providers, and the MCP
   * server at `assistantMcpUrl`. Tests replace them with fakes.
   */
  assistantDeps?: Partial<AssistantTurnDeps> & {
    turnOptions?: ConstructorParameters<typeof AssistantTurnRunner>[4];
  };
  /** The MCP server's URL as this process reaches it (`MCP_INTERNAL_URL`). */
  assistantMcpUrl?: string;
  /** Installed accounting adapters (default: none, so nothing is ever sent). */
  accountingAdapters?: AccountingAdapterRegistry;
  xero?: XeroConnectionService;
}

export function createApp({
  db,
  auth,
  mailer,
  appUrl,
  calendar,
  setupToken,
  syncHub = new SyncHub(db),
  trustedOrigins = [],
  providers = [],
  log = false,
  publicRateLimit = { max: 30, windowMs: 60_000 },
  apiTokenRateLimit: tokenLimits = {
    reads: DEFAULT_TOKEN_READS_PER_MINUTE,
    writes: DEFAULT_TOKEN_WRITES_PER_MINUTE,
  },
  streamRevalidateMs = DEFAULT_STREAM_REVALIDATE_MS,
  storage,
  uploadMaxBytes = DEFAULT_UPLOAD_MAX_BYTES,
  activeModules = moduleIds,
  secret,
  assistantHub = new AssistantHub(db),
  assistantDeps,
  assistantMcpUrl = "http://127.0.0.1:4100/mcp",
  xero,
  accountingAdapters = createAccountingAdapterRegistry(xero ? { xero: xero.adapter } : {}),
}: AppOptions) {
  const app = new Hono<AppEnv>();
  const staffPinKey = deriveStaffPinKey(secret);
  const attachmentLinkKey = deriveAttachmentLinkKey(secret);
  const assistantKeyKey = deriveAssistantKeyKey(secret);
  const assistantProviders = assistantDeps?.providers ?? createProviderRegistry();
  const assistantTurns = new AssistantTurnRunner(
    db,
    assistantHub,
    assistantKeyKey,
    { providers: assistantProviders, openTools: assistantDeps?.openTools ?? mcpTools(assistantMcpUrl) },
    assistantDeps?.turnOptions,
  );
  // Module write paths and the due-date sweep email their notifications through this.
  registerNotificationDelivery(db, { mailer, appUrl, activeModules });

  if (log) {
    const logRequest = logger();
    app.use("*", (c, next) => (c.req.path === xeroCallbackPath ? next() : logRequest(c, next)));
  }
  app.use("*", cors({ origin: [appUrl, ...trustedOrigins], credentials: true }));
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("auth", auth);
    c.set("mailer", mailer);
    c.set("appUrl", appUrl);
    c.set("providers", providers);
    c.set("calendar", calendar);
    c.set("setupToken", setupToken);
    c.set("syncHub", syncHub);
    c.set("streamRevalidateMs", streamRevalidateMs);
    c.set("storage", storage);
    c.set("uploadMaxBytes", uploadMaxBytes);
    c.set("activeModules", activeModules);
    c.set("accountingAdapters", accountingAdapters);
    c.set("xero", xero);
    c.set("staffPinKey", staffPinKey);
    c.set("attachmentLinkKey", attachmentLinkKey);
    c.set("assistantHub", assistantHub);
    c.set("assistantTurns", assistantTurns);
    c.set("assistantProviders", assistantProviders);
    c.set("assistantKeyKey", assistantKeyKey);
    c.set("internalFetch", (request: Request) => Promise.resolve(app.fetch(request)));
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    }
    // Creates accept client-generated ids (offline/optimistic clients); reusing one is the
    // client's mistake, not a server failure.
    if (isPrimaryKeyViolation(err)) {
      return c.json({ error: { code: "id_conflict", message: "An item with this id already exists" } }, 409);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

  app.use("*", requestBodyLimit);
  app.use("*", async (c, next) => {
    // Sessions, invitation details, reset links and pairing credentials must not enter caches.
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-store");
  });

  // Personal API tokens (`knw_…`) are resolved by `requireSession` and never reach Better Auth.
  app.use("/api/auth/*", async (c, next) => {
    const bearer = bearerValue(c.req.raw.headers);
    if (bearer && isApiToken(bearer)) {
      throw new ApiError(403, "token_not_allowed", "API tokens can't be used for sign-in endpoints");
    }
    await next();
  });

  // Better Auth: sign-in/out, sessions, OAuth callbacks, password reset.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // CSRF: cookie-authenticated writes must come from Knotworking's own origin.
  // (Bearer-token clients — desktop/mobile — send no cookie and aren't affected.)
  const allowedOrigins = new Set([appUrl, ...trustedOrigins]);
  app.use("/v1/*", async (c, next) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (unsafe && c.req.header("cookie")) {
      const origin = c.req.header("origin");
      if (!origin || !allowedOrigins.has(origin)) {
        throw new ApiError(403, "bad_origin", "Request blocked: it didn't come from this Knotworking site");
      }
    }
    await next();
  });

  // Server push: after a successful write, wake this workspace's `/events`
  // listeners now rather than on the hub's next poll.
  app.use("/v1/workspaces/:slug/*", async (c, next) => {
    await next();
    const workspace = (c.var as Partial<WorkspaceEnv["Variables"]>).workspace;
    if (workspace && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.res.status < 400)
      syncHub.nudge(workspace.id);
  });

  // Setup and invitation endpoints need no session, so brake token guessing and setup hammering.
  // The login page's config lookup is cheap and read-only, so it is not counted.
  app.use(
    "/v1/public/*",
    rateLimit({
      ...publicRateLimit,
      skip: (method, path) => method === "GET" && path === "/v1/public/auth-config",
    }),
  );

  // Per-token request budgets (tokens only; sessions pass). Must come right after `requireSession`,
  // which resolves the credential. Forbidden routes are counted too: a token hammering them is
  // still a token hammering the API.
  const limitTokens = apiTokenRateLimit(tokenLimits);
  app.use("/v1/me/*", requireSession, limitTokens);
  app.use("/v1/calendar/*", requireSession, limitTokens, forbidTokens, async (c, next) => {
    // Connected calendars belong to the `calendar` module, so they vanish with it.
    if (!c.var.activeModules.includes("calendar")) {
      throw new ApiError(404, "module_inactive", "The calendar module is not enabled on this server");
    }
    return next();
  });
  app.use("/v1/workspaces/*", requireSession, limitTokens);
  // Personal calendar events must stay out of agent reach: the combined calendar view includes
  // the user's own connected-calendar events, and import copies one into the workspace.
  app.use("/v1/workspaces/:slug/calendar", forbidTokens);
  app.use("/v1/workspaces/:slug/meetings/import", forbidTokens);
  // Meeting writes act through the owner's connected Google/Microsoft calendar (invitations go out
  // from their account), so an agent token can read workspace meetings but not create or change them.
  app.use("/v1/workspaces/:slug/meetings/*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    return forbidTokens(c as never, next);
  });
  // The attendance kiosk: a paired tablet's credential only (routes/kiosk.ts).
  app.use("/v1/kiosk/*", requireDevice as never);
  // The assistant spends the person's own AI key and holds personal chats: a signed-in person only, never a token.
  app.use("/v1/workspaces/:slug/assistant/*", forbidTokens);
  app.use("/v1/workspaces/:slug/*", workspaceAccess as never);
  // Audit of token calls through an API access toggle; wraps the module gate so its refusals count.
  app.use("/v1/workspaces/:slug/*", tokenActionAudit as never);
  // Module gate: inactive modules answer 404, modules the member can't use 403 (modules/routes.ts).
  app.use("/v1/workspaces/:slug/*", moduleGuard as never);

  // Chained so the route types flow into `AppType` for the typed client.
  const routes = app
    .get("/health", (c) => c.json({ ok: true }))
    .route("/v1/public", publicRoutes)
    .route("/v1/public", kioskPairRoutes)
    .route("/v1/public", attachmentLinkRoutes)
    .route("/v1/kiosk", kioskRoutes)
    .get("/v1/me", async (c) =>
      c.json({ user: c.var.user, workspaces: await listMyWorkspaces(c.var.db, c.var.user.id) }),
    )
    .route("/v1/me", apiTokenRoutes)
    .route("/v1/me", assistantKeyRoutes)
    .route("/v1/workspaces/:slug", workspaceRoutes)
    .route("/v1/workspaces/:slug", taskRoutes)
    .route("/v1/workspaces/:slug", docRoutes)
    .route("/v1/workspaces/:slug", timeRoutes)
    .route("/v1/workspaces/:slug", structureRoutes)
    .route("/v1/workspaces/:slug", accessRoutes)
    .route("/v1/workspaces/:slug", tokenActionRoutes)
    .route("/v1/workspaces/:slug", meetingRoutes)
    .route("/v1/workspaces/:slug", assetRoutes)
    .route("/v1/workspaces/:slug", notificationRoutes)
    .route("/v1/workspaces/:slug", itemRoutes)
    .route("/v1/workspaces/:slug", recipeRoutes)
    .route("/v1/workspaces/:slug", sopRoutes)
    .route("/v1/workspaces/:slug", stockRoutes)
    .route("/v1/workspaces/:slug", customerRoutes)
    .route("/v1/workspaces/:slug", hseRoutes)
    .route("/v1/workspaces/:slug", hseIncidentRoutes)
    .route("/v1/workspaces/:slug", workforceRoutes)
    .route("/v1/workspaces/:slug", accountingRoutes)
    .route("/", xeroCallbackRoutes)
    .route("/v1/workspaces/:slug", salesRoutes)
    .route("/v1/workspaces/:slug", despatchRoutes)
    .route("/v1/workspaces/:slug", despatchOperationRoutes)
    .route("/v1/workspaces/:slug", demandRoutes)
    .route("/v1/workspaces/:slug", productionRoutes)
    .route("/v1/workspaces/:slug", haccpRoutes)
    .route("/v1/workspaces/:slug", peopleRoutes)
    .route("/v1/workspaces/:slug", trainingRoutes)
    .route("/v1/workspaces/:slug", attendanceRoutes)
    .route("/v1/workspaces/:slug", qualityRoutes)
    .route("/v1/workspaces/:slug", authenticityRoutes)
    .route("/v1/workspaces/:slug", incidentRoutes)
    .route("/v1/workspaces/:slug", purchasingRoutes)
    .route("/v1/workspaces/:slug", purchaseInvoiceRoutes)
    .route("/v1/workspaces/:slug", purchaseCreditNoteRoutes)
    .route("/v1/workspaces/:slug", costingRoutes)
    .route("/v1/workspaces/:slug/maintenance", maintenanceRoutes)
    .route("/v1/workspaces/:slug/site/maintenance", maintenanceRoutes)
    .route("/v1/workspaces/:slug", siteRoutes)
    .route("/v1/workspaces/:slug", checklistRoutes)
    .route("/v1/workspaces/:slug", labelRoutes)
    .route("/v1/workspaces/:slug", specificationRoutes)
    .route("/v1/workspaces/:slug", testingRoutes)
    .route("/v1/workspaces/:slug", npdRoutes)
    .route("/v1/workspaces/:slug", defenceRoutes)
    .route("/v1/workspaces/:slug", governanceRoutes)
    .route("/v1/workspaces/:slug", concernRoutes)
    .route("/v1/workspaces/:slug", purchaseRequestRoutes)
    .route("/v1/workspaces/:slug", clientServicesRoutes)
    .route("/v1/workspaces/:slug", assistantRoutes)
    .route("/v1/workspaces/:slug", biRoutes)
    .route("/v1/calendar", calendarConnectionRoutes);

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
