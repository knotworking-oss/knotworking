import { z } from "zod";
import { toCsv } from "./csv";
// Monday of the ISO week a local date falls in (shared with demand planning).
import { weekStart } from "./demand";
import { defaultPayPeriod, payPeriodSettingFields } from "./pay-periods";
import { DEFAULT_TIME_ZONE, dateInZone } from "./time-zone";

/**
 * Attendance module: clock events (append-only), shifts derived from them, payroll exports, the
 * on-site register for evacuations, visitors, and the tablet kiosk. Builds on the People module.
 * No DOM or Node APIs (time zones use `Intl`, which every runtime has).
 */

// ─── Settings ────────────────────────────────────────────────────────────────

/** The longest replay window a workspace may set (one week). */
export const OFFLINE_REPLAY_MAX_HOURS = 168;

export const roundingMinuteOptions = [0, 5, 10, 15] as const;

/**
 * The settings an attendance manager edits. The time zone shifts and payroll periods are dated in is
 * the workspace's own (`workspaceSettingsSchema`), so it is not part of these: it is read-only here.
 */
export const attendanceSettingsSchema = z.object({
  /** Clock times are rounded to the nearest N minutes for payroll (0 = exact). Raw times are kept. */
  roundingMinutes: z
    .number()
    .int()
    .refine(
      (n) => (roundingMinuteOptions as readonly number[]).includes(n),
      "Round to 0, 5, 10 or 15 minutes",
    ),
  /** Unpaid break deducted from shifts at least this long (hours); null = no deduction. */
  breakAfterHours: z.number().min(0).max(24).nullable(),
  breakMinutes: z.number().int().min(0).max(240),
  /** A shift open longer than this is treated as a missed clock-out. */
  maxShiftHours: z.number().int().min(4).max(36),
  /** Hours a week after which time counts as overtime; null = no overtime split. */
  overtimeAfterWeeklyHours: z.number().min(0).max(168).nullable(),
  payrollFormat: z.string().trim().min(1).max(40),
  /**
   * The pay period payroll runs for (see `pay-periods.ts`): the payroll page and file default to
   * the last finished one. The anchor is the first day of any period, needed unless monthly.
   */
  ...payPeriodSettingFields,
  /** Sage 50 Payroll: the payment reference numbers hours are imported against. */
  sageBasicPaymentRef: z.string().trim().max(20).nullable(),
  sageOvertimePaymentRef: z.string().trim().max(20).nullable(),
  /** Visitor sign-ins older than this are deleted (UK GDPR storage limitation). */
  visitorRetentionMonths: z.number().int().min(1).max(84),
  /** A scanned badge still asks for the PIN (default). Off: the badge alone identifies the person. */
  badgeRequiresPin: z.boolean(),
  /** How far back (hours) a kiosk may replay events it queued while offline. */
  offlineReplayHours: z.number().int().min(1).max(OFFLINE_REPLAY_MAX_HOURS),
  /** Site rules visitors must accept at sign-in; null = no rules to accept. */
  visitorSiteRules: z
    .string()
    .trim()
    .max(4000)
    .transform((v) => v || null)
    .nullable(),
});
export type AttendanceSettings = z.infer<typeof attendanceSettingsSchema> & {
  /** The workspace's time zone (read-only here): shift dates and the payroll period are local dates in it. */
  timeZone: string;
};

export const defaultAttendanceSettings: AttendanceSettings = {
  timeZone: DEFAULT_TIME_ZONE,
  roundingMinutes: 0,
  breakAfterHours: null,
  breakMinutes: 0,
  maxShiftHours: 16,
  overtimeAfterWeeklyHours: null,
  payrollFormat: "generic",
  payPeriodKind: defaultPayPeriod.kind,
  payPeriodAnchor: defaultPayPeriod.anchor,
  sageBasicPaymentRef: null,
  sageOvertimePaymentRef: null,
  visitorRetentionMonths: 24,
  badgeRequiresPin: true,
  offlineReplayHours: 72,
  visitorSiteRules: null,
};

