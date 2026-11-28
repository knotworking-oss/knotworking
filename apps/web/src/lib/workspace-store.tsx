"use client";

import { shouldRefreshModulePage } from "./module-invalidation";

import {
  deleteRow,
  deleteWhere,
  hasModuleLevel,
  effectiveTimeZone,
  todayInZone,
  newId,
  patchRow,
  sortKeyBetween,
  timerMinutes,
  upsertRow,
  wouldCreateBlockingCycle,
  type ModuleAccessLevel,
  type ModuleId,
  type Overlay,
  type ProjectCreateInput,
  type ProjectUpdateInput,
  type SyncRow,
  type SyncTables,
  type TaskCreateInput,
  type TaskUpdateInput,
  type TimeEntryCreateInput,
  type TimeEntryUpdateInput,
  type WorkspaceRole,
  type DocumentUpdateInput,
} from "@knotworking/core";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { Bootstrap, TaskSummary } from "./api";
import { browserApi, errorMessage, unwrap } from "./auth-client";
import { indexWorkspace, type WorkspaceIndex } from "./model";
import { detachProject, removeTaskRelationsOf, setProjectTeams, setTaskLabels } from "./sync-model";
import { runningTimer as findRunningTimer, type TimeEntry } from "./time";
import { WorkspaceSync } from "./workspace-sync";

export type ProjectRow = Bootstrap["projects"][number];

/** The attachment fields of a doc edit. */
export type DocAttachment = Pick<DocumentUpdateInput, "teamId" | "projectId">;

/** Fields a task edit can change; descriptions are edited on the task page only. */
export type TaskPatch = Omit<TaskUpdateInput, "description">;

interface WorkspaceStore {
  slug: string;
  viewer: { id: string; role: WorkspaceRole };
  /** Guests are read-only. Role only: for edit controls use the per-module flags below. */
  canEdit: boolean;
  /** Whether the viewer may write in a module (`can(id, "write")`): what edit controls should check. */
  canEditTasks: boolean;
  canEditDocs: boolean;
  canEditTime: boolean;
  /** The active modules with the viewer's level in each. */
  modules: Bootstrap["modules"];
  /**
   * Whether the viewer has `level` (default `read`) in a module. False for modules that are
   * switched off in this environment. Use it to hide navigation and actions; the API enforces it.
   */
  can: (moduleId: ModuleId, level?: ModuleAccessLevel) => boolean;
  /** The live workspace: server state from the sync log plus this tab's pending edits. */
  idx: WorkspaceIndex;
  tasks: TaskSummary[];
  updateTask: (id: string, patch: TaskPatch) => Promise<boolean>;
  createTask: (input: TaskCreateInput) => Promise<TaskSummary | null>;
  deleteTask: (id: string) => Promise<boolean>;
  /**
   * Optimistic: `blockingTaskId` blocks `blockedTaskId`. Refused locally (with a toast) when it
   * would create a circular dependency; the API checks again.
   */
  createTaskRelation: (blockingTaskId: string, blockedTaskId: string) => Promise<boolean>;
  deleteTaskRelation: (id: string) => Promise<boolean>;
  /** Optimistic: the project shows up immediately and is removed again if the API refuses it. */
  createProject: (input: ProjectCreateInput) => Promise<boolean>;
  updateProject: (id: string, patch: ProjectUpdateInput) => Promise<boolean>;
  /** Tasks and docs of a deleted project stay, without a project. */
  deleteProject: (id: string) => Promise<boolean>;
  /** Live time entries (finished and running), newest day first. */
  timeEntries: TimeEntry[];
  /** The viewer's running timer, if any. */
  runningTimer: TimeEntry | undefined;
  /** Logs finished time on a task (for someone else: owners and admins only). */
  logTime: (taskId: string, input: Omit<TimeEntryCreateInput, "id">) => Promise<boolean>;
  updateTimeEntry: (id: string, patch: TimeEntryUpdateInput) => Promise<boolean>;
  deleteTimeEntry: (id: string) => Promise<boolean>;
  /** Starts the viewer's timer on a task, stopping the one already running. */
  startTimer: (taskId: string) => Promise<boolean>;
  stopTimer: () => Promise<boolean>;
  /**
   * Attaches a doc to a team and/or project, or detaches it (`null`); a side left out is unchanged.
   * Optimistic, rolled back with a toast if the API refuses it.
   */
  attachDocument: (id: string, attachment: DocAttachment) => Promise<boolean>;
  /**
   * The underlying sync store, for features beyond tasks: read any entity's
   * rows (`sync.store.getSnapshot()`) or run optimistic writes with
   * `sync.store.mutate(...)`.
   */
  sync: WorkspaceSync;
}

const Ctx = createContext<WorkspaceStore | null>(null);

export function useWorkspace() {
  const store = useContext(Ctx);
  if (!store) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return store;
}

