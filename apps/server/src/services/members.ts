import { wouldCreateReportingCycle, type MemberProfileInput, type WorkspaceRole } from "@knotworking/core";
import {
  accounts,
  lockWorkspaceLog,
  recordChanges,
  sessions,
  users,
  workspaceMembers,
  workspaces,
  type Database,
} from "@knotworking/db";
import { and, asc, eq, isNull, max, ne, sql } from "drizzle-orm";
import type { Auth } from "../auth";
import { captureResetLink } from "../auth";
import type { CurrentWorkspace } from "../env";
import { ApiError, notFound } from "../errors";
import type { Mailer } from "../mailer";

const rank: Record<WorkspaceRole, number> = { owner: 3, admin: 2, member: 1, guest: 0 };
export const isAdmin = (role: WorkspaceRole) => rank[role] >= rank.admin;

export async function listMembers(db: Database, workspaceId: string) {
  const lastActive = db
    .select({ userId: sessions.userId, at: max(sessions.updatedAt).as("at") })
    .from(sessions)
    .groupBy(sessions.userId)
    .as("last_active");
  const hasPassword = db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.providerId, "credential"))
    .as("has_password");
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      role: workspaceMembers.role,
      title: workspaceMembers.title,
      department: workspaceMembers.department,
      reportsToUserId: workspaceMembers.reportsToUserId,
      joinedAt: workspaceMembers.createdAt,
      deactivatedAt: workspaceMembers.deletedAt,
      lastActiveAt: lastActive.at,
      hasPassword: sql<boolean>`${hasPassword.userId} is not null`,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .leftJoin(lastActive, eq(lastActive.userId, users.id))
    .leftJoin(hasPassword, eq(hasPassword.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(users.name));
  return rows;
}

async function getMember(db: Database, workspaceId: string, userId: string) {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (!member) throw notFound("Member");
  return member;
}

async function otherOwnerCount(db: Database, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "owner"),
        isNull(workspaceMembers.deletedAt),
        ne(workspaceMembers.userId, userId),
      ),
    );
  return row?.n ?? 0;
}

/** Admins manage members and admins; only owners can touch owners. */
function assertCanManage(actor: CurrentWorkspace, target: { role: WorkspaceRole }, nextRole?: WorkspaceRole) {
  if (!isAdmin(actor.role)) throw new ApiError(403, "forbidden", "Only owners and admins can manage members");
  const touchesOwner = target.role === "owner" || nextRole === "owner";
  if (touchesOwner && actor.role !== "owner")
    throw new ApiError(403, "forbidden", "Only owners can manage owners");
}

export async function changeRole(
  db: Database,
  actor: CurrentWorkspace & { userId: string },
  userId: string,
  role: WorkspaceRole,
) {
  const member = await getMember(db, actor.id, userId);
  assertCanManage(actor, member, role);
  if (member.role === "owner" && role !== "owner" && (await otherOwnerCount(db, actor.id, userId)) === 0) {
    throw new ApiError(409, "last_owner", "A workspace needs at least one owner");
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(workspaceMembers)
      .set({ role })
      .where(eq(workspaceMembers.id, member.id))
      .returning();
    await recordChanges(tx, actor.id, actor.userId, [
      { entity: "workspace_member", entityId: row!.id, action: "upsert", data: row },
    ]);
    return row!;
  });
}

/** Removes access immediately: membership is deactivated and the person is signed out everywhere. */
export async function deactivateMember(
  db: Database,
  actor: CurrentWorkspace & { userId: string },
  userId: string,
) {
  if (userId === actor.userId) throw new ApiError(409, "self", "You can't deactivate yourself");
  const member = await getMember(db, actor.id, userId);
  assertCanManage(actor, member);
  if (member.deletedAt) return member;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(workspaceMembers)
      .set({ deletedAt: new Date() })
      .where(eq(workspaceMembers.id, member.id))
      .returning();
    const [stillActive] = await tx
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
      .limit(1);
    if (!stillActive) await tx.delete(sessions).where(eq(sessions.userId, userId));
    await recordChanges(tx, actor.id, actor.userId, [
      { entity: "workspace_member", entityId: row!.id, action: "delete" },
    ]);
    return row!;
  });
}