export const attendanceSettingsUpdateSchema = attendanceSettingsSchema
  .partial()
  .extend({
    /** Moved to the workspace settings: a patch that still sends it is refused, not silently ignored. */
    timeZone: z
      .undefined({ error: "The time zone is a workspace setting now (workspace settings)" })
      .optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type AttendanceSettingsUpdateInput = z.infer<typeof attendanceSettingsUpdateSchema>;

// ─── Time zones ──────────────────────────────────────────────────────────────

/** The local calendar date (`YYYY-MM-DD`) of an instant in a time zone (see `dateInZone`). */
export const localDate = (at: Date | string, timeZone: string): string => dateInZone(at, timeZone);

// ─── Events and shifts ───────────────────────────────────────────────────────

export const clockKinds = ["in", "out"] as const;
export type ClockKind = (typeof clockKinds)[number];

export const clockSources = ["kiosk", "manager"] as const;
export type ClockSource = (typeof clockSources)[number];

export interface ClockEventLike {
  id: string;
  kind: ClockKind;
  at: Date | string;
  voidedAt?: Date | string | null;
}

export const shiftIssues = ["missing_out", "missing_in", "too_long"] as const;
export type ShiftIssue = (typeof shiftIssues)[number];
export const shiftIssueLabels: Record<ShiftIssue, string> = {
  missing_out: "No clock-out",
  missing_in: "No clock-in",
  too_long: "Longer than the maximum shift",
};

export interface Shift {
  inEventId: string | null;
  outEventId: string | null;
  start: string | null;
  end: string | null;
  /** Local date of the clock-in (or the clock-out when there is none): the shift's day. */
  date: string;
  /** Minutes between clock-in and clock-out, exact; null when either is missing. */
  minutes: number | null;
  /** Paid minutes after rounding and the unpaid break; 0 when the shift has an issue that loses time. */
  paidMinutes: number;
  /** Still clocked in, within the maximum shift length. */
  open: boolean;
  issue: ShiftIssue | null;
}

const iso = (at: Date | string) => (typeof at === "string" ? new Date(at) : at).toISOString();
const ms = (at: Date | string) => (typeof at === "string" ? Date.parse(at) : at.getTime());

/** Rounds an instant to the nearest `minutes` (half up). */
const roundTo = (t: number, minutes: number) =>
  minutes ? Math.round(t / (minutes * 60_000)) * minutes * 60_000 : t;

/** Paid minutes for a closed shift: rounded clock times, less the unpaid break when it applies. */
export function paidMinutes(
  start: Date | string,
  end: Date | string,
  settings: Pick<AttendanceSettings, "roundingMinutes" | "breakAfterHours" | "breakMinutes">,
) {
  const worked = Math.max(
    0,
    (roundTo(ms(end), settings.roundingMinutes) - roundTo(ms(start), settings.roundingMinutes)) / 60_000,
  );
  const breakApplies = settings.breakAfterHours !== null && worked >= settings.breakAfterHours * 60;
  return Math.max(0, Math.round(worked - (breakApplies ? settings.breakMinutes : 0)));
}

/**
 * Pairs one person's clock events into shifts: each `in` with the next `out`. Voided events are
 * ignored. An `in` followed by another `in` leaves the first without a clock-out; an `out` with
 * no open `in` has no clock-in; a pair longer than `maxShiftHours` is flagged; an `in` still open
 * after `maxShiftHours` is a missed clock-out, otherwise the person is on site (`open`).
 * Shifts with an issue pay nothing until a manager fixes the events.
 */
export function buildShifts(
  events: readonly ClockEventLike[],
  settings: Pick<
    AttendanceSettings,
    "timeZone" | "maxShiftHours" | "roundingMinutes" | "breakAfterHours" | "breakMinutes"
  >,
  now: Date = new Date(),
): Shift[] {
  const max = settings.maxShiftHours * 3_600_000;
  const live = events
    .filter((e) => !e.voidedAt)
    .sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
  const shifts: Shift[] = [];
  let open: ClockEventLike | null = null;
  const unclosed = (e: ClockEventLike, issue: ShiftIssue | null, isOpen: boolean): Shift => ({
    inEventId: e.id,
    outEventId: null,
    start: iso(e.at),
    end: null,
    date: localDate(e.at, settings.timeZone),
    minutes: null,
    paidMinutes: 0,
    open: isOpen,
    issue,
  });
  for (const e of live) {
    if (e.kind === "in") {
      if (open) shifts.push(unclosed(open, "missing_out", false));
      open = e;
    } else if (open) {
      const minutes = Math.round((ms(e.at) - ms(open.at)) / 60_000);
      const tooLong = ms(e.at) - ms(open.at) > max;
      shifts.push({
        inEventId: open.id,
        outEventId: e.id,
        start: iso(open.at),
        end: iso(e.at),
        date: localDate(open.at, settings.timeZone),
        minutes,
        paidMinutes: tooLong ? 0 : paidMinutes(open.at, e.at, settings),
        open: false,
        issue: tooLong ? "too_long" : null,
      });
      open = null;
    } else {
      shifts.push({
        inEventId: null,
        outEventId: e.id,
        start: null,
        end: iso(e.at),
        date: localDate(e.at, settings.timeZone),
        minutes: null,
        paidMinutes: 0,
        open: false,
        issue: "missing_in",
      });
    }
  }
  if (open) {
    const stale = now.getTime() - ms(open.at) > max;
    shifts.push(unclosed(open, stale ? "missing_out" : null, !stale));
  }
  return shifts;
}

/** The kind a person's next clock event should be: out while clocked in (within the maximum shift), otherwise in. */
export function expectedClockKind(
  last: { kind: ClockKind; at: Date | string } | null | undefined,
  maxShiftHours: number,
  now: Date = new Date(),
): ClockKind {
  if (!last || last.kind === "out") return "in";
  return now.getTime() - ms(last.at) > maxShiftHours * 3_600_000 ? "in" : "out";
}

/**
 * Splits paid minutes into basic and overtime per ISO week (Monday start, local dates): within
 * each week, minutes past `overtimeAfterWeeklyHours` are overtime, in shift order.
 *
 * Weeks are counted whole: pass every shift from the Monday of the period's first week, and
 * `countFrom` (the period's first day). Shifts before it count towards their week's threshold
 * but are not added to the totals, so a week that straddles two monthly pay periods loses no
 * overtime: hours before the period fill up the week first, as they were paid in the last one.
 */
export function splitOvertime(
  shifts: readonly Pick<Shift, "date" | "start" | "paidMinutes">[],
  overtimeAfterWeeklyHours: number | null,
  countFrom?: string,
) {
  const counted = (s: { date: string }) => !countFrom || s.date >= countFrom;
  if (overtimeAfterWeeklyHours === null) {
    return {
      basicMinutes: shifts.filter(counted).reduce((n, s) => n + s.paidMinutes, 0),
      overtimeMinutes: 0,
    };
  }
  const limit = overtimeAfterWeeklyHours * 60;
  const byWeek = new Map<string, number>();
  let basicMinutes = 0;
  let overtimeMinutes = 0;
  const ordered = [...shifts].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.start ?? "").localeCompare(b.start ?? ""),
  );
  for (const s of ordered) {
    const week = weekStart(s.date);
    const before = byWeek.get(week) ?? 0;
    const basic = Math.max(0, Math.min(s.paidMinutes, limit - before));
    byWeek.set(week, before + s.paidMinutes);
    if (!counted(s)) continue;
    basicMinutes += basic;
    overtimeMinutes += s.paidMinutes - basic;
  }
  return { basicMinutes, overtimeMinutes };
}

