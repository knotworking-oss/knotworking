"use client";

import { wouldCreateBlockingCycle, type Priority } from "@knotworking/core";
import { BlockedBadge } from "@knotworking/ui/components/blocked-badge";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { Kbd } from "@knotworking/ui/components/kbd";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@knotworking/ui/components/tooltip";
import { cn } from "@knotworking/ui/lib/utils";
import { Copy, Link2, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { TaskRelation, TaskSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { isOverdue } from "@/lib/format";
import { isOverlayOpen, isTypingTarget } from "@/lib/keyboard";
import { orderTasks } from "@/lib/model";
import { useWorkspace } from "@/lib/workspace-store";
import {
  AssigneeChip,
  AssigneePicker,
  DueDateChip,
  DueDatePicker,
  LabelsChip,
  LabelsPicker,
  PriorityChip,
  PriorityPicker,
  ProjectChip,
  ProjectPicker,
  StartDateChip,
  StartDatePicker,
  StatusChip,
  StatusPicker,
  TaskPicker,
} from "./task-pickers";
import { useNewTask } from "./new-task-dialog";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";

/** The live task from the store (falls back to the server's copy). */
function useTask(initial: TaskSummary) {
  const { tasks } = useWorkspace();
  return tasks.find((i) => i.id === initial.id) ?? initial;
}

export function TaskTitle({ initial }: { initial: TaskSummary }) {
  const task = useTask(initial);
  const { canEditTasks: canEdit, updateTask } = useWorkspace();
  const [value, setValue] = useState(task.title);
  useEffect(() => setValue(task.title), [task.title]);

  if (!canEdit) return <h1 className="text-3xl font-semibold tracking-tight">{task.title}</h1>;

  const save = () => {
    const title = value.trim();
    if (!title) return setValue(task.title);
    if (title !== task.title) void updateTask(task.id, { title });
  };
  return (
    <h1 className="text-3xl font-semibold tracking-tight">
      <textarea
        aria-label="Task title"
        value={value}
        rows={1}
        maxLength={512}
        onChange={(e) => setValue(e.target.value.replace(/\n/g, ""))}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setValue(task.title);
            requestAnimationFrame(() => (e.target as HTMLTextAreaElement).blur());
          }
        }}
        className="field-sizing-content w-full resize-none rounded-md bg-transparent outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      />
    </h1>
  );
}

type MenuKey = "status" | "priority" | "assignee" | "labels" | "project" | "startDate" | "dueDate";
const shortcuts: Record<string, MenuKey> = { s: "status", p: "priority", a: "assignee", l: "labels" };

/** Property sidebar. `S`, `P`, `A` and `L` open the status, priority, assignee and label menus. */
export function TaskProperties({ initial, stacked = false }: { initial: TaskSummary; stacked?: boolean }) {
  const task = useTask(initial);
  const { idx, canEditTasks: canEdit, updateTask } = useWorkspace();
  const [open, setOpen] = useState<MenuKey | null>(null);
  const state = idx.states.get(task.stateId);
  const overdue =
    isOverdue(task.dueDate, new Date(), idx.boot.workspace.timeZone) &&
    state?.type !== "completed" &&
    state?.type !== "canceled";

  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      const menu = shortcuts[e.key];
      if (!menu || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (isOverlayOpen()) return;
      // The page renders two copies: the sidebar (from `lg`) and a stacked one below it. Only the visible copy answers.
      if (window.matchMedia("(min-width: 1024px)").matches === stacked) return;
      e.preventDefault();
      setOpen(menu);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canEdit, stacked]);

  const menu = (key: MenuKey) => ({
    open: open === key,
    onOpenChange: (o: boolean) => setOpen(o ? key : null),
  });
  const chip = { className: "-ml-1.5 w-full justify-start", disabled: !canEdit };

  return (
    <>
      <Property label="Status" shortcut={stacked ? undefined : "S"}>
        <StatusPicker
          teamId={task.teamId}
          value={task.stateId}
          onChange={(stateId) => updateTask(task.id, { stateId })}
          {...menu("status")}
        >
          <StatusChip stateId={task.stateId} {...chip} />
        </StatusPicker>
      </Property>
      <Property label="Priority" shortcut={stacked ? undefined : "P"}>
        <PriorityPicker
          value={task.priority as Priority}
          onChange={(priority) => updateTask(task.id, { priority })}
          {...menu("priority")}
        >
          <PriorityChip priority={task.priority as Priority} {...chip} />
        </PriorityPicker>
      </Property>
      <Property label="Assignee" shortcut={stacked ? undefined : "A"}>
        <AssigneePicker
          value={task.assigneeId}
          onChange={(assigneeId) => updateTask(task.id, { assigneeId })}
          {...menu("assignee")}
        >
          <AssigneeChip userId={task.assigneeId} {...chip} />
        </AssigneePicker>
      </Property>
      <Property label="Labels" shortcut={stacked ? undefined : "L"}>
        <LabelsPicker
          value={task.labelIds}
          onChange={(labelIds) => updateTask(task.id, { labelIds })}
          {...menu("labels")}
        >
          <LabelsChip labelIds={task.labelIds} {...chip} />
        </LabelsPicker>
      </Property>
      <Property label="Project">
        <ProjectPicker
          value={task.projectId}
          onChange={(projectId) => updateTask(task.id, { projectId })}
          {...menu("project")}
        >
          <ProjectChip projectId={task.projectId} {...chip} />
        </ProjectPicker>
      </Property>
      <Property label="Start date">
        <StartDatePicker
          value={task.startDate}
          max={task.dueDate}
          onChange={(startDate) => updateTask(task.id, { startDate })}
          {...menu("startDate")}
        >
          <StartDateChip startDate={task.startDate} {...chip} />
        </StartDatePicker>
      </Property>
      <Property label="Due date">
        <DueDatePicker
          value={task.dueDate}
          min={task.startDate}
          onChange={(dueDate) => updateTask(task.id, { dueDate })}
          {...menu("dueDate")}
        >
          <DueDateChip dueDate={task.dueDate} overdue={overdue} {...chip} />
        </DueDatePicker>
      </Property>
    </>
  );
}

