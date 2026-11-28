import {
  compareSortKeys,
  deleteWhere,
  editTable,
  getTable,
  tablesFromRows,
  type SyncEntityType,
  type SyncRow,
  type SyncTable,
  type SyncTables,
} from "@knotworking/core";
import type { Bootstrap, TaskSummary } from "./api";

/**
 * How the bootstrap snapshot maps onto sync-log tables, and back.
 *
 * The store keeps rows exactly as `/sync` carries them, keyed by entity type.
 * Components keep reading a `Bootstrap`-shaped snapshot, projected from those
 * tables. To make a new entity live, add its bootstrap collection here (and a
 * projection if its wire format differs from the raw row).
 */
const collections = {
  teams: "team",
  teamMembers: "team_member",
  workflowStates: "workflow_state",
  labels: "label",
  projects: "project",
  projectTeams: "project_team",
  projectMilestones: "project_milestone",
  projectSections: "project_section",
  tasks: "task",
  taskViews: "task_view",
  taskLabels: "task_label",
  taskRelations: "task_relation",
  documents: "document",
  meetings: "meeting",
  meetingAttendees: "meeting_attendee",
  timeEntries: "time_entry",
} as const satisfies Partial<Record<keyof Bootstrap, SyncEntityType>>;

type Collection = keyof typeof collections;

/**
 * Entities that appear in the snapshot only joined or as a singleton (members
 * are users joined with their role). A change to one refetches the bootstrap
 * instead of being projected.
 */
export const refetchOn: ReadonlySet<string> = new Set<SyncEntityType>([
  "workspace",
  "workspace_modules",
  "user",
  "workspace_member",
  // Someone's module access changed: what the viewer may see can differ, so start from a fresh snapshot.
  "module_access",
]);

export function seedTables(boot: Bootstrap): SyncTables {
  return tablesFromRows(
    Object.fromEntries(
      Object.entries(collections).map(([key, entity]) => [
        entity,
        (boot[key as Collection] ?? []) as unknown as SyncRow[],
      ]),
    ),
  );
}

// ── Projection ──

const byName = (a: SyncRow, b: SyncRow) => String(a.name ?? "").localeCompare(String(b.name ?? ""));
const bySortOrder = (a: SyncRow, b: SyncRow) =>
  compareSortKeys(String(a.sortOrder ?? ""), String(b.sortOrder ?? "")) || compareSortKeys(a.id, b.id);
/** Same order as the API's task list: manual order, then newest first. */
const byTaskOrder = (a: SyncRow, b: SyncRow) =>
  compareSortKeys(String(a.sortOrder ?? ""), String(b.sortOrder ?? "")) ||
  String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));

/** Same order as the API: newest day first, then newest entry. */
const byEntryDate = (a: SyncRow, b: SyncRow) =>
  String(b.entryDate ?? "").localeCompare(String(a.entryDate ?? "")) ||
  String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));

const order: Partial<Record<Collection, (a: SyncRow, b: SyncRow) => number>> = {
  teams: byName,
  labels: byName,
  workflowStates: bySortOrder,
  projects: bySortOrder,
  projectMilestones: bySortOrder,
  projectSections: bySortOrder,
  documents: bySortOrder,
  tasks: byTaskOrder,
  taskViews: byName,
  timeEntries: byEntryDate,
};

/** Fields the bootstrap leaves out of a row (heavy or server-only). */
const omit: Partial<Record<Collection, string[]>> = {
  tasks: ["description", "deletedAt", "workspaceId", "labelIds"],
  documents: ["content", "deletedAt", "workspaceId"],
  timeEntries: ["deletedAt", "workspaceId"],
};

function strip(row: SyncRow, fields: string[] | undefined): SyncRow {
  if (!fields?.some((f) => f in row)) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const f of fields) delete copy[f];
  return copy as SyncRow;
}

/** Projections are cached per table, so untouched collections keep their identity. */
const listCache = new WeakMap<SyncTable, SyncRow[]>();
function list(table: SyncTable, key: Collection) {
  let rows = listCache.get(table);
  if (!rows) {
    rows = [...table.values()].map((r) => strip(r, omit[key]));
    const compare = order[key];
    if (compare) rows.sort(compare);
    listCache.set(table, rows);
  }
  return rows;
}