/** Minutes as decimal hours to 2 places (7h 30m → 7.5). */
export const decimalHours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

// ─── Payroll export ──────────────────────────────────────────────────────────

export interface PayrollRow {
  staffNumber: string;
  payrollReference: string | null;
  firstName: string;
  lastName: string;
  shifts: number;
  basicMinutes: number;
  overtimeMinutes: number;
}

export interface PayrollExportContext {
  from: string;
  to: string;
  settings: Pick<AttendanceSettings, "sageBasicPaymentRef" | "sageOvertimePaymentRef">;
}

export interface PayrollFormat {
  id: string;
  label: string;
  /**
   * Whether the layout has been checked against the vendor's own import template with a
   * successful test import. Unverified formats are offered with a warning.
   */
  verified: boolean;
  description: string;
  /** Problems that stop this export (missing settings), checked before building it. */
  problems(rows: readonly PayrollRow[], context: PayrollExportContext): string[];
  build(rows: readonly PayrollRow[], context: PayrollExportContext): string;
  fileName(context: PayrollExportContext): string;
}

const employeeRef = (r: PayrollRow) => r.payrollReference ?? r.staffNumber;
const hasOvertime = (rows: readonly PayrollRow[]) => rows.some((r) => r.overtimeMinutes > 0);

export const payrollFormats: readonly PayrollFormat[] = [
  {
    id: "generic",
    label: "Generic CSV",
    verified: true,
    description:
      "One row per person: staff number, payroll reference, names, shifts and basic, overtime and total hours.",
    problems: () => [],
    build: (rows, { from, to }) =>
      toCsv([
        [
          "Staff number",
          "Payroll reference",
          "First name",
          "Last name",
          "Period start",
          "Period end",
          "Shifts",
          "Basic hours",
          "Overtime hours",
          "Total hours",
        ],
        ...rows.map((r) => [
          r.staffNumber,
          r.payrollReference,
          r.firstName,
          r.lastName,
          from,
          to,
          r.shifts,
          decimalHours(r.basicMinutes),
          decimalHours(r.overtimeMinutes),
          decimalHours(r.basicMinutes + r.overtimeMinutes),
        ]),
      ]),
    fileName: ({ from, to }) => `hours-${from}-to-${to}.csv`,
  },
  {
    id: "sage50",
    label: "Sage 50 Payroll (hours)",
    verified: false,
    description:
      "Hours against payment references, one row per employee and payment: Employee Reference (the payroll reference, or the staff number), Payment Reference and Hours. Do a test import into a backup company before the first real run.",
    problems: (rows, { settings }) => [
      ...(settings.sageBasicPaymentRef
        ? []
        : ["Set the Sage payment reference for basic hours in attendance settings."]),
      ...(hasOvertime(rows) && !settings.sageOvertimePaymentRef
        ? ["There is overtime: set the Sage payment reference for overtime in attendance settings."]
        : []),
    ],
    build: (rows, { settings }) =>
      toCsv([
        ["Employee Reference", "Payment Reference", "Hours"],
        ...rows.flatMap((r) => [
          ...(r.basicMinutes > 0
            ? [[employeeRef(r), settings.sageBasicPaymentRef, decimalHours(r.basicMinutes)]]
            : []),
          ...(r.overtimeMinutes > 0
            ? [[employeeRef(r), settings.sageOvertimePaymentRef, decimalHours(r.overtimeMinutes)]]
            : []),
        ]),
      ]),
    fileName: ({ from, to }) => `sage50-hours-${from}-to-${to}.csv`,
  },
];

