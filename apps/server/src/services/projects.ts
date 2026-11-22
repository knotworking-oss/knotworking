import {
  sortKeyBetween,
  type ProjectCreateInput,
  type ProjectStatus,
  type ProjectUpdateInput,
} from "@knotworking/core";
import {
  documents,
  projects,
  projectTeams,
  recordChanges,
  tasks,
  teams,
  workflowStates,
  type Database,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, eq, inArray, isNull, max } from "drizzle-orm";
import { badRequest, notFound } from "../errors";
import { assertRefs } from "./refs";

type ProjectRow = typeof projects.$inferSelect;
type Change = Parameters<typeof recordChanges>[3][number];

/** Wire format for a written project; `teamIds` is the set of linked teams. */
function serializeProject(row: ProjectRow, teamIds: string[]) {
  const { deletedAt: _deleted, workspaceId: _ws, ...rest } = row;
  return { ...rest, teamIds };
}

/** Projects with task progress by state category (for list/portfolio views). */
export async function listProjects(db: Database, workspaceId: string) {
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
      .orderBy(asc(projects.sortOrder)),
    db
      .select({ projectId: tasks.projectId, type: workflowStates.type, n: count() })
      .from(tasks)
      .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
      .where(and(eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
      .groupBy(tasks.projectId, workflowStates.type),
  ]);
  return rows.map((p) => {
    const mine = counts.filter((c) => c.projectId === p.id);
    const by = (t: string) => mine.find((c) => c.type === t)?.n ?? 0;
    const canceled = by("canceled");
    const total = mine.reduce((s, c) => s + c.n, 0) - canceled;
    const completed = by("completed");
    const started = by("started");
    return {
      ...p,
      progress: { total, completed, started, ratio: total ? completed / total : 0 },
    };
  });
}

async function assertTeams(tx: Transaction, workspaceId: string, teamIds: string[]) {
  if (teamIds.length === 0) return;
  const found = await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), inArray(teams.id, teamIds), isNull(teams.deletedAt)));
  if (found.length !== teamIds.length) throw badRequest("Unknown teamId");
}

/** A project is "completed" from the moment its status becomes completed. */
const completedAtFor = (status: ProjectStatus) => (status === "completed" ? new Date() : null);

export async function createProject(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ProjectCreateInput,
) {
  return db.transaction(async (tx) => {
    const { teamIds: requested = [], ...fields } = input;
    const teamIds = [...new Set(requested)];
    await assertRefs(tx, workspaceId, { assigneeId: fields.leadId });
    await assertTeams(tx, workspaceId, teamIds);

    const [last] = await tx
      .select({ value: max(projects.sortOrder) })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId));
    const [project] = await tx
      .insert(projects)
      .values({
        ...fields,
        workspaceId,
        sortOrder: sortKeyBetween(last?.value ?? null, null),
        completedAt: completedAtFor(fields.status ?? "planned"),
      })
      .returning();
    const links = teamIds.length
      ? await tx
          .insert(projectTeams)
          .values(teamIds.map((teamId) => ({ workspaceId, projectId: project!.id, teamId })))
          .returning()
      : [];
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "project", entityId: project!.id, action: "upsert", data: project },
      ...links.map((l) => ({
        entity: "project_team" as const,
        entityId: l.id,
        action: "upsert" as const,
        data: l,
      })),
    ]);
    return serializeProject(project!, teamIds);
  });
}

export async function updateProject(
  db: Database,
  workspaceId: string,
  actorId: string,
  projectId: string,
  input: ProjectUpdateInput,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(projects)
      .where(
        and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)),
      );
    if (!current) throw notFound("Project");

    const { teamIds, ...fields } = input;
    await assertRefs(tx, workspaceId, { assigneeId: fields.leadId });

    // The schema checks dates sent together; one sent alone is checked against the stored other.
    const startDate = fields.startDate === undefined ? current.startDate : fields.startDate;
    const targetDate = fields.targetDate === undefined ? current.targetDate : fields.targetDate;
    if (startDate && targetDate && startDate > targetDate) {
      throw badRequest("The target date can't be before the start date");
    }

    const patch: Partial<typeof projects.$inferInsert> = { ...fields, updatedAt: new Date() };
    if (fields.status && fields.status !== current.status) {
      patch.completedAt = completedAtFor(fields.status);
    }
    const [project] = await tx.update(projects).set(patch).where(eq(projects.id, projectId)).returning();
    const changes: Change[] = [{ entity: "project", entityId: projectId, action: "upsert", data: project }];

    const existing = await tx.select().from(projectTeams).where(eq(projectTeams.projectId, projectId));
    let finalTeamIds = existing.map((l) => l.teamId);
    if (teamIds) {
      const next = [...new Set(teamIds)];
      await assertTeams(tx, workspaceId, next);
      const removed = existing.filter((l) => !next.includes(l.teamId));
      const added = next.filter((id) => !existing.some((l) => l.teamId === id));
      if (removed.length) {
        // Hard delete the join row (unique constraint) and emit a tombstone.
        await tx.delete(projectTeams).where(
          inArray(
            projectTeams.id,
            removed.map((r) => r.id),
          ),
        );
        changes.push(
          ...removed.map((r) => ({
            entity: "project_team" as const,
            entityId: r.id,
            action: "delete" as const,
          })),
        );
      }
      if (added.length) {
        const rows = await tx
          .insert(projectTeams)
          .values(added.map((teamId) => ({ workspaceId, projectId, teamId })))
          .returning();
        changes.push(
          ...rows.map((r) => ({
            entity: "project_team" as const,
            entityId: r.id,
            action: "upsert" as const,
            data: r,
          })),
        );
      }
      finalTeamIds = next;
    }

    await recordChanges(tx, workspaceId, actorId, changes);
    return serializeProject(project!, finalTeamIds);
  });
}

/**
 * Soft-deletes a project. Its tasks and docs are kept but detached (the
 * foreign key's `set null` only fires on hard deletes), and its team links are
 * removed, each recorded so clients converge.
 */
export async function deleteProject(db: Database, workspaceId: string, actorId: string, projectId: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)),
      )
      .returning({ id: projects.id });
    if (!row) throw notFound("Project");

    const links = await tx.delete(projectTeams).where(eq(projectTeams.projectId, projectId)).returning();
    const detachedTasks = await tx
      .update(tasks)
      .set({ projectId: null })
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .returning();
    const detachedDocs = await tx
      .update(documents)
      .set({ projectId: null })
      .where(and(eq(documents.projectId, projectId), isNull(documents.deletedAt)))
      .returning();

    await recordChanges(tx, workspaceId, actorId, [
      { entity: "project", entityId: projectId, action: "delete" },
      ...links.map((l) => ({ entity: "project_team" as const, entityId: l.id, action: "delete" as const })),
      ...detachedTasks.map((t) => ({
        entity: "task" as const,
        entityId: t.id,
        action: "upsert" as const,
        data: t,
      })),
      ...detachedDocs.map((d) => ({
        entity: "document" as const,
        entityId: d.id,
        action: "upsert" as const,
        data: d,
      })),
    ]);
  });
}
