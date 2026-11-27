"use client";

import type { Priority } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { BlockedBadge } from "@knotworking/ui/components/blocked-badge";
import { LabelBadge } from "@knotworking/ui/components/label-badge";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { TimeSummary } from "@knotworking/ui/components/time-tracking";
import { cn } from "@knotworking/ui/lib/utils";
import { Inbox, Plus } from "lucide-react";
import Link from "next/link";
import type { TaskSummary } from "@/lib/api";
import { formatShortDate, isOverdue } from "@/lib/format";
import type { TaskGroup } from "@/lib/model";
import { useWorkspace } from "@/lib/workspace-store";
import { TaskDndProvider, TaskDropZone, useSortableTask, type DropHandler } from "./task-dnd";
import { MenuAnchor, TaskKeyboardNav, useTaskRow, type RowMenuProps } from "./task-keyboard";
import {
  AssigneeChip,
  AssigneePicker,
  LabelsPicker,
  PriorityChip,
  PriorityPicker,
  StatusChip,
  StatusPicker,
} from "./task-pickers";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";
import { BulkTaskCheckbox, useBulkTaskRow } from "./bulk-task-controls";

/**
 * Dense list grouped by status. Rows can be dragged within and between groups, and navigated from the
 * keyboard (`J`/`K`, `S` `P` `A` `L` `X` on the focused row; see `task-keyboard.tsx`).
 */
export function TaskList({
  groups,
  onDrop,
  onCreate,
  emptyDescription = "Tasks assigned to you or your teams will show up here.",
}: {
  groups: TaskGroup[];
  onDrop: DropHandler;
  onCreate?: (group: TaskGroup) => void;
  emptyDescription?: string;
}) {
  const { canEditTasks: canEdit } = useWorkspace();
  if (groups.every((g) => g.tasks.length === 0)) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyTitle>No tasks</EmptyTitle>
          <EmptyDescription>
            {emptyDescription}
            {canEdit && (
              <>
                {" "}
                Press <kbd className="font-mono">C</kbd> to create one.
              </>
            )}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <TaskDndProvider
      groups={groups}
      onDrop={onDrop}
      renderOverlay={(task) => <RowContent task={task} overlay />}
    >
      {({ columns, dragging }) => (
        <TaskKeyboardNav dragging={dragging}>
          <div className="flex flex-col">
            {groups.map((g) => {
              const items = columns[g.key] ?? [];
              // Empty groups appear while dragging so they can be dropped into.
              if (items.length === 0 && !dragging) return null;
              return (
                <section key={g.key} aria-label={g.title}>
                  <div className="sticky top-0 z-20 flex h-9 items-center gap-2 border-b bg-muted/60 px-4 text-sm backdrop-blur">
                    <StatusIcon type={g.type} progress={g.progress} />
                    <span className="font-medium">{g.title}</span>
                    <span className="text-muted-foreground tabular-nums">{items.length}</span>
                    {canEdit && onCreate && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="ml-auto text-muted-foreground"
                        aria-label={`New task in ${g.title}`}
                        onClick={() => onCreate(g)}
                      >
                        <Plus />
                      </Button>
                    )}
                  </div>
                  <TaskDropZone
                    as="ul"
                    id={g.key}
                    items={items}
                    className="min-h-1 data-over:bg-muted/40 [&:empty]:min-h-10"
                  >
                    {items.map((task) => (
                      <TaskRow key={task.id} task={task} column={g.key} />
                    ))}
                  </TaskDropZone>
                </section>
              );
            })}
          </div>
        </TaskKeyboardNav>
      )}
    </TaskDndProvider>
  );
}

