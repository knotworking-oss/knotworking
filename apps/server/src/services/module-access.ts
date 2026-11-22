import {
  hasModuleLevel,
  isModuleId,
  modules,
  resolveModuleAccess,
  summarizeModules,
  type ModuleAccessLevel,
  type ModuleAccessMap,
  type ModuleId,
  type WorkspaceRole,
} from "@knotworking/core";
import { memberModuleAccess, recordChanges, users, workspaceMembers, type Database } from "@knotworking/db";
import type { Executor } from "@knotworking/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

/** Explicit grants of one member (rows of modules this build doesn't know are ignored). */
export async function loadGrants(
  db: Executor,
  workspaceId: string,
  userId: string,
): Promise<ModuleAccessMap> {
  const rows = await db
    .select({ moduleId: memberModuleAccess.moduleId, level: memberModuleAccess.level })
    .from(memberModuleAccess)
    .where(
      and(
        eq(memberModuleAccess.workspaceId, workspaceId),
        eq(memberModuleAccess.userId, userId),
        isNull(memberModuleAccess.deletedAt),
      ),
    );
  const grants: ModuleAccessMap = {};
  for (const row of rows) if (isModuleId(row.moduleId)) grants[row.moduleId] = row.level;
  return grants;
}

/** A member's effective level per active module. */
export async function memberModuleLevels(
  db: Executor,
  workspaceId: string,
  member: { userId: string; role: WorkspaceRole },
  active: readonly ModuleId[],
  /** An API token's module allowlist (`null`: unrestricted). */
  allow?: readonly ModuleId[] | null,
) {
  return resolveModuleAccess({
    role: member.role,
    active,
    grants: await loadGrants(db, workspaceId, member.userId),
    allow,
  });
}

/**
 * Admin view: every active member with their explicit grant (`null` = module default) and
 * effective level per active module.
 */
export async function listModuleAccess(db: Database, workspaceId: string, active: readonly ModuleId[]) {
  const [members, grantRows] = await Promise.all([
    db
      .select({ userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deletedAt)))
      .orderBy(asc(users.name)),
    db
      .select()
      .from(memberModuleAccess)
      .where(and(eq(memberModuleAccess.workspaceId, workspaceId), isNull(memberModuleAccess.deletedAt))),
  ]);
  const grantsByUser = new Map<string, ModuleAccessMap>();
  for (const row of grantRows) {
    if (!isModuleId(row.moduleId)) continue;
    const grants = grantsByUser.get(row.userId) ?? {};
    grants[row.moduleId] = row.level;
    grantsByUser.set(row.userId, grants);
  }
  return {
    modules: summarizeModules(Object.fromEntries(active.map((id) => [id, "manage"]))).map(
      ({ access: _access, ...m }) => ({ ...m, defaultAccess: modules[m.id].defaultAccess }),
    ),
    members: members.map((m) => {
      const grants = grantsByUser.get(m.userId) ?? {};
      const effective = resolveModuleAccess({ role: m.role, active, grants });
      return {
        ...m,
        /** Owners and admins always have full access; their grants can't be edited. */
        locked: m.role === "owner" || m.role === "admin",
        access: Object.fromEntries(
          active.map((id) => [id, { grant: grants[id] ?? null, effective: effective[id] ?? "none" }]),
        ) as Partial<Record<ModuleId, { grant: ModuleAccessLevel | null; effective: ModuleAccessLevel }>>,
      };
    }),
  };
}

/**
 * Sets (or with `level: null` clears) one member's grant in one active module. Recorded in the
 * sync log as `module_access`, so the member's open clients notice and reload what they may see.
 */
export async function setModuleAccess(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  target: { userId: string; moduleId: string },
  level: ModuleAccessLevel | null,
) {
  if (!isModuleId(target.moduleId) || !active.includes(target.moduleId)) throw notFound("Module");
  const moduleId = target.moduleId;
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, target.userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) throw notFound("Member");
  if (member.role === "owner" || member.role === "admin") {
    throw new ApiError(
      409,
      "always_full_access",
      "Owners and admins always have full access to every module",
    );
  }
  if (member.role === "guest" && level && hasModuleLevel(level, "write")) {
    throw new ApiError(409, "guest_read_only", "Guests can be given read access at most");
  }
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(memberModuleAccess)
      .values({
        workspaceId,
        userId: target.userId,
        moduleId,
        level: level ?? "none",
        deletedAt: level ? null : now,
      })
      .onConflictDoUpdate({
        target: [memberModuleAccess.workspaceId, memberModuleAccess.userId, memberModuleAccess.moduleId],
        set: { ...(level ? { level } : {}), deletedAt: level ? null : now, updatedAt: now },
      })
      .returning();
    // Always an upsert (a cleared grant carries `level: null`), so clients can tell whose access changed.
    await recordChanges(tx, workspaceId, actorId, [
      {
        entity: "module_access",
        entityId: row!.id,
        action: "upsert",
        data: { id: row!.id, userId: row!.userId, moduleId, level },
      },
    ]);
    const grants = await loadGrants(tx, workspaceId, target.userId);
    const effective = resolveModuleAccess({ role: member.role, active, grants });
    return {
      userId: target.userId,
      moduleId,
      grant: grants[moduleId] ?? null,
      effective: effective[moduleId]!,
    };
  });
}