/** Like `useWorkspace`, but `null` outside a provider (e.g. read-only renderers on the design page). */
export function useOptionalWorkspace() {
  return useContext(Ctx);
}

/** Task rows as the server returns them → sync-log row (labels live in `task_label`). */
function taskOverlay(task: TaskSummary & { description?: unknown }): Overlay {
  const { labelIds, ...row } = task;
  return (t) => setTaskLabels(upsertRow(t, "task", row as unknown as SyncRow), task.id, labelIds);
}

/** Project rows as the API returns them (`teamIds` stands in for `project_team` rows). */
function projectOverlay(project: { id: string; teamIds: string[] } & Record<string, unknown>): Overlay {
  const { teamIds, ...row } = project;
  return (t) => setProjectTeams(upsertRow(t, "project", row as unknown as SyncRow), project.id, teamIds);
}

/** Stops every running timer of `userId` in the tables, as the server does before starting another. */
function stopTimers(tables: SyncTables, userId: string, now: Date): SyncTables {
  let next = tables;
  for (const row of tables.time_entry?.values() ?? []) {
    if (row.userId === userId && row.minutes === null) {
      next = patchRow(next, "time_entry", row.id, {
        minutes: timerMinutes(String(row.startedAt ?? row.createdAt), now),
        updatedAt: now.toISOString(),
      });
    }
  }
  return next;
}

/**
 * Client-side sync store for the workspace (see docs/architecture.md, "Sync
 * protocol"). Seeded from the server-rendered bootstrap, caught up with
 * `/sync`, pushed to by `/events`, and written to with optimistic mutations that
 * roll back on failure. Components only see `tasks`, `idx` and the mutation
 * functions.
 */
