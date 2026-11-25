import { hasModuleLevel, type ModuleAccessLevel, type ModuleId } from "@knotworking/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { WorkspaceEnv } from "../env";
import { ApiError, notFound } from "../errors";
import { moduleOfRoute, workspaceSubPath } from "../modules/routes";

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
/**
 * Writes that only need `read`: a personal record about what the reader has seen (SOP
 * acknowledgement), and evacuation roll calls (fire marshals need not see anyone's hours).
 */
const READ_LEVEL_WRITES = [
  /^\/workforce\/me\/absences(\/|$)/,
  /^\/sops\/[^/]+\/acknowledge$/,
  /^\/attendance\/roll-calls(\/|$)/,
];

/** Throws unless the caller has `needed` in `moduleId`. Inactive modules look like missing routes. */
export function assertModule(
  c: Context<WorkspaceEnv>,
  moduleId: ModuleId,
  needed: Exclude<ModuleAccessLevel, "none">,
) {
  if (!c.var.activeModules.includes(moduleId)) {
    throw new ApiError(404, "module_inactive", `The ${moduleId} module is not enabled in this workspace`);
  }
  if (!hasModuleLevel(c.var.workspace.modules[moduleId], needed)) {
    // Guests are capped at read in every module; keep the error they have always had for writes.
    if (c.var.workspace.role === "guest" && canRead(c, moduleId)) {
      throw new ApiError(403, "read_only", "Guests have read-only access to this workspace");
    }
    throw new ApiError(
      403,
      "module_forbidden",
      needed === "read"
        ? `You don't have access to the ${moduleId} module in this workspace`
        : `You don't have ${needed} access to the ${moduleId} module in this workspace`,
    );
  }
}

/** Whether the caller can at least read `moduleId` (false when it is inactive). */
export const canRead = (c: Context<WorkspaceEnv>, moduleId: ModuleId) =>
  hasModuleLevel(c.var.workspace.modules[moduleId], "read");

/**
 * After `workspaceAccess`: gates every workspace route by the module that owns it
 * (`modules/routes.ts`). Safe methods need `read`, everything else `write`; routes that need
 * more call `requireModuleLevel`. Applies to sessions and API tokens alike: a token acts with
 * its owner's module access.
 */
export const moduleGuard = createMiddleware<WorkspaceEnv>(async (c, next) => {
  const sub = workspaceSubPath(c.req.path);
  const owner = sub === null ? "platform" : moduleOfRoute(sub);
  // Unclassified paths are not routes we know (module-routes.test.ts keeps the table complete).
  if (!owner) throw notFound("Route");
  if (owner !== "platform") {
    const readOnly =
      SAFE_METHODS.includes(c.req.method) || (sub !== null && READ_LEVEL_WRITES.some((p) => p.test(sub)));
    assertModule(c, owner, readOnly ? "read" : "write");
  }
  await next();
});

/** For routes that need more than the method implies, e.g. `requireModuleLevel("sops", "manage")`. */
export const requireModuleLevel = (moduleId: ModuleId, needed: Exclude<ModuleAccessLevel, "none">) =>
  createMiddleware<WorkspaceEnv>(async (c, next) => {
    assertModule(c, moduleId, needed);
    await next();
  });
