import type { SubtaskRollup } from "@knotworking/core";
import { projects, tasks, teams, workflowStates, type Database } from "@knotworking/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function projectSubtaskRollups(db: Database, workspaceId: string, projectId: string) {
  const parent = alias(tasks, "parent_task");
  const parentTeam = alias(teams, "parent_team");
  const rows = await db
    .select({
      id: parent.id,
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${workflowStates.type} = 'completed')::int`,
      startDate: sql<string | null>`min(${tasks.startDate})::text`,
      dueDate: sql<string | null>`max(${tasks.dueDate})::text`,
    })
    .from(parent)
    .innerJoin(projects, and(eq(projects.id, parent.projectId), isNull(projects.deletedAt)))
    .innerJoin(parentTeam, and(eq(parentTeam.id, parent.teamId), isNull(parentTeam.deletedAt)))
    .innerJoin(
      tasks,
      and(eq(tasks.parentId, parent.id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)),
    )
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
    .where(
      and(eq(parent.workspaceId, workspaceId), eq(parent.projectId, projectId), isNull(parent.deletedAt)),
    )
    .groupBy(parent.id);
  const rollups: Record<string, SubtaskRollup> = Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
  return { rollups };
}
