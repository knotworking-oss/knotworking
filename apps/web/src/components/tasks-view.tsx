"use client";

import type { TaskUpdateInput } from "@knotworking/core";
import { useCallback, useMemo } from "react";
import { groupByCategory, groupByState, planDrop, type TaskGroup, type TaskOrdering } from "@/lib/model";
import { useWorkspace } from "@/lib/workspace-store";
import { TaskBoard } from "./task-board";
import type { DropHandler } from "./task-dnd";
import { TaskList } from "./task-list";
import { useNewTask } from "./new-task-dialog";

/**
 * Tasks for one page, live from the workspace store.
 * `teamId` groups by the team's own workflow states; without it (cross-team
 * views like My tasks) tasks are grouped by state category.
 */
export function TasksView({
  teamId,
  assignedToMe,
  projectId,
  view,
  ordering,
  emptyDescription,
}: {
  teamId?: string;
  assignedToMe?: boolean;
  /** Only this project's tasks (grouped by state category). */
  projectId?: string;
  view: "list" | "board";
  ordering: TaskOrdering;
  emptyDescription?: string;
}) {
  const { idx, tasks, viewer, updateTask } = useWorkspace();
  const newTask = useNewTask();

  const groups = useMemo(() => {
    const shown = tasks.filter(
      (i) =>
        (!teamId || i.teamId === teamId) &&
        (!assignedToMe || i.assigneeId === viewer.id) &&
        (!projectId || i.projectId === projectId),
    );
    return teamId
      ? groupByState(
          shown,
          idx.boot.workflowStates.filter((s) => s.teamId === teamId),
          idx,
          ordering,
        )
      : groupByCategory(shown, idx, ordering);
  }, [tasks, teamId, assignedToMe, projectId, viewer.id, idx, ordering]);

  const onDrop = useCallback<DropHandler>(
    (taskId, groupKey, column, index) => {
      const task = column[index];
      if (!task || task.id !== taskId) return;
      // Group keys are state IDs, or state categories in cross-team views.
      const stateId = idx.states.has(groupKey)
        ? groupKey
        : idx.boot.workflowStates.find((s) => s.teamId === task.teamId && s.type === groupKey)?.id;
      const patch: TaskUpdateInput = { ...planDrop(column, index, ordering) };
      if (stateId && stateId !== task.stateId) patch.stateId = stateId;
      if (Object.keys(patch).length) void updateTask(taskId, patch);
    },
    [idx, ordering, updateTask],
  );

  const onCreate = (g: TaskGroup) =>
    newTask({
      teamId,
      ...(idx.states.has(g.key) ? { stateId: g.key } : { stateType: g.type }),
      ...(assignedToMe ? { assigneeId: viewer.id } : {}),
      ...(projectId ? { projectId } : {}),
    });

  return view === "board" ? (
    <TaskBoard groups={groups} onDrop={onDrop} onCreate={onCreate} />
  ) : (
    <TaskList groups={groups} onDrop={onDrop} onCreate={onCreate} emptyDescription={emptyDescription} />
  );
}
