import { z } from "zod";

/**
 * Training module: courses, which job roles need them (the training matrix), and append-only
 * training records with a competency sign-off. Builds on the People module's staff register and,
 * when it is active, on SOPs. No DOM or Node APIs.
 */

export const trainingCourseKinds = ["sop", "induction", "on_the_job", "external", "certificate"] as const;
export type TrainingCourseKind = (typeof trainingCourseKinds)[number];
export const trainingCourseKindLabels: Record<TrainingCourseKind, string> = {
  sop: "SOP",
  induction: "Induction",
  on_the_job: "On the job",
  external: "External course",
  certificate: "Certificate",
};

export const trainingCourseStatuses = ["active", "archived"] as const;
export type TrainingCourseStatus = (typeof trainingCourseStatuses)[number];

export const trainingOutcomes = ["competent", "not_yet_competent", "attended"] as const;
export type TrainingOutcome = (typeof trainingOutcomes)[number];
export const trainingOutcomeLabels: Record<TrainingOutcome, string> = {
  competent: "Competent",
  not_yet_competent: "Not yet competent",
  attended: "Attended",
};

/**
 * Where a person stands on a course, derived on read (never stored):
 * - `current`: trained, in date, on the SOP's current version;
 * - `expiring`: in date but expiring within `TRAINING_EXPIRING_DAYS`;
 * - `expired`: the latest training has run out;
 * - `outdated`: trained on an SOP version that has since been replaced;
 * - `pending_sign_off`: trained but waiting for a competency sign-off;
 * - `missing`: required by a role the person holds, never trained (`overdue` when past its due date);
 * - `not_required`: no requirement and no training.
 */
export const trainingStatuses = [
  "current",
  "expiring",
  "expired",
  "outdated",
  "pending_sign_off",
  "missing",
  "not_required",
] as const;
export type TrainingStatus = (typeof trainingStatuses)[number];
export const trainingStatusLabels: Record<TrainingStatus, string> = {
  current: "Current",
  expiring: "Expiring",
  expired: "Expired",
  outdated: "Outdated",
  pending_sign_off: "Awaiting sign-off",
  missing: "Missing",
  not_required: "Not required",
};
/** Statuses that need someone to act. */
export const trainingGapStatuses: readonly TrainingStatus[] = [
  "expired",
  "outdated",
  "missing",
  "expiring",
  "pending_sign_off",
];

export const TRAINING_EXPIRING_DAYS = 30;

// ─── Dates (YYYY-MM-DD, calendar arithmetic in UTC) ─────────────────────────

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export const addDaysIso = (iso: string, days: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
};

/** Adds calendar months, clamping to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export const addMonthsIso = (iso: string, months: number) => {
  const d = toDate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toIso(d);
};

// ─── Status ──────────────────────────────────────────────────────────────────

export interface TrainingRecordForStatus {
  completedOn: string;
  outcome: TrainingOutcome;
  expiresOn: string | null;
  sopVersionId: string | null;
  signedOffAt: string | Date | null;
  voidedAt: string | Date | null;
}

export interface TrainingCellStatus {
  status: TrainingStatus;
  /** The record the status is based on (latest that counts), if any. */
  completedOn: string | null;
  expiresOn: string | null;
  required: boolean;
  /** For a missing requirement: when it is due (start date + the requirement's window). */
  dueOn: string | null;
  overdue: boolean;
}

/** Whether a record counts towards a course: not voided, a passing outcome, signed off if the course needs it. */
export const recordCounts = (r: TrainingRecordForStatus, requiresSignOff: boolean) =>
  !r.voidedAt &&
  r.outcome !== "not_yet_competent" &&
  (!requiresSignOff || (r.outcome === "competent" && r.signedOffAt !== null));

/**
 * One person's standing on one course. `records` are that person's records for the course in any
 * order; `currentSopVersionId` is the SOP's approved version for SOP courses (`undefined`
 * otherwise); `requirement` is set when a role the person holds needs the course.
 */
