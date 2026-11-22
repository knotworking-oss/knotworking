import type { ModuleId } from "@knotworking/core";
import { jobRoles, sopTargets, staff, staffJobRoles, type Executor } from "@knotworking/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

/**
 * Who must read which SOP. An SOP with live targets is for the named members plus the members who
 * hold a targeted job role (through the active staff record linked to their login; needs the
 * `people` module). An SOP with none is for everyone with `read` on SOPs, so it has no entry here.
 * The result is not filtered by access: callers intersect it with the members who can read SOPs.
 * Kept free of the notification and SOP services so both can use it.
 */
export async function sopTargetUserIds(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[],
  sopIds: string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (sopIds.length === 0) return result;
  const targets = await db
    .select({ sopId: sopTargets.sopId, jobRoleId: sopTargets.jobRoleId, userId: sopTargets.userId })
    .from(sopTargets)
    .where(
      and(
        eq(sopTargets.workspaceId, workspaceId),
        inArray(sopTargets.sopId, sopIds),
        isNull(sopTargets.deletedAt),
      ),
    );
  for (const t of targets) if (!result.has(t.sopId)) result.set(t.sopId, new Set());
  for (const t of targets) if (t.userId) result.get(t.sopId)!.add(t.userId);
  const roleIds = [...new Set(targets.flatMap((t) => (t.jobRoleId ? [t.jobRoleId] : [])))];
  if (roleIds.length && active.includes("people")) {
    const holders = await db
      .select({ jobRoleId: staffJobRoles.jobRoleId, userId: staff.userId })
      .from(staffJobRoles)
      .innerJoin(staff, eq(staff.id, staffJobRoles.staffId))
      .innerJoin(jobRoles, and(eq(jobRoles.id, staffJobRoles.jobRoleId), isNull(jobRoles.deletedAt)))
      .where(
        and(
          eq(staffJobRoles.workspaceId, workspaceId),
          inArray(staffJobRoles.jobRoleId, roleIds),
          isNull(staffJobRoles.deletedAt),
          eq(staff.status, "active"),
          isNull(staff.deletedAt),
          isNotNull(staff.userId),
        ),
      );
    for (const t of targets) {
      if (!t.jobRoleId) continue;
      for (const h of holders) if (h.jobRoleId === t.jobRoleId) result.get(t.sopId)!.add(h.userId!);
    }
  }
  return result;
}