function Property({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <div className="group/property flex min-h-9 items-center gap-2 text-sm">
      <span className="flex w-20 shrink-0 items-center gap-1 text-muted-foreground">
        {label}
        {shortcut && (
          <Kbd className="opacity-0 transition-opacity group-hover/property:opacity-100">{shortcut}</Kbd>
        )}
      </span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

/** Subtasks, live from the store, with a shortcut to add one. */
export function Subtasks({
  initial,
  initialChildren = [],
}: {
  initial: TaskSummary;
  initialChildren?: TaskSummary[];
}) {
  const task = useTask(initial);
  const { idx, tasks, slug, canEditTasks: canEdit } = useWorkspace();
  const newTask = useNewTask();
  const byId = new Map(initialChildren.map((child) => [child.id, idx.tasks.get(child.id) ?? child]));
  for (const child of tasks) if (child.parentId === task.id) byId.set(child.id, child);
  const children = orderTasks(
    [...byId.values()].filter((child) => child.parentId === task.id),
    "manual",
  );
  if (children.length === 0 && !canEdit) return null;
  const done = children.filter((c) => idx.states.get(c.stateId)?.type === "completed").length;

  return (
    <section className="mt-4 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Subtasks
          {children.length > 0 && (
            <span className="ml-2 tabular-nums">
              {done}/{children.length}
            </span>
          )}
        </h2>
        {canEdit && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            onClick={() => newTask({ parentId: task.id, teamId: task.teamId })}
          >
            <Plus /> Add subtask
          </Button>
        )}
      </div>
      {children.map((c) => {
        const state = idx.states.get(c.stateId);
        const assignee = c.assigneeId ? idx.users.get(c.assigneeId) : undefined;
        return (
          <Link
            key={c.id}
            href={`/${slug}/task/${c.id}`}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
          >
            <StatusIcon type={state?.type ?? "unstarted"} progress={idx.stateProgress(c.stateId)} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                state?.type === "canceled" && "text-muted-foreground line-through",
              )}
            >
              {c.title}
            </span>
            {assignee && <UserAvatar name={assignee.name} src={assignee.avatarUrl} className="size-5" />}
          </Link>
        );
      })}
    </section>
  );
}

/**
 * "Blocked by" and "Blocks": the task's dependencies, live from the store, with a
 * task picker to add one. Tasks that would close a circular dependency aren't offered.
 */
export function TaskDependencies({
  initial,
  context,
}: {
  initial: TaskSummary;
  context?: { relations: TaskRelation[]; tasks: TaskSummary[] };
}) {
  const task = useTask(initial);
  const { idx, canEditTasks: canEdit, createTaskRelation, deleteTaskRelation } = useWorkspace();
  const relations = [
    ...new Map(
      [...(context?.relations ?? []), ...(idx.boot.taskRelations ?? [])].map((relation) => [
        relation.id,
        relation,
      ]),
    ).values(),
  ];
  const related = new Map(context?.tasks.map((related) => [related.id, related]));
  const blockedBy = relations.filter((r) => r.blockedTaskId === task.id);
  const blocking = relations.filter((r) => r.blockingTaskId === task.id);
  if (blockedBy.length === 0 && blocking.length === 0 && !canEdit) return null;

  const openBlockers = blockedBy.filter((r) => {
    const blocker = idx.tasks.get(r.blockingTaskId) ?? related.get(r.blockingTaskId);
    const type = blocker && idx.states.get(blocker.stateId)?.type;
    return !!type && type !== "completed" && type !== "canceled";
  }).length;
  const linked = new Set([
    task.id,
    ...blockedBy.map((r) => r.blockingTaskId),
    ...blocking.map((r) => r.blockedTaskId),
  ]);

  return (
    <section className="mt-4 flex flex-col gap-3" aria-label="Dependencies">
      <DependencyGroup
        title="Blocked by"
        addLabel="Add blocker"
        relations={blockedBy}
        related={related}
        other={(r) => r.blockingTaskId}
        canEdit={canEdit}
        exclude={(id) => linked.has(id) || wouldCreateBlockingCycle(relations, id, task.id)}
        onAdd={(id) => createTaskRelation(id, task.id)}
        onRemove={deleteTaskRelation}
        badge={openBlockers > 0 ? <BlockedBadge count={openBlockers} showLabel /> : undefined}
      />
      <DependencyGroup
        title="Blocks"
        addLabel="Add blocked task"
        relations={blocking}
        related={related}
        other={(r) => r.blockedTaskId}
        canEdit={canEdit}
        exclude={(id) => linked.has(id) || wouldCreateBlockingCycle(relations, task.id, id)}
        onAdd={(id) => createTaskRelation(task.id, id)}
        onRemove={deleteTaskRelation}
      />
    </section>
  );
}