export function WorkspaceProvider({
  boot,
  slug,
  viewer,
  children,
}: {
  boot: Bootstrap;
  slug: string;
  viewer: { id: string; role: WorkspaceRole };
  children: ReactNode;
}) {
  const router = useRouter();
  const [sync] = useState(() => new WorkspaceSync(slug, boot, () => router.refresh()));

  // A newer server-rendered snapshot (navigation, refresh) replaces ours; an older one is ignored.
  useEffect(() => sync.adopt(boot), [sync, boot]);
  useEffect(() => sync.connect(), [sync]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = sync.onChanges((changes) => {
      if (!shouldRefreshModulePage(window.location.pathname, changes)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        router.refresh();
      }, 200);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [sync, router]);

  const live = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
  const tasks = live.tasks;
  const modules = live.modules;
  const can = useCallback(
    (moduleId: ModuleId, level: ModuleAccessLevel = "read") =>
      hasModuleLevel(modules.find((m) => m.id === moduleId)?.access, level),
    [modules],
  );
  const idx = useMemo(() => indexWorkspace(live), [live]);
  /** Dates for new time entries are the workspace's calendar day, not the browser's. */
  const timeZone = effectiveTimeZone(idx.boot.workspace.timeZone).timeZone;

  /** Runs an optimistic write; failures roll back (in the store) and show a toast. */
  const write = useCallback(
    async <T,>(options: Parameters<typeof sync.store.mutate<T>>[0]): Promise<T | null> => {
      try {
        return await sync.store.mutate(options);
      } catch (err) {
        toast.error(errorMessage(err));
        return null;
      }
    },
    [sync],
  );

  const updateTask = useCallback(
    async (id: string, patch: TaskPatch) => {
      const { labelIds, ...fields } = patch;
      const updatedAt = new Date().toISOString();
      const result = await write({
        apply: (t) => {
          const next = patchRow(t, "task", id, { ...fields, updatedAt });
          return labelIds && next !== t ? setTaskLabels(next, id, labelIds) : next;
        },
        send: () =>
          unwrap(
            browserApi().v1.workspaces[":slug"].tasks[":id"].$patch({ param: { slug, id }, json: patch }),
          ),
      });
      return result !== null;
    },
    [write, slug],
  );

  const createTask = useCallback(
    async (input: TaskCreateInput) => {
      // Shown once the server has filled in defaults (state, order); kept until the sync log has it.
      const created = await write({
        apply: (t) => t,
        send: () => unwrap(browserApi().v1.workspaces[":slug"].tasks.$post({ param: { slug }, json: input })),
        confirmed: taskOverlay,
      });
      if (!created) return null;
      const { description: _description, ...summary } = created;
      return summary as TaskSummary;
    },
    [write, slug],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      const result = await write({
        apply: (t) => removeTaskRelationsOf(deleteRow(t, "task", id), id),
        send: async () => {
          const res = await browserApi().v1.workspaces[":slug"].tasks[":id"].$delete({
            param: { slug, id },
          });
          if (!res.ok) await unwrap(Promise.resolve(res));
          return true;
        },
      });
      return result !== null;
    },
    [write, slug],
  );

  const createTaskRelation = useCallback(
    async (blockingTaskId: string, blockedTaskId: string) => {
      const existing = idx.boot.taskRelations ?? [];
      if (existing.some((r) => r.blockingTaskId === blockingTaskId && r.blockedTaskId === blockedTaskId)) {
        return true;
      }
      if (wouldCreateBlockingCycle(existing, blockingTaskId, blockedTaskId)) {
        toast.error("That would create a circular dependency.");
        return false;
      }
      const id = newId();
      const now = new Date().toISOString();
      const row = { id, blockingTaskId, blockedTaskId, creatorId: viewer.id, createdAt: now, updatedAt: now };
      const result = await write({
        apply: (t) => upsertRow(t, "task_relation", row as unknown as SyncRow),
        send: () =>
          unwrap(
            browserApi().v1.workspaces[":slug"]["task-relations"].$post({
              param: { slug },
              json: { id, blockingTaskId, blockedTaskId },
            }),
          ),
        confirmed: (created) => (t) => upsertRow(t, "task_relation", created as unknown as SyncRow),
      });
      return result !== null;
    },
    [write, slug, idx, viewer.id],
  );

  const deleteTaskRelation = useCallback(
    async (id: string) => {
      const result = await write({
        apply: (t) => deleteRow(t, "task_relation", id),
        send: async () => {
          const res = await browserApi().v1.workspaces[":slug"]["task-relations"][":id"].$delete({
            param: { slug, id },
          });
          if (!res.ok) await unwrap(Promise.resolve(res));
          return true;
        },
      });
      return result !== null;
    },
    [write, slug],
  );

  const createProject = useCallback(
    async (input: ProjectCreateInput) => {
      const id = input.id ?? newId();
      const now = new Date().toISOString();
      const { teamIds = [], ...fields } = input;
      const last = idx.boot.projects.reduce<string | null>(
        (m, p) => (m === null || p.sortOrder > m ? p.sortOrder : m),
        null,
      );
      const optimistic = {
        id,
        workspaceId: idx.boot.workspace.id,
        name: fields.name,
        description: fields.description ?? null,
        icon: fields.icon ?? null,
        color: fields.color ?? "purple",
        status: fields.status ?? "planned",
        health: fields.health ?? null,
        leadId: fields.leadId ?? null,
        startDate: fields.startDate ?? null,
        targetDate: fields.targetDate ?? null,
        sortOrder: sortKeyBetween(last, null),
        completedAt: fields.status === "completed" ? now : null,
        lastUpdateAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        teamIds: [...new Set(teamIds)],
      };
      const created = await write({
        apply: projectOverlay(optimistic),
        send: () =>
          unwrap(
            browserApi().v1.workspaces[":slug"].projects.$post({ param: { slug }, json: { ...input, id } }),
          ),
        confirmed: projectOverlay,
      });
      return created !== null;
    },
    [write, slug, idx],
  );

  const updateProject = useCallback(
    async (id: string, patch: ProjectUpdateInput) => {
      const { teamIds, ...fields } = patch;
      const now = new Date().toISOString();
      const result = await write({
        apply: (t) => {
          const next = patchRow(t, "project", id, {
            ...fields,
            ...(fields.status ? { completedAt: fields.status === "completed" ? now : null } : {}),
            updatedAt: now,
          });
          return teamIds && next !== t ? setProjectTeams(next, id, teamIds) : next;
        },
        send: () =>
          unwrap(
            browserApi().v1.workspaces[":slug"].projects[":id"].$patch({
              param: { slug, id },
              json: patch,
            }),
          ),
      });
      return result !== null;
    },
    [write, slug],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      const result = await write({
        apply: (t) =>
          detachProject(
            deleteWhere(deleteRow(t, "project", id), "project_team", (l) => l.projectId === id),
            id,
          ),
        send: async () => {
          const res = await browserApi().v1.workspaces[":slug"].projects[":id"].$delete({
            param: { slug, id },
          });
          if (!res.ok) await unwrap(Promise.resolve(res));
          return true;
        },
      });
      return result !== null;
    },
    [write, slug],
  );

  const attachDocument = useCallback(
    async (id: string, attachment: DocAttachment) => {
      const patch: DocAttachment = {
        ...(attachment.teamId !== undefined ? { teamId: attachment.teamId } : {}),
        ...(attachment.projectId !== undefined ? { projectId: attachment.projectId } : {}),
      };
      const updatedAt = new Date().toISOString();
      const result = await write({
        apply: (t) => patchRow(t, "document", id, { ...patch, updatedAt }),
        send: () =>
          unwrap(
            browserApi().v1.workspaces[":slug"].documents[":id"].$patch({
              param: { slug, id },
              json: patch,
            }),
          ),
      });
      return result !== null;
    },
    [write, slug],
  );

  // ── Time tracking ──

  const timeEntries = live.timeEntries;
  const runningTimer = useMemo(() => findRunningTimer(timeEntries, viewer.id), [timeEntries, viewer.id]);
  const timeApi = useCallback(() => browserApi().v1.workspaces[":slug"], []);

  const logTime = useCallback(
    async (taskId: string, input: Omit<TimeEntryCreateInput, "id">) => {
      const id = newId();
      const now = new Date().toISOString();
      const row = {
        id,
        taskId,
        userId: input.userId ?? viewer.id,
        minutes: input.minutes,
        note: input.note || null,
        entryDate: input.entryDate ?? todayInZone(timeZone),
        startedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const result = await write({
        apply: (t) => upsertRow(t, "time_entry", row),
        send: () =>
          unwrap(
            timeApi().tasks[":id"]["time-entries"].$post({
              param: { slug, id: taskId },
              json: { ...input, id, entryDate: row.entryDate },
            }),
          ),
        confirmed: (entry) => (t) => upsertRow(t, "time_entry", entry as unknown as SyncRow),
      });
      return result !== null;
    },
    [write, slug, viewer.id, timeApi, timeZone],
  );

  const updateTimeEntry = useCallback(
    async (id: string, patch: TimeEntryUpdateInput) => {
      const result = await write({
        apply: (t) =>
          patchRow(t, "time_entry", id, {
            ...patch,
            ...("note" in patch ? { note: patch.note || null } : {}),
            updatedAt: new Date().toISOString(),
          }),
        send: () => unwrap(timeApi()["time-entries"][":id"].$patch({ param: { slug, id }, json: patch })),
      });
      return result !== null;
    },
    [write, slug, timeApi],
  );

  const deleteTimeEntry = useCallback(
    async (id: string) => {
      const result = await write({
        apply: (t) => deleteRow(t, "time_entry", id),
        send: async () => {
          const res = await timeApi()["time-entries"][":id"].$delete({ param: { slug, id } });
          if (!res.ok) await unwrap(Promise.resolve(res));
          return true;
        },
      });
      return result !== null;
    },
    [write, slug, timeApi],
  );

  const startTimer = useCallback(
    async (taskId: string) => {
      const id = newId();
      const now = new Date();
      const row = {
        id,
        taskId,
        userId: viewer.id,
        minutes: null,
        note: null,
        entryDate: todayInZone(timeZone, now),
        startedAt: now.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const result = await write({
        apply: (t) => upsertRow(stopTimers(t, viewer.id, now), "time_entry", row),
        send: () =>
          unwrap(
            timeApi().tasks[":id"].timer.$post({
              param: { slug, id: taskId },
              json: { id, entryDate: row.entryDate },
            }),
          ),
        confirmed:
          ({ entry, stopped }) =>
          (t) => {
            const next = upsertRow(t, "time_entry", entry as unknown as SyncRow);
            return stopped ? upsertRow(next, "time_entry", stopped as unknown as SyncRow) : next;
          },
      });
      return result !== null;
    },
    [write, slug, viewer.id, timeApi, timeZone],
  );

  const stopTimer = useCallback(async () => {
    const result = await write({
      apply: (t) => stopTimers(t, viewer.id, new Date()),
      send: () => unwrap(timeApi().timer.stop.$post({ param: { slug } })),
      confirmed: (entry) => (t) => upsertRow(t, "time_entry", entry as unknown as SyncRow),
    });
    return result !== null;
  }, [write, slug, viewer.id, timeApi]);

  const value = useMemo<WorkspaceStore>(
    () => ({
      slug,
      viewer,
      canEdit: viewer.role !== "guest",
      // The API caps guests at read; the role check keeps that true for any snapshot.
      canEditTasks: viewer.role !== "guest" && can("tasks", "write"),
      canEditDocs: viewer.role !== "guest" && can("docs", "write"),
      canEditTime: viewer.role !== "guest" && can("time", "write"),
      modules,
      can,
      idx,
      tasks,
      updateTask,
      createTask,
      deleteTask,
      createTaskRelation,
      deleteTaskRelation,
      createProject,
      updateProject,
      deleteProject,
      attachDocument,
      timeEntries,
      runningTimer,
      logTime,
      updateTimeEntry,
      deleteTimeEntry,
      startTimer,
      stopTimer,
      sync,
    }),
    [
      slug,
      viewer,
      can,
      modules,
      idx,
      tasks,
      updateTask,
      createTask,
      deleteTask,
      createTaskRelation,
      deleteTaskRelation,
      createProject,
      updateProject,
      deleteProject,
      attachDocument,
      timeEntries,
      runningTimer,
      logTime,
      updateTimeEntry,
      deleteTimeEntry,
      startTimer,
      stopTimer,
      sync,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
