import { hashPassword } from "better-auth/crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { WorkspaceRole, WorkflowStateType } from "@knotworking/core";
import { sortKeysBetween } from "@knotworking/core";
import type { Executor } from "./client";
import { accounts, teamMembers, teams, users, workflowStates, workspaceMembers } from "./schema";

/**
 * Creates a user who signs in with email + password. Uses Better Auth's own
 * password hashing so the account works with its sign-in endpoint.
 */
export async function createPasswordUser(
  db: Executor,
  input: { email: string; name: string; password: string },
): Promise<typeof users.$inferSelect> {
  const [user] = await db
    .insert(users)
    .values({ email: input.email.trim().toLowerCase(), name: input.name.trim(), emailVerified: true })
    .returning();
  await db.insert(accounts).values({
    userId: user!.id,
    providerId: "credential",
    accountId: user!.id,
    password: await hashPassword(input.password),
  });
  return user!;
}

export async function findUserByEmail(db: Executor, email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  return user;
}

/** Adds (or re-activates) a workspace membership. */
export async function addWorkspaceMember(
  db: Executor,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
) {
  const [existing] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (existing) {
    const [row] = await db
      .update(workspaceMembers)
      .set({ role, deletedAt: null })
      .where(eq(workspaceMembers.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db.insert(workspaceMembers).values({ workspaceId, userId, role }).returning();
  return row!;
}

/** The default workflow every new team starts with. Teams can rename/add states later. */
export const defaultWorkflow: [string, WorkflowStateType][] = [
  ["Backlog", "backlog"],
  ["Todo", "unstarted"],
  ["In Progress", "started"],
  ["In Review", "started"],
  ["Done", "completed"],
  ["Canceled", "canceled"],
];

export async function createTeamWithWorkflow(
  db: Executor,
  input: {
    workspaceId: string;
    key: string;
    name: string;
    icon?: string | null;
    color?: (typeof teams.$inferInsert)["color"];
    memberIds?: string[];
  },
) {
  const [team] = await db
    .insert(teams)
    .values({
      workspaceId: input.workspaceId,
      key: input.key.toUpperCase(),
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? "gray",
    })
    .returning();
  const keys = sortKeysBetween(null, null, defaultWorkflow.length);
  const states = await db
    .insert(workflowStates)
    .values(
      defaultWorkflow.map(([name, type], i) => ({
        workspaceId: input.workspaceId,
        teamId: team!.id,
        name,
        type,
        sortOrder: keys[i]!,
      })),
    )
    .returning();
  if (input.memberIds?.length) {
    await db
      .insert(teamMembers)
      .values(
        input.memberIds.map((userId) => ({ workspaceId: input.workspaceId, teamId: team!.id, userId })),
      );
  }
  return { team: team!, states };
}

/** Users who are active members of at least one workspace. */
export async function hasActiveMembership(db: Executor, userId: string) {
  const [row] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);
  return Boolean(row);
}
