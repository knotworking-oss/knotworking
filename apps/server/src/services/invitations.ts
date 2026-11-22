import { createHash, randomBytes } from "node:crypto";
import type { WorkspaceRole } from "@knotworking/core";
import {
  addWorkspaceMember,
  createPasswordUser,
  findUserByEmail,
  invitations,
  recordChanges,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";

const INVITE_TTL_DAYS = 7;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const normalize = (email: string) => email.trim().toLowerCase();
const pending = () =>
  and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()));

export async function hasPendingInvitation(db: Executor, email: string) {
  const [row] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.email, normalize(email)), pending()))
    .limit(1);
  return Boolean(row);
}

/** Turns every pending invitation for this email into a workspace membership. */
export async function acceptPendingInvitations(db: Database, userId: string, email: string) {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.email, normalize(email)), pending()));
    for (const invite of rows) await accept(tx, invite, userId);
  });
}

async function accept(tx: Executor, invite: typeof invitations.$inferSelect, userId: string) {
  const member = await addWorkspaceMember(tx, invite.workspaceId, userId, invite.role);
  await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invite.id));
  await recordChanges(tx as never, invite.workspaceId, userId, [
    { entity: "workspace_member", entityId: member.id, action: "upsert", data: member },
  ]);
}

export async function listInvitations(db: Database, workspaceId: string) {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      invitedBy: users.name,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedById))
    .where(and(eq(invitations.workspaceId, workspaceId), pending()))
    .orderBy(desc(invitations.createdAt));
}

export async function createInvitation(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: { email: string; role: WorkspaceRole },
) {
  const email = normalize(input.email);
  const existing = await findUserByEmail(db, email);
  if (existing) {
    const [member] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, existing.id)));
    if (member && !member.deletedAt)
      throw new ApiError(409, "already_member", `${email} is already a member`);
    if (member?.deletedAt) {
      throw new ApiError(
        409,
        "deactivated_member",
        `${email} was deactivated — reactivate them from the members list`,
      );
    }
  }

  const token = randomBytes(32).toString("base64url");
  return db.transaction(async (tx) => {
    // One live invitation per address: re-inviting replaces the old link.
    await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.workspaceId, workspaceId), eq(invitations.email, email), pending()));
    const [invitation] = await tx
      .insert(invitations)
      .values({
        workspaceId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: actorId,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
      })
      .returning();
    return { invitation: invitation!, token };
  });
}

export async function revokeInvitation(db: Database, workspaceId: string, id: string) {
  const [row] = await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, id), eq(invitations.workspaceId, workspaceId), pending()))
    .returning({ id: invitations.id });
  if (!row) throw notFound("Invitation");
}

async function findByToken(db: Executor, token: string) {
  const [row] = await db
    .select({ invite: invitations, workspaceName: workspaces.name, workspaceSlug: workspaces.slug })
    .from(invitations)
    .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
    .where(and(eq(invitations.tokenHash, hashToken(token)), pending()));
  if (!row) throw new ApiError(404, "invalid_invitation", "This invitation link is invalid or has expired");
  return row;
}

/** Public: what the invite page shows before someone accepts. */
export async function describeInvitation(db: Database, token: string) {
  const { invite, workspaceName } = await findByToken(db, token);
  const existingUser = await findUserByEmail(db, invite.email);
  return { email: invite.email, role: invite.role, workspaceName, existingUser: Boolean(existingUser) };
}

/**
 * Public: accepts an invitation. New people choose a name and password; people
 * who already have an account just join the workspace and sign in as usual.
 */
export async function acceptInvitation(
  db: Database,
  token: string,
  input: { name?: string; password?: string },
) {
  return db.transaction(async (tx) => {
    const { invite, workspaceSlug } = await findByToken(tx, token);
    let user = await findUserByEmail(tx, invite.email);
    if (!user) {
      if (!input.name?.trim() || !input.password) throw badRequest("Name and password are required");
      if (input.password.length < 10) throw badRequest("Password must be at least 10 characters");
      user = await createPasswordUser(tx, {
        email: invite.email,
        name: input.name,
        password: input.password,
      });
    }
    await accept(tx, invite, user.id);
    return { email: user.email, workspaceSlug };
  });
}
