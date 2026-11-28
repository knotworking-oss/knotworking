import { sortKeyBetween, type SectionCreateInput, type SectionUpdateInput } from "@knotworking/core";
import {
  lockWorkspaceLog,
  projectSections,
  projects,
  recordChanges,
  tasks,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { badRequest, notFound } from "../errors";

function sectionRows(db: Executor, workspaceId: string, projectId?: string, id?: string) {
  return db
    .select({ section: projectSections })
    .from(projectSections)
    .innerJoin(projects, and(eq(projects.id, projectSections.projectId), isNull(projects.deletedAt)))
    .where(
      and(
        eq(projectSections.workspaceId, workspaceId),
        isNull(projectSections.deletedAt),
        projectId ? eq(projectSections.projectId, projectId) : undefined,
        id ? eq(projectSections.id, id) : undefined,
      ),
    );
}

export async function listProjectSections(db: Executor, workspaceId: string, projectId?: string) {
  const rows = await sectionRows(db, workspaceId, projectId).orderBy(
    asc(projectSections.sortOrder),
    asc(projectSections.id),
  );
  return rows.map((row) => row.section);
}

export async function assertSection(db: Executor, workspaceId: string, projectId: string | null, id: string) {
  if (projectId && (await sectionRows(db, workspaceId, projectId, id)).length) return;
  throw badRequest("Section must belong to the task's project");
}

export async function createSection(
  db: Executor,
  workspaceId: string,
  projectId: string,
  actorId: string,
  input: SectionCreateInput,
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
      .select({ key: max(projectSections.sortOrder) })
      .from(projectSections)
      .where(and(eq(projectSections.projectId, projectId), isNull(projectSections.deletedAt)));
    const [section] = await tx
      .insert(projectSections)
      .values({
        ...input,
        workspaceId,
        projectId,
        sortOrder: sortKeyBetween(last?.key, null),
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "project_section", entityId: section!.id, action: "upsert", data: section },
    ]);
    return section!;
  });
}

export async function changeSection(
  db: Database,
  workspaceId: string,
  projectId: string,
  id: string,
  actorId: string,
  input: SectionUpdateInput | null,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (!(await sectionRows(tx, workspaceId, projectId, id)).length) throw notFound("Section");
    const [section] = await tx
      .update(projectSections)
      .set(input ?? { deletedAt: new Date() })
      .where(eq(projectSections.id, id))
      .returning();
    if (input) {
      await recordChanges(tx, workspaceId, actorId, [
        { entity: "project_section", entityId: id, action: "upsert", data: section },
      ]);
    } else {
      const detached = await tx
        .update(tasks)
        .set({ sectionId: null })
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.sectionId, id), isNull(tasks.deletedAt)))
        .returning();
      await recordChanges(tx, workspaceId, actorId, [
        { entity: "project_section", entityId: id, action: "delete" },
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
    return section!;
  });
}
