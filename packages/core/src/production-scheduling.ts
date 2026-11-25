import { z } from "zod";
import { allergens, type AllergenCode } from "./items";
import type { DayOff } from "./production-calendar";
import type { ProductionBatchStatus } from "./production";
import { isoWeekdayOf } from "./quality";

/**
 * Detailed scheduling (Phase 3.5.1): shift windows on production lines, changeover times between
 * recipes, allergen clean-downs, crew sizes, and the timed plan of one line on one day with an
 * explained proposal for the order of its batches. Pure rules and validation schemas; no DOM or
 * Node APIs.
 *
 * **Advisory throughout.** The plan and its warnings are computed on read; a proposal changes
 * nothing until someone applies the order they want (`PUT /production/schedule/sequence`).
 *
 * Times are minutes from midnight at the start of the production day. A shift that ends at or
 * before its start crosses midnight and belongs to the day it starts (a Monday night shift
 * 22:00–06:00 is Monday's), so times can run past 24:00 (shown as "06:00 +1").
 */

// ─── Shifts ──────────────────────────────────────────────────────────────────

export const MINUTES_PER_DAY = 1440;
/** Most shift windows a line can have. */
export const LINE_SHIFTS_MAX = 20;
/** Most changeover rules a line can have. */
export const LINE_CHANGEOVERS_MAX = 200;
/** Nominal start when a line has no shifts: its hours per day are counted from 06:00. */
export const DEFAULT_DAY_START_MINUTE = 6 * 60;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, like 06:00");
export const clockToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};
/** "06:00", "22:30", or "06:00 +1" past midnight. */
export function minutesToClock(minutes: number): string {
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const rest = minutes - days * MINUTES_PER_DAY;
  const hh = String(Math.floor(rest / 60)).padStart(2, "0");
  const mm = String(Math.round(rest % 60)).padStart(2, "0");
  return `${hh}:${mm}${days > 0 ? ` +${days}` : ""}`;
}

export const lineShiftInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    /** ISO weekdays it runs on (1 = Monday … 7 = Sunday), the day it starts. */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: clock,
    /** At or before `start`: crosses midnight into the next day. */
    end: clock,
  })
  .strict();
export type LineShiftInput = z.infer<typeof lineShiftInputSchema>;

/** Replaces every shift window of a line. An empty list: capacity is the line's hours per day again. */
export const lineShiftsSetSchema = z
  .object({ shifts: z.array(lineShiftInputSchema).max(LINE_SHIFTS_MAX) })
  .strict();
export type LineShiftsSetInput = z.infer<typeof lineShiftsSetSchema>;

/** A stored shift: `endMinute` is past `startMinute`, up to 24 hours later (more than 1440 crosses midnight). */
export interface LineShift {
  name: string;
  weekdays: readonly number[];
  startMinute: number;
  endMinute: number;
}

/** Minutes of a shift input as stored. */
export function lineShiftMinutes(input: Pick<LineShiftInput, "start" | "end">): {
  startMinute: number;
  endMinute: number;
} {
  const startMinute = clockToMinutes(input.start);
  let endMinute = clockToMinutes(input.end);
  if (endMinute <= startMinute) endMinute += MINUTES_PER_DAY;
  return { startMinute, endMinute };
}

export interface ShiftWindow {
  start: number;
  end: number;
  /** The shift names that make up the window (overlapping shifts merge). */
  names: string[];
}

