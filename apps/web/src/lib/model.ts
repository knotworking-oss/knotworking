import {
  compareSortKeys,
  sortKeyForMove,
  workflowStateTypes,
  type WorkflowStateType,
} from "@knotworking/core";
import type { Bootstrap, TaskRelation, TaskSummary, WorkflowState } from "./api";
import { loggedByTask } from "./time";

/**
 * Normalised lookups over the bootstrap snapshot — the same shape a local
 * sync store (SQLite on desktop/mobile) will expose later.
 */
export function indexWorkspace(boot: Bootstrap) {
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const states = byId(boot.workflowStates);
  const tasks = byId(boot.tasks);
  const relations = indexRelations(boot.taskRelations ?? [], tasks);
  return {
    boot,
    users: byId(boot.users),
    teams: byId(boot.teams),
    teamsByKey: new Map(boot.teams.map((t) => [t.key, t])),
    states,
    labels: byId(boot.labels),
    projects: byId(boot.projects),
    documents: byId(boot.documents ?? []),
    tasks,
    /** Finished minutes logged per task. */
    loggedMinutes: loggedByTask(boot.timeEntries),
    stateProgress: (stateId: string) => stateProgress(boot.workflowStates, states.get(stateId)),
    /** Relations where the task is the blocked one ("blocked by"). */
    blockedBy: (taskId: string) => relations.blockedBy.get(taskId) ?? noRelations,
    /** Relations where the task is the blocking one ("blocks"). */
    blocking: (taskId: string) => relations.blocking.get(taskId) ?? noRelations,
    /** Open (not completed or canceled) tasks that block this one; empty when it isn't blocked. */
    openBlockers: (taskId: string) =>
      (relations.blockedBy.get(taskId) ?? noRelations)
        .map((r) => tasks.get(r.blockingTaskId))
        .filter((t): t is TaskSummary => t !== undefined && isOpen(states.get(t.stateId)?.type)),
  };
}
export type WorkspaceIndex = ReturnType<typeof indexWorkspace>;

const noRelations: TaskRelation[] = [];
const isOpen = (type: WorkflowStateType | undefined) => type !== "completed" && type !== "canceled";

/** Relations by task, skipping any whose tasks this snapshot doesn't have (deleted, archived team). */
function indexRelations(rows: TaskRelation[], tasks: Map<string, TaskSummary>) {
  const blockedBy = new Map<string, TaskRelation[]>();
  const blocking = new Map<string, TaskRelation[]>();
  for (const r of rows) {
    if (!tasks.has(r.blockingTaskId) || !tasks.has(r.blockedTaskId)) continue;
    blockedBy.set(r.blockedTaskId, [...(blockedBy.get(r.blockedTaskId) ?? []), r]);
    blocking.set(r.blockingTaskId, [...(blocking.get(r.blockingTaskId) ?? []), r]);
  }
  return { blockedBy, blocking };
}

/** "Started" states fill progressively (In Progress → In Review). */
function stateProgress(all: WorkflowState[], state: WorkflowState | undefined) {
  if (!state || state.type !== "started") return undefined;
  const started = all.filter((s) => s.teamId === state.teamId && s.type === "started");
  const i = started.findIndex((s) => s.id === state.id);
  return 0.5 + (i / Math.max(1, started.length - 1)) * 0.25;
}

export interface TaskGroup {
  key: string;
  title: string;
  type: WorkflowStateType;
  progress?: number;
  tasks: TaskSummary[];
}

/** Group by workflow state (single team) — keeps team-specific states like "In Review". */
export function groupByState(
  tasks: TaskSummary[],
  states: WorkflowState[],
  idx: WorkspaceIndex,
  ordering: TaskOrdering = "priority",
): TaskGroup[] {
  return states.map((s) => ({
    key: s.id,
    title: s.name,
    type: s.type,
    progress: idx.stateProgress(s.id),
    tasks: orderTasks(
      tasks.filter((i) => i.stateId === s.id),
      ordering,
    ),
  }));
}

const categoryTitles: Record<WorkflowStateType, string> = {
  started: "In Progress",
  unstarted: "Todo",
  backlog: "Backlog",
  completed: "Done",
  canceled: "Canceled",
};

/** Group by state category (across teams with different workflows). */
export function groupByCategory(
  tasks: TaskSummary[],
  idx: WorkspaceIndex,
  ordering: TaskOrdering = "priority",
): TaskGroup[] {
  const order: WorkflowStateType[] = ["started", "unstarted", "backlog", "completed", "canceled"];
  return order
    .filter((t) => workflowStateTypes.includes(t))
    .map((type) => ({
      key: type,
      title: categoryTitles[type],
      type,
      tasks: orderTasks(
        tasks.filter((i) => idx.states.get(i.stateId)?.type === type),
        ordering,
      ),
    }));
}

export const taskOrderings = ["priority", "manual", "created", "updated"] as const;
export type TaskOrdering = (typeof taskOrderings)[number];
export const orderingLabels: Record<TaskOrdering, string> = {
  priority: "Priority",
  manual: "Manual",
  created: "Created",
  updated: "Last updated",
};
export const parseOrdering = (value: string | undefined): TaskOrdering =>
  taskOrderings.find((o) => o === value) ?? "priority";

/** Urgent → low, "no priority" last. */
const priorityRank = (p: number) => (p === 0 ? 5 : p);
const byKey = (a: TaskSummary, b: TaskSummary) =>
  compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id);

export function orderTasks(tasks: TaskSummary[], ordering: TaskOrdering) {
  const sorted = [...tasks];
  switch (ordering) {
    case "manual":
      return sorted.sort(byKey);
    case "created":
      return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byKey(a, b));
    case "updated":
      return sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || byKey(a, b));
    default:
      return sorted.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byKey(a, b));
  }
}

/**
 * What changes when a task is dropped at `index` of `column` (the column's
 * final order, including the moved task). Manual ordering takes a key between
 * the neighbours. Priority ordering adopts the priority of the slot it was
 * dropped into and orders among tasks of that priority. Date orderings can't be
 * rearranged by hand, so only the column (state) changes.
 */
export function planDrop(
  column: TaskSummary[],
  index: number,
  ordering: TaskOrdering,
): { sortOrder?: string; priority?: 0 | 1 | 2 | 3 | 4 } {
  const task = column[index];
  if (!task) return {};
  const above = column[index - 1];
  const below = column[index + 1];
  if (ordering === "manual") {
    const sortOrder = sortKeyForMove(above?.sortOrder, below?.sortOrder);
    return sortOrder === task.sortOrder ? {} : { sortOrder };
  }
  if (ordering === "priority") {
    const priority = (above ?? below)?.priority ?? task.priority;
    const same = (n?: TaskSummary) =>
      n && priorityRank(n.priority) === priorityRank(priority) ? n : undefined;
    const sortOrder = sortKeyForMove(same(above)?.sortOrder, same(below)?.sortOrder);
    return {
      ...(priority !== task.priority ? { priority: priority as 0 | 1 | 2 | 3 | 4 } : {}),
      sortOrder,
    };
  }
  return {};
}
