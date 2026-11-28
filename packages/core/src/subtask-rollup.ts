export interface SubtaskRollup {
  total: number;
  completed: number;
  startDate: string | null;
  dueDate: string | null;
}

/** Counts direct children and the range of their explicit dates. */
export function summarizeSubtasks(
  children: Iterable<{ startDate: string | null; dueDate: string | null; stateId: string }>,
  isCompleted: (stateId: string) => boolean,
): SubtaskRollup {
  const rollup: SubtaskRollup = { total: 0, completed: 0, startDate: null, dueDate: null };
  for (const child of children) {
    rollup.total += 1;
    if (isCompleted(child.stateId)) rollup.completed += 1;
    if (child.startDate && (!rollup.startDate || child.startDate < rollup.startDate)) {
      rollup.startDate = child.startDate;
    }
    if (child.dueDate && (!rollup.dueDate || child.dueDate > rollup.dueDate)) rollup.dueDate = child.dueDate;
  }
  return rollup;
}