export const payrollFormatIds = payrollFormats.map((f) => f.id);
export const findPayrollFormat = (id: string) => payrollFormats.find((f) => f.id === id);

// ─── Request schemas ─────────────────────────────────────────────────────────

const isoDate = z.iso.date();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

/** A manager adding a missed clock event (always with a reason). */
export const attendanceEventCreateSchema = z.object({
  staffId: z.uuid(),
  kind: z.enum(clockKinds),
  at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
});
export type AttendanceEventCreateInput = z.infer<typeof attendanceEventCreateSchema>;

export const attendanceVoidSchema = z.object({ reason: z.string().trim().min(1).max(500) });

const period = z
  .object({ from: isoDate, to: isoDate })
  .refine((p) => p.from <= p.to, { message: "`from` is after `to`", path: ["to"] })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= 92 * 86_400_000, {
    message: "A period is at most 93 days",
    path: ["to"],
  });

export const attendanceShiftsQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    staffId: z.uuid().optional(),
    department: z.string().trim().max(200).optional(),
    /** Only shifts with an issue. */
    issues: z.enum(["true", "false"]).optional(),
  })
  .and(period);
export type AttendanceShiftsQuery = z.infer<typeof attendanceShiftsQuerySchema>;

/**
 * The payroll preview and file. `from` and `to` go together; with neither, the last finished pay
 * period (an attendance setting) is used.
 */