export async function reactivateMember(
  db: Database,
  actor: CurrentWorkspace & { userId: string },
  userId: string,
) {
  const member = await getMember(db, actor.id, userId);
  assertCanManage(actor, member);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(workspaceMembers)
      .set({ deletedAt: null })
      .where(eq(workspaceMembers.id, member.id))
      .returning();
    await recordChanges(tx, actor.id, actor.userId, [
      { entity: "workspace_member", entityId: row!.id, action: "upsert", data: row },
    ]);
    return row!;
  });
}

/**
 * Creates a password-reset link for a member. It's emailed when SMTP is
 * configured, and always returned so an admin can share it directly.
 */
export async function createPasswordResetLink(
  db: Database,
  auth: Auth,
  mailer: Mailer,
  appUrl: string,
  actor: CurrentWorkspace & { userId: string },
  userId: string,
) {
  const member = await getMember(db, actor.id, userId);
  assertCanManage(actor, member);
  // A reset link lets the holder sign in as that person, so admins can only issue
  // them for members and guests; owners can issue them for anyone.
  if (actor.role !== "owner" && rank[member.role] >= rank[actor.role]) {
    throw new ApiError(403, "forbidden", "Only owners can create reset links for admins");
  }
  if (userId === actor.userId)
    throw new ApiError(409, "self", "Use “Forgot password?” to reset your own password");
  // A password belongs to the global account, while this actor's authority stops at this
  // workspace. Returning a reset credential for a shared account would let a workspace owner
  // take over the person's access in every other workspace (including as an owner there).
  const [elsewhere] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        ne(workspaceMembers.workspaceId, actor.id),
        isNull(workspaceMembers.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (elsewhere) {
    throw new ApiError(
      403,
      "shared_account_reset",
      "This account belongs to other workspaces. Ask the person to use “Forgot password?” instead.",
    );
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound("Member");
  const url = await captureResetLink(() =>
    auth.api.requestPasswordReset({ body: { email: user.email, redirectTo: `${appUrl}/reset-password` } }),
  );
  if (!url) throw new ApiError(500, "reset_failed", "Couldn't create a reset link");
  return { url, emailed: mailer.configured };
}

/**
 * Sets a member's place on the org chart: title, department, who they report to. Display only, so
 * any admin may set anyone's, owners included. The manager must be an active member, and the line
 * can't loop back (a reports to b reports to a); the workspace lock keeps two edits from making one.
 */
export async function setMemberProfile(
  db: Database,
  actor: CurrentWorkspace & { userId: string },
  userId: string,
  input: MemberProfileInput,
) {
  if (!isAdmin(actor.role))
    throw new ApiError(403, "forbidden", "Only owners and admins can edit the org chart");
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, actor.id);
    const [member] = await tx
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, actor.id), eq(workspaceMembers.userId, userId)));
    if (!member) throw notFound("Member");
    if (member.deletedAt)
      throw new ApiError(
        409,
        "member_deactivated",
        "Reactivate this member before changing their place on the org chart",
      );
    const managerId = input.reportsToUserId;
    if (managerId && managerId !== member.reportsToUserId) {
      if (managerId === userId)
        throw new ApiError(400, "invalid_input", "Someone can't report to themselves");
      const all = await tx
        .select({
          userId: workspaceMembers.userId,
          reportsToUserId: workspaceMembers.reportsToUserId,
          deletedAt: workspaceMembers.deletedAt,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, actor.id));
      const manager = all.find((m) => m.userId === managerId);
      if (!manager || manager.deletedAt)
        throw new ApiError(400, "invalid_input", "The manager must be an active member of this workspace");
      const managerOf = new Map(all.map((m) => [m.userId, m.reportsToUserId]));
      if (wouldCreateReportingCycle(managerOf, userId, managerId))
        throw new ApiError(
          409,
          "reporting_cycle",
          "That would make a loop: the manager already reports to them",
        );
    }
    const [row] = await tx
      .update(workspaceMembers)
      .set(input)
      .where(eq(workspaceMembers.id, member.id))
      .returning();
    await recordChanges(tx, actor.id, actor.userId, [
      { entity: "workspace_member", entityId: row!.id, action: "upsert", data: row },
    ]);
    return row!;
  });
}
