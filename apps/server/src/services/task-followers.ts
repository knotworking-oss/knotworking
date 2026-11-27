import {
  lockWorkspaceLog,
  recordChanges,
  taskFollowers,
  tasks,
  teams,
  workspaceMembers,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { notFound } from "../errors";

type Subject = Pick<typeof tasks.$inferSelect, "id" | "creatorId" | "assigneeId">;

/** Explicit unfollows survive later assignments and comments. */
export async function autoFollowTask(
  tx: Transaction,
  workspaceId: string,
  taskId: string,
  users: (string | null)[],
) {
  const ids = [...new Set(users.filter((id): id is string => id !== null))];
  if (!ids.length) return;
  await tx
    .insert(taskFollowers)
    .values(ids.map((userId) => ({ workspaceId, taskId, userId, following: true })))
    .onConflictDoNothing({ target: [taskFollowers.taskId, taskFollowers.userId] });
}

export async function taskFollowerIds(db: Executor, workspaceId: string, task: Subject) {
  const candidates = new Set([task.creatorId, task.assigneeId].filter((id): id is string => id !== null));
  const preferences = await db
    .select({ userId: taskFollowers.userId, following: taskFollowers.following })
    .from(taskFollowers)
    .where(and(eq(taskFollowers.workspaceId, workspaceId), eq(taskFollowers.taskId, task.id)));
  for (const pref of preferences) {
    if (pref.following) candidates.add(pref.userId);
    else candidates.delete(pref.userId);
  }
  if (!candidates.size) return [];
  const members = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        isNull(workspaceMembers.deletedAt),
        inArray(workspaceMembers.userId, [...candidates]),
      ),
    )
    .orderBy(asc(workspaceMembers.userId));
  return members.map((row) => row.userId);
}

async function visibleTask(db: Executor, workspaceId: string, taskId: string) {
  const [task] = await db
    .select({ id: tasks.id, assigneeId: tasks.assigneeId, creatorId: tasks.creatorId })
    .from(tasks)
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)));
  if (!task) throw notFound("Task");
  return task;
}

export async function getTaskFollowing(db: Executor, workspaceId: string, taskId: string, userId: string) {
  const task = await visibleTask(db, workspaceId, taskId);
  const followers = await taskFollowerIds(db, workspaceId, task);
  return { following: followers.includes(userId), count: followers.length };
}

export async function setTaskFollowing(
  db: Database,
  workspaceId: string,
  taskId: string,
  userId: string,
  following: boolean,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const task = await visibleTask(tx, workspaceId, taskId);
    await tx
      .insert(taskFollowers)
      .values({ workspaceId, taskId, userId, following })
      .onConflictDoUpdate({
        target: [taskFollowers.taskId, taskFollowers.userId],
        set: { following, updatedAt: new Date() },
      });
    // Invalidate the task's count while leaving individual preferences private.
    await recordChanges(tx, workspaceId, userId, [
      { entity: "task_follower", entityId: taskId, action: "upsert", data: { id: taskId } },
    ]);
    return { following, count: (await taskFollowerIds(tx, workspaceId, task)).length };
  });
}
