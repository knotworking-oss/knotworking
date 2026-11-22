import {
  hasModuleLevel,
  tokenActionLogQuerySchema,
  tokenActionParamSchema,
  tokenActionUpdateSchema,
  type ModuleId,
} from "@knotworking/core";
import { Hono } from "hono";
import type { WorkspaceEnv } from "../env";
import { requireSessionCredential } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { isAdmin } from "../services/members";
import { listTokenActionLog, listTokenActions, setTokenAction } from "../services/token-actions";
import { validate } from "../validate";

/**
 * API access toggles, mounted at `/v1/workspaces/:slug`: which person-only actions this workspace
 * has opened to API tokens (`@knotworking/core` token-actions.ts, `middleware/token-actions.ts`).
 *
 * - Anyone (tokens too) may read the list: the MCP server reads it to pick its tools.
 * - Only owners and admins, signed in with their own account, may switch an action or read the
 *   audit: a token can never widen its own powers.
 */
export const tokenActionRoutes = new Hono<WorkspaceEnv>()
  .get("/token-actions", async (c) => {
    const { modules, role } = c.var.workspace;
    // Only the active modules the caller can read (a token's module allowlist narrows this).
    const visible = (Object.keys(modules) as ModuleId[]).filter((id) => hasModuleLevel(modules[id], "read"));
    const credential = c.var.credential;
    return c.json({
      ...(await listTokenActions(
        c.var.db,
        c.var.workspace.id,
        visible,
        credential.kind === "token" ? { tokenActions: credential.tokenActions ?? null } : undefined,
      )),
      canManage: isAdmin(role) && c.var.credential.kind === "session",
    });
  })
  .get(
    "/token-actions/log",
    requireSessionCredential,
    requireAdmin,
    validate("query", tokenActionLogQuerySchema),
    async (c) => c.json(await listTokenActionLog(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .put(
    "/token-actions/:action",
    requireSessionCredential,
    requireAdmin,
    validate("param", tokenActionParamSchema),
    validate("json", tokenActionUpdateSchema),
    async (c) =>
      c.json(
        await setTokenAction(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").action,
          c.req.valid("json").enabled,
        ),
      ),
  );
