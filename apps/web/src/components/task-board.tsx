"use client";

import type { Priority } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { BlockedBadge } from "@knotworking/ui/components/blocked-badge";
import { LabelBadge } from "@knotworking/ui/components/label-badge";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { TimeSummary } from "@knotworking/ui/components/time-tracking";
import { cn } from "@knotworking/ui/lib/utils";
import { Plus } from "lucide-react";
import Link from "next/link";
import type { TaskSummary } from "@/lib/api";
import type { TaskGroup } from "@/lib/model";
import { useWorkspace } from "@/lib/workspace-store";
import { TaskDndProvider, TaskDropZone, useSortableTask, type DropHandler } from "./task-dnd";
import { MenuAnchor, TaskKeyboardNav, useTaskRow, type RowMenuProps } from "./task-keyboard";
import { BulkTaskCheckbox, useBulkTaskRow } from "./bulk-task-controls";
import {
  AssigneeChip,
  AssigneePicker,
  LabelsPicker,
  PriorityChip,
  PriorityPicker,
  StatusPicker,
} from "./task-pickers";

/**
 * Kanban columns. Drag cards to reorder or to move them to another state, or use the keyboard
 * (`J`/`K` and the arrow keys to move focus, `S` `P` `A` `L` `X` on the focused card; see `task-keyboard.tsx`).
 */
export function TaskBoard({
  groups,
  onDrop,
  onCreate,
}: {
  groups: TaskGroup[];
  onDrop: DropHandler;
  onCreate?: (group: TaskGroup) => void;
}) {
  const { canEditTasks: canEdit } = useWorkspace();
  const columnsShown = groups.filter((g) => g.type !== "canceled");
  return (
    <TaskDndProvider
      groups={columnsShown}
      onDrop={onDrop}
      renderOverlay={(task) => <CardContent task={task} overlay />}
    >
      {({ columns, dragging }) => (
        <TaskKeyboardNav dragging={dragging} horizontal>
          <div className="flex h-full gap-4 overflow-x-auto p-4">
            {columnsShown.map((g) => {
              const items = columns[g.key] ?? [];
              return (
                <section key={g.key} aria-label={g.title} className="flex w-72 shrink-0 flex-col gap-3">
                  <header className="flex h-7 items-center gap-2 px-1 text-sm">
                    {!g.group && <StatusIcon type={g.type} progress={g.progress} />}
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
                  </header>
                  <TaskDropZone
                    id={g.key}
                    items={items}
                    className="flex min-h-24 flex-1 flex-col gap-2 rounded-xl pb-4 transition-colors data-over:bg-muted/50"
                  >
                    {items.map((task) => (
                      <BoardCard key={task.id} task={task} column={g.key} />
                    ))}
                    {items.length === 0 && (
                      <div className="rounded-xl border border-dashed px-2 py-8 text-center text-sm text-muted-foreground">
                        No tasks
                      </div>
                    )}
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

function BoardCard({ task, column }: { task: TaskSummary; column: string }) {
  const { slug, canEditTasks: canEdit } = useWorkspace();
  const selection = useBulkTaskRow(task.id);
  const { nodeProps, handleProps, isDragging } = useSortableTask(task.id, !canEdit || selection.selecting);
  const { linkRef, menus, rowProps } = useTaskRow(task, column);
  return (
    <div
      {...nodeProps}
      {...rowProps}
      className={cn("group/card relative rounded-xl", isDragging && "opacity-40")}
    >
      <Link
        ref={linkRef}
        href={`/${slug}/task/${task.id}`}
        aria-label={task.title}
        className="peer absolute inset-0 z-0 rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        {...handleProps}
        onClick={selection.onClick}
        {...(selection.selecting ? { onKeyDown: selection.onKeyDown } : {})}
      />
      <CardContent task={task} menus={menus} />
    </div>
  );
}

function CardContent({
  task,
  overlay,
  menus,
}: {
  task: TaskSummary;
  overlay?: boolean;
  /** Keyboard-controlled menu state; absent for the drag overlay. */
  menus?: RowMenuProps;
}) {
  const { idx, canEditTasks: canEdit, updateTask } = useWorkspace();
  const blockers = idx.openBlockers(task.id).length;
  const control = "relative z-10";
  const logged = idx.loggedMinutes.get(task.id) ?? 0;
  return (
    <div
      className={cn(
        "pointer-events-none relative flex flex-col gap-2 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10 transition-shadow group-hover/card:shadow-md",
        canEdit && "[&_button]:pointer-events-auto",
        overlay && "rotate-1 shadow-lg",
      )}
    >
      {menus && (
        // The column is the status, so there is no status chip: `S` opens its menu from the card's corner.
        <StatusPicker
          teamId={task.teamId}
          value={task.stateId}
          onChange={(stateId) => updateTask(task.id, { stateId })}
          {...menus("status")}
        >
          <MenuAnchor className="absolute top-3 left-3" />
        </StatusPicker>
      )}
      <div className="flex items-start justify-between gap-2">
        {!overlay && <BulkTaskCheckbox task={task} />}
        <p className="text-sm leading-snug font-medium">
          {task.reference && (
            <span className="mr-1.5 text-xs font-normal text-muted-foreground">{task.reference}</span>
          )}
          {task.title}
        </p>
        <AssigneePicker
          value={task.assigneeId}
          onChange={(assigneeId) => updateTask(task.id, { assigneeId })}
          align="end"
          {...menus?.("assignee")}
        >
          <AssigneeChip
            userId={task.assigneeId}
            showName={false}
            className={cn(control, "-my-0.5 -mr-1 h-6 shrink-0 px-1")}
            disabled={!canEdit}
          />
        </AssigneePicker>
      </div>
      <div className="relative flex flex-wrap items-center gap-1.5">
        {menus && (
          <LabelsPicker
            value={task.labelIds}
            onChange={(labelIds) => updateTask(task.id, { labelIds })}
            {...menus("labels")}
          >
            <MenuAnchor className="absolute bottom-0 left-0" />
          </LabelsPicker>
        )}
        <PriorityPicker
          value={task.priority as Priority}
          onChange={(priority) => updateTask(task.id, { priority })}
          {...menus?.("priority")}
        >
          <PriorityChip
            priority={task.priority as Priority}
            showName={false}
            className={cn(control, "-ml-1 h-6 px-1")}
            disabled={!canEdit}
          />
        </PriorityPicker>
        {blockers > 0 && <BlockedBadge count={blockers} showLabel />}
        {task.labelIds.map((id) => {
          const l = idx.labels.get(id);
          return l ? (
            <LabelBadge key={id} color={l.color}>
              {l.name}
            </LabelBadge>
          ) : null;
        })}
        {(logged > 0 || task.estimateMinutes != null) && (
          <TimeSummary logged={logged} estimate={task.estimateMinutes} compact className="ml-auto" />
        )}
      </div>
    </div>
  );
}
