import type { Bootstrap, TaskSummary } from "./api";

export type TimeEntry = Bootstrap["timeEntries"][number];

export interface TimeTotal {
  /** Finished minutes (running timers count once stopped). */
  logged: number;
  /** Sum of time estimates, in minutes; 0 when nothing is estimated. */
  estimate: number;
}

/** Finished minutes per task, from the store's entries. */
export function loggedByTask(entries: readonly TimeEntry[]) {
  const map = new Map<string, number>();
  for (const e of entries) {
    if (e.minutes !== null) map.set(e.taskId, (map.get(e.taskId) ?? 0) + e.minutes);
  }
  return map;
}

/**
 * Logged and estimated time per project, over the store's (live) tasks, so it follows
 * edits made in this tab. Matches `GET /projects/:id/time`: entries on deleted tasks don't count.
 */
export function projectTime(tasks: readonly TaskSummary[], logged: ReadonlyMap<string, number>) {
  const map = new Map<string, TimeTotal>();
  for (const t of tasks) {
    if (!t.projectId) continue;
    const total = map.get(t.projectId) ?? { logged: 0, estimate: 0 };
    total.logged += logged.get(t.id) ?? 0;
    total.estimate += t.estimateMinutes ?? 0;
    map.set(t.projectId, total);
  }
  return map;
}

/** The user's running timer, if any (at most one per workspace). */
export function runningTimer(entries: readonly TimeEntry[], userId: string) {
  return entries.find((e) => e.userId === userId && e.minutes === null);
}