function DependencyGroup({
  title,
  addLabel,
  relations,
  related,
  other,
  canEdit,
  exclude,
  onAdd,
  onRemove,
  badge,
}: {
  title: string;
  addLabel: string;
  relations: TaskRelation[];
  related: ReadonlyMap<string, TaskSummary>;
  /** The task on the other end of a relation. */
  other: (r: TaskRelation) => string;
  canEdit: boolean;
  exclude: (taskId: string) => boolean;
  onAdd: (taskId: string) => void;
  onRemove: (relationId: string) => void;
  badge?: ReactNode;
}) {
  const { idx, slug } = useWorkspace();
  if (relations.length === 0 && !canEdit) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          {title}
          {relations.length > 0 && <span className="ml-2 tabular-nums">{relations.length}</span>}
        </h2>
        {badge}
        {canEdit && (
          <TaskPicker
            value={null}
            exclude={exclude}
            onChange={(id) => id && onAdd(id)}
            align="end"
            placeholder={`${addLabel}…`}
          >
            <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground">
              <Plus /> {addLabel}
            </Button>
          </TaskPicker>
        )}
      </div>
      {relations.map((r) => {
        const t = idx.tasks.get(other(r)) ?? related.get(other(r));
        if (!t || !idx.teams.has(t.teamId)) return null;
        const state = idx.states.get(t.stateId);
        return (
          <div key={r.id} className="group/dep flex items-center gap-1 rounded-md hover:bg-muted">
            <Link
              href={`/${slug}/task/${t.id}`}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm"
            >
              <StatusIcon type={state?.type ?? "unstarted"} progress={idx.stateProgress(t.stateId)} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  (state?.type === "canceled" || state?.type === "completed") && "text-muted-foreground",
                  state?.type === "canceled" && "line-through",
                )}
              >
                {t.title}
              </span>
            </Link>
            {canEdit && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove “${t.title}”`}
                className="mr-1 text-muted-foreground opacity-0 group-hover/dep:opacity-100 focus-visible:opacity-100"
                onClick={() => onRemove(r.id)}
              >
                <X />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Header actions: copy link, and a menu with copy title and delete. */
export function TaskActions({ initial, teamKey }: { initial: TaskSummary; teamKey: string }) {
  const task = useTask(initial);
  const router = useRouter();
  const { slug, idx, canEditTasks: canEdit, deleteTask, updateTask } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${what}`);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  };
  const link = () => `${window.location.origin}/${slug}/task/${task.id}`;
  async function duplicate() {
    setDuplicating(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].tasks[":id"].duplicate.$post({
          param: { slug, id: task.id },
        }),
      );
      router.push(`/${slug}/task/${created.id}`);
      toast.success("Task duplicated");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDuplicating(false);
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Copy link" onClick={() => copy(link(), "link")}>
            <Link2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy link</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => copy(link(), "link")}>
            <Link2 /> Copy task link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copy(task.title, "title")}>
            <Copy /> Copy title
          </DropdownMenuItem>
          {canEdit && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={duplicating} onSelect={() => void duplicate()}>
                <Copy /> Duplicate task
              </DropdownMenuItem>
              {idx.boot.teams.some((team) => team.id !== task.teamId) && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Move to team</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {idx.boot.teams
                      .filter((team) => team.id !== task.teamId)
                      .map((team) => (
                        <DropdownMenuItem
                          key={team.id}
                          onSelect={async () => {
                            if (await updateTask(task.id, { teamId: team.id })) {
                              toast.success(`Moved to ${team.name}`);
                              router.refresh();
                            }
                          }}
                        >
                          {team.name}
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                <Trash2 /> Delete task
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this task?</DialogTitle>
            <DialogDescription>
              &ldquo;{task.title}&rdquo; will be removed for everyone in the workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={async () => {
                setConfirming(false);
                router.push(`/${slug}/team/${teamKey}`);
                if (await deleteTask(task.id)) toast.success("Task deleted", { description: task.title });
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
