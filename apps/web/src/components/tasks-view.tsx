"use client";

import {
  filterTaskRows,
  taskFilterJsonSchema,
  taskFilterSchema,
  taskViewProperties,
  type Priority,
  type TaskFilterExpression,
  type TaskUpdateInput,
} from "@knotworking/core";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  groupByCategory,
  groupByState,
  groupTasksBy,
  parseTaskGroup,
  planDrop,
  withTaskSubgroups,
  type TaskGroup,
  type TaskOrdering,
} from "@/lib/model";
import { datePatch, fromDay, shiftDates, toDay, weekday } from "@/lib/timeline";
import { useWorkspace } from "@/lib/workspace-store";
import { TaskBoard } from "./task-board";
import type { DropHandler } from "./task-dnd";
import { TaskList } from "./task-list";
import { useNewTask } from "./new-task-dialog";
import { OlderTasksControl, useOlderTasks } from "./older-tasks";
import { FilteredTasksControl, needsFullTaskGraph, useFilteredTasks } from "./filtered-tasks";
import { TaskFilterBar } from "./task-filter-bar";
import type { SavedTaskView } from "@/lib/api";
import { SaveTaskViewDialog } from "./save-task-view-dialog";
import { BulkTaskSelection } from "./bulk-task-controls";
import { TaskCalendar } from "./task-calendar";
import { defaultBoardProperties, parseTaskProperties } from "@/lib/task-view-properties";

/**
 * Tasks for one page, live from the workspace store.
 * `teamId` groups by the team's own workflow states; without it (cross-team
 * views like My tasks) tasks are grouped by state category.
 */