export const payrollQuerySchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional(), format: z.string().trim().max(40).optional() })
  .refine((p) => (p.from === undefined) === (p.to === undefined), {
    message: "Give both `from` and `to`, or neither for the last pay period",
    path: ["to"],
  })
  .refine((p) => p.from === undefined || p.to === undefined || p.from <= p.to, {
    message: "`from` is after `to`",
    path: ["to"],
  })
  .refine(
    (p) =>
      p.from === undefined || p.to === undefined || Date.parse(p.to) - Date.parse(p.from) <= 92 * 86_400_000,
    { message: "A period is at most 93 days", path: ["to"] },
  );
export type PayrollQuery = z.infer<typeof payrollQuerySchema>;

export const rollCallKinds = ["drill", "real"] as const;
export type RollCallKind = (typeof rollCallKinds)[number];
export const rollCallStatuses = ["unaccounted", "safe", "missing"] as const;
export type RollCallStatus = (typeof rollCallStatuses)[number];

export const rollCallCreateSchema = z.object({
  kind: z.enum(rollCallKinds),
  notes: optionalText(2000).optional(),
});
export const rollCallMarkSchema = z.object({ status: z.enum(rollCallStatuses) });
export const rollCallEndSchema = z.object({ notes: optionalText(2000).optional() });

export const attendanceDeviceCreateSchema = z.object({ name: z.string().trim().min(1).max(100) });

// ─── Kiosk ───────────────────────────────────────────────────────────────────

/** Kiosk device credentials start with this, so they are told apart from API tokens (`knw_`). */
export const KIOSK_TOKEN_PREFIX = "knk_";
/** Pairing codes are 8 characters from an alphabet without look-alikes, valid for 15 minutes. */
export const KIOSK_PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const KIOSK_PAIRING_MINUTES = 15;

const staffNumber = z.string().regex(/^\d{6}$/, "A staff number is exactly 6 digits");
const pin = z.string().regex(/^\d{6}$/, "A PIN is exactly 6 digits");
const personName = z.string().trim().min(1).max(100);

export const kioskPairSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase().replace(/[\s-]/g, ""))
    .pipe(z.string().length(8)),
});
export const kioskChangePinSchema = z.object({ staffNumber, currentPin: pin, newPin: pin });

// ─── Badges ──────────────────────────────────────────────────────────────────

/**
 * A badge code: 16 characters from the pairing alphabet (80 bits), opaque and revocable. It says
 * nothing about the person (not the staff number, never the PIN). The QR code holds it with this
 * prefix; typed by hand it may have spaces or dashes and any case.
 */
export const KIOSK_BADGE_PREFIX = "knb:";
export const KIOSK_BADGE_LENGTH = 16;
const badgePattern = new RegExp(`^[${KIOSK_PAIRING_ALPHABET}]{${KIOSK_BADGE_LENGTH}}$`);

/** A scanned or typed badge in its stored form, or null if it isn't one. */
export function normalizeBadgeCode(input: string): string | null {
  let v = input.trim();
  if (v.toLowerCase().startsWith(KIOSK_BADGE_PREFIX)) v = v.slice(KIOSK_BADGE_PREFIX.length);
  v = v.toUpperCase().replace(/[\s-]/g, "");
  return badgePattern.test(v) ? v : null;
}