function TaskRow({ task, column }: { task: TaskSummary; column: string }) {
  const { slug, canEditTasks: canEdit } = useWorkspace();
  const selection = useBulkTaskRow(task.id);
  const { nodeProps, handleProps, isDragging } = useSortableTask(task.id, !canEdit || selection.selecting);
  const { linkRef, menus, rowProps } = useTaskRow(task, column);
  return (
    <li {...nodeProps} {...rowProps} className={cn("group/row relative", isDragging && "z-10 opacity-40")}>
      <Link
        ref={linkRef}
        href={`/${slug}/task/${task.id}`}
        aria-label={task.title}
        className="peer absolute inset-0 z-0 focus-visible:outline-none"
        {...handleProps}
        onClick={selection.onClick}
        {...(selection.selecting ? { onKeyDown: selection.onKeyDown } : {})}
      />
      <RowContent task={task} menus={menus} />
    </li>
  );
}

/** Row visuals. Property chips sit above the row link so they open menus instead of the task. */
function RowContent({
  task,
  overlay,
  menus,
}: {
  task: TaskSummary;
  overlay?: boolean;
  /** Keyboard-controlled menu state; absent for the drag overlay. */
  menus?: RowMenuProps;
}) {
  const timeZone = useWorkspaceTimeZone();
  const { idx, canEditTasks: canEdit, updateTask } = useWorkspace();
  const state = idx.states.get(task.stateId);
  const project = task.projectId ? idx.projects.get(task.projectId) : undefined;
  const overdue =
    isOverdue(task.dueDate, new Date(), idx.boot.workspace.timeZone) &&
    state?.type !== "completed" &&
    state?.type !== "canceled";
  const blockers = idx.openBlockers(task.id).length;
  const control = "relative z-10 px-1";
  const logged = idx.loggedMinutes.get(task.id) ?? 0;

  return (
    <div
      className={cn(
        "pointer-events-none flex h-10 items-center gap-2 border-b px-3 text-sm transition-colors group-hover/row:bg-muted/50 peer-focus-visible:bg-muted/50",
        canEdit && "[&_button]:pointer-events-auto",
        overlay && "rounded-md border bg-background shadow-lg",
      )}
    >
      {!overlay && <BulkTaskCheckbox task={task} />}
      <PriorityPicker
        value={task.priority as Priority}
        onChange={(priority) => updateTask(task.id, { priority })}
        {...menus?.("priority")}
      >
        <PriorityChip
          priority={task.priority as Priority}
          showName={false}
          className={control}
          disabled={!canEdit}
        />
      </PriorityPicker>
      <StatusPicker
        teamId={task.teamId}
        value={task.stateId}
        onChange={(stateId) => updateTask(task.id, { stateId })}
        {...menus?.("status")}
      >
        <StatusChip stateId={task.stateId} showName={false} className={control} disabled={!canEdit} />
      </StatusPicker>
      <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
      {blockers > 0 && <BlockedBadge count={blockers} />}
      {menus && (
        <LabelsPicker
          value={task.labelIds}
          onChange={(labelIds) => updateTask(task.id, { labelIds })}
          align="end"
          {...menus("labels")}
        >
          <MenuAnchor />
        </LabelsPicker>
      )}
      <span className="hidden items-center gap-1.5 md:flex">
        {task.labelIds.slice(0, 2).map((id) => {
          const l = idx.labels.get(id);
          return l ? (
            <LabelBadge key={id} color={l.color}>
              {l.name}
            </LabelBadge>
          ) : null;
        })}
        {project && (
          <LabelBadge color={project.color} className="hidden lg:inline-flex">
            {project.name}
          </LabelBadge>
        )}
      </span>
      {(logged > 0 || task.estimateMinutes != null) && (
        <TimeSummary
          logged={logged}
          estimate={task.estimateMinutes}
          compact
          className="hidden shrink-0 sm:inline-flex"
        />
      )}
      {task.dueDate && (
        <span className={cn("text-xs", overdue ? "text-destructive" : "text-muted-foreground")}>
          {formatShortDate(task.dueDate)}
        </span>
      )}
      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
        {formatShortDate(task.createdAt, timeZone)}
      </span>
      <AssigneePicker
        value={task.assigneeId}
        onChange={(assigneeId) => updateTask(task.id, { assigneeId })}
        align="end"
        {...menus?.("assignee")}
      >
        <AssigneeChip userId={task.assigneeId} showName={false} className={control} disabled={!canEdit} />
      </AssigneePicker>
    </div>
  );
}
