import { workspaceMembers, workspaces } from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { activeWorkspaceModules, effectiveCurrency, effectiveTimeZone, todayInZone } from "@knotworking/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { WorkspaceEnv } from "../env";
import { notFound } from "../errors";
import { memberModuleLevels } from "../services/module-access";
import { withTimeZoneScope } from "../services/time-zone";

/** Resolves `:slug` to a workspace the current user belongs to, with their module access. */
export const workspaceAccess = createMiddleware<WorkspaceEnv>(async (c, next) => {
  const slug = c.req.param("slug");
  if (!slug) throw notFound("Workspace");
  await withWorkspaceAccess(c, slug, next);
});

/** The fixed OAuth callback resolves its workspace from the one-time state. */
export async function withWorkspaceAccess(c: Context<WorkspaceEnv>, slug: string, next: () => Promise<void>) {
  const [membership] = await c.var.db
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
      timeZone: workspaces.timeZone,
      currency: workspaces.currency,
      enabledModules: workspaces.enabledModules,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaces.slug, slug),
        eq(workspaceMembers.userId, c.var.user.id),
        isNull(workspaces.deletedAt),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  // 404 (not 403) so workspace slugs can't be probed.
  if (!membership) throw notFound("Workspace");
  const { enabledModules, ...row } = membership;
  const availableModules = c.var.activeModules;
  const activeModules = activeWorkspaceModules(availableModules, enabledModules);
  const modules = await memberModuleLevels(
    c.var.db,
    row.id,
    { userId: c.var.user.id, role: row.role },
    activeModules,
    c.var.credential.kind === "token" ? c.var.credential.modules : null,
  );
  // A stored zone the schema refuses (old free-text attendance values) falls back to the default.
  const { timeZone } = effectiveTimeZone(row.timeZone);
  c.set("activeModules", activeModules);
  c.set("workspace", {
    ...row,
    timeZone,
    currency: effectiveCurrency(row.currency),
    availableModules,
    modules,
  });
  // The request's zone lookups (services' `workspaceTimeZone`) start from this one, not a SELECT each.
  await withTimeZoneScope(next, { workspaceId: row.id, timeZone });
}

/**
 * Today's date in the workspace's time zone: the "today" every business decision on a workspace
 * route uses (what's due, no future dates, default report periods). Never the server's UTC date.
 */
export const todayIn = (c: Context<WorkspaceEnv>, now: Date | number = Date.now()) =>
  todayInZone(c.var.workspace.timeZone, now);
