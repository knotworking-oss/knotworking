import { currencySchema } from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { requireSession } from "../middleware/auth";
import { assertModule } from "../middleware/modules";
import { requireAdmin } from "../middleware/roles";
import { withWorkspaceAccess } from "../middleware/workspace";
import { validate } from "../validate";
import { xeroCallbackPath } from "../accounting/xero-http";

const id = z.object({ id: z.uuid() });
const review = z.object({ flowId: z.uuid(), tenantId: z.uuid() }).strict();
const command = z.object({ commandId: z.uuid(), expectedRevision: z.number().int().positive() }).strict();
const confirmation = review
  .extend(command.shape)
  .extend({ organisationId: z.uuid(), baseCurrency: currencySchema });
const callback = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().max(120).optional(),
});

function service(c: Context<WorkspaceEnv>) {
  if (!c.var.xero)
    throw new ApiError(409, "xero_not_configured", "Xero has not been configured on this server.");
  return c.var.xero;
}
function session(c: Context<WorkspaceEnv>) {
  if (!c.var.sessionId) throw new ApiError(403, "session_required", "Sign in to connect Xero.");
  return c.var.sessionId;
}
const destination = (c: Context<WorkspaceEnv>, connectionId: string) => ({
  workspaceId: c.var.workspace.id,
  connectionId,
  sessionId: session(c),
});

// Mounted under the accounting admin and module guards.
export const xeroRoutes = new Hono<WorkspaceEnv>()
  .get("/", validate("param", id), async (c) =>
    c.json(await service(c).status(destination(c, c.req.valid("param").id))),
  )
  .post("/start", validate("param", id), async (c) =>
    c.json(await service(c).start(destination(c, c.req.valid("param").id), c.var.user.id)),
  )
  .post("/review", validate("param", id), validate("json", review), async (c) =>
    c.json(
      await service(c).inspect(destination(c, c.req.valid("param").id), c.var.workspace, c.req.valid("json")),
    ),
  )
  .post("/confirm", validate("param", id), validate("json", confirmation), async (c) =>
    c.json(
      await service(c).confirm(
        destination(c, c.req.valid("param").id),
        c.var.workspace,
        c.var.user.id,
        c.req.valid("json"),
      ),
    ),
  )
  .post("/verify", validate("param", id), async (c) =>
    c.json(await service(c).verify(destination(c, c.req.valid("param").id), c.var.workspace)),
  )
  .post("/disconnect", validate("param", id), validate("json", command), async (c) =>
    c.json(
      await service(c).disconnect(
        destination(c, c.req.valid("param").id),
        c.var.user.id,
        c.req.valid("json"),
      ),
    ),
  );

// Xero registers one exact redirect URI. Resolve the workspace from opaque state, then run the
// same membership, admin and Accounting checks before consuming the state or exchanging a code.
export const xeroCallbackRoutes = new Hono<WorkspaceEnv>().get(
  xeroCallbackPath,
  async (c, next) => {
    c.header("Referrer-Policy", "no-referrer");
    await next();
  },
  requireSession,
  async (c, next) => {
    session(c);
    await next();
  },
  validate("query", callback),
  async (c, next) => {
    const { state } = c.req.valid("query");
    const flow = await service(c).callbackWorkspace(session(c), state);
    await withWorkspaceAccess(c, flow.slug, async () => {
      if (c.var.workspace.id !== flow.workspaceId)
        throw new ApiError(409, "xero_conflict", "This Xero sign-in is no longer valid.");
      await next();
    });
  },
  requireAdmin,
  async (c) => {
    assertModule(c, "accounting", "manage");
    const { state, code, error } = c.req.valid("query");
    const { ok, connectionId } = await service(c).complete(
      c.var.workspace.id,
      session(c),
      state,
      error ? undefined : code,
    );
    const url = new URL(`/${c.var.workspace.slug}/settings/accounting`, c.var.appUrl);
    url.searchParams.set("connection", connectionId);
    if (!ok) url.searchParams.set("xero", "error");
    return c.redirect(url.href, 303);
  },
);
