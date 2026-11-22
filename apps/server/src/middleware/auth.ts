import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { ApiError } from "../errors";
import { authenticateApiToken, isApiToken } from "../services/api-tokens";

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** The value of `Authorization: Bearer <value>`, if the request has one. */
export function bearerValue(headers: Headers) {
  return /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "")?.[1];
}

/**
 * Requires a signed-in user. Accepts the session cookie (web), `Authorization: Bearer <session
 * token>` (desktop/mobile) or `Authorization: Bearer knw_…`, a personal API token (agents, scripts).
 *
 * Tokens are resolved here and never reach Better Auth. A `read` token may only make
 * GET/HEAD/OPTIONS requests; `write` tokens act with their owner's permissions (the workspace role
 * still applies downstream). Sets `c.var.user` and `c.var.credential`.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = bearerValue(c.req.raw.headers);
  if (bearer && isApiToken(bearer)) {
    const identity = await authenticateApiToken(c.var.db, bearer);
    if (!identity) throw new ApiError(401, "unauthenticated", "Sign in to continue");
    if (identity.scope === "read" && !SAFE_METHODS.includes(c.req.method)) {
      throw new ApiError(403, "token_read_only", "This API token is read-only");
    }
    c.set("user", identity.user);
    c.set("credential", {
      kind: "token",
      scope: identity.scope,
      tokenId: identity.tokenId,
      modules: identity.modules,
      tokenActions: identity.tokenActions,
      maxOrderValue: identity.maxOrderValue,
    });
    return next();
  }

  const result = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) throw new ApiError(401, "unauthenticated", "Sign in to continue");
  c.set("user", { id: result.user.id, email: result.user.email, name: result.user.name });
  c.set("credential", { kind: "session" });
  await next();
});

/** After `requireSession`: refuses API tokens (personal data, admin actions). Sessions pass. */
export const forbidTokens = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.credential.kind === "token") {
    throw new ApiError(403, "token_not_allowed", "API tokens can't be used for this");
  }
  await next();
});

/** After `requireSession`: only a real sign-in session may continue, so a leaked token can't mint more. */
export const requireSessionCredential = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.credential.kind !== "session") {
    throw new ApiError(403, "session_required", "Sign in with your account to manage API tokens");
  }
  await next();
});
