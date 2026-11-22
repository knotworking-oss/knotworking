"use client";

import { priorities, priorityLabels, type Priority } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { ColorDot, LabelBadge } from "@knotworking/ui/components/label-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover";
import { PriorityIcon } from "@knotworking/ui/components/priority-icon";
import { PropertyMenu, type PropertyOption } from "@knotworking/ui/components/property-menu";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { cn } from "@knotworking/ui/lib/utils";
import { CalendarArrowUp, CalendarDays, Tag, UserRound } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { formatShortDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

/**
 * Pickers for task properties. Each takes a value and change handler, and its
 * child is the trigger, so the same menu works in the create dialog, list rows,
 * board cards and the task sidebar.
 */
interface PickerProps<T> {
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  /** Lets the owner of a keyboard-opened menu decide where focus lands when it closes. */
  onCloseAutoFocus?: (event: Event) => void;
}

const NONE = "__none__";

export function StatusPicker({ teamId, ...props }: PickerProps<string> & { teamId: string }) {
  const { idx } = useWorkspace();
  const options: PropertyOption[] = idx.boot.workflowStates
    .filter((s) => s.teamId === teamId)
    .map((s, i) => ({
      value: s.id,
      label: s.name,
      icon: <StatusIcon type={s.type} progress={idx.stateProgress(s.id)} />,
      shortcut: i < 9 ? String(i + 1) : undefined,
    }));
  return (
    <PropertyMenu
      options={options}
      value={props.value}
      onValueChange={props.onChange}
      placeholder="Change status…"
      open={props.open}
      onOpenChange={props.onOpenChange}
      align={props.align}
      onCloseAutoFocus={props.onCloseAutoFocus}
    >
      {props.children}
    </PropertyMenu>
  );
}

export function PriorityPicker(props: PickerProps<Priority>) {
  const options: PropertyOption[] = priorities.map((p) => ({
    value: String(p),
    label: priorityLabels[p],
    icon: <PriorityIcon priority={p} />,
    shortcut: String(p),
  }));
  return (
    <PropertyMenu
      options={options}
      value={String(props.value)}
      onValueChange={(v) => props.onChange(Number(v) as Priority)}
      placeholder="Set priority…"
      open={props.open}
      onOpenChange={props.onOpenChange}
      align={props.align}
      onCloseAutoFocus={props.onCloseAutoFocus}
    >
      {props.children}
    </PropertyMenu>
  );
}

export function AssigneePicker(props: PickerProps<string | null>) {
  const { idx, viewer } = useWorkspace();
  const users = [...idx.boot.users].sort((a, b) =>
    a.id === viewer.id ? -1 : b.id === viewer.id ? 1 : a.name.localeCompare(b.name),
  );
  const options: PropertyOption[] = [
    {
      value: NONE,
      label: "No assignee",
      icon: <UserRound className="text-muted-foreground" />,
      shortcut: "0",
    },
    ...users.map((u) => ({
      value: u.id,
      label: u.id === viewer.id ? `${u.name} (you)` : u.name,
      keywords: [u.email].filter(Boolean),
      icon: <UserAvatar name={u.name} src={u.avatarUrl} className="size-5" />,
    })),
  ];
  return (
    <PropertyMenu
      options={options}
      value={props.value ?? NONE}
      onValueChange={(v) => props.onChange(v === NONE ? null : v)}
      placeholder="Assign to…"
      open={props.open}
      onOpenChange={props.onOpenChange}
      align={props.align}
      onCloseAutoFocus={props.onCloseAutoFocus}
    >
      {props.children}
    </PropertyMenu>
  );
}

export function LabelsPicker(props: PickerProps<string[]>) {
  const { idx } = useWorkspace();
  const options: PropertyOption[] = idx.boot.labels.map((l) => ({
    value: l.id,
    label: l.name,
    icon: <ColorDot color={l.color} className="size-2.5" />,
  }));
  return (
    <PropertyMenu
      multiple
      options={options}
      value={props.value}
      onValueChange={props.onChange}
      placeholder="Add labels…"
      emptyText="No labels"
      open={props.open}
      onOpenChange={props.onOpenChange}
      align={props.align}
      onCloseAutoFocus={props.onCloseAutoFocus}
    >
      {props.children}
    </PropertyMenu>
  );
}

export function ProjectPicker(props: PickerProps<string | null>) {
  const { idx } = useWorkspace();
  const options: PropertyOption[] = [
    { value: NONE, label: "No project", shortcut: "0" },
    ...idx.boot.projects
      .filter((p) => (p.status !== "canceled" && p.status !== "completed") || p.id === props.value)
      .map((p) => ({
        value: p.id,
        label: p.name,
        icon: <span className="w-4 text-center">{p.icon ?? "◆"}</span>,
      })),
  ];
  return (
    <PropertyMenu
      options={options}
      value={props.value ?? NONE}
      onValueChange={(v) => props.onChange(v === NONE ? null : v)}
      placeholder="Add to project…"
      emptyText="No projects"
      open={props.open}
      onOpenChange={props.onOpenChange}
      align={props.align}
    >
      {props.children}
    </PropertyMenu>
  );
}

type DatePickerProps = PickerProps<string | null> & {
  /** Earliest / latest selectable day (YYYY-MM-DD), e.g. the due date bounds the start date. */
  min?: string | null;
  max?: string | null;
};

export function DueDatePicker(props: DatePickerProps) {
  return <DatePicker {...props} label="Due date" />;
}

/** When work on a task is planned to begin; can't be after the due date. */
export function StartDatePicker(props: DatePickerProps) {
  return <DatePicker {...props} label="Start date" />;
}

function DatePicker({ label, ...props }: DatePickerProps & { label: string }) {
  const [openState, setOpenState] = useState(false);
  const open = props.open ?? openState;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    props.onOpenChange?.(o);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{props.children}</PopoverTrigger>
      <PopoverContent
        align={props.align ?? "start"}
        className="w-60"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <Input
          type="date"
          aria-label={label}
          defaultValue={props.value ?? ""}
          min={props.min ?? undefined}
          max={props.max ?? undefined}
          onChange={(e) => e.target.value && props.onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setOpen(false)}
        />
        {props.value && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              props.onChange(null);
              setOpen(false);
            }}
          >
            Remove {label.toLowerCase()}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Chips: compact triggers that show the current value ────────────────────

const chip =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-dashed border-transparent px-1.5 text-sm transition-colors hover:bg-muted data-[state=open]:bg-muted disabled:pointer-events-none";

export function StatusChip({
  stateId,
  showName = true,
  className,
  ...rest
}: { stateId: string; showName?: boolean } & ChipProps) {
  const { idx } = useWorkspace();
  const state = idx.states.get(stateId);
  return (
    <button type="button" className={cn(chip, className)} {...rest}>
      {state && <StatusIcon type={state.type} progress={idx.stateProgress(state.id)} label={state.name} />}
      {showName && <span className="truncate">{state?.name ?? "Status"}</span>}
    </button>
  );
}

export function PriorityChip({
  priority,
  showName = true,
  className,
  ...rest
}: { priority: Priority; showName?: boolean } & ChipProps) {
  return (
    <button
      type="button"
      className={cn(chip, className)}
      aria-label={`Priority: ${priorityLabels[priority]}`}
      {...rest}
    >
      <PriorityIcon priority={priority} />
      {showName && <span className="truncate">{priority === 0 ? "Priority" : priorityLabels[priority]}</span>}
    </button>
  );
}

export function AssigneeChip({
  userId,
  showName = true,
  className,
  ...rest
}: { userId: string | null; showName?: boolean } & ChipProps) {
  const { idx } = useWorkspace();
  const user = userId ? idx.users.get(userId) : undefined;
  return (
    <button
      type="button"
      className={cn(chip, className)}
      aria-label={user ? `Assigned to ${user.name}` : "Unassigned"}
      {...rest}
    >
      {user ? (
        <UserAvatar name={user.name} src={user.avatarUrl} className="size-5" />
      ) : (
        <span className="size-5 shrink-0 rounded-full border border-dashed border-muted-foreground/50" />
      )}
      {showName && (
        <span className={cn("truncate", !user && "text-muted-foreground")}>{user?.name ?? "Assignee"}</span>
      )}
    </button>
  );
}

export function LabelsChip({ labelIds, className, ...rest }: { labelIds: string[] } & ChipProps) {
  const { idx } = useWorkspace();
  const list = labelIds.map((id) => idx.labels.get(id)).filter((l) => l !== undefined);
  return (
    <button type="button" className={cn(chip, "h-auto min-h-7 flex-wrap py-1", className)} {...rest}>
      {list.length ? (
        list.map((l) => (
          <LabelBadge key={l.id} color={l.color}>
            {l.name}
          </LabelBadge>
        ))
      ) : (
        <>
          <Tag className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Labels</span>
        </>
      )}
    </button>
  );
}

export function ProjectChip({ projectId, className, ...rest }: { projectId: string | null } & ChipProps) {
  const { idx } = useWorkspace();
  const project = projectId ? idx.projects.get(projectId) : undefined;
  return (
    <button type="button" className={cn(chip, className)} {...rest}>
      {project ? (
        <LabelBadge color={project.color} variant="tint">
          {project.icon} {project.name}
        </LabelBadge>
      ) : (
        <span className="text-muted-foreground">Project</span>
      )}
    </button>
  );
}

export function DueDateChip({
  dueDate,
  overdue,
  className,
  ...rest
}: { dueDate: string | null; overdue?: boolean } & ChipProps) {
  return (
    <button type="button" className={cn(chip, className)} {...rest}>
      <CalendarDays className="size-3.5 text-muted-foreground" />
      <span className={cn(!dueDate && "text-muted-foreground", overdue && "text-destructive")}>
        {dueDate ? formatShortDate(dueDate) : "Due date"}
      </span>
    </button>
  );
}

export function StartDateChip({ startDate, className, ...rest }: { startDate: string | null } & ChipProps) {
  return (
    <button type="button" className={cn(chip, className)} {...rest}>
      <CalendarArrowUp className="size-3.5 text-muted-foreground" />
      <span className={cn(!startDate && "text-muted-foreground")}>
        {startDate ? formatShortDate(startDate) : "Start date"}
      </span>
    </button>
  );
}

/**
 * Picks another task (dependencies). `exclude` hides tasks that can't be chosen,
 * such as the task itself, ones already linked, or ones that would close a cycle.
 */
export function TaskPicker({
  exclude,
  placeholder = "Search tasks…",
  ...props
}: Omit<PickerProps<string | null>, "value"> & {
  value?: string | null;
  exclude?: (taskId: string) => boolean;
  placeholder?: string;
}) {
  const { idx, tasks } = useWorkspace();
  const options: PropertyOption[] = tasks
    .filter((t) => !exclude?.(t.id))
    .map((t) => {
      const state = idx.states.get(t.stateId);
      const team = idx.teams.get(t.teamId);
      return {
        value: t.id,
        label: t.title,
        keywords: [team?.key, state?.name].filter((k): k is string => Boolean(k)),
        icon: <StatusIcon type={state?.type ?? "unstarted"} progress={idx.stateProgress(t.stateId)} />,
      };
    });
  return (
    <PropertyMenu
      options={options}
      value={props.value ?? null}
      onValueChange={(v) => props.onChange(v)}
      placeholder={placeholder}
      emptyText="No tasks"
      open={props.open}
      onOpenChange={props.onOpenChange}
      align={props.align}
      className="w-80"
    >
      {props.children}
    </PropertyMenu>
  );
}

type ChipProps = Omit<ComponentProps<"button">, "children">;
