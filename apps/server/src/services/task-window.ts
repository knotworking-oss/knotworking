import { olderClosedTaskFilter } from "@knotworking/core";
import { taskLabels, tasks, teams, timeEntries, workflowStates, type Executor } from "@knotworking/db";
import { and, count, eq, isNotNull, isNull, not, sql, sum } from "drizzle-orm";
import { taskFilterSql } from "./task-query";

export const withinTaskWindow = (cutoff: string) =>
  not(taskFilterSql({ version: 1, expression: olderClosedTaskFilter(cutoff) }));

export function recentTaskIds(db: Executor, workspaceId: string, cutoff: string) {
  return db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
    .innerJoin(teams, and(eq(teams.id, tasks.teamId), isNull(teams.deletedAt)))
    .where(and(eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt), withinTaskWindow(cutoff)));
}

/** Full-workspace metrics used by project cards and administrative counts. */
export async function taskWindowSummary(
  db: Executor,
  workspaceId: string,
  cutoff: string,
  includeTime: boolean,
) {
  const visible = and(eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt), isNull(teams.deletedAt));
  const [buckets, labels, times] = await Promise.all([
    db
      .select({
        stateId: tasks.stateId,
        category: workflowStates.type,
        projectId: tasks.projectId,
        count: count(),
        estimate: sum(tasks.estimateMinutes).mapWith(Number),
        older: sql<number>`count(*) filter (where not ${withinTaskWindow(cutoff)})`.mapWith(Number),
      })
      .from(tasks)
      .innerJoin(teams, eq(teams.id, tasks.teamId))
      .innerJoin(workflowStates, eq(workflowStates.id, tasks.stateId))
      .where(visible)
      .groupBy(tasks.stateId, workflowStates.type, tasks.projectId),
    db
      .select({ id: taskLabels.labelId, count: count() })
      .from(taskLabels)
      .innerJoin(tasks, eq(tasks.id, taskLabels.taskId))
      .innerJoin(teams, eq(teams.id, tasks.teamId))
      .where(and(visible, eq(taskLabels.workspaceId, workspaceId), isNull(taskLabels.deletedAt)))
      .groupBy(taskLabels.labelId),
    includeTime
      ? db
          .select({ id: tasks.projectId, logged: sum(timeEntries.minutes).mapWith(Number) })
          .from(timeEntries)
          .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
          .innerJoin(teams, eq(teams.id, tasks.teamId))
          .where(
            and(
              visible,
              eq(timeEntries.workspaceId, workspaceId),
              isNull(timeEntries.deletedAt),
              isNotNull(tasks.projectId),
            ),
          )
          .groupBy(tasks.projectId)
      : [],
  ]);
  const stateCounts: Record<string, number> = {};
  const projectCounts: Record<
    string,
    { open: number; completed: number; canceled: number; started: number; estimate: number; logged: number }
  > = {};
  const logged = new Map(times.map((time) => [time.id, time.logged ?? 0]));
  let olderCount = 0;
  for (const bucket of buckets) {
    olderCount += bucket.older;
    stateCounts[bucket.stateId] = (stateCounts[bucket.stateId] ?? 0) + bucket.count;
    if (!bucket.projectId) continue;
    const project = (projectCounts[bucket.projectId] ??= {
      open: 0,
      completed: 0,
      canceled: 0,
      started: 0,
      estimate: 0,
      logged: logged.get(bucket.projectId) ?? 0,
    });
    if (bucket.category === "completed") project.completed += bucket.count;
    else if (bucket.category === "canceled") project.canceled += bucket.count;
    else project.open += bucket.count;
    if (bucket.category === "started") project.started += bucket.count;
    project.estimate += bucket.estimate ?? 0;
  }
  return {
    cutoff,
    olderCount,
    stateCounts,
    projectCounts,
    labelCounts: Object.fromEntries(labels.map((label) => [label.id, label.count])),
  };
}
