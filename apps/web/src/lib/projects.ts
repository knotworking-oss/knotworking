import type { TaskSummary } from "./api";
import type { WorkspaceIndex } from "./model";

export interface ProjectProgress {
  total: number;
  completed: number;
  started: number;
  ratio: number;
}

export const noProgress: ProjectProgress = { total: 0, completed: 0, started: 0, ratio: 0 };

/**
 * Task progress per project, from the store's tasks so it follows edits made in
 * this tab. Matches the API: canceled tasks don't count towards the total.
 */
export function projectProgress(tasks: TaskSummary[], idx: WorkspaceIndex) {
  const map = new Map<string, ProjectProgress>();
  for (const t of tasks) {
    if (!t.projectId) continue;
    const type = idx.states.get(t.stateId)?.type;
    if (type === "canceled") continue;
    const p = map.get(t.projectId) ?? { ...noProgress };
    p.total++;
    if (type === "completed") p.completed++;
    if (type === "started") p.started++;
    p.ratio = p.completed / p.total;
    map.set(t.projectId, p);
  }
  return map;
}
