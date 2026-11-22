/**
 * Date and layout math for the project timeline (Gantt) view. Pure and DOM-free so it can be
 * unit-tested and reused by other clients.
 *
 * Dates are `YYYY-MM-DD` strings, the same as `startDate`/`dueDate` on tasks. Internally a date is a
 * **day number** (days since 1970-01-01, computed in UTC), so the math never shifts with the local
 * time zone or daylight saving. Days are inclusive: a task from the 3rd to the 5th covers three days.
 */

import { compareSortKeys } from "@knotworking/core";

// ─── Days ────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** "2026-11-09" → day number; null for anything that isn't a date. */
export function toDay(iso: string | null | undefined): number | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY) : null;
}

/** Day number → "2026-11-09". */
export function fromDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export const weekday = (day: number) => (((day + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday

export const startOfWeekDay = (day: number) => day - weekday(day);

export function startOfMonthDay(day: number): number {
  const d = new Date(day * MS_PER_DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / MS_PER_DAY);
}

function addMonths(day: number, n: number): number {
  const d = new Date(day * MS_PER_DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / MS_PER_DAY);
}

// ─── Zoom ────────────────────────────────────────────────────────────────────

export const zoomLevels = ["day", "week", "month"] as const;
export type Zoom = (typeof zoomLevels)[number];

/** Pixels per day at each zoom level. */
export const PX_PER_DAY: Record<Zoom, number> = { day: 32, week: 14, month: 5 };

/** Empty days kept around the scheduled work, so there is room to drag. */
const PADDING_DAYS: Record<Zoom, number> = { day: 7, week: 14, month: 31 };

export const parseZoom = (value: string | null | undefined): Zoom =>
  zoomLevels.find((z) => z === value) ?? "week";

export interface TimelineRange {
  /** First day shown (left edge). */
  start: number;
  /** Number of days shown. */
  days: number;
}

/**
 * The days to draw: every given date (bars, project start/target, today) plus padding, aligned to
 * the start of a week (week zoom) or month (month zoom) so the header reads cleanly.
 */
export function timelineRange(
  dates: (string | null | undefined)[],
  today: string,
  zoom: Zoom,
): TimelineRange {
  const days = [...dates, today].map(toDay).filter((d): d is number => d !== null);
  const pad = PADDING_DAYS[zoom];
  let start = Math.min(...days) - pad;
  let end = Math.max(...days) + pad;
  if (zoom === "week") {
    start = startOfWeekDay(start);
    end = startOfWeekDay(end) + 6;
  } else if (zoom === "month") {
    start = startOfMonthDay(start);
    end = addMonths(end, 1) - 1;
  }
  return { start, days: end - start + 1 };
}

/** Left edge (px) of a day. */
export const dayToX = (day: number, range: TimelineRange, zoom: Zoom) =>
  (day - range.start) * PX_PER_DAY[zoom];

/** The day under an x offset (px). */
export const xToDay = (x: number, range: TimelineRange, zoom: Zoom) =>
  range.start + Math.floor(x / PX_PER_DAY[zoom]);

/** A pointer movement (px) snapped to whole days. */
export const snapDays = (dx: number, zoom: Zoom) => Math.round(dx / PX_PER_DAY[zoom]) || 0;

// ─── Header ──────────────────────────────────────────────────────────────────

export interface HeaderCell {
  start: number;
  days: number;
  label: string;
}

const monthYear = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthOnly = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const asDate = (day: number) => new Date(day * MS_PER_DAY);

/** Splits the range into cells, starting a new one wherever `boundary(day)` is true. */
function cells(range: TimelineRange, boundary: (day: number) => boolean, label: (day: number) => string) {
  const out: HeaderCell[] = [];
  const end = range.start + range.days;
  for (let day = range.start; day < end; day++) {
    const last = out.at(-1);
    if (!last || boundary(day)) out.push({ start: day, days: 1, label: label(day) });
    else last.days++;
  }
  return out;
}

const isFirstOfMonth = (day: number) => asDate(day).getUTCDate() === 1;

/** Two header rows: months over days or weeks, or years over months. */
export function headerRows(range: TimelineRange, zoom: Zoom): { top: HeaderCell[]; bottom: HeaderCell[] } {
  if (zoom === "month") {
    return {
      top: cells(
        range,
        (d) => isFirstOfMonth(d) && asDate(d).getUTCMonth() === 0,
        (d) => String(asDate(d).getUTCFullYear()),
      ),
      bottom: cells(range, isFirstOfMonth, (d) => monthOnly.format(asDate(d))),
    };
  }
  const top = cells(range, isFirstOfMonth, (d) => monthYear.format(asDate(d)));
  const bottom =
    zoom === "day"
      ? cells(
          range,
          () => true,
          (d) => String(asDate(d).getUTCDate()),
        )
      : cells(
          range,
          (d) => weekday(d) === 0,
          (d) => monthDay.format(asDate(d)),
        );
  return { top, bottom };
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/** The fields of a task the timeline reads. */
export interface TimelineTask {
  id: string;
  parentId: string | null;
  startDate: string | null;
  dueDate: string | null;
  sortOrder: string;
}

/**
 * The days a task covers. `start` and `end` are inclusive day numbers. A task with only one date is a
 * single-day marker (`kind` says which date it has).
 */
export interface Span {
  start: number;
  end: number;
  kind: "range" | "start" | "due";
}

export function taskSpan(task: Pick<TimelineTask, "startDate" | "dueDate">): Span | null {
  const start = toDay(task.startDate);
  const due = toDay(task.dueDate);
  if (start !== null && due !== null)
    return { start: Math.min(start, due), end: Math.max(start, due), kind: "range" };
  if (start !== null) return { start, end: start, kind: "start" };
  if (due !== null) return { start: due, end: due, kind: "due" };
  return null;
}

export interface TimelineRow<T extends TimelineTask> {
  task: T;
  /** Nesting level: 0 for top-level tasks, 1 for their subtasks, … */
  depth: number;
  /** Null for a parent with no dates of its own, shown because a subtask is scheduled. */
  span: Span | null;
}

/**
 * Orders tasks into rows: subtasks under their parent, siblings by the day they start (then manual
 * order). A task without dates is a row only when it is the parent of a scheduled task; the others
 * are returned as `unscheduled` (in manual order). Subtasks whose parent isn't among `tasks` (another
 * project) are top-level.
 */
export function timelineRows<T extends TimelineTask>(
  tasks: T[],
): { rows: TimelineRow<T>[]; unscheduled: T[] } {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<string | null, T[]>();
  for (const t of tasks) {
    const parent = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), t]);
  }

  // Earliest day in each subtree, so a parent sorts by its first scheduled subtask; null when none.
  const firstDay = new Map<string, number | null>();
  const visiting = new Set<string>();
  const earliest = (t: T): number | null => {
    if (firstDay.has(t.id)) return firstDay.get(t.id)!;
    if (visiting.has(t.id)) return null; // malformed parent cycle
    visiting.add(t.id);
    const own = taskSpan(t)?.start ?? null;
    const days = [own, ...(children.get(t.id) ?? []).map(earliest)].filter((d): d is number => d !== null);
    const first = days.length ? Math.min(...days) : null;
    firstDay.set(t.id, first);
    return first;
  };

  const byStart = (a: T, b: T) =>
    (earliest(a) ?? Infinity) - (earliest(b) ?? Infinity) ||
    compareSortKeys(a.sortOrder, b.sortOrder) ||
    compareSortKeys(a.id, b.id);

  const rows: TimelineRow<T>[] = [];
  const unscheduled: T[] = [];
  const placed = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const t of [...(children.get(parent) ?? [])].sort(byStart)) {
      if (placed.has(t.id)) continue;
      placed.add(t.id);
      if (earliest(t) === null) {
        unscheduled.push(t);
        continue;
      }
      rows.push({ task: t, depth, span: taskSpan(t) });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  // Tasks only reachable through a parent cycle: list them rather than lose them.
  for (const t of tasks) {
    if (placed.has(t.id)) continue;
    const span = taskSpan(t);
    if (span) rows.push({ task: t, depth: 0, span });
    else unscheduled.push(t);
  }
  unscheduled.sort((a, b) => compareSortKeys(a.sortOrder, b.sortOrder) || compareSortKeys(a.id, b.id));
  return { rows, unscheduled };
}

// ─── Rescheduling ────────────────────────────────────────────────────────────

/** What a drag (or arrow key) changes: the whole bar, its start edge or its end (due) edge. */
export type DragMode = "move" | "start" | "end";

export interface TaskDates {
  startDate: string | null;
  dueDate: string | null;
}

/**
 * The dates after moving by `delta` days. Moving shifts whichever dates the task has. Dragging an edge
 * changes that date and never past the other one (a start can't be after the due date); dragging the
 * free edge of a single-day marker adds the missing date, turning it into a bar.
 */
export function shiftDates(dates: TaskDates, mode: DragMode, delta: number): TaskDates {
  const span = taskSpan(dates);
  if (!span || delta === 0) return dates;
  const shift = (iso: string | null) => (iso === null ? null : fromDay(toDay(iso)! + delta));
  if (mode === "move") return { startDate: shift(dates.startDate), dueDate: shift(dates.dueDate) };
  if (mode === "start") {
    const start = Math.min(span.start + delta, span.end);
    // A due-only marker gets a start; a start-only marker keeps being a marker.
    return { startDate: fromDay(start), dueDate: span.kind === "start" ? null : fromDay(span.end) };
  }
  const end = Math.max(span.end + delta, span.start);
  return { startDate: span.kind === "due" ? null : fromDay(span.start), dueDate: fromDay(end) };
}

/** Only the fields that differ, for a PATCH; empty when nothing changed. */
export function datePatch(before: TaskDates, after: TaskDates): Partial<TaskDates> {
  const patch: Partial<TaskDates> = {};
  if (after.startDate !== before.startDate) patch.startDate = after.startDate;
  if (after.dueDate !== before.dueDate) patch.dueDate = after.dueDate;
  return patch;
}

// ─── Geometry ────────────────────────────────────────────────────────────────

export const ROW_HEIGHT = 36;

export interface BarBox {
  x: number;
  width: number;
}

/** Where a span sits horizontally: from the left edge of its first day to the right edge of its last. */
export function barBox(span: Span, range: TimelineRange, zoom: Zoom): BarBox {
  return { x: dayToX(span.start, range, zoom), width: (span.end - span.start + 1) * PX_PER_DAY[zoom] };
}

/** Vertical centre of a row. */
export const rowCenter = (index: number) => index * ROW_HEIGHT + ROW_HEIGHT / 2;

export interface Point {
  x: number;
  y: number;
}

/**
 * SVG path for a dependency arrow from the end of the blocking bar (`from`) to the start of the
 * blocked bar (`to`). It leaves to the right, turns, and enters from the left. When the blocked bar
 * starts too far left to fit that, it doubles back between the two rows.
 */
export function dependencyPath(from: Point, to: Point, gap = 8): string {
  if (to.x - from.x >= gap * 2) {
    const mid = from.x + gap;
    return `M ${from.x} ${from.y} H ${mid} V ${to.y} H ${to.x}`;
  }
  const between = from.y === to.y ? from.y + ROW_HEIGHT / 2 : (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} H ${from.x + gap} V ${between} H ${to.x - gap} V ${to.y} H ${to.x}`;
}

/**
 * A dependency is violated when the blocked task starts on or before the day its blocker ends: days
 * are inclusive, so the blocked task should start the day after.
 */
export const isViolated = (blocking: Span, blocked: Span) => blocked.start <= blocking.end;

export interface DependencyLine {
  id: string;
  blockingTaskId: string;
  blockedTaskId: string;
  path: string;
  violated: boolean;
}

/**
 * Arrows for the relations whose two tasks are both drawn as bars. `boxes` maps task id → its row
 * index, span and box (including any drag in progress).
 */
export function dependencyLines(
  relations: { id: string; blockingTaskId: string; blockedTaskId: string }[],
  boxes: Map<string, { index: number; span: Span; box: BarBox }>,
): DependencyLine[] {
  const lines: DependencyLine[] = [];
  for (const r of relations) {
    const from = boxes.get(r.blockingTaskId);
    const to = boxes.get(r.blockedTaskId);
    if (!from || !to) continue;
    lines.push({
      ...r,
      path: dependencyPath(
        { x: from.box.x + from.box.width, y: rowCenter(from.index) },
        { x: to.box.x, y: rowCenter(to.index) },
      ),
      violated: isViolated(from.span, to.span),
    });
  }
  return lines;
}
