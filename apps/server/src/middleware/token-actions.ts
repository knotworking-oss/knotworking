import {
  tokenActionRefusal,
  tokenAllowlistRefusal,
  tokenMayUseAction,
  type TokenActionId,
} from "@knotworking/core";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import type { WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { notifyTokenActionUsed } from "../services/notifications";
import { isTokenActionEnabled, logTokenActionUse } from "../services/token-actions";

const actionOf = new WeakMap<MiddlewareHandler, TokenActionId>();

/** The action a route's `personOrToken` guard stands for (route classification test). */
export const tokenActionOfHandler = (handler: unknown) =>
  typeof handler === "function" ? actionOf.get(handler as MiddlewareHandler) : undefined;

/**
 * After `workspaceAccess`, in place of `forbidTokens` on a route an owner or admin may open to API
 * tokens (`@knotworking/core` token-actions.ts). Sessions pass as before. A token passes only when
 * the workspace has switched `action` on, otherwise 403 `token_not_allowed` naming the action and
 * where to allow it, and even then only one whose own allowlist (`api_tokens.token_actions`) names
 * the action, otherwise 403 `token_not_allowed` with `details.reason` `token_allowlist`. The route's module level (`requireModuleLevel`) and the token's module
 * allowlist still apply. The audit is `tokenActionAudit`, which runs before the module gate.
 */
export const personOrToken = (action: TokenActionId) => {
  const middleware = createMiddleware<WorkspaceEnv>(async (c, next) => {
    if (c.var.credential.kind !== "token") return next();
    if (!(await isTokenActionEnabled(c.var.db, c.var.workspace.id, action))) {
      throw new ApiError(403, "token_not_allowed", tokenActionRefusal(action), { action });
    }
    // The workspace allows it; the token's own allowlist must too (null: an older token, unrestricted).
    if (!tokenMayUseAction(c.var.credential.tokenActions, action)) {
      throw new ApiError(403, "token_not_allowed", tokenAllowlistRefusal(action), {
        action,
        reason: "token_allowlist",
      });
    }
    await next();
  });
  actionOf.set(middleware as MiddlewareHandler, action);
  return middleware;
};

/** The action of the `personOrToken` guard on the route this request matched, if any. */
function matchedAction(c: Context): TokenActionId | undefined {
  for (const route of matchedRoutes(c)) {
    const action = tokenActionOfHandler(route.handler);
    if (action) return action;
  }
  return undefined;
}

/**
 * App-level, after `workspaceAccess` and before `moduleGuard`: audits, in `api_token_action_log`
 * with the response status, every request a token makes to a route whose action the workspace has
 * switched on. It wraps the module gate and the token's module allowlist as well as the route, so
 * a call refused there (e.g. 403 `module_forbidden` for an owner with only read access) is recorded
 * like one the handler refused or failed. The row is written after the response is decided and
 * outside the handler's transaction.
 */
export const tokenActionAudit = createMiddleware<WorkspaceEnv>(async (c, next) => {
  const credential = c.var.credential;
  const action = credential.kind === "token" ? matchedAction(c) : undefined;
  if (
    credential.kind !== "token" ||
    !action ||
    !(await isTokenActionEnabled(c.var.db, c.var.workspace.id, action))
  ) {
    return next();
  }
  // Hono turns an error into the response inside `next()`; the fallback covers anything else.
  let status = 500;
  let note: string | null = null;
  try {
    await next();
    status = c.res.status;
    note = await limitNote(c.res, status);
  } finally {
    try {
      const tokenName = await logTokenActionUse(c.var.db, {
        workspaceId: c.var.workspace.id,
        tokenId: credential.tokenId,
        userId: c.var.user.id,
        action,
        method: c.req.method,
        path: c.req.path,
        status,
        note,
      });
      // Tell people only when it worked: a refused or failed call changed nothing (the log has it).
      if (status >= 200 && status < 300) {
        await notifyTokenActionUsed(c.var.db, c.var.workspace.id, {
          tokenId: credential.tokenId,
          tokenName,
          ownerId: c.var.user.id,
          ownerName: c.var.user.name,
          action,
        });
      }
    } catch (err) {
      console.error(`[token-actions] couldn't write the audit row for ${action}:`, err);
    }
  }
});

/** The refusal's message when the token's own allowlist or limit refused the call, for the audit. */
async function limitNote(res: Response, status: number): Promise<string | null> {
  if (status !== 403) return null;
  try {
    const body = (await res.clone().json()) as { error?: { code?: string; message?: string } };
    return body.error?.code === "token_limit_exceeded" || body.error?.code === "token_not_allowed"
      ? (body.error.message ?? null)
      : null;
  } catch {
    return null;
  }
}