/** The badge code in groups of four, as printed under the QR code. */
export const formatBadgeCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

const badge = z
  .string()
  .max(64)
  .transform((v, ctx) => {
    const code = normalizeBadgeCode(v);
    if (!code) {
      ctx.addIssue({ code: "custom", message: "That isn't a badge code" });
      return z.NEVER;
    }
    return code;
  });

export const attendanceBadgeIssueSchema = z.object({ staffId: z.uuid() });

// ─── Kiosk requests ──────────────────────────────────────────────────────────

/**
 * Who is at the kiosk: a staff number and PIN, or a badge (with the PIN unless the workspace lets
 * badges alone identify people: `badgeRequiresPin`).
 */
const kioskCredentialFields = {
  staffNumber: staffNumber.optional(),
  badge: badge.optional(),
  pin: pin.optional(),
};
const credentialGiven = (v: {
  staffNumber?: string | undefined;
  badge?: string | undefined;
  pin?: string | undefined;
}) =>
  v.badge !== undefined ? v.staffNumber === undefined : v.staffNumber !== undefined && v.pin !== undefined;
const credentialMessage = { message: "Give a staff number and PIN, or a badge" };

export const kioskCredentialSchema = z
  .object(kioskCredentialFields)
  .refine(credentialGiven, credentialMessage);
export type KioskCredential = z.infer<typeof kioskCredentialSchema>;

export const kioskIdentifySchema = kioskCredentialSchema;
export const kioskClockSchema = z
  .object({
    ...kioskCredentialFields,
    kind: z.enum(clockKinds),
    /** Makes a retry after a timeout safe: the same id never clocks twice. */
    clientId: z.uuid().optional(),
  })
  .refine(credentialGiven, credentialMessage);

/** Who a visitor is here to see: a member of staff or a workspace member, picked at the kiosk. */
export const visitorHostKinds = ["staff", "member"] as const;
export type VisitorHostKind = (typeof visitorHostKinds)[number];

export const kioskVisitorSchema = z.object({
  firstName: personName,
  lastName: personName,
  clientId: z.uuid().optional(),
});
export type KioskVisitorInput = z.infer<typeof kioskVisitorSchema>;

export const kioskVisitorSignInSchema = kioskVisitorSchema.extend({
  company: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v || null)
    .nullish(),
  host: z.object({ kind: z.enum(visitorHostKinds), id: z.uuid() }).nullish(),
  /** The visitor ticked "I have read and accept the site rules" (needed when the workspace has rules). */
  acceptedRules: z.boolean().optional(),
});
export type KioskVisitorSignInInput = z.infer<typeof kioskVisitorSignInSchema>;

/** Host search at the kiosk: at least three characters, matched as the start of a first or last name. */
export const KIOSK_HOST_QUERY_MIN = 3;
export const kioskHostQuerySchema = z.object({ q: z.string().trim().min(KIOSK_HOST_QUERY_MIN).max(100) });

/** Reading or acknowledging an SOP at the kiosk, with the prompt token a clock-in returned. */
export const kioskPromptReadSchema = z.object({ promptToken: z.string().min(10).max(1000) });
export const kioskAcknowledgeSchema = kioskPromptReadSchema.extend({ versionId: z.uuid() });

// ─── Offline queue ───────────────────────────────────────────────────────────

/**
 * What a kiosk queues while offline. The clear fields are the event's type, when it happened (the
 * tablet's clock) and a client id; who it was (staff number, badge, PIN or the visitor's details)
 * is sealed to the server's public key (`KIOSK_SEAL_*`), so the tablet's storage holds no PINs
 * or names anyone could read. The server opens the seal on replay and checks the PIN then.
 */
export const kioskOfflineTypes = ["clock_in", "clock_out", "visitor_in", "visitor_out"] as const;
export type KioskOfflineType = (typeof kioskOfflineTypes)[number];

