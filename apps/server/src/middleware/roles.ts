import { createMiddleware } from "hono/factory";
import type { WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { isAdmin } from "../services/members";

/** Restricts a workspace route to owners and admins. API tokens never get admin routes. */
export const requireAdmin = createMiddleware<WorkspaceEnv>(async (c, next) => {
  if (c.var.credential.kind === "token") {
    throw new ApiError(403, "token_not_allowed", "API tokens can't be used for admin actions");
  }
  if (!isAdmin(c.var.workspace.role)) {
    throw new ApiError(403, "forbidden", "Only workspace owners and admins can do this");
  }
  await next();
});

/** Guests have read-only access: blocks writes for them. */
export const requireWriter = createMiddleware<WorkspaceEnv>(async (c, next) => {
  if (c.var.workspace.role === "guest") {
    throw new ApiError(403, "read_only", "Guests have read-only access to this workspace");
  }
  await next();
});