export function trainingStatus(input: {
  records: readonly TrainingRecordForStatus[];
  requiresSignOff: boolean;
  currentSopVersionId?: string | null | undefined;
  requirement?: { dueWithinDays: number | null; startDate: string | null } | null | undefined;
  today: string;
}): TrainingCellStatus {
  const { requiresSignOff, today } = input;
  const required = Boolean(input.requirement);
  // Same day: the record on the SOP's current version wins (a new version acknowledged the day
  // the previous one was).
  const onCurrent = (r: TrainingRecordForStatus) =>
    input.currentSopVersionId !== undefined && r.sopVersionId === input.currentSopVersionId ? 1 : 0;
  const latestFirst = [...input.records].sort(
    (a, b) => b.completedOn.localeCompare(a.completedOn) || onCurrent(b) - onCurrent(a),
  );
  const counted = latestFirst.find((r) => recordCounts(r, requiresSignOff));
  const pending =
    requiresSignOff &&
    latestFirst.find((r) => !r.voidedAt && r.outcome === "competent" && r.signedOffAt === null);
  const base = { required, dueOn: null, overdue: false };

  if (counted) {
    const at = { completedOn: counted.completedOn, expiresOn: counted.expiresOn };
    // A newer training waiting for sign-off is what to act on when the counted one has lapsed.
    const awaiting = pending && pending.completedOn >= counted.completedOn ? pending : null;
    if (counted.expiresOn && counted.expiresOn < today) {
      return { ...base, ...at, status: awaiting ? "pending_sign_off" : "expired" };
    }
    if (input.currentSopVersionId !== undefined && counted.sopVersionId !== input.currentSopVersionId) {
      return { ...base, ...at, status: awaiting ? "pending_sign_off" : "outdated" };
    }
    if (counted.expiresOn && counted.expiresOn <= addDaysIso(today, TRAINING_EXPIRING_DAYS)) {
      return { ...base, ...at, status: "expiring" };
    }
    return { ...base, ...at, status: "current" };
  }
  if (pending) {
    return {
      ...base,
      status: "pending_sign_off",
      completedOn: pending.completedOn,
      expiresOn: pending.expiresOn,
    };
  }
  if (!input.requirement) return { ...base, status: "not_required", completedOn: null, expiresOn: null };
  const { dueWithinDays, startDate } = input.requirement;
  const dueOn = dueWithinDays !== null && startDate ? addDaysIso(startDate, dueWithinDays) : null;
  return {
    status: "missing",
    required,
    completedOn: null,
    expiresOn: null,
    dueOn,
    overdue: dueOn !== null && dueOn < today,
  };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();

const courseFields = {
  code: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  description: optionalText(4000),
  kind: z.enum(trainingCourseKinds),
  /** The SOP an `sop` course trains on. */
  sopId: z.uuid().nullable(),
  /** How long training stays valid; null means it never expires. */
  validityMonths: z.number().int().min(1).max(120).nullable(),
  /** Whether a manager must sign the person off as competent before it counts. */
  requiresSignOff: z.boolean(),
};

const sopNeedsSop = (c: { kind?: TrainingCourseKind; sopId?: string | null }) =>
  c.kind === undefined || (c.kind === "sop") === Boolean(c.sopId);

export const trainingCourseCreateSchema = z
  .object({
    id: z.uuid().optional(),
    code: courseFields.code,
    title: courseFields.title,
    description: courseFields.description.optional(),
    kind: courseFields.kind,
    sopId: courseFields.sopId.optional(),
    validityMonths: courseFields.validityMonths.optional(),
    requiresSignOff: courseFields.requiresSignOff.optional(),
  })
  .refine(sopNeedsSop, {
    message: "An SOP course needs an SOP, and only SOP courses have one",
    path: ["sopId"],
  });
export type TrainingCourseCreateInput = z.infer<typeof trainingCourseCreateSchema>;

export const trainingCourseUpdateSchema = z
  .object({ ...courseFields, status: z.enum(trainingCourseStatuses) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type TrainingCourseUpdateInput = z.infer<typeof trainingCourseUpdateSchema>;

export const trainingCourseListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum([...trainingCourseStatuses, "all"]).default("active"),
  kind: z.enum(trainingCourseKinds).optional(),
  sopId: z.uuid().optional(),
});
export type TrainingCourseListQuery = z.infer<typeof trainingCourseListQuerySchema>;

/** Replaces which job roles need a course. */
export const trainingRequirementsSchema = z.object({
  requirements: z
    .array(
      z.object({
        jobRoleId: z.uuid(),
        /** Days after the person's start date by which they must be trained. */
        dueWithinDays: z.number().int().min(0).max(3650).nullable().optional(),
      }),
    )
    .max(200)
    .refine((list) => new Set(list.map((r) => r.jobRoleId)).size === list.length, "Duplicate job role"),
});
export type TrainingRequirementsInput = z.infer<typeof trainingRequirementsSchema>;

/** Records one training session for one or more people. */
export const trainingRecordCreateSchema = z
  .object({
    staffIds: z
      .array(z.uuid())
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate staff member"),
    courseId: z.uuid(),
    completedOn: isoDate,
    outcome: z.enum(trainingOutcomes).default("competent"),
    /** A workspace member who gave the training. */
    trainerUserId: z.uuid().nullable().optional(),
    /** Or an outside trainer or provider. */
    trainerName: optionalText(200).optional(),
    notes: optionalText(4000).optional(),
  })
  .refine((r) => !(r.trainerUserId && r.trainerName), {
    message: "Give a trainer member or a trainer name, not both",
    path: ["trainerName"],
  });
export type TrainingRecordCreateInput = z.infer<typeof trainingRecordCreateSchema>;

export const trainingSignOffSchema = z.object({
  recordIds: z
    .array(z.uuid())
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate record"),
});
export type TrainingSignOffInput = z.infer<typeof trainingSignOffSchema>;

export const trainingVoidSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type TrainingVoidInput = z.infer<typeof trainingVoidSchema>;

export const trainingMatrixQuerySchema = z.object({
  jobRoleId: z.uuid().optional(),
  department: z.string().trim().max(200).optional(),
  courseId: z.uuid().optional(),
  /** Only people with at least one cell in this status. */
  status: z.enum(trainingStatuses).optional(),
  /** Every active course as a column, not only those required or trained on. */
  allCourses: z.enum(["true", "false"]).optional(),
});
export type TrainingMatrixQuery = z.infer<typeof trainingMatrixQuerySchema>;

export const trainingDueQuerySchema = z.object({
  /** Expiring within this many days counts as due (default 30). */
  withinDays: z.coerce.number().int().min(0).max(365).default(TRAINING_EXPIRING_DAYS),
  jobRoleId: z.uuid().optional(),
  department: z.string().trim().max(200).optional(),
});
export type TrainingDueQuery = z.infer<typeof trainingDueQuerySchema>;

export const trainingRecordListQuerySchema = z.object({
  staffId: z.uuid().optional(),
  courseId: z.uuid().optional(),
  /** `pending`: competent, not signed off, not voided (for courses that need a sign-off). */
  signOff: z.enum(["pending"]).optional(),
  includeVoided: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TrainingRecordListQuery = z.infer<typeof trainingRecordListQuerySchema>;
