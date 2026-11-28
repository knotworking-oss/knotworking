"use client";

import type { WorkflowStateType } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { cn } from "@knotworking/ui/lib/utils";
import { CalendarClock } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { formatShortDate } from "@/lib/format";
import {
  barBox,
  datePatch,
  dayToX,
  dependencyLines,
  headerRows,
  PX_PER_DAY,
  ROW_HEIGHT,
  shiftDates,
  snapDays,
  taskSpan,
  timelineRange,
  timelineRows,
  toDay,
  weekday,
  zoomLevels,
  type BarBox,
  type DragMode,
  type Span,
  type TaskDates,
  type TimelineTask,
  type Zoom,
} from "@/lib/timeline";
import { DueDateChip, DueDatePicker, StartDateChip, StartDatePicker } from "./task-pickers";

/** A task as the timeline draws it. */
export interface GanttTask extends TimelineTask {
  title: string;
  status: WorkflowStateType;
  /** Fill of a "started" status icon (see `StatusIcon`). */
  statusProgress?: number;
  assignee?: { name: string; avatarUrl: string | null } | null;
  /** Where the task's title links to. */
  href?: string;
}

export interface GanttRelation {
  id: string;
  blockingTaskId: string;
  blockedTaskId: string;
}

const NAME_WIDTH = 260;
const BAR_HEIGHT = 20;

/** Bar colour by state category, from the status palette. */
const barColor: Record<WorkflowStateType, string> = {
  backlog: "border-status-backlog bg-status-backlog/25",
  unstarted: "border-status-unstarted bg-status-unstarted/25",
  started: "border-status-started bg-status-started/40",
  completed: "border-status-completed bg-status-completed/35",
  canceled: "border-status-canceled bg-status-canceled/20 opacity-60",
};
const markerColor: Record<WorkflowStateType, string> = {
  backlog: "bg-status-backlog",
  unstarted: "bg-status-unstarted",
  started: "bg-status-started",
  completed: "bg-status-completed",
  canceled: "bg-status-canceled opacity-60",
};

const zoomLabels: Record<Zoom, string> = { day: "Day", week: "Week", month: "Month" };

const isOpen = (status: WorkflowStateType) => status !== "completed" && status !== "canceled";

function describeDates(dates: TaskDates) {
  if (dates.startDate && dates.dueDate) {
    return dates.startDate === dates.dueDate
      ? formatShortDate(dates.dueDate)
      : `${formatShortDate(dates.startDate)} – ${formatShortDate(dates.dueDate)}`;
  }
  if (dates.startDate) return `Starts ${formatShortDate(dates.startDate)}`;
  if (dates.dueDate) return `Due ${formatShortDate(dates.dueDate)}`;
  return "No dates";
}

/** A drag or keyboard adjustment in progress: not yet saved. */
interface Pending {
  id: string;
  mode: DragMode;
  delta: number;
}

/**
 * Project timeline: one row per task (subtasks nested), a bar from start to due date, dependency
 * arrows, the project's start/target range and today. Writers can drag bars (or use the arrow keys)
 * to reschedule; `onReschedule` receives only the dates that changed. Tasks without dates are listed
 * below with date pickers.
 *
 * Presentational: it doesn't read the workspace store, so `/design` can show it with sample data.
 */