const taskCache = new WeakMap<SyncTable, WeakMap<SyncTable, TaskSummary[]>>();
function tasks(tables: SyncTables): TaskSummary[] {
  const taskTable = getTable(tables, "task");
  const linkTable = getTable(tables, "task_label");
  let inner = taskCache.get(taskTable);
  if (!inner) taskCache.set(taskTable, (inner = new WeakMap()));
  let result = inner.get(linkTable);
  if (!result) {
    const labelIds = new Map<string, string[]>();
    for (const link of linkTable.values()) {
      const taskId = String(link.taskId);
      labelIds.set(taskId, [...(labelIds.get(taskId) ?? []), String(link.labelId)]);
    }
    result = list(taskTable, "tasks").map(
      (t) => ({ ...t, labelIds: labelIds.get(t.id) ?? [] }) as unknown as TaskSummary,
    );
    inner.set(linkTable, result);
  }
  return result;
}

/** The snapshot components read: `base` (users, workspace) plus every synced collection. */
export function projectBootstrap(tables: SyncTables, base: Bootstrap, cursor: string): Bootstrap {
  const out: Record<string, unknown> = { ...base, cursor };
  for (const [key, entity] of Object.entries(collections) as [Collection, string][]) {
    out[key] = key === "tasks" ? tasks(tables) : list(getTable(tables, entity), key);
  }
  if (base.closedWindow) {
    const states = getTable(tables, "workflow_state");
    const cutoff = base.closedWindow.cutoff;
    out.tasks = (out.tasks as TaskSummary[]).filter((task) => {
      const type = states.get(task.stateId)?.type;
      return (type !== "completed" && type !== "canceled") || task.updatedAt >= cutoff;
    });
  }
  return out as Bootstrap;
}

// ── Optimistic edits on tables ──

/** Replaces a task's label links (optimistic rows get synthetic IDs until the server's arrive). */
export function setTaskLabels(tables: SyncTables, taskId: string, labelIds: readonly string[]) {
  const cleared = deleteWhere(tables, "task_label", (l) => l.taskId === taskId);
  return editTable(cleared, "task_label", (rows) => {
    for (const labelId of new Set(labelIds))
      rows.set(`optimistic:${taskId}:${labelId}`, { id: `optimistic:${taskId}:${labelId}`, taskId, labelId });
  });
}

/** Removes every dependency that involves `taskId` (the API does the same when a task is deleted). */
export function removeTaskRelationsOf(tables: SyncTables, taskId: string) {
  return deleteWhere(
    tables,
    "task_relation",
    (r) => r.blockingTaskId === taskId || r.blockedTaskId === taskId,
  );
}

/** Replaces a project's team links (optimistic rows get synthetic IDs until the server's arrive). */
export function setProjectTeams(tables: SyncTables, projectId: string, teamIds: readonly string[]) {
  const cleared = deleteWhere(tables, "project_team", (l) => l.projectId === projectId);
  return editTable(cleared, "project_team", (rows) => {
    for (const teamId of new Set(teamIds)) {
      const id = `optimistic:${projectId}:${teamId}`;
      rows.set(id, { id, projectId, teamId });
    }
  });
}

/** Deleting a project detaches its tasks and docs (the API does the same, in the sync log). */
export function detachProject(tables: SyncTables, projectId: string) {
  let next = deleteWhere(tables, "project_milestone", (row) => row.projectId === projectId);
  next = deleteWhere(next, "project_section", (row) => row.projectId === projectId);
  for (const entity of ["task", "document"]) {
    const table = getTable(next, entity);
    if (![...table.values()].some((r) => r.projectId === projectId)) continue;
    next = editTable(next, entity, (rows) => {
      for (const [id, row] of rows)
        if (row.projectId === projectId)
          rows.set(id, {
            ...row,
            projectId: null,
            ...(entity === "task" ? { milestoneId: null, sectionId: null } : {}),
          });
    });
  }
  return next;
}
