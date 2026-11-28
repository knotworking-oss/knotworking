import { sortKeyBetween, type MilestoneCreateInput, type MilestoneUpdateInput } from "@knotworking/core";
import {
  lockWorkspaceLog,
  projectMilestones,
  projects,
  recordChanges,
  tasks,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { badRequest, notFound } from "../errors";

export async function listProjectMilestones(db: Executor, workspaceId: string, projectId?: string) {
  const rows = await db
    .select({ milestone: projectMilestones })
    .from(projectMilestones)
    .innerJoin(projects, and(eq(projects.id, projectMilestones.projectId), isNull(projects.deletedAt)))
    .where(
      and(
        eq(projectMilestones.workspaceId, workspaceId),
        isNull(projectMilestones.deletedAt),
        projectId ? eq(projectMilestones.projectId, projectId) : undefined,
      ),
    )
    .orderBy(asc(projectMilestones.sortOrder), asc(projectMilestones.id));
  return rows.map((row) => row.milestone);
}

export async function assertMilestone(
  db: Executor,
  workspaceId: string,
  projectId: string | null,
  id: string,
) {
  const [milestone] = await db
    .select({ projectId: projectMilestones.projectId })
    .from(projectMilestones)
    .innerJoin(projects, and(eq(projects.id, projectMilestones.projectId), isNull(projects.deletedAt)))
    .where(
      and(
        eq(projectMilestones.workspaceId, workspaceId),
        eq(projectMilestones.id, id),
        isNull(projectMilestones.deletedAt),
      ),
    );
  if (!milestone || milestone.projectId !== projectId)
    throw badRequest("Milestone must belong to the task's project");
}

export async function createMilestone(
  db: Executor,
  workspaceId: string,
  projectId: string,
  actorId: string,
  input: MilestoneCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId), isNull(projects.deletedAt)),
      );
    if (!project) throw notFound("Project");
    const [last] = await tx
      .select({ key: max(projectMilestones.sortOrder) })
      .from(projectMilestones)
      .where(and(eq(projectMilestones.projectId, projectId), isNull(projectMilestones.deletedAt)));
    const [row] = await tx
      .insert(projectMilestones)
      .values({
        ...input,
        workspaceId,
        projectId,
        sortOrder: sortKeyBetween(last?.key, null),
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "project_milestone", entityId: row!.id, action: "upsert", data: row },
    ]);
    return row!;
  });
}

export async function changeMilestone(
  db: Database,
  workspaceId: string,
  projectId: string,
  id: string,
  actorId: string,
  input: MilestoneUpdateInput | null,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [current] = await tx
      .select({ milestone: projectMilestones })
      .from(projectMilestones)
      .innerJoin(projects, and(eq(projects.id, projectMilestones.projectId), isNull(projects.deletedAt)))
      .where(
        and(
          eq(projectMilestones.workspaceId, workspaceId),
          eq(projectMilestones.projectId, projectId),
          eq(projectMilestones.id, id),
          isNull(projectMilestones.deletedAt),
        ),
      );
    if (!current) throw notFound("Milestone");
    const { completed, ...fields } = input ?? {};
    const [row] = await tx
      .update(projectMilestones)
      .set(
        input
          ? {
              ...fields,
              ...(completed === undefined
                ? {}
                : {
                    completedAt: completed ? (current.milestone.completedAt ?? new Date()) : null,
                  }),
            }
          : { deletedAt: new Date() },
      )
      .where(eq(projectMilestones.id, id))
      .returning();
    if (input) {
      await recordChanges(tx, workspaceId, actorId, [
        { entity: "project_milestone", entityId: id, action: "upsert", data: row },
      ]);
    } else {
      const detached = await tx
        .update(tasks)
        .set({ milestoneId: null })
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.milestoneId, id), isNull(tasks.deletedAt)))
        .returning();
      await recordChanges(tx, workspaceId, actorId, [
        { entity: "project_milestone", entityId: id, action: "delete" },
      ]);
      for (let at = 0; at < detached.length; at += 500) {
        await recordChanges(
          tx,
          workspaceId,
          actorId,
          detached.slice(at, at + 500).map((task) => ({
            entity: "task",
            entityId: task.id,
            action: "upsert",
            data: task,
          })),
        );
      }
    }
    return row!;
  });
}