export function GanttChart({
  tasks,
  relations,
  project,
  milestones,
  today,
  canEdit,
  onReschedule,
  onOpen,
  defaultZoom = "week",
  className,
}: {
  tasks: GanttTask[];
  relations: GanttRelation[];
  project?: { startDate: string | null; targetDate: string | null };
  milestones?: readonly { id: string; name: string; targetDate: string | null; completedAt: string | null }[];
  /** Today's date (YYYY-MM-DD) in the viewer's time zone. */
  today: string;
  canEdit: boolean;
  onReschedule: (id: string, patch: Partial<TaskDates>) => void;
  /** Opens a task (Enter on a bar, or a click without dragging). */
  onOpen?: (task: GanttTask) => void;
  defaultZoom?: Zoom;
  className?: string;
}) {
  const [zoom, setZoom] = useState<Zoom>(defaultZoom);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const uid = useId();
  const ppd = PX_PER_DAY[zoom];

  const { rows, unscheduled } = useMemo(() => timelineRows(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  /** Dates as drawn: the saved ones, or the pending adjustment's. */
  const datesOf = useCallback(
    (t: GanttTask): TaskDates =>
      pending?.id === t.id
        ? shiftDates(t, pending.mode, pending.delta)
        : { startDate: t.startDate, dueDate: t.dueDate },
    [pending],
  );

  // The range ignores pending adjustments, so the chart doesn't jump while dragging.
  const range = useMemo(
    () =>
      timelineRange(
        [
          ...tasks.flatMap((t) => [
            t.startDate,
            t.dueDate,
            t.subtaskRollup?.startDate,
            t.subtaskRollup?.dueDate,
          ]),
          project?.startDate,
          project?.targetDate,
          ...(milestones ?? []).map((row) => row.targetDate),
        ],
        today,
        zoom,
      ),
    [tasks, project?.startDate, project?.targetDate, milestones, today, zoom],
  );
  const width = range.days * ppd;
  const header = useMemo(() => headerRows(range, zoom), [range, zoom]);

  const boxes = useMemo(() => {
    const out = new Map<string, { index: number; span: Span; box: BarBox }>();
    rows.forEach((row, index) => {
      const span = taskSpan(datesOf(row.task));
      if (span) out.set(row.task.id, { index, span, box: barBox(span, range, zoom) });
    });
    return out;
  }, [rows, datesOf, range, zoom]);
  const lines = useMemo(() => dependencyLines(relations, boxes), [relations, boxes]);
  const violatedBlockers = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const l of lines) {
      if (!l.violated) continue;
      const blocker = byId.get(l.blockingTaskId)?.title ?? "its blocker";
      out.set(l.blockedTaskId, [...(out.get(l.blockedTaskId) ?? []), blocker]);
    }
    return out;
  }, [lines, byId]);

  const todayDay = toDay(today)!;
  const todayX = dayToX(todayDay, range, zoom) + ppd / 2;

  const scrollToToday = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, NAME_WIDTH + todayX - el.clientWidth / 2);
  }, [todayX]);
  // Start at today, and keep it in view when zooming (not on every data change).
  const scrollOnZoom = useRef(scrollToToday);
  scrollOnZoom.current = scrollToToday;
  useLayoutEffect(() => scrollOnZoom.current(), [zoom]);

  const commit = useCallback(
    (p: Pending | null) => {
      pendingRef.current = null;
      setPending(null);
      const task = p && byId.get(p.id);
      if (!p || !task || p.delta === 0) return;
      const patch = datePatch(task, shiftDates(task, p.mode, p.delta));
      if (Object.keys(patch).length) onReschedule(task.id, patch);
    },
    [byId, onReschedule],
  );
  const update = (p: Pending | null) => {
    pendingRef.current = p;
    setPending(p);
  };

  // A drag listens on the window, so it keeps tracking outside the bar.
  const drag = useRef<{ cleanup: () => void } | null>(null);
  useEffect(() => () => drag.current?.cleanup(), []);

  const startDrag = (e: ReactPointerEvent<HTMLElement>, task: GanttTask, mode: DragMode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget.closest("[data-bar]") as HTMLElement | null)?.focus();
    const x0 = e.clientX;
    let moved = false;
    let current: Pending = { id: task.id, mode, delta: 0 };
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!canEdit) return;
      const delta = snapDays(ev.clientX - x0, zoom);
      if (delta !== current.delta) {
        current = { ...current, delta };
        update(current);
      }
    };
    const onUp = () => {
      cleanup();
      if (current.delta !== 0) commit(current);
      else {
        update(null);
        if (!moved) onOpen?.(task);
      }
    };
    const onCancel = () => {
      cleanup();
      update(null);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      drag.current = null;
    };
    drag.current?.cleanup();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    drag.current = { cleanup };
  };

  /** Arrows move, Shift+arrows change the due date, Alt+Shift+arrows the start date; saved on key release. */
  const onBarKeyDown = (e: ReactKeyboardEvent, task: GanttTask) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen?.(task);
      return;
    }
    if (e.key === "Escape" && pendingRef.current) {
      e.preventDefault();
      update(null);
      return;
    }
    if (!canEdit || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const mode: DragMode = e.shiftKey ? (e.altKey ? "start" : "end") : "move";
    const step = e.key === "ArrowLeft" ? -1 : 1;
    const prev = pendingRef.current;
    if (prev && (prev.id !== task.id || prev.mode !== mode)) commit(prev);
    const base = prev && prev.id === task.id && prev.mode === mode ? prev.delta : 0;
    update({ id: task.id, mode, delta: base + step });
  };
  const onBarKeyUp = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") commit(pendingRef.current);
  };

  const projectStart = toDay(project?.startDate);
  const projectEnd = toDay(project?.targetDate);
  const bodyHeight = Math.max(rows.length, 1) * ROW_HEIGHT;
  const hintId = `${uid}-hint`;

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-2 px-4 py-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={zoom}
          onValueChange={(v) => v && setZoom(v as Zoom)}
          aria-label="Zoom"
        >
          {zoomLevels.map((z) => (
            <ToggleGroupItem key={z} value={z} className="px-2.5">
              {zoomLabels[z]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button variant="outline" size="sm" onClick={scrollToToday}>
          <CalendarClock /> Today
        </Button>
        <Legend />
      </div>
      <p id={hintId} className="sr-only">
        {canEdit
          ? "Arrow keys move the task by a day, Shift+arrows change its due date, Alt+Shift+arrows change its start date. Enter opens it."
          : "Enter opens the task."}
      </p>

      <div
        ref={scroller}
        role="region"
        aria-label="Timeline"
        className="relative max-h-[70vh] overflow-auto border-y"
      >
        <div style={{ width: NAME_WIDTH + width }}>
          {/* Header: months and days/weeks, with the project's markers and today. */}
          <div className="sticky top-0 z-20 flex border-b bg-background text-xs text-muted-foreground">
            <div
              className="sticky left-0 z-30 flex shrink-0 items-end border-r bg-background px-4 pb-1.5 font-medium"
              style={{ width: NAME_WIDTH }}
            >
              Task
            </div>
            <div className="relative shrink-0" style={{ width, height: 52 }}>
              {header.top.map((c) => (
                <div
                  key={`t${c.start}`}
                  className="absolute top-0 flex h-6 items-center border-l px-1.5 font-medium whitespace-nowrap text-foreground"
                  style={{ left: dayToX(c.start, range, zoom), width: c.days * ppd }}
                >
                  {/* Sticks beside the task column, so a long month keeps its label in view. */}
                  <span className="sticky left-[calc(260px+0.375rem)]">{c.label}</span>
                </div>
              ))}
              {header.bottom.map((c) => (
                <div
                  key={`b${c.start}`}
                  className={cn(
                    "absolute top-6 flex h-7 items-center border-t border-l",
                    zoom === "day" ? "justify-center" : "px-1.5",
                    zoom === "day" && c.start === todayDay && "font-semibold text-foreground",
                  )}
                  style={{ left: dayToX(c.start, range, zoom), width: c.days * ppd }}
                >
                  <span className="truncate">{c.label}</span>
                </div>
              ))}
              {projectStart !== null && (
                <Flag x={dayToX(projectStart, range, zoom)} label="Start" align="start" />
              )}
              {projectEnd !== null && (
                <Flag x={dayToX(projectEnd, range, zoom) + ppd} label="Target" align="end" />
              )}
              {milestones?.map((row) => {
                const day = toDay(row.targetDate);
                return (
                  day !== null && (
                    <span
                      key={row.id}
                      title={row.name}
                      aria-label={row.name}
                      role="img"
                      className={cn(
                        "absolute bottom-1 size-2.5 -translate-x-1/2 rotate-45 border border-primary bg-background",
                        row.completedAt && "bg-primary",
                      )}
                      style={{ left: dayToX(day, range, zoom) + ppd / 2 }}
                    />
                  )
                );
              })}
              <div
                className="absolute bottom-0 h-1.5 w-0.5 -translate-x-1/2 bg-primary"
                style={{ left: todayX }}
                aria-hidden
              />
            </div>
          </div>

          <div className="flex">
            {/* Task names, sticky on the left. */}
            <ul
              aria-label="Tasks"
              className="sticky left-0 z-10 shrink-0 border-r bg-background"
              style={{ width: NAME_WIDTH }}
            >
              {rows.map(({ task, depth }) => (
                <li
                  key={task.id}
                  className="flex items-center gap-2 border-b pr-3 text-sm"
                  style={{ height: ROW_HEIGHT, paddingLeft: 16 + depth * 16 }}
                >
                  <StatusIcon type={task.status} progress={task.statusProgress} />
                  {task.href ? (
                    <Link href={task.href} className="min-w-0 flex-1 truncate hover:underline">
                      {task.title}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  )}
                  {task.subtaskRollup && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      <span className="sr-only">Subtasks completed </span>
                      {task.subtaskRollup.completed}/{task.subtaskRollup.total}
                    </span>
                  )}
                </li>
              ))}
              {rows.length === 0 && (
                <li
                  className="flex items-center px-4 text-sm text-muted-foreground"
                  style={{ height: ROW_HEIGHT }}
                >
                  Nothing scheduled
                </li>
              )}
            </ul>

            {/* The chart. */}
            <div className="relative shrink-0" style={{ width, height: bodyHeight }}>
              <Grid range={range} zoom={zoom} cells={header.bottom} />
              {(projectStart !== null || projectEnd !== null) && (
                <div
                  aria-hidden
                  data-testid="project-range"
                  className={cn(
                    "absolute inset-y-0 border-dashed border-primary/40 bg-primary/[0.04]",
                    projectStart !== null && "border-l",
                    projectEnd !== null && "border-r",
                  )}
                  style={{
                    left: projectStart !== null ? dayToX(projectStart, range, zoom) : 0,
                    right: projectEnd !== null ? width - dayToX(projectEnd, range, zoom) - ppd : 0,
                  }}
                />
              )}
              {rows.map((_, i) => (
                <div
                  key={i}
                  aria-hidden
                  className="absolute inset-x-0 border-b"
                  style={{ top: (i + 1) * ROW_HEIGHT - 1 }}
                />
              ))}
              <div
                aria-hidden
                data-testid="today-line"
                className="absolute inset-y-0 z-[1] w-0.5 -translate-x-1/2 bg-primary/70"
                style={{ left: todayX }}
              />

              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[2] overflow-visible"
                width={width}
                height={bodyHeight}
              >
                <defs>
                  <marker
                    id={`${uid}-arrow`}
                    viewBox="0 0 6 6"
                    refX="5"
                    refY="3"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6 z" className="fill-muted-foreground" />
                  </marker>
                  <marker
                    id={`${uid}-arrow-bad`}
                    viewBox="0 0 6 6"
                    refX="5"
                    refY="3"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6 z" className="fill-destructive" />
                  </marker>
                </defs>
                {lines.map((l) => (
                  <path
                    key={l.id}
                    d={l.path}
                    fill="none"
                    data-relation={l.id}
                    data-violated={l.violated || undefined}
                    className={l.violated ? "stroke-destructive" : "stroke-muted-foreground/70"}
                    strokeWidth={1.5}
                    strokeDasharray={l.violated ? "4 3" : undefined}
                    markerEnd={`url(#${l.violated ? `${uid}-arrow-bad` : `${uid}-arrow`})`}
                  />
                ))}
              </svg>

              {rows.map(({ task }, index) => {
                const span = task.subtaskRollup ? taskSpan(task.subtaskRollup) : null;
                if (!span || !task.subtaskRollup) return null;
                const box = barBox(span, range, zoom);
                return (
                  <div
                    key={task.id}
                    role="img"
                    aria-label={`${task.title} subtask dates, ${describeDates(task.subtaskRollup)}`}
                    title={`Subtask dates · ${describeDates(task.subtaskRollup)}`}
                    className="absolute h-1 rounded bg-primary/45"
                    style={{ left: box.x, width: box.width, top: (index + 1) * ROW_HEIGHT - 6 }}
                  />
                );
              })}
              {rows.map(({ task }, index) => {
                const entry = boxes.get(task.id);
                if (!entry) return null;
                const dates = datesOf(task);
                const overdue = isOpen(task.status) && !!dates.dueDate && dates.dueDate < today;
                const violated = violatedBlockers.get(task.id);
                const label = [
                  `${task.title}: ${describeDates(dates)}`,
                  overdue && "overdue",
                  violated && `starts before ${violated.join(", ")} ends`,
                ]
                  .filter(Boolean)
                  .join(", ");
                return (
                  <Bar
                    key={task.id}
                    task={task}
                    span={entry.span}
                    box={entry.box}
                    top={index * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2}
                    label={label}
                    hintId={hintId}
                    overdue={overdue}
                    violated={!!violated}
                    canEdit={canEdit}
                    adjusting={pending?.id === task.id ? describeDates(dates) : null}
                    onPointerDown={startDrag}
                    onKeyDown={onBarKeyDown}
                    onKeyUp={onBarKeyUp}
                    onBlur={() => pendingRef.current?.id === task.id && commit(pendingRef.current)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <Unscheduled tasks={unscheduled} canEdit={canEdit} onReschedule={onReschedule} />
    </div>
  );
}

function Legend() {
  return (
    <div className="ml-auto hidden items-center gap-4 text-xs text-muted-foreground md:flex">
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-4 rounded-sm border border-dashed border-primary/40 bg-primary/[0.04]" />
        Project
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-0.5 bg-primary/70" />
        Today
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden>
          <path d="M0 3 H18" className="stroke-destructive" strokeWidth={1.5} strokeDasharray="4 3" />
        </svg>
        Starts before its blocker ends
      </span>
    </div>
  );
}

/** A labelled marker in the header for the project's start or target date. */
function Flag({ x, label, align }: { x: number; label: string; align: "start" | "end" }) {
  return (
    <div
      className={cn(
        "absolute top-6 z-[1] flex h-7 items-center",
        // Outside the range, so the pill doesn't cover the label of the cell the line falls in.
        align === "start"
          ? "-translate-x-full border-r-2 border-primary/60 pr-1"
          : "border-l-2 border-primary/60 pl-1",
      )}
      style={{ left: x }}
    >
      <span className="rounded-sm bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground">
        {label}
      </span>
    </div>
  );
}

/** Column lines (and weekend shading at day zoom). */
function Grid({
  range,
  zoom,
  cells,
}: {
  range: { start: number; days: number };
  zoom: Zoom;
  cells: { start: number; days: number }[];
}) {
  const ppd = PX_PER_DAY[zoom];
  return (
    <div aria-hidden className="absolute inset-0">
      {cells.map((c) => (
        <div
          key={c.start}
          className={cn(
            "absolute inset-y-0 border-l border-border/60",
            zoom === "day" && weekday(c.start) >= 5 && "bg-muted/50",
          )}
          style={{ left: dayToX(c.start, range, zoom), width: c.days * ppd }}
        />
      ))}
    </div>
  );
}

function Bar({
  task,
  span,
  box,
  top,
  label,
  hintId,
  overdue,
  violated,
  canEdit,
  adjusting,
  onPointerDown,
  onKeyDown,
  onKeyUp,
  onBlur,
}: {
  task: GanttTask;
  span: Span;
  box: BarBox;
  top: number;
  label: string;
  hintId: string;
  overdue: boolean;
  violated: boolean;
  canEdit: boolean;
  /** The dates being set, while dragging or using the keyboard. */
  adjusting: string | null;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, task: GanttTask, mode: DragMode) => void;
  onKeyDown: (e: ReactKeyboardEvent, task: GanttTask) => void;
  onKeyUp: (e: ReactKeyboardEvent) => void;
  onBlur: () => void;
}) {
  const marker = span.kind !== "range";
  const handles = canEdit && box.width >= 12;
  return (
    <div
      data-bar={task.id}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-describedby={hintId}
      className={cn(
        "group/bar absolute z-[3] flex items-center outline-none select-none",
        canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
      )}
      style={{ left: box.x, width: box.width, top, height: BAR_HEIGHT }}
      onPointerDown={(e) => onPointerDown(e, task, "move")}
      onKeyDown={(e) => onKeyDown(e, task)}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
    >
      {marker ? (
        <span
          className={cn(
            "mx-auto size-3 rotate-45 rounded-[2px] ring-offset-background group-focus-visible/bar:ring-2 group-focus-visible/bar:ring-ring group-focus-visible/bar:ring-offset-2",
            markerColor[task.status],
            overdue && "ring-2 ring-destructive",
          )}
        />
      ) : (
        <span
          className={cn(
            "h-full w-full rounded-md border ring-offset-background group-focus-visible/bar:ring-2 group-focus-visible/bar:ring-ring group-focus-visible/bar:ring-offset-1",
            barColor[task.status],
            overdue && "border-r-4 border-destructive",
            violated && "border-dashed",
          )}
        />
      )}
      {handles && (
        <>
          <span
            data-handle="start"
            aria-hidden
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-md group-hover/bar:bg-foreground/15"
            onPointerDown={(e) => onPointerDown(e, task, "start")}
          />
          <span
            data-handle="end"
            aria-hidden
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-md group-hover/bar:bg-foreground/15"
            onPointerDown={(e) => onPointerDown(e, task, "end")}
          />
        </>
      )}
      {task.assignee && (
        <UserAvatar
          name={task.assignee.name}
          src={task.assignee.avatarUrl}
          className="pointer-events-none absolute left-full ml-1.5 size-5"
        />
      )}
      {adjusting && (
        <span className="pointer-events-none absolute bottom-full left-0 mb-1 rounded bg-popover px-1.5 py-0.5 text-xs whitespace-nowrap text-popover-foreground shadow ring-1 ring-foreground/10">
          {adjusting}
        </span>
      )}
    </div>
  );
}

function Unscheduled({
  tasks,
  canEdit,
  onReschedule,
}: {
  tasks: GanttTask[];
  canEdit: boolean;
  onReschedule: (id: string, patch: Partial<TaskDates>) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section aria-label="Unscheduled" className="px-4 py-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
        Unscheduled <span className="text-muted-foreground tabular-nums">{tasks.length}</span>
      </h3>
      <ul className="flex flex-col">
        {tasks.map((t) => (
          <li key={t.id} className="flex h-9 items-center gap-2 border-b text-sm last:border-b-0">
            <StatusIcon type={t.status} progress={t.statusProgress} />
            {t.href ? (
              <Link href={t.href} className="min-w-0 flex-1 truncate hover:underline">
                {t.title}
              </Link>
            ) : (
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
            )}
            {t.subtaskRollup && (
              <span className="text-xs text-muted-foreground tabular-nums">
                <span className="sr-only">Subtasks completed </span>
                {t.subtaskRollup.completed}/{t.subtaskRollup.total}
              </span>
            )}
            {canEdit ? (
              <span className="flex items-center gap-1" aria-label={`Dates for ${t.title}`} role="group">
                <StartDatePicker
                  value={null}
                  onChange={(startDate) => onReschedule(t.id, { startDate })}
                  align="end"
                >
                  <StartDateChip startDate={null} />
                </StartDatePicker>
                <DueDatePicker
                  value={null}
                  onChange={(dueDate) => onReschedule(t.id, { dueDate })}
                  align="end"
                >
                  <DueDateChip dueDate={null} />
                </DueDatePicker>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No dates</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
