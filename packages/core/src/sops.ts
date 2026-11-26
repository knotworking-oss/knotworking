import { z } from "zod";
import { docContentSchema } from "./content";

/**
 * SOPs module: standard operating procedures under document control (BRCGS). An SOP has a working
 * draft and a list of immutable versions; exactly one version is the current approved one. Shared
 * vocabulary, validation and the pure rules (review dates, four-eyes). No DOM or Node APIs.
 */

export const sopStatuses = ["active", "archived"] as const;
export type SopStatus = (typeof sopStatuses)[number];

export const sopVersionStatuses = ["in_review", "approved", "rejected", "superseded"] as const;
export type SopVersionStatus = (typeof sopVersionStatuses)[number];
export const sopVersionStatusLabels: Record<SopVersionStatus, string> = {
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

export const sopCopyStatuses = ["issued", "returned", "destroyed"] as const;
export type SopCopyStatus = (typeof sopCopyStatuses)[number];
export const sopCopyStatusLabels: Record<SopCopyStatus, string> = {
  issued: "Issued",
  returned: "Returned",
  destroyed: "Destroyed",
};

/** Months between reviews unless the SOP says otherwise. */
export const DEFAULT_SOP_REVIEW_INTERVAL_MONTHS = 12;
/** Days an acknowledgement may stay outstanding before reminders go out, unless the SOP says otherwise. */
export const DEFAULT_SOP_ACK_REMINDER_DAYS = 14;
/** A review is "due soon" from this many days before its date. */
export const SOP_REVIEW_SOON_DAYS = 30;

// ─── Dates (plain `YYYY-MM-DD`, compared as strings) ─────────────────────────

/** The first and last dates a `YYYY-MM-DD` string can hold; derived dates outside them are refused. */
export const ISO_DATE_MIN = "0001-01-01";
export const ISO_DATE_MAX = "9999-12-31";

/** Whether `date` is a four-digit-year `YYYY-MM-DD` from 0001-01-01 to 9999-12-31 (so it sorts as text). */
export const isIsoDateInRange = (date: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= ISO_DATE_MIN && date <= ISO_DATE_MAX;

const pad = (n: number) => String(n).padStart(2, "0");
/**
 * Years 0–9999 as four digits; any other year in the ISO expanded form (`+010000`, `-000001`), as
 * `Date#toISOString` writes it, so an out-of-range result is never mistaken for a valid date.
 */
const isoYear = (year: number) =>
  year >= 0 && year <= 9999
    ? String(year).padStart(4, "0")
    : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
const toIso = (d: Date) =>
  `${isoYear(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** Midnight UTC on a calendar date. Unlike `Date.UTC`, years 0–99 stay themselves (not 1900–1999). */
const utcDate = (year: number, monthIndex: number, day: number) => {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  return d;
};
const fromIso = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return utcDate(y!, m! - 1, d!);
};

/**
 * The UTC date of an instant as `YYYY-MM-DD`. Not for business dates: those are decided in the
 * workspace's time zone (`todayInZone`, `dateInZone`).
 */
export const isoToday = (now: Date = new Date()): string => toIso(now);

export function addDaysToIsoDate(date: string, days: number): string {
  const d = fromIso(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

/** Adds calendar months, clamping to the last day of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsToIsoDate(date: string, months: number): string {
  const d = fromIso(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toIso(d);
}

/** When a version that takes effect on `effectiveOn` is next reviewed, unless the approver says otherwise. */
export const defaultSopReviewDueOn = (effectiveOn: string, reviewIntervalMonths: number): string =>
  addMonthsToIsoDate(effectiveOn, reviewIntervalMonths);

export const sopReviewStates = ["overdue", "soon", "ok"] as const;
export type SopReviewState = (typeof sopReviewStates)[number];

/**
 * Where an approved version stands against its review date: `overdue` once the date has passed,
 * `soon` within `SOP_REVIEW_SOON_DAYS` (the date itself included), otherwise `ok`. `null` when
 * there is no review date (no approved version yet).
 */
export function sopReviewState(
  reviewDueOn: string | null | undefined,
  today: string,
  soonDays: number = SOP_REVIEW_SOON_DAYS,
): SopReviewState | null {
  if (!reviewDueOn) return null;
  if (reviewDueOn < today) return "overdue";
  return reviewDueOn <= addDaysToIsoDate(today, soonDays) ? "soon" : "ok";
}

/**
 * Four-eyes: the person who submitted a version may not approve it, unless nobody else could
 * (they are the only member with `manage` in the module). `managerIds` are the members who hold
 * `manage`.
 */
export function canApproveSopVersion(input: {
  submittedBy: string | null;
  deciderId: string;
  managerIds: readonly string[];
}): boolean {
  if (input.submittedBy !== input.deciderId) return true;
  return input.managerIds.every((id) => id === input.deciderId);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
/** `YYYY-MM-DD`. */
const isoDate = z.iso.date();

const sopFields = {
  /** Document reference, e.g. `SOP-001`. Unique among live SOPs, case-insensitively. */
  code: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(300),
  category: optionalText(80),
  ownerId: z.uuid().nullable(),
  reviewIntervalMonths: z.number().int().min(1).max(120),
  /** Outstanding acknowledgements are chased after this many days (see the reminder sweep). */
  ackReminderDays: z.number().int().min(1).max(365),
  /**
   * A person still outstanding is reminded again every this many days after the first reminder;
   * `null`: the first reminder is the only one.
   */
  ackReminderRepeatDays: z.number().int().min(1).max(365).nullable(),
};

export const sopCreateSchema = z.object({
  /** Client-generated id, like tasks. */
  id: z.uuid().optional(),
  code: sopFields.code,
  title: sopFields.title,
  category: sopFields.category.optional(),
  ownerId: sopFields.ownerId.optional(),
  reviewIntervalMonths: sopFields.reviewIntervalMonths.optional(),
  ackReminderDays: sopFields.ackReminderDays.optional(),
  ackReminderRepeatDays: sopFields.ackReminderRepeatDays.optional(),
  /** Optional first draft. */
  content: docContentSchema.optional(),
});
export type SopCreateInput = z.infer<typeof sopCreateSchema>;

export const sopUpdateSchema = z
  .object({ ...sopFields, status: z.enum(sopStatuses) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type SopUpdateInput = z.infer<typeof sopUpdateSchema>;

/** Saves the working draft. `content: null` discards it. */
export const sopDraftSchema = z.object({
  content: docContentSchema.nullable(),
  /** The title the next version will carry; defaults to the SOP's title. */
  title: sopFields.title.optional(),
  /**
   * The `draftUpdatedAt` the caller last saw (`null`: never saved). When given and the draft has
   * been saved since, the write is refused with 409 `draft_conflict`.
   */
  expectedDraftUpdatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type SopDraftInput = z.infer<typeof sopDraftSchema>;

export const sopSubmitSchema = z.object({
  /** What changed and why: shown to the approver and kept with the version. */
  changeSummary: z.string().trim().min(1).max(2000),
});
export type SopSubmitInput = z.infer<typeof sopSubmitSchema>;

/** The decision on a version in review: a sign-off by a person with `manage`. */
export const sopDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    /** Default: today. May be in the future. */
    effectiveOn: isoDate.optional(),
    /** Default: `effectiveOn` plus the SOP's review interval. */
    reviewDueOn: isoDate.optional(),
    note: optionalText(2000).optional(),
  }),
  z.object({
    decision: z.literal("reject"),
    /** Why, so the author can rework the draft. */
    note: z.string().trim().min(1).max(2000),
  }),
]);
export type SopDecisionInput = z.infer<typeof sopDecisionSchema>;

export const sopAcknowledgeSchema = z.object({
  /** The version the reader has in front of them; refused if it is no longer the current one. */
  versionId: z.uuid().optional(),
});
export type SopAcknowledgeInput = z.infer<typeof sopAcknowledgeSchema>;

/**
 * Who must read an SOP: members who hold any of these job roles (through their linked staff
 * record) and/or these named members. Both empty means everyone with `read` on SOPs, as before.
 */
export const sopTargetsSchema = z.object({
  jobRoleIds: z.array(z.uuid()).max(100).default([]),
  userIds: z.array(z.uuid()).max(500).default([]),
});
export type SopTargetsInput = z.infer<typeof sopTargetsSchema>;

export const sopOutstandingQuerySchema = z.object({
  sopId: z.uuid().optional(),
  userId: z.uuid().optional(),
  /** Only acknowledgements outstanding for at least this many days. */
  minDays: z.coerce.number().int().min(0).max(3650).optional(),
});
export type SopOutstandingQuery = z.infer<typeof sopOutstandingQuerySchema>;

/** Whole days from `since` to `today` (both `YYYY-MM-DD`); 0 when `since` is today or later. */
export function daysOutstanding(since: string, today: string): number {
  const ms = fromIso(today).getTime() - fromIso(since).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * Which reminder an outstanding acknowledgement is on, given `days` outstanding: 0 is the first
 * (once `ackReminderDays` have passed), 1 the first repeat (`repeatDays` later), and so on. `null`
 * before the first. Without a repeat interval the first is the only one. Only the latest round is
 * ever due, so a long-outstanding person gets one reminder per round, never a burst to catch up.
 */
export function sopReminderRound(
  days: number,
  ackReminderDays: number,
  repeatDays: number | null,
): number | null {
  if (days < ackReminderDays) return null;
  if (!repeatDays) return 0;
  return Math.floor((days - ackReminderDays) / repeatDays);
}

/** The day reminder `round` falls due: `since` plus the first interval and `round` repeats. */
export const sopReminderDueOn = (
  since: string,
  ackReminderDays: number,
  repeatDays: number | null,
  round: number,
): string => addDaysToIsoDate(since, ackReminderDays + round * (repeatDays ?? 0));

export const sopListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(80).optional(),
  /** Default: active SOPs only. */
  status: z.enum([...sopStatuses, "all"]).default("active"),
  /** By the current version's review date: past it, or within `SOP_REVIEW_SOON_DAYS`. */
  due: z.enum(["overdue", "soon"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SopListQuery = z.infer<typeof sopListQuerySchema>;

// ─── Controlled copies ───────────────────────────────────────────────────────

/**
 * Issues a printed controlled copy of an approved version to a member and/or a named person or
 * place. Without `versionId` it is the current approved version.
 */
export const sopCopyIssueSchema = z
  .object({
    versionId: z.uuid().optional(),
    /** A member holding the copy. */
    issuedToUserId: z.uuid().nullable().optional(),
    /** A name or place ("Packing room wall file"); defaults to the member's name. */
    issuedTo: z.string().trim().min(1).max(200).optional(),
    location: optionalText(200).optional(),
  })
  .refine((v) => v.issuedToUserId || v.issuedTo, {
    message: "Say who or where the copy is issued to",
    path: ["issuedTo"],
  });
export type SopCopyIssueInput = z.infer<typeof sopCopyIssueSchema>;

/** Calls a copy in: returned to the document controller, or destroyed. */
export const sopCopyCloseSchema = z.object({
  status: z.enum(["returned", "destroyed"]),
  note: optionalText(1000).optional(),
});
export type SopCopyCloseInput = z.infer<typeof sopCopyCloseSchema>;

export const sopCopyListQuerySchema = z.object({
  sopId: z.uuid().optional(),
  /** Default: copies still out (`issued`). */
  status: z.enum([...sopCopyStatuses, "all"]).default("issued"),
  /** Only issued copies of a version that is no longer the current one: the ones to call in. */
  outOfDate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SopCopyListQuery = z.infer<typeof sopCopyListQuerySchema>;