/** Sealing: ECDH P-256 with an ephemeral key, HKDF-SHA-256, AES-256-GCM. */
export const KIOSK_SEAL_VERSION = "s1";
export const KIOSK_SEAL_HKDF_SALT = "knotworking:kiosk-seal:v1";
/** Binds a sealed payload to the clear fields it was queued with, so it can't be moved to another event. */
export const kioskSealAad = (e: { clientId: string; type: KioskOfflineType; at: string }) =>
  `${e.clientId}|${e.type}|${e.at}`;

export const KIOSK_REPLAY_BATCH = 50;

export const kioskOfflineEventSchema = z.object({
  clientId: z.uuid(),
  type: z.enum(kioskOfflineTypes),
  /** When it happened, by the tablet's clock (corrected on the server by the sealed `clockOffsetMs`). */
  at: z.iso.datetime({ offset: true }),
  /** Room for a visitor sign-in carrying up to 4,000 characters of site rules. */
  sealed: z.string().min(1).max(24000),
});
export type KioskOfflineEvent = z.infer<typeof kioskOfflineEventSchema>;

export const kioskReplaySchema = z.object({
  /**
   * The tablet's clock when it sent the batch. Not authenticated, so only used for entries queued
   * before the kiosk sealed `clockOffsetMs`, and then only within `KIOSK_MAX_CLOCK_CORRECTION_MINUTES`.
   */
  sentAt: z.iso.datetime({ offset: true }),
  events: z.array(kioskOfflineEventSchema).min(1).max(KIOSK_REPLAY_BATCH),
});

/**
 * The most a replayed entry's time is moved to correct the tablet's clock. A tablet further out
 * than this has its entries refused (`clock_skew`) for a manager to add by hand.
 */
export const KIOSK_MAX_CLOCK_CORRECTION_MINUTES = 5;

/**
 * Sealed with every entry: the server's clock minus the tablet's, as the kiosk measured it at its
 * last `GET /v1/kiosk/session` (0 if it never reached it). Sealed, so it can't be changed later.
 */
const clockOffsetMs = z.number().int().min(-1e12).max(1e12).optional();

/** What the seal holds, per type. */
export const kioskSealedClockSchema = z
  .object({ ...kioskCredentialFields, clockOffsetMs })
  .refine(credentialGiven, credentialMessage);
export const kioskSealedVisitorInSchema = kioskVisitorSignInSchema.omit({ clientId: true }).extend({
  clockOffsetMs,
  /**
   * The site rules the tablet showed the visitor (null = none), so a replay records what they
   * accepted rather than the rules in force by then. Absent in events queued by older tablets.
   */
  siteRules: z.string().max(4000).nullish(),
  /** The host's name as the kiosk showed it, kept if the host has left by the time it is replayed. */
  hostName: z.string().trim().max(200).nullish(),
});
export const kioskSealedVisitorOutSchema = kioskVisitorSchema
  .omit({ clientId: true })
  .extend({ clockOffsetMs });

export const kioskReplayStatuses = ["accepted", "duplicate", "rejected"] as const;
export type KioskReplayStatus = (typeof kioskReplayStatuses)[number];

/** Why a replayed event was refused (kept for managers under Settings & kiosks). */
export const kioskRejectionLabels: Record<string, string> = {
  replay_too_old: "Older than the replay window",
  replay_in_future: "Time is in the future",
  clock_skew: "The tablet's clock was too far out",
  replay_conflict: "Contradicts the recorded clock events",
  pin_invalid: "Wrong staff number or PIN",
  pin_locked: "Staff number locked after wrong PINs",
  pin_required: "Badge used without the PIN",
  badge_invalid: "Badge not recognised or revoked",
  staff_inactive: "Not active staff",
  visitor_not_found: "No matching visitor signed in",
  site_rules_required: "Site rules not accepted",
  host_not_found: "Host not found",
  seal_invalid: "Couldn't be read (the server key changed?)",
  invalid: "Incomplete or malformed",
};
