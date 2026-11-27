"use client";

import {
  filterTaskRows,
  taskFilterJsonSchema,
  taskFilterSchema,
  type TaskFilterExpression,
  type TaskUpdateInput,
} from "@knotworking/core";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { groupByCategory, groupByState, planDrop, type TaskGroup, type TaskOrdering } from "@/lib/model";
import { useWorkspace } from "@/lib/workspace-store";
import { TaskBoard } from "./task-board";
import type { DropHandler } from "./task-dnd";
import { TaskList } from "./task-list";
import { useNewTask } from "./new-task-dialog";
import { OlderTasksControl, useOlderTasks } from "./older-tasks";
import { TaskFilterBar } from "./task-filter-bar";
import type { SavedTaskView } from "@/lib/api";
import { SaveTaskViewDialog } from "./save-task-view-dialog";
import { BulkTaskSelection } from "./bulk-task-controls";

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
  savedView,
}: {
  teamId?: string;
  assignedToMe?: boolean;
  /** Only this project's tasks (grouped by state category). */
  projectId?: string;
  view: "list" | "board";
  ordering: TaskOrdering;
  emptyDescription?: string;
  savedView?: SavedTaskView;
}) {
  const { idx, viewer, updateTask } = useWorkspace();
  const rawFilter = useSearchParams().get("filter");
  const filter = useMemo(() => {
    if (rawFilter === null) return savedView?.spec.filter ?? undefined;
    const result = taskFilterJsonSchema.safeParse(rawFilter);
    return result.success ? result.data : undefined;
  }, [rawFilter, savedView?.spec.filter]);
  const viewSpec = useMemo(() => {
    const conditions: TaskFilterExpression[] = [];
    if (teamId) conditions.push({ field: "teamId", op: "eq", value: teamId });
    if (projectId) conditions.push({ field: "projectId", op: "eq", value: projectId });
    if (assignedToMe) conditions.push({ field: "assigneeId", op: "eq", value: viewer.id });
    if (filter)
      conditions.push(...("and" in filter.expression ? filter.expression.and : [filter.expression]));
    const unique = [
      ...new Map(conditions.map((condition) => [JSON.stringify(condition), condition])).values(),
    ];
    const expression = unique.length === 1 ? unique[0] : { and: unique };
    const checked = taskFilterSchema.safeParse({ version: 1, expression });
    const usable = !unique.length || (checked.success && JSON.stringify(checked.data).length <= 8192);
    return { usable, spec: { filter: checked.success ? checked.data : null, layout: view, sort: ordering } };
  }, [teamId, projectId, assignedToMe, viewer.id, filter, view, ordering]);
  const history = useOlderTasks({
    teamId,
    projectId,
    assigneeId: assignedToMe ? viewer.id : undefined,
    sort: ordering,
    filter,
  });
  const { tasks } = history;
  const newTask = useNewTask();

  const groups = useMemo(() => {
    const filters: TaskFilterExpression[] = [];
    if (teamId) filters.push({ field: "teamId", op: "eq", value: teamId });
    if (projectId) filters.push({ field: "projectId", op: "eq", value: projectId });
    if (assignedToMe) filters.push({ field: "assigneeId", op: "eq", value: viewer.id });
    if (filter) filters.push(filter.expression);
    const shown = filters.length
      ? filterTaskRows(
          tasks,
          { version: 1, expression: { and: filters } },
          (id) => idx.states.get(id)?.type ?? null,
          [...(idx.boot.taskRelations ?? []), ...(history.relations ?? [])],
        )
      : tasks;
    return teamId
      ? groupByState(
          shown,
          idx.boot.workflowStates.filter((s) => s.teamId === teamId),
          idx,
          ordering,
        )
      : groupByCategory(shown, idx, ordering);
  }, [tasks, teamId, assignedToMe, projectId, viewer.id, idx, ordering, filter, history.relations]);

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

  return (
    <>
      <TaskFilterBar
        filter={filter}
        clearParam={savedView ? "all" : null}
        actions={
          <SaveTaskViewDialog
            initial={savedView}
            teamId={teamId}
            spec={viewSpec.spec}
            disabled={!viewSpec.usable}
          />
        }
      />
      <OlderTasksControl history={history} />
      <BulkTaskSelection
        key={JSON.stringify([teamId, projectId, assignedToMe, rawFilter, view])}
        tasks={groups
          .filter((group) => view !== "board" || group.type !== "canceled")
          .flatMap((group) => group.tasks)}
      >
        {view === "board" ? (
          <TaskBoard groups={groups} onDrop={onDrop} onCreate={onCreate} />
        ) : (
          <TaskList groups={groups} onDrop={onDrop} onCreate={onCreate} emptyDescription={emptyDescription} />
        )}
      </BulkTaskSelection>
    </>
  );
}
