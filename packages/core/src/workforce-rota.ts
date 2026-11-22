import { z } from "zod";
import { inclusiveDays } from "./time";

/**
 * Workforce planning beyond leave (Phase 3.4.4.2 and 3.4.4.3): shifts, rotas, working patterns,
 * agency engagements and competence-based staffing requirements. Agency workers are People
 * records; competence comes from Training. See docs/workforce.md.
 */

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Monday first, matching the bit order of a weekday mask (Monday = bit 0 … Sunday = bit 6). */
export const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const ALL_WEEKDAYS = 0b1111111;
export const WEEKDAYS_MON_FRI = 0b0011111;

/** 0 = Monday … 6 = Sunday, for an ISO date. */
export function isoWeekday(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}
export const onWeekday = (mask: number, date: string) => (mask & (1 << isoWeekday(date))) !== 0;
export function weekdayLabel(mask: number): string {
  if (mask === ALL_WEEKDAYS) return "Every day";
  if (mask === WEEKDAYS_MON_FRI) return "Mon–Fri";
  return weekdayNames.filter((_, i) => mask & (1 << i)).join(", ") || "No days";
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/**
 * A shift on a date as an absolute minute range [start, end). A shift whose end is not after its
 * start crosses midnight and ends the next day.
 */
export function shiftWindow(date: string, shift: { startTime: string; endTime: string }) {
  const start = dayNumber(date) * 1440 + minutesOf(shift.startTime);
  let end = dayNumber(date) * 1440 + minutesOf(shift.endTime);
  if (end <= start) end += 1440;
  return { start, end };
}
export const windowsOverlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;
/** Shift length in minutes. */
export const shiftMinutes = (shift: { startTime: string; endTime: string }) => {
  const w = shiftWindow("2000-01-03", shift);
  return w.end - w.start;
};

/** Every ISO date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = dayNumber(from); d <= dayNumber(to); d++)
    out.push(new Date(d * 86_400_000).toISOString().slice(0, 10));
  return out;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const name = z.string().trim().min(1).max(120);
const reason = z.string().trim().min(1).max(2000);
const note = z.string().trim().max(2000).default("");
const time = z.string().regex(TIME, "Use a 24-hour time such as 06:00");
const weekdays = z.number().int().min(1).max(ALL_WEEKDAYS);
const command = { commandId: z.uuid() };
const revision = { expectedRevision: z.number().int().positive() };
const validity = { validFrom: z.iso.date(), validTo: z.iso.date().nullable().default(null) };
const validRange = (v: { validFrom: string; validTo: string | null }) =>
  !v.validTo || v.validTo >= v.validFrom;
const rangeMessage = "The end date must be on or after the start date";

export const shiftCreateSchema = z
  .object({
    ...command,
    name,
    startTime: time,
    endTime: time,
    lineId: z.uuid().nullable().default(null),
  })
  .strict()
  .refine((v) => v.startTime !== v.endTime, "A shift can't start and end at the same time");
export const shiftUpdateSchema = z
  .object({
    ...command,
    ...revision,
    name,
    startTime: time,
    endTime: time,
    lineId: z.uuid().nullable(),
    active: z.boolean(),
  })
  .strict()
  .refine((v) => v.startTime !== v.endTime, "A shift can't start and end at the same time");

export const rotaEntryCreateSchema = z
  .object({
    ...command,
    shiftId: z.uuid(),
    staffId: z.uuid(),
    workDate: z.iso.date(),
    jobRoleId: z.uuid().nullable().default(null),
    note,
  })
  .strict();
export const rotaEntryCancelSchema = z.object({ ...command, ...revision, reason }).strict();

export const workingPatternCreateSchema = z
  .object({
    ...command,
    staffId: z.uuid(),
    shiftId: z.uuid(),
    weekdays,
    jobRoleId: z.uuid().nullable().default(null),
    ...validity,
  })
  .strict()
  .refine(validRange, rangeMessage);
export const workingPatternEndSchema = z
  .object({ ...command, ...revision, validTo: z.iso.date(), reason })
  .strict();

const window = (max: number) =>
  z
    .object({ from: z.iso.date(), to: z.iso.date() })
    .refine(
      (v) => v.to >= v.from && inclusiveDays(v.from, v.to) <= max,
      `Choose a date window of no more than ${max} days`,
    );
export const ROTA_WINDOW_DAYS = 31;
export const GENERATE_WINDOW_DAYS = 62;
export const rotaQuerySchema = window(ROTA_WINDOW_DAYS);
export const staffingQuerySchema = window(ROTA_WINDOW_DAYS);
export const rotaGenerateSchema = z
  .object({
    ...command,
    from: z.iso.date(),
    to: z.iso.date(),
    staffIds: z.array(z.uuid()).max(500).optional(),
  })
  .strict()
  .refine(
    (v) => v.to >= v.from && inclusiveDays(v.from, v.to) <= GENERATE_WINDOW_DAYS,
    `Generate at most ${GENERATE_WINDOW_DAYS} days at a time`,
  );

export const agencyCreateSchema = z
  .object({ ...command, name, contact: z.string().trim().max(500).default("") })
  .strict();
export const agencyUpdateSchema = z
  .object({ ...command, ...revision, name, contact: z.string().trim().max(500), active: z.boolean() })
  .strict();
export const agencyEngagementCreateSchema = z
  .object({
    ...command,
    agencyId: z.uuid(),
    staffId: z.uuid(),
    startOn: z.iso.date(),
    endOn: z.iso.date().nullable().default(null),
    reference: z.string().trim().max(200).default(""),
  })
  .strict()
  .refine((v) => !v.endOn || v.endOn >= v.startOn, rangeMessage);
export const agencyEngagementEndSchema = z
  .object({ ...command, ...revision, endOn: z.iso.date(), reason })
  .strict();

export const staffingAppliesWhen = ["always", "production_planned"] as const;
export type StaffingAppliesWhen = (typeof staffingAppliesWhen)[number];
export const staffingAppliesWhenLabels: Record<StaffingAppliesWhen, string> = {
  always: "Every scheduled day",
  production_planned: "Only when production is planned on the line",
};
const requirementFields = {
  shiftId: z.uuid(),
  name,
  headcount: z.number().int().min(1).max(500),
  jobRoleId: z.uuid().nullable().default(null),
  courseIds: z.array(z.uuid()).max(10).default([]),
  weekdays: weekdays.default(ALL_WEEKDAYS),
  appliesWhen: z.enum(staffingAppliesWhen).default("always"),
  ...validity,
};
const distinctCourses = (v: { courseIds: string[] }) => new Set(v.courseIds).size === v.courseIds.length;
export const staffingRequirementCreateSchema = z
  .object({ ...command, ...requirementFields })
  .strict()
  .refine(validRange, rangeMessage)
  .refine(distinctCourses, "List each course once")
  .refine((v) => v.jobRoleId || v.courseIds.length, "Require a job role, a course, or both");
export const staffingRequirementUpdateSchema = z
  .object({ ...command, ...revision, ...requirementFields, active: z.boolean() })
  .strict()
  .refine(validRange, rangeMessage)
  .refine(distinctCourses, "List each course once")
  .refine((v) => v.jobRoleId || v.courseIds.length, "Require a job role, a course, or both");

/** Why a rostered person doesn't count towards a requirement. */
export const staffingGapReasons = [
  "unavailable",
  "role_not_held",
  "training_missing",
  "training_expired",
  "training_expires_before_shift",
  "training_awaiting_sign_off",
  "training_outdated",
  "course_archived",
  /** Shown instead of the per-course reason to readers without Training access. */
  "competence_not_met",
] as const;
export type StaffingGapReason = (typeof staffingGapReasons)[number];
export const staffingGapReasonLabels: Record<StaffingGapReason, string> = {
  unavailable: "Recorded as unavailable",
  role_not_held: "Doesn't hold the job role",
  training_missing: "Not trained",
  training_expired: "Training expired",
  training_expires_before_shift: "Training expires before the shift",
  training_awaiting_sign_off: "Training awaiting sign-off",
  training_outdated: "Trained on an outdated SOP version",
  course_archived: "Required course is archived",
  competence_not_met: "Doesn't meet the training requirement",
};

/** Why a rota entry or pattern date was not created when generating. */
export const rotaSkipReasons = [
  "already_rostered",
  "overlaps_another_shift",
  "unavailable",
  "not_employed",
  "role_not_held",
  "shift_inactive",
] as const;
export type RotaSkipReason = (typeof rotaSkipReasons)[number];
export const rotaSkipReasonLabels: Record<RotaSkipReason, string> = {
  already_rostered: "Already on this shift",
  overlaps_another_shift: "Overlaps another shift",
  unavailable: "Recorded as unavailable",
  not_employed: "Not employed on that date",
  role_not_held: "Doesn't hold the job role",
  shift_inactive: "Shift is inactive",
};