/** The productive windows of a line on a date: its shifts that start on that weekday, overlaps merged. */
export function shiftWindows(shifts: readonly LineShift[], date: string): ShiftWindow[] {
  const weekday = isoWeekdayOf(date);
  const today = shifts
    .filter((s) => s.weekdays.includes(weekday))
    .map((s) => ({ start: s.startMinute, end: s.endMinute, names: [s.name] }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ShiftWindow[] = [];
  for (const w of today) {
    const last = out.at(-1);
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      if (!last.names.includes(w.names[0]!)) last.names.push(w.names[0]!);
    } else out.push({ ...w, names: [...w.names] });
  }
  return out;
}

export interface ShiftedLine {
  hoursPerDay: number;
  /** With shifts the line runs only in them: a weekday with none has no capacity. */
  shifts?: readonly LineShift[];
}

/**
 * Hours a line can run on a date: none on a day off; the length of its shift windows that day when
 * it has shifts; otherwise its hours per day.
 */
export function lineCapacityHours(line: ShiftedLine, date: string, dayOff: DayOff | null): number {
  if (dayOff) return 0;
  if (!line.shifts?.length) return line.hoursPerDay;
  const minutes = shiftWindows(line.shifts, date).reduce((t, w) => t + (w.end - w.start), 0);
  return Math.round((minutes / 60) * 100) / 100;
}

/** The windows a day plan is timed against: the shifts, or the hours per day from 06:00 without any. */
function planWindows(line: ShiftedLine, date: string, dayOff: DayOff | null): ShiftWindow[] {
  if (dayOff) return [];
  if (line.shifts?.length) return shiftWindows(line.shifts, date);
  return [
    {
      start: DEFAULT_DAY_START_MINUTE,
      end: DEFAULT_DAY_START_MINUTE + Math.round(line.hoursPerDay * 60),
      names: ["Hours per day"],
    },
  ];
}

// ─── Changeovers and allergens ───────────────────────────────────────────────

const minutes = z.number().int().min(0).max(MINUTES_PER_DAY);

export const changeoverRuleInputSchema = z
  .object({
    /** The recipe made before; null: any recipe. */
    fromRecipeId: z.uuid().nullable(),
    /** The recipe made next; null: any recipe. */
    toRecipeId: z.uuid().nullable(),
    minutes,
    note: z.string().trim().max(200).default(""),
  })
  .strict()
  .refine((v) => v.fromRecipeId !== null || v.toRecipeId !== null, {
    message: "Name the recipe before, after, or both; the line's default covers any to any",
  });
export type ChangeoverRuleInput = z.infer<typeof changeoverRuleInputSchema>;

/** Replaces every changeover rule of a line. */
export const lineChangeoversSetSchema = z
  .object({ rules: z.array(changeoverRuleInputSchema).max(LINE_CHANGEOVERS_MAX) })
  .strict()
  .refine(
    (v) => new Set(v.rules.map((r) => `${r.fromRecipeId}>${r.toRecipeId}`)).size === v.rules.length,
    "Each pair of recipes can have one rule",
  );
export type LineChangeoversSetInput = z.infer<typeof lineChangeoversSetSchema>;

export interface ChangeoverRule {
  fromRecipeId: string | null;
  toRecipeId: string | null;
  minutes: number;
  note?: string | null;
}

export type ChangeoverSource = "start" | "rule" | "same_recipe" | "line_default";

/**
 * Minutes to change a line from one recipe to the next. The same recipe again takes none unless a
 * rule names that exact pair (A→A); wildcard rules never apply to it. Otherwise the most specific
 * rule first: from→to, then from→any, then any→to, else the line's default.
 */
export function changeoverMinutes(
  rules: readonly ChangeoverRule[],
  lineDefault: number,
  fromRecipeId: string | null,
  toRecipeId: string,
): { minutes: number; source: ChangeoverSource; rule: ChangeoverRule | null } {
  if (fromRecipeId === null) return { minutes: 0, source: "start", rule: null };
  const find = (from: string | null, to: string | null) =>
    rules.find((r) => r.fromRecipeId === from && r.toRecipeId === to) ?? null;
  if (fromRecipeId === toRecipeId) {
    const exact = find(fromRecipeId, toRecipeId);
    return exact
      ? { minutes: exact.minutes, source: "rule", rule: exact }
      : { minutes: 0, source: "same_recipe", rule: null };
  }
  const rule = find(fromRecipeId, toRecipeId) ?? find(fromRecipeId, null) ?? find(null, toRecipeId);
  if (rule) return { minutes: rule.minutes, source: "rule", rule };
  return { minutes: lineDefault, source: "line_default", rule: null };
}

/**
 * Allergens a batch leaves on the line that the next one does not contain: a clean-down is needed
 * before it, whatever its "may contain" label says (a precautionary label is not a substitute for
 * cleaning). Empty when the next batch contains everything the previous one did.
 */
export const allergenCarryover = (
  previous: { contains: readonly AllergenCode[] } | null,
  next: { contains: readonly AllergenCode[] },
): AllergenCode[] => (previous ? previous.contains.filter((a) => !next.contains.includes(a)) : []);

// ─── Day plan ────────────────────────────────────────────────────────────────

export interface DayPlanLine extends ShiftedLine {
  id: string;
  name: string;
  changeoverMinutes: number;
  allergenCleanMinutes: number;
  /** People who can work the line at once; null: not limited. */
  crewAvailable: number | null;
  changeovers: readonly ChangeoverRule[];
}

/**
 * How a plan is explained. With `redactAllergens` (the caller can't read Food items) the timing is
 * the same, computed from the real declarations so every clean-down keeps its time, but no reason
 * names an allergen or says a product has none.
 */
export interface DayPlanOptions {
  redactAllergens?: boolean;
}

export interface DayPlanBatch {
  id: string;
  batchCode: string;
  recipeId: string;
  status: ProductionBatchStatus;
  /** Run time on this line; null without a rate (the line has none for the recipe). */
  runMinutes: number | null;
  /** People the line needs for the recipe; null: not set. */
  crew: number | null;
  /** The pinned recipe version's approved ingredient roll-up together with the output item's own declaration. */
  contains: readonly AllergenCode[];
  mayContain: readonly AllergenCode[];
}

export interface PlanStep {
  batchId: string;
  batchCode: string;
  position: number;
  changeover: {
    minutes: number;
    source: ChangeoverSource;
    /** A clean-down comes first: the previous batch leaves an allergen this one doesn't contain. */
    cleanDown: boolean;
    /** Allergens left by the previous batch that this one doesn't contain: a clean-down first. */
    allergenClean: AllergenCode[];
    reason: string;
  };
  /** Minutes from the start of the production day; the changeover ends at `start`. */
  changeoverStart: number;
  start: number;
  end: number;
  runMinutes: number | null;
  crew: number | null;
  /** Ends after the last shift window. */
  overrun: boolean;
  warnings: string[];
}

export interface DayPlan {
  date: string;
  dayOff: DayOff | null;
  windows: ShiftWindow[];
  /** Whether the windows are the line's shifts, or its hours per day from 06:00 (no shifts set). */
  timing: "shifts" | "hours_per_day" | "day_off";
  capacityMinutes: number;
  runMinutes: number;
  changeoverMinutes: number;
  cleanDowns: number;
  /** When the last batch ends; null with no batches. */
  endMinute: number | null;
  /** Minutes past the last window's end (0 when it fits). */
  overrunMinutes: number;
  /** Batches without a rate: their run time is unknown, so later times are understated. */
  unrated: number;
  /** Run hours × crew over batches with both. */
  labourHours: number;
  steps: PlanStep[];
  warnings: string[];
}

/** Runs `minutes` of work from `cursor` inside the windows, pausing between them; past the last, continues. */
function place(cursor: number, minutes: number, windows: readonly ShiftWindow[]) {
  let remaining = minutes;
  let start: number | null = null;
  for (const w of windows) {
    if (cursor >= w.end) continue;
    if (cursor < w.start) cursor = w.start;
    start ??= cursor;
    const take = Math.min(remaining, w.end - cursor);
    cursor += take;
    remaining -= take;
    if (remaining <= 0) return { start, end: cursor };
  }
  return { start: start ?? cursor, end: cursor + remaining };
}

/** "Cereals containing gluten, Milk": the names, not the codes. */
const allergenList = (codes: readonly AllergenCode[]) => codes.map((c) => allergens[c] ?? c).join(", ");

function changeoverReason(
  previous: DayPlanBatch | null,
  next: DayPlanBatch,
  co: ReturnType<typeof changeoverMinutes>,
  clean: AllergenCode[],
  line: DayPlanLine,
  redact: boolean,
): string {
  if (!previous) return "First batch of the day: assumes the line starts clean";
  const base =
    co.source === "rule"
      ? `${co.minutes} min changeover rule${co.rule?.note ? ` (${co.rule.note})` : ""}`
      : co.source === "same_recipe"
        ? "Same recipe as the batch before: no changeover"
        : `${co.minutes} min line default changeover`;
  if (clean.length === 0) return base;
  const minutes = Math.max(co.minutes, line.allergenCleanMinutes);
  if (redact)
    return `Allergen clean-down: ${previous.batchCode} leaves an allergen ${next.batchCode} doesn't contain; takes ${minutes} min, the longer of the clean-down and the changeover`;
  const covered = clean.filter((a) => next.mayContain.includes(a));
  return `Allergen clean-down: ${previous.batchCode} contains ${allergenList(clean)} and ${next.batchCode} doesn't${
    covered.length ? ` (its "may contain" label doesn't replace cleaning)` : ""
  }; takes ${minutes} min, the longer of the clean-down and the changeover`;
}

/**
 * Times the batches of one line on one day in the order given: each one's changeover (the rule or
 * default, raised to the line's allergen clean-down time when the previous batch leaves an allergen
 * this one doesn't contain), then its run, inside the shift windows. Work pauses between windows and
 * continues past the last one, which is reported as an overrun. Pure; nothing is stored.
 */
export function planLineDay(
  line: DayPlanLine,
  date: string,
  dayOff: DayOff | null,
  batches: readonly DayPlanBatch[],
  options: DayPlanOptions = {},
): DayPlan {
  const windows = planWindows(line, date, dayOff);
  const timing: DayPlan["timing"] = dayOff ? "day_off" : line.shifts?.length ? "shifts" : "hours_per_day";
  const capacityMinutes = windows.reduce((t, w) => t + (w.end - w.start), 0);
  const lastEnd = windows.at(-1)?.end ?? DEFAULT_DAY_START_MINUTE;
  let cursor = windows[0]?.start ?? DEFAULT_DAY_START_MINUTE;
  let previous: DayPlanBatch | null = null;
  const steps: PlanStep[] = [];
  for (const [i, b] of batches.entries()) {
    const co = changeoverMinutes(
      line.changeovers,
      line.changeoverMinutes,
      previous?.recipeId ?? null,
      b.recipeId,
    );
    const clean = allergenCarryover(previous, b);
    const coMinutes = clean.length ? Math.max(co.minutes, line.allergenCleanMinutes) : co.minutes;
    const c = place(cursor, coMinutes, windows);
    const run = place(c.end, b.runMinutes ?? 0, windows);
    const warnings: string[] = [];
    if (b.runMinutes === null)
      warnings.push(`${line.name} has no rate for this recipe, so its run time is unknown`);
    if (b.crew !== null && line.crewAvailable !== null && b.crew > line.crewAvailable)
      warnings.push(`Needs ${b.crew} people; ${line.name} has ${line.crewAvailable}`);
    const overrun = run.end > lastEnd || windows.length === 0;
    if (overrun && windows.length > 0)
      warnings.push(`Runs past the end of the last shift (${minutesToClock(lastEnd)})`);
    steps.push({
      batchId: b.id,
      batchCode: b.batchCode,
      position: i + 1,
      changeover: {
        minutes: coMinutes,
        source: co.source,
        cleanDown: clean.length > 0,
        allergenClean: clean,
        reason: changeoverReason(previous, b, co, clean, line, !!options.redactAllergens),
      },
      changeoverStart: c.start,
      start: run.start,
      end: run.end,
      runMinutes: b.runMinutes,
      crew: b.crew,
      overrun,
      warnings,
    });
    cursor = run.end;
    previous = b;
  }
  const endMinute = steps.at(-1)?.end ?? null;
  const overrunMinutes =
    endMinute === null
      ? 0
      : windows.length
        ? Math.max(0, endMinute - lastEnd)
        : endMinute - DEFAULT_DAY_START_MINUTE;
  const unrated = batches.filter((b) => b.runMinutes === null).length;
  const warnings: string[] = [];
  if (dayOff && batches.length)
    warnings.push(
      `${date} is a non-working day for ${line.name}${dayOff.reason ? ` (${dayOff.reason})` : ""}`,
    );
  else if (timing === "shifts" && windows.length === 0 && batches.length)
    warnings.push(`${line.name} has no shift on this weekday`);
  if (timing === "hours_per_day" && batches.length)
    warnings.push(`${line.name} has no shifts set, so times assume ${line.hoursPerDay} h from 06:00`);
  if (overrunMinutes > 0 && windows.length)
    warnings.push(`The day runs ${overrunMinutes} min past the last shift`);
  if (unrated)
    warnings.push(
      `${unrated} batch${unrated === 1 ? " has" : "es have"} no rate on this line, so later times are understated`,
    );
  const crewShort = steps.filter(
    (s) => s.crew !== null && line.crewAvailable !== null && s.crew > line.crewAvailable,
  ).length;
  if (crewShort)
    warnings.push(
      `${crewShort} batch${crewShort === 1 ? " needs" : "es need"} more people than the line has`,
    );
  return {
    date,
    dayOff,
    windows,
    timing,
    capacityMinutes,
    runMinutes: batches.reduce((t, b) => t + (b.runMinutes ?? 0), 0),
    changeoverMinutes: steps.reduce((t, s) => t + s.changeover.minutes, 0),
    cleanDowns: steps.filter((s) => s.changeover.cleanDown).length,
    endMinute,
    overrunMinutes,
    unrated,
    labourHours:
      Math.round(
        batches.reduce(
          (t, b) => t + (b.runMinutes !== null && b.crew !== null ? (b.runMinutes / 60) * b.crew : 0),
          0,
        ) * 100,
      ) / 100,
    steps,
    warnings,
  };
}

// ─── Proposal ────────────────────────────────────────────────────────────────

export interface ProposalStep {
  batchId: string;
  batchCode: string;
  /** Why this batch comes here. */
  reason: string;
  /** Started or finished batches keep their place at the front. */
  fixed: boolean;
}

export interface SequenceProposal {
  order: ProposalStep[];
  current: Pick<DayPlan, "changeoverMinutes" | "cleanDowns" | "endMinute" | "overrunMinutes">;
  proposed: Pick<DayPlan, "changeoverMinutes" | "cleanDowns" | "endMinute" | "overrunMinutes">;
  /** The proposed order differs from the current one. */
  changed: boolean;
  /** Fewer clean-downs, or as many and less changeover time. */
  improves: boolean;
  method: string;
}

export const PROPOSAL_METHOD =
  "Started and finished batches stay first. Then, one at a time, the next batch is the one that avoids an allergen clean-down, then has the shortest changeover (a clean-down counts its full time), then the fewest allergens, then keeps the current order. Starting the day with the fewest allergens means allergen-free products run first.";

/**
 * Proposes an order for a line's day: greedy and explainable (see {@link PROPOSAL_METHOD}). It
 * changes nothing; compare `current` with `proposed` and apply the order if it suits.
 */
export function proposeLineDaySequence(
  line: DayPlanLine,
  date: string,
  dayOff: DayOff | null,
  batches: readonly DayPlanBatch[],
  options: DayPlanOptions = {},
): SequenceProposal {
  const fixed = batches.filter((b) => b.status !== "planned");
  const remaining = batches.filter((b) => b.status === "planned");
  const order: ProposalStep[] = fixed.map((b) => ({
    batchId: b.id,
    batchCode: b.batchCode,
    reason: b.status === "in_progress" ? "Already started" : `Already ${b.status}`,
    fixed: true,
  }));
  const chosen: DayPlanBatch[] = [...fixed];
  let previous: DayPlanBatch | null = fixed.at(-1) ?? null;
  const position = new Map(batches.map((b, i) => [b.id, i]));
  while (remaining.length) {
    const scored = remaining.map((b) => {
      const clean = allergenCarryover(previous, b).length > 0;
      const co = changeoverMinutes(
        line.changeovers,
        line.changeoverMinutes,
        previous?.recipeId ?? null,
        b.recipeId,
      ).minutes;
      // The time it really takes: a clean-down raises the changeover to the clean-down time.
      return { b, clean, minutes: clean ? Math.max(co, line.allergenCleanMinutes) : co };
    });
    scored.sort(
      (x, y) =>
        Number(x.clean) - Number(y.clean) ||
        x.minutes - y.minutes ||
        x.b.contains.length - y.b.contains.length ||
        position.get(x.b.id)! - position.get(y.b.id)!,
    );
    const pick = scored[0]!;
    const next = scored[1];
    // Name the criterion that actually separated the pick from the runner-up.
    const tieOn = (k: "clean" | "minutes" | "allergens") =>
      !next ||
      (k === "clean"
        ? next.clean === pick.clean
        : k === "minutes"
          ? next.clean === pick.clean && next.minutes === pick.minutes
          : next.clean === pick.clean &&
            next.minutes === pick.minutes &&
            next.b.contains.length === pick.b.contains.length);
    const allergenNote = options.redactAllergens
      ? "fewest allergens"
      : pick.b.contains.length
        ? `fewest allergens (${allergenList(pick.b.contains)})`
        : "contains no allergens";
    let reason: string;
    if (!previous) {
      reason = `Starts the day: ${allergenNote}`;
    } else if (pick.clean) {
      const why = !next
        ? "the last batch"
        : !tieOn("minutes")
          ? `shortest of them (${pick.minutes} min)`
          : !tieOn("allergens")
            ? allergenNote
            : "keeps the current order";
      reason = `Clean-down unavoidable: every remaining batch lacks an allergen ${previous.batchCode} contains; ${why}`;
    } else if (next && !tieOn("clean")) {
      reason = `Avoids an allergen clean-down after ${previous.batchCode}${pick.minutes ? ` (${pick.minutes} min changeover)` : ""}`;
    } else if (next && !tieOn("minutes")) {
      reason =
        pick.minutes === 0
          ? `No changeover after ${previous.batchCode}`
          : `Shortest changeover after ${previous.batchCode} (${pick.minutes} min)`;
    } else if (next && !tieOn("allergens")) {
      reason = `Same changeover as the alternatives (${pick.minutes} min); ${allergenNote}`;
    } else {
      reason = next
        ? `Same changeover and allergens as the alternatives (${pick.minutes} min); keeps the current order`
        : `Last batch (${pick.minutes} min changeover after ${previous.batchCode})`;
    }
    order.push({ batchId: pick.b.id, batchCode: pick.b.batchCode, reason, fixed: false });
    chosen.push(pick.b);
    remaining.splice(remaining.indexOf(pick.b), 1);
    previous = pick.b;
  }
  const summary = (plan: DayPlan) => ({
    changeoverMinutes: plan.changeoverMinutes,
    cleanDowns: plan.cleanDowns,
    endMinute: plan.endMinute,
    overrunMinutes: plan.overrunMinutes,
  });
  const current = summary(planLineDay(line, date, dayOff, batches, options));
  const proposed = summary(planLineDay(line, date, dayOff, chosen, options));
  const changed = chosen.some((b, i) => b.id !== batches[i]!.id);
  return {
    order,
    current,
    proposed,
    changed,
    improves:
      changed &&
      (proposed.cleanDowns < current.cleanDowns ||
        (proposed.cleanDowns === current.cleanDowns &&
          proposed.changeoverMinutes < current.changeoverMinutes)),
    method: PROPOSAL_METHOD,
  };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const lineDayQuerySchema = z.object({ lineId: z.uuid(), date: z.iso.date() });
export type LineDayQuery = z.infer<typeof lineDayQuerySchema>;

export const LINE_DAY_MAX_BATCHES = 500;

/**
 * The order of every live batch on a line's day, first to last. Refused if the set has changed, or
 * (with `expectedBatchIds`, the order the plan was read in) if someone else reordered it meanwhile.
 */
export const lineSequenceSetSchema = z
  .object({
    lineId: z.uuid(),
    date: z.iso.date(),
    batchIds: z.array(z.uuid()).min(1).max(LINE_DAY_MAX_BATCHES),
    expectedBatchIds: z.array(z.uuid()).max(LINE_DAY_MAX_BATCHES).optional(),
  })
  .strict()
  .refine((v) => new Set(v.batchIds).size === v.batchIds.length, "A batch can appear once");
export type LineSequenceSetInput = z.infer<typeof lineSequenceSetSchema>;

// ─── Daily demand ────────────────────────────────────────────────────────────

export const DAILY_DEMAND_MAX_DAYS = 31;
export const dailyDemandQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(DAILY_DEMAND_MAX_DAYS).default(14),
  itemId: z.uuid().optional(),
});
export type DailyDemandQuery = z.infer<typeof dailyDemandQuerySchema>;

export interface DailyDemandDayInput {
  date: string;
  committed: number;
  planned: number;
}

export interface DailyDemandDay extends DailyDemandDayInput {
  /** Opening stock + planned so far − committed so far; null without stock figures. */
  projected: number | null;
  short: boolean;
}

/**
 * One item's days: confirmed commitments due and planned output each day, and the running
 * projection from today's free stock. Commitments overdue before today and planned batches whose
 * date has passed count on the first day. Weekly demand (forecasts and entered demand) is reported
 * beside it and never added in, so an order and its forecast are not counted twice.
 */
export function projectDailyDemand(
  opening: number | null,
  days: readonly DailyDemandDayInput[],
): { days: DailyDemandDay[]; firstShortDate: string | null } {
  let running = opening ?? 0;
  let firstShortDate: string | null = null;
  const out = days.map((d) => {
    running = Math.round((running + d.planned - d.committed) * 10_000) / 10_000;
    const short = opening !== null && running < -1e-9;
    if (short && !firstShortDate) firstShortDate = d.date;
    return { ...d, projected: opening === null ? null : running, short };
  });
  return { days: out, firstShortDate };
}