export function TasksView({
  teamId,
  assigneeId,
  projectId,
  view,
  ordering,
  emptyDescription,
  savedView,
}: {
  teamId?: string;
  assigneeId?: string;
  /** Only this project's tasks (grouped by state category). */
  projectId?: string;
  view: "list" | "board" | "calendar";
  ordering: TaskOrdering;
  emptyDescription?: string;
  savedView?: SavedTaskView;
}) {
  const { idx, updateTask } = useWorkspace();
  const params = useSearchParams();
  const rawFilter = params.get("filter");
  const grouping = parseTaskGroup(params.get("group")) ?? savedView?.spec.group ?? "status";
  const rawSubgroup = params.get("subgroup");
  const requestedSubgroup =
    rawSubgroup === "none" ? null : (parseTaskGroup(rawSubgroup) ?? savedView?.spec.subgroup);
  const subgrouping = requestedSubgroup === grouping ? null : requestedSubgroup;
  const rawProperties = params.get("properties");
  const properties = useMemo(
    () => parseTaskProperties(rawProperties) ?? savedView?.spec.properties,
    [rawProperties, savedView?.spec.properties],
  );
  const visibleProperties = useMemo(
    () => new Set(properties ?? (view === "board" ? defaultBoardProperties : taskViewProperties)),
    [properties, view],
  );
  const filter = useMemo(() => {
    if (rawFilter === null) return savedView?.spec.filter ?? undefined;
    const result = taskFilterJsonSchema.safeParse(rawFilter);
    return result.success ? result.data : undefined;
  }, [rawFilter, savedView?.spec.filter]);
  const viewSpec = useMemo(() => {
    const conditions: TaskFilterExpression[] = [];
    if (teamId) conditions.push({ field: "teamId", op: "eq", value: teamId });
    if (projectId) conditions.push({ field: "projectId", op: "eq", value: projectId });
    if (assigneeId) conditions.push({ field: "assigneeId", op: "eq", value: assigneeId });
    if (filter)
      conditions.push(...("and" in filter.expression ? filter.expression.and : [filter.expression]));
    const unique = [
      ...new Map(conditions.map((condition) => [JSON.stringify(condition), condition])).values(),
    ];
    const expression = unique.length === 1 ? unique[0] : { and: unique };
    const checked = taskFilterSchema.safeParse({ version: 1, expression });
    const usable = !unique.length || (checked.success && JSON.stringify(checked.data).length <= 8192);
    return {
      usable,
      spec: {
        filter: checked.success ? checked.data : null,
        layout: view,
        sort: ordering,
        group: grouping,
        ...(subgrouping !== undefined ? { subgroup: subgrouping } : {}),
        ...(properties ? { properties } : {}),
      },
    };
  }, [teamId, projectId, assigneeId, filter, view, ordering, grouping, subgrouping, properties]);
  const history = useOlderTasks({
    teamId,
    projectId,
    assigneeId,
    sort: ordering,
    filter,
  });
  const { tasks } = history;
  const serverFiltered = Boolean(idx.boot.closedWindow) && needsFullTaskGraph(filter);
  const remote = useFilteredTasks({
    filter: serverFiltered ? filter : undefined,
    teamId,
    projectId,
    assigneeId,
    sort: ordering,
  });
  const remoteTasks = serverFiltered ? remote.tasks : undefined;
  const newTask = useNewTask();

  const groups = useMemo(() => {
    const filters: TaskFilterExpression[] = [];
    if (teamId) filters.push({ field: "teamId", op: "eq", value: teamId });
    if (projectId) filters.push({ field: "projectId", op: "eq", value: projectId });
    if (assigneeId) filters.push({ field: "assigneeId", op: "eq", value: assigneeId });
    if (filter) filters.push(filter.expression);
    const shown =
      remoteTasks ??
      (filters.length
        ? filterTaskRows(
            tasks,
            { version: 1, expression: { and: filters } },
            (id) => idx.states.get(id)?.type ?? null,
            [...(idx.boot.taskRelations ?? []), ...(history.relations ?? [])],
          )
        : tasks);
    const groupTasks = (rows: typeof shown, field: typeof grouping) => {
      if (field !== "status") return groupTasksBy(rows, idx, field, ordering, projectId);
      return teamId
        ? groupByState(
            rows,
            idx.boot.workflowStates.filter((s) => s.teamId === teamId),
            idx,
            ordering,
          )
        : groupByCategory(rows, idx, ordering);
    };
    const primary = groupTasks(shown, grouping);
    return view !== "calendar" && subgrouping
      ? withTaskSubgroups(primary, (rows) => groupTasks(rows, subgrouping))
      : primary;
  }, [
    tasks,
    teamId,
    assigneeId,
    projectId,
    idx,
    ordering,
    filter,
    history.relations,
    remoteTasks,
    grouping,
    subgrouping,
    view,
  ]);

  const onDrop = useCallback<DropHandler>(
    (taskId, groupKey, column, index) => {
      const task = column[index];
      if (!task || task.id !== taskId) return;
      const primary = groups.find(
        (group) => group.key === groupKey || group.subgroups?.some((child) => child.key === groupKey),
      );
      if (!primary) return;
      const secondary = primary.subgroups?.find((child) => child.key === groupKey)?.group;
      const patch: TaskUpdateInput = { ...planDrop(column, index, ordering) };
      for (const target of secondary ? [primary, secondary] : [primary]) {
        const group = target.group;
        if (!group) {
          const stateId = idx.states.has(target.key)
            ? target.key
            : idx.boot.workflowStates.find((s) => s.teamId === task.teamId && s.type === target.key)?.id;
          if (!stateId) return;
          if (stateId !== task.stateId) patch.stateId = stateId;
          continue;
        }
        if (group.field === "labelIds" && ([...task.labelIds].sort()[0] ?? null) !== group.value) return;
        if (group.field === "assigneeId" && task.assigneeId !== group.value) patch.assigneeId = group.value;
        if (group.field === "projectId" && task.projectId !== group.value) patch.projectId = group.value;
        if (group.field === "sectionId" && task.sectionId !== group.value) patch.sectionId = group.value;
        if (group.field === "priority") patch.priority = Number(group.value) as Priority;
        if (group.field === "dueWeek") {
          const week = toDay(group.value);
          const due = toDay(task.dueDate);
          if (week === null && due !== null) patch.dueDate = null;
          else if (week !== null && due === null) {
            patch.dueDate = fromDay(week);
            if (task.startDate && task.startDate > patch.dueDate) patch.startDate = patch.dueDate;
          } else if (week !== null && due !== null) {
            Object.assign(patch, datePatch(task, shiftDates(task, "move", week + weekday(due) - due)));
          }
        }
      }
      if (
        patch.sectionId &&
        idx.sections.get(patch.sectionId)?.projectId !==
          (patch.projectId === undefined ? task.projectId : patch.projectId)
      )
        return;
      if (Object.keys(patch).length) void updateTask(taskId, patch);
    },
    [idx, groups, ordering, updateTask],
  );

  const groupDefaults = (g: TaskGroup) => ({
    ...(!g.group ? (idx.states.has(g.key) ? { stateId: g.key } : { stateType: g.type }) : {}),
    ...(g.group?.field === "assigneeId" ? { assigneeId: g.group.value } : {}),
    ...(g.group?.field === "projectId" ? { projectId: g.group.value } : {}),
    ...(g.group?.field === "priority" ? { priority: Number(g.group.value) as Priority } : {}),
    ...(g.group?.field === "sectionId" && g.group.value
      ? { sectionId: g.group.value, projectId: idx.sections.get(g.group.value)?.projectId }
      : {}),
  });
  const onCreate = (primary: TaskGroup, secondary?: TaskGroup) =>
    newTask({
      teamId,
      ...(assigneeId ? { assigneeId } : {}),
      ...(projectId ? { projectId } : {}),
      ...groupDefaults(primary),
      ...(secondary ? groupDefaults(secondary) : {}),
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
      {serverFiltered ? <FilteredTasksControl result={remote} /> : <OlderTasksControl history={history} />}
      {serverFiltered && (remote.loading || remote.error) && !remote.tasks.length ? null : view ===
        "calendar" ? (
        <TaskCalendar tasks={groups.flatMap((group) => group.tasks)} />
      ) : (
        <BulkTaskSelection
          key={JSON.stringify([teamId, projectId, assigneeId, rawFilter, view, grouping, subgrouping])}
          tasks={groups
            .filter((group) => view !== "board" || group.type !== "canceled")
            .flatMap((group) => group.tasks)}
        >
          {view === "board" ? (
            <TaskBoard
              groups={groups}
              properties={visibleProperties}
              onDrop={onDrop}
              onCreate={
                [grouping, subgrouping].some((field) => field === "labelIds" || field === "dueWeek")
                  ? undefined
                  : onCreate
              }
            />
          ) : (
            <TaskList
              groups={groups}
              properties={visibleProperties}
              onDrop={onDrop}
              onCreate={
                [grouping, subgrouping].some((field) => field === "labelIds" || field === "dueWeek")
                  ? undefined
                  : onCreate
              }
              emptyDescription={emptyDescription}
            />
          )}
        </BulkTaskSelection>
      )}
    </>
  );
}
