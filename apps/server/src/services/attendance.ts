import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  activeWorkspaceModules,
  addDaysToIsoDate,
  buildShifts,
  defaultAttendanceSettings,
  expectedClockKind,
  findPayrollFormat,
  hasModuleLevel,
  KIOSK_PAIRING_ALPHABET,
  KIOSK_PAIRING_MINUTES,
  KIOSK_TOKEN_PREFIX,
  lastFinishedPayPeriod,
  localDate,
  payPeriodProblem,
  todayInZone,
  VISITOR_NOTIFY_MAX_AGE_MINUTES,
  weekStart,
  payrollFormatIds,
  resolveModuleAccess,
  splitOvertime,
  type AttendanceEventCreateInput,
  type AttendanceSettings,
  type AttendanceSettingsUpdateInput,
  type AttendanceShiftsQuery,
  type ClockKind,
  type KioskVisitorInput,
  type KioskVisitorSignInInput,
  type ModuleAccessMap,
  type ModuleId,
  type PayrollRow,
  type RollCallKind,
  type RollCallStatus,
  type Shift,
} from "@knotworking/core";
import {
  attendanceDevices,
  attendanceEvents,
  attendanceKioskRejections,
  attendanceRollCallEntries,
  attendanceRollCalls,
  attendanceSettings,
  attendanceVisits,
  lockWorkspaceLog,
  memberModuleAccess,
  notifications,
  staff,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, badRequest, notFound } from "../errors";
import { deliverNotifications, notifyVisitorArrived, type NotificationRow } from "./notifications";
import { workspaceTimeZone } from "./time-zone";

/**
 * Attendance module: clock events, shifts, payroll exports, the on-site register, evacuation roll
 * calls, visitors and kiosk devices.
 *
 * Clock times and visitor names are personal data. Like private calendar events, nothing here is
 * written to the sync log or the bootstrap: pages read it through these queries, and only people
 * with the right module level (or the person themselves, for their own times) see it.
 */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// ─── Settings ────────────────────────────────────────────────────────────────

/** The attendance settings, with the workspace's time zone (read-only here: it is a workspace setting). */
export async function getAttendanceSettings(db: Executor, workspaceId: string): Promise<AttendanceSettings> {
  const [[row], timeZone] = await Promise.all([
    db.select().from(attendanceSettings).where(eq(attendanceSettings.workspaceId, workspaceId)),
    workspaceTimeZone(db, workspaceId),
  ]);
  if (!row) return { ...defaultAttendanceSettings, timeZone };
  return {
    timeZone,
    roundingMinutes: row.roundingMinutes,
    breakAfterHours: row.breakAfterHours,
    breakMinutes: row.breakMinutes,
    maxShiftHours: row.maxShiftHours,
    overtimeAfterWeeklyHours: row.overtimeAfterWeeklyHours,
    payrollFormat: row.payrollFormat,
    payPeriodKind: row.payPeriodKind,
    payPeriodAnchor: row.payPeriodAnchor,
    sageBasicPaymentRef: row.sageBasicPaymentRef,
    sageOvertimePaymentRef: row.sageOvertimePaymentRef,
    visitorRetentionMonths: row.visitorRetentionMonths,
    badgeRequiresPin: row.badgeRequiresPin,
    offlineReplayHours: row.offlineReplayHours,
    visitorSiteRules: row.visitorSiteRules,
  };
}

export async function updateAttendanceSettings(
  db: Database,
  workspaceId: string,
  actorId: string,
  patch: AttendanceSettingsUpdateInput,
) {
  if (patch.payrollFormat !== undefined && !payrollFormatIds.includes(patch.payrollFormat)) {
    throw badRequest(`Unknown payroll format "${patch.payrollFormat}"`);
  }
  return db.transaction(async (tx) => {
    const { timeZone: _zone, ...stored } = patch;
    const next = { ...(await getAttendanceSettings(tx, workspaceId)), ...stored };
    const periodProblem = payPeriodProblem({ kind: next.payPeriodKind, anchor: next.payPeriodAnchor });
    if (periodProblem) throw badRequest(periodProblem);
    const { timeZone, ...row } = next;
    await tx
      .insert(attendanceSettings)
      .values({ workspaceId, ...row, updatedBy: actorId })
      .onConflictDoUpdate({
        target: attendanceSettings.workspaceId,
        set: { ...row, updatedBy: actorId, updatedAt: new Date() },
      });
    return { ...row, timeZone };
  });
}

// ─── Events and shifts ───────────────────────────────────────────────────────

const recorder = alias(users, "recorder");
const voider = alias(users, "voider");

async function eventsBetween(db: Executor, workspaceId: string, from: Date, to: Date, staffIds?: string[]) {
  return db
    .select({
      event: attendanceEvents,
      recordedByName: recorder.name,
      voidedByName: voider.name,
      deviceName: attendanceDevices.name,
    })
    .from(attendanceEvents)
    .leftJoin(recorder, eq(recorder.id, attendanceEvents.recordedBy))
    .leftJoin(voider, eq(voider.id, attendanceEvents.voidedBy))
    .leftJoin(attendanceDevices, eq(attendanceDevices.id, attendanceEvents.deviceId))
    .where(
      and(
        eq(attendanceEvents.workspaceId, workspaceId),
        gte(attendanceEvents.at, from),
        lt(attendanceEvents.at, to),
        staffIds ? inArray(attendanceEvents.staffId, staffIds) : undefined,
      ),
    )
    .orderBy(asc(attendanceEvents.at), asc(attendanceEvents.id));
}

const eventView = (r: Awaited<ReturnType<typeof eventsBetween>>[number]) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...event } = r.event;
  return {
    ...event,
    recordedByName: r.recordedByName,
    voidedByName: r.voidedByName,
    deviceName: r.deviceName,
  };
};

/**
 * The UTC window to load events for a period of local dates: a day either side for time zones,
 * plus the maximum shift length before the start so a shift that began just before still pairs.
 */
const periodWindow = (from: string, to: string, settings: AttendanceSettings) => ({
  start: new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000 - settings.maxShiftHours * 3_600_000),
  end: new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000 + settings.maxShiftHours * 3_600_000),
});

interface ShiftsScope {
  from: string;
  to: string;
  staffIds?: string[];
  department?: string;
}

/** Shifts per person whose day falls in [from, to] (local dates), with the events behind them. */
async function shiftsFor(db: Executor, workspaceId: string, scope: ShiftsScope, now = new Date()) {
  const settings = await getAttendanceSettings(db, workspaceId);
  // From the Monday of the first week: overtime counts whole weeks (see `splitOvertime`).
  const weekFrom = weekStart(scope.from);
  const window = periodWindow(weekFrom, scope.to, settings);
  const rows = await eventsBetween(db, workspaceId, window.start, window.end, scope.staffIds);
  const byStaff = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byStaff.get(r.event.staffId) ?? [];
    list.push(r);
    byStaff.set(r.event.staffId, list);
  }
  const ids = [...byStaff.keys()];
  const people = ids.length
    ? await db
        .select({
          id: staff.id,
          staffNumber: staff.staffNumber,
          firstName: staff.firstName,
          lastName: staff.lastName,
          department: staff.department,
          payrollReference: staff.payrollReference,
          status: staff.status,
        })
        .from(staff)
        .where(
          and(
            inArray(staff.id, ids),
            scope.department ? sql`lower(${staff.department}) = lower(${scope.department})` : undefined,
          ),
        )
        .orderBy(asc(staff.lastName), asc(staff.firstName))
    : [];
  const inPeriod = (s: Shift) => s.date >= scope.from && s.date <= scope.to;
  const result = people.map((person) => {
    const events = byStaff.get(person.id) ?? [];
    const all = buildShifts(
      events.map((e) => e.event),
      settings,
      now,
    );
    const shifts = all.filter(inPeriod);
    const used = new Set(shifts.flatMap((s) => [s.inEventId, s.outEventId]));
    const split = splitOvertime(
      all.filter((s) => !s.issue && !s.open && s.date >= weekFrom && s.date <= scope.to),
      settings.overtimeAfterWeeklyHours,
      scope.from,
    );
    return {
      staff: person,
      shifts,
      // Events behind the shifts shown, voided ones included (kept and marked).
      events: events
        .filter(
          (e) => used.has(e.event.id) || (e.event.voidedAt && localInPeriod(e.event.at, settings, scope)),
        )
        .map(eventView),
      totals: {
        shifts: shifts.filter((s) => !s.issue && !s.open).length,
        paidMinutes: split.basicMinutes + split.overtimeMinutes,
        ...split,
        issues: shifts.filter((s) => s.issue).length,
      },
    };
  });
  return { settings, people: result.filter((r) => r.shifts.length > 0 || r.events.length > 0) };
}

const localInPeriod = (at: Date, settings: AttendanceSettings, scope: { from: string; to: string }) => {
  const d = localDate(at, settings.timeZone);
  return d >= scope.from && d <= scope.to;
};

/**
 * Clock-ins with no clock-out that are now past the maximum shift (`missing_out` shifts), for the
 * notification sweep: the same shifts the Shifts page and the payroll preview flag, so the Inbox
 * agrees with them. Only clock-ins from the last `sinceDays` local days are looked at, which keeps
 * the query to a couple of weeks of events however long the module has been in use. A shift whose
 * clock-out is added or whose clock-in is voided stops being listed.
 */
export async function missedClockOuts(
  db: Executor,
  workspaceId: string,
  sinceDays: number,
  now = new Date(),
) {
  const settings = await getAttendanceSettings(db, workspaceId);
  const since = addDaysToIsoDate(todayInZone(settings.timeZone, now), -sinceDays);
  // Events from a day before the earliest day looked at, so time zones can't clip the first one.
  const windowStart = new Date(Date.parse(`${since}T00:00:00Z`) - 86_400_000);
  const rows = await eventsBetween(db, workspaceId, windowStart, new Date(now.getTime() + 86_400_000));
  const byStaff = new Map<string, typeof rows>();
  for (const r of rows) byStaff.set(r.event.staffId, [...(byStaff.get(r.event.staffId) ?? []), r]);
  if (byStaff.size === 0) return [];
  const people = await db
    .select({ id: staff.id, firstName: staff.firstName, lastName: staff.lastName, userId: staff.userId })
    .from(staff)
    .where(and(inArray(staff.id, [...byStaff.keys()]), isNull(staff.deletedAt)));
  const maxMs = settings.maxShiftHours * 3_600_000;
  return people.flatMap((person) =>
    buildShifts(
      byStaff.get(person.id)!.map((e) => e.event),
      settings,
      now,
    )
      // `buildShifts` also flags a clock-in followed by another clock-in at once; the person may
      // still be in the middle of that shift, so wait for the maximum shift to pass either way.
      .filter(
        (s) =>
          s.issue === "missing_out" &&
          s.inEventId &&
          s.start &&
          s.date >= since &&
          Date.parse(s.start) + maxMs <= now.getTime(),
      )
      .map((s) => ({ staff: person, inEventId: s.inEventId!, start: s.start!, date: s.date })),
  );
}

export async function listShifts(db: Database, workspaceId: string, query: AttendanceShiftsQuery) {
  const { settings, people } = await shiftsFor(db, workspaceId, {
    from: query.from,
    to: query.to,
    ...(query.staffId ? { staffIds: [query.staffId] } : {}),
    ...(query.department ? { department: query.department } : {}),
  });
  const rows = query.issues === "true" ? people.filter((p) => p.totals.issues > 0) : people;
  return {
    from: query.from,
    to: query.to,
    timeZone: settings.timeZone,
    people: rows,
    issues: rows.reduce((n, p) => n + p.totals.issues, 0),
  };
}

/** A person's own times, for members linked to a staff record. */
export async function myAttendance(
  db: Database,
  workspaceId: string,
  userId: string,
  from: string,
  to: string,
) {
  const [me] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.workspaceId, workspaceId), eq(staff.userId, userId), isNull(staff.deletedAt)));
  if (!me) return { linked: false as const, from, to, shifts: [], totals: null };
  const { people } = await shiftsFor(db, workspaceId, { from, to, staffIds: [me.id] });
  const mine = people[0];
  return { linked: true as const, from, to, shifts: mine?.shifts ?? [], totals: mine?.totals ?? null };
}

async function findStaffMember(db: Executor, workspaceId: string, staffId: string) {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.workspaceId, workspaceId), isNull(staff.deletedAt)));
  if (!row) throw notFound("Staff member");
  return row;
}

/**
 * Nobody edits their own clock record (payroll integrity), unless they are the only member with
 * `manage` on attendance, so a one-manager business isn't locked out (like the SOP four-eyes rule).
 */
async function assertNotOwnRecord(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[],
  actorId: string,
  staffUserId: string | null,
  message: string,
) {
  if (staffUserId !== actorId) return;
  const [members, grants] = await Promise.all([
    db
      .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deletedAt))),
    db
      .select({
        userId: memberModuleAccess.userId,
        moduleId: memberModuleAccess.moduleId,
        level: memberModuleAccess.level,
      })
      .from(memberModuleAccess)
      .where(and(eq(memberModuleAccess.workspaceId, workspaceId), isNull(memberModuleAccess.deletedAt))),
  ]);
  // Every module's grants, not just attendance's: attendance depends on people, so a member's
  // attendance level is `none` unless they can also read people.
  const grantOf = new Map<string, ModuleAccessMap>();
  for (const g of grants)
    grantOf.set(g.userId, { ...grantOf.get(g.userId), [g.moduleId as ModuleId]: g.level });
  const managerIds = members
    .filter((m) =>
      hasModuleLevel(
        resolveModuleAccess({
          role: m.role,
          active,
          grants: grantOf.get(m.userId) ?? {},
        }).attendance,
        "manage",
      ),
    )
    .map((m) => m.userId);
  if (managerIds.length === 1 && managerIds[0] === actorId) return;
  throw new ApiError(403, "own_attendance", message);
}

/** A manager adding a missed clock event, with a reason. */
export async function createManualEvent(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  input: AttendanceEventCreateInput,
) {
  const at = new Date(input.at);
  if (at.getTime() > Date.now() + 5 * 60_000) throw badRequest("A clock event can't be in the future");
  return db.transaction(async (tx) => {
    const person = await findStaffMember(tx, workspaceId, input.staffId);
    await assertNotOwnRecord(
      tx,
      workspaceId,
      active,
      actorId,
      person.userId,
      "You can't add clock events to your own record; ask another manager",
    );
    const [row] = await tx
      .insert(attendanceEvents)
      .values({
        workspaceId,
        staffId: input.staffId,
        kind: input.kind,
        at,
        source: "manager",
        recordedBy: actorId,
        reason: input.reason,
      })
      .returning();
    const { workspaceId: _ws, deletedAt: _deleted, ...event } = row!;
    return event;
  });
}

/** Voids a wrong clock event: kept and shown, never counted. */
export async function voidEvent(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(attendanceEvents)
      .where(and(eq(attendanceEvents.id, id), eq(attendanceEvents.workspaceId, workspaceId)))
      .for("update");
    if (!row) throw notFound("Clock event");
    if (row.voidedAt) throw new ApiError(409, "event_voided", "Already voided");
    const [owner] = await tx.select({ userId: staff.userId }).from(staff).where(eq(staff.id, row.staffId));
    await assertNotOwnRecord(
      tx,
      workspaceId,
      active,
      actorId,
      owner?.userId ?? null,
      "You can't void clock events on your own record; ask another manager",
    );
    const [updated] = await tx
      .update(attendanceEvents)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: reason })
      .where(eq(attendanceEvents.id, id))
      .returning();
    const { workspaceId: _ws, deletedAt: _deleted, ...event } = updated!;
    return event;
  });
}

/** Whether a person has any clock events (people can't be deleted once they do). */
export async function hasAttendanceEvents(db: Executor, staffId: string) {
  const [row] = await db
    .select({ id: attendanceEvents.id })
    .from(attendanceEvents)
    .where(eq(attendanceEvents.staffId, staffId))
    .limit(1);
  return Boolean(row);
}

// ─── Payroll ─────────────────────────────────────────────────────────────────

/**
 * The period a payroll preview or file covers: the dates asked for, or (with neither) the last
 * finished pay period of the workspace's setting, on the workspace's calendar.
 */
export async function payrollPeriod(
  db: Executor,
  workspaceId: string,
  range: { from?: string | undefined; to?: string | undefined },
  now = new Date(),
) {
  if (range.from && range.to) return { from: range.from, to: range.to };
  const settings = await getAttendanceSettings(db, workspaceId);
  return lastFinishedPayPeriod(todayInZone(settings.timeZone, now), {
    kind: settings.payPeriodKind,
    anchor: settings.payPeriodAnchor,
  });
}

/**
 * Per-person paid time for a period, for payroll runs (services/payroll-runs.ts): the same shift
 * pairing, rounding, breaks and whole-week overtime as the payroll preview, plus how many shifts
 * are still open or need fixing.
 */
export async function payrollPeriodTotals(
  db: Executor,
  workspaceId: string,
  period: { from: string; to: string },
  staffIds?: string[],
) {
  const { settings, people } = await shiftsFor(db, workspaceId, {
    ...period,
    ...(staffIds ? { staffIds } : {}),
  });
  return {
    settings,
    people: people.map((p) => ({
      staff: p.staff,
      shifts: p.totals.shifts,
      basicMinutes: p.totals.basicMinutes,
      overtimeMinutes: p.totals.overtimeMinutes,
      openShifts: p.shifts.filter((s) => s.open).length,
      issueShifts: p.totals.issues,
    })),
  };
}

export async function payrollPreview(
  db: Database,
  workspaceId: string,
  range: { from?: string | undefined; to?: string | undefined },
  formatId?: string,
) {
  const { from, to } = await payrollPeriod(db, workspaceId, range);
  const { settings, people } = await shiftsFor(db, workspaceId, { from, to });
  const format = findPayrollFormat(formatId ?? settings.payrollFormat);
  if (!format) throw badRequest(`Unknown payroll format "${formatId}"`);
  const rows = people
    .filter((p) => p.totals.paidMinutes > 0)
    .map((p) => ({
      staffId: p.staff.id,
      staffNumber: p.staff.staffNumber,
      payrollReference: p.staff.payrollReference,
      firstName: p.staff.firstName,
      lastName: p.staff.lastName,
      shifts: p.totals.shifts,
      basicMinutes: p.totals.basicMinutes,
      overtimeMinutes: p.totals.overtimeMinutes,
      issues: p.totals.issues,
    }));
  const exceptions = people.flatMap((p) =>
    p.shifts.filter((s) => s.issue).map((s) => ({ staff: p.staff, shift: s })),
  );
  const context = { from, to, settings };
  const stillIn = people.filter((p) => p.shifts.some((s) => s.open)).length;
  const warnings = [
    ...(stillIn
      ? [
          `${stillIn} ${stillIn === 1 ? "person is" : "people are"} still clocked in: their current shift isn't included until they clock out.`,
        ]
      : []),
    ...(exceptions.length
      ? [
          `${exceptions.length} ${exceptions.length === 1 ? "shift has" : "shifts have"} a missing or overlong clock event and pay nothing until fixed.`,
        ]
      : []),
    ...(rows.some((r) => !r.payrollReference) && format.id !== "generic"
      ? ["Some people have no payroll reference: their staff number is used instead."]
      : []),
    ...(format.verified
      ? []
      : [
          "This format hasn't been checked against the payroll package's own import template yet: do a test import first.",
        ]),
  ];
  return {
    from,
    to,
    format: {
      id: format.id,
      label: format.label,
      verified: format.verified,
      description: format.description,
    },
    rows,
    exceptions,
    problems: format.problems(rows, context),
    warnings,
  };
}

export async function payrollExport(
  db: Database,
  workspaceId: string,
  range: { from?: string | undefined; to?: string | undefined },
  formatId?: string,
) {
  const preview = await payrollPreview(db, workspaceId, range, formatId);
  const { from, to } = preview;
  if (preview.problems.length) {
    throw new ApiError(409, "payroll_export_blocked", preview.problems.join(" "));
  }
  const settings = await getAttendanceSettings(db, workspaceId);
  const format = findPayrollFormat(preview.format.id)!;
  const rows: PayrollRow[] = preview.rows;
  const context = { from, to, settings };
  return { fileName: format.fileName(context), csv: format.build(rows, context) };
}

// ─── On site ─────────────────────────────────────────────────────────────────

const VISIT_STALE_HOURS = 24;

/**
 * Who is on site now: staff whose latest clock event is `in` within the maximum shift length, and
 * visitors signed in today. Older open clock-ins and visits are listed apart as `possiblyLeft`
 * (they forgot to clock or sign out): in an evacuation they are checked too.
 */
export async function onSite(db: Executor, workspaceId: string, now = new Date()) {
  const settings = await getAttendanceSettings(db, workspaceId);
  const latest = await db
    .selectDistinctOn([attendanceEvents.staffId], {
      staffId: attendanceEvents.staffId,
      kind: attendanceEvents.kind,
      at: attendanceEvents.at,
    })
    .from(attendanceEvents)
    .where(and(eq(attendanceEvents.workspaceId, workspaceId), isNull(attendanceEvents.voidedAt)))
    .orderBy(attendanceEvents.staffId, desc(attendanceEvents.at), desc(attendanceEvents.id));
  const inside = latest.filter((l) => l.kind === "in");
  const people = inside.length
    ? await db
        .select({
          id: staff.id,
          staffNumber: staff.staffNumber,
          firstName: staff.firstName,
          lastName: staff.lastName,
          department: staff.department,
          status: staff.status,
        })
        .from(staff)
        .where(
          and(
            inArray(
              staff.id,
              inside.map((l) => l.staffId),
            ),
            isNull(staff.deletedAt),
          ),
        )
    : [];
  const since = new Map(inside.map((l) => [l.staffId, l.at]));
  const max = settings.maxShiftHours * 3_600_000;
  const staffRows = people
    .map((p) => ({ ...p, since: since.get(p.id)! }))
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  const visits = await db
    .select()
    .from(attendanceVisits)
    .where(and(eq(attendanceVisits.workspaceId, workspaceId), isNull(attendanceVisits.signedOutAt)))
    .orderBy(asc(attendanceVisits.lastName), asc(attendanceVisits.firstName));
  const visitStale = VISIT_STALE_HOURS * 3_600_000;
  const visitView = (v: (typeof visits)[number]) => ({
    id: v.id,
    firstName: v.firstName,
    lastName: v.lastName,
    company: v.company,
    hostName: v.hostName,
    hostMissing: v.hostMissing,
    siteRulesAcceptedAt: v.siteRulesAcceptedAt,
    offline: v.offline,
    since: v.signedInAt,
  });
  return {
    at: now,
    staff: staffRows.filter((s) => now.getTime() - s.since.getTime() <= max),
    visitors: visits.filter((v) => now.getTime() - v.signedInAt.getTime() <= visitStale).map(visitView),
    possiblyLeft: {
      staff: staffRows.filter((s) => now.getTime() - s.since.getTime() > max),
      visitors: visits.filter((v) => now.getTime() - v.signedInAt.getTime() > visitStale).map(visitView),
    },
  };
}

// ─── Roll calls ──────────────────────────────────────────────────────────────

const starter = alias(users, "starter");
const ender = alias(users, "ender");

export async function listRollCalls(db: Database, workspaceId: string) {
  const calls = await db
    .select({ call: attendanceRollCalls, startedByName: starter.name, endedByName: ender.name })
    .from(attendanceRollCalls)
    .leftJoin(starter, eq(starter.id, attendanceRollCalls.startedBy))
    .leftJoin(ender, eq(ender.id, attendanceRollCalls.endedBy))
    .where(eq(attendanceRollCalls.workspaceId, workspaceId))
    .orderBy(desc(attendanceRollCalls.startedAt))
    .limit(50);
  const ids = calls.map((c) => c.call.id);
  const counts = ids.length
    ? await db
        .select({
          rollCallId: attendanceRollCallEntries.rollCallId,
          status: attendanceRollCallEntries.status,
          n: sql<number>`count(*)::int`,
        })
        .from(attendanceRollCallEntries)
        .where(inArray(attendanceRollCallEntries.rollCallId, ids))
        .groupBy(attendanceRollCallEntries.rollCallId, attendanceRollCallEntries.status)
    : [];
  return calls.map(({ call, startedByName, endedByName }) => {
    const { workspaceId: _ws, deletedAt: _deleted, ...rest } = call;
    const of = (status: RollCallStatus) =>
      counts.find((c) => c.rollCallId === call.id && c.status === status)?.n ?? 0;
    return {
      ...rest,
      startedByName,
      endedByName,
      counts: { safe: of("safe"), missing: of("missing"), unaccounted: of("unaccounted") },
    };
  });
}

export async function getRollCall(db: Executor, workspaceId: string, id: string) {
  const [found] = await db
    .select({ call: attendanceRollCalls, startedByName: starter.name, endedByName: ender.name })
    .from(attendanceRollCalls)
    .leftJoin(starter, eq(starter.id, attendanceRollCalls.startedBy))
    .leftJoin(ender, eq(ender.id, attendanceRollCalls.endedBy))
    .where(and(eq(attendanceRollCalls.id, id), eq(attendanceRollCalls.workspaceId, workspaceId)));
  if (!found) throw notFound("Roll call");
  const marker = alias(users, "marker");
  const entries = await db
    .select({ entry: attendanceRollCallEntries, markedByName: marker.name })
    .from(attendanceRollCallEntries)
    .leftJoin(marker, eq(marker.id, attendanceRollCallEntries.markedBy))
    .where(eq(attendanceRollCallEntries.rollCallId, id))
    .orderBy(asc(attendanceRollCallEntries.name));
  const { workspaceId: _ws, deletedAt: _deleted, ...call } = found.call;
  return {
    ...call,
    startedByName: found.startedByName,
    endedByName: found.endedByName,
    entries: entries.map(({ entry, markedByName }) => {
      const { workspaceId: _w, deletedAt: _d, ...rest } = entry;
      return { ...rest, markedByName };
    }),
  };
}

/**
 * Starts a roll call: everyone on site now, plus anyone who may have left without clocking out
 * (better to check one person too many), frozen as the list to account for. One at a time.
 */
export async function startRollCall(
  db: Database,
  workspaceId: string,
  actorId: string,
  kind: RollCallKind,
  notes: string | null | undefined,
) {
  const id = await db.transaction(async (tx) => {
    // Two marshals pressing at once: the second waits here, then sees the first one open.
    await lockWorkspaceLog(tx, workspaceId);
    const [open] = await tx
      .select({ id: attendanceRollCalls.id })
      .from(attendanceRollCalls)
      .where(and(eq(attendanceRollCalls.workspaceId, workspaceId), isNull(attendanceRollCalls.endedAt)))
      .for("update");
    if (open) throw new ApiError(409, "roll_call_open", "A roll call is already running", { id: open.id });
    const here = await onSite(tx, workspaceId);
    const { timeZone } = await getAttendanceSettings(tx, workspaceId);
    const sinceText = (at: Date) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(at);
    const now = new Date();
    const [call] = await tx
      .insert(attendanceRollCalls)
      .values({ workspaceId, kind, startedAt: now, startedBy: actorId, notes: notes ?? null })
      .returning();
    const staffEntries = [...here.staff, ...here.possiblyLeft.staff].map((s) => ({
      workspaceId,
      rollCallId: call!.id,
      staffId: s.id,
      name: `${s.firstName} ${s.lastName}`,
      detail: here.staff.includes(s)
        ? s.staffNumber
        : `${s.staffNumber} · no clock-out since ${sinceText(s.since)}`,
    }));
    const visitorEntries = [...here.visitors, ...here.possiblyLeft.visitors].map((v) => ({
      workspaceId,
      rollCallId: call!.id,
      visitId: v.id,
      name: `${v.firstName} ${v.lastName}`,
      detail: visitorDetail(v),
    }));
    const entries = [...staffEntries, ...visitorEntries];
    if (entries.length) await tx.insert(attendanceRollCallEntries).values(entries);
    return call!.id;
  });
  return getRollCall(db, workspaceId, id);
}

export async function markRollCallEntry(
  db: Database,
  workspaceId: string,
  actorId: string,
  rollCallId: string,
  entryId: string,
  status: RollCallStatus,
) {
  return db.transaction(async (tx) => {
    const call = await getOpenRollCall(tx, workspaceId, rollCallId);
    const [entry] = await tx
      .update(attendanceRollCallEntries)
      .set({ status, markedAt: new Date(), markedBy: actorId })
      .where(
        and(eq(attendanceRollCallEntries.id, entryId), eq(attendanceRollCallEntries.rollCallId, call.id)),
      )
      .returning();
    if (!entry) throw notFound("Roll call entry");
    const { workspaceId: _ws, deletedAt: _deleted, ...rest } = entry;
    return rest;
  });
}

async function getOpenRollCall(db: Executor, workspaceId: string, id: string) {
  const [call] = await db
    .select()
    .from(attendanceRollCalls)
    .where(and(eq(attendanceRollCalls.id, id), eq(attendanceRollCalls.workspaceId, workspaceId)));
  if (!call) throw notFound("Roll call");
  if (call.endedAt) throw new ApiError(409, "roll_call_ended", "This roll call has ended");
  return call;
}

export async function endRollCall(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  notes: string | null | undefined,
) {
  await db.transaction(async (tx) => {
    const call = await getOpenRollCall(tx, workspaceId, id);
    await tx
      .update(attendanceRollCalls)
      .set({
        endedAt: new Date(),
        endedBy: actorId,
        ...(notes !== undefined ? { notes: [call.notes, notes].filter(Boolean).join("\n") || null } : {}),
      })
      .where(eq(attendanceRollCalls.id, id));
  });
  return getRollCall(db, workspaceId, id);
}

// ─── Visitors ────────────────────────────────────────────────────────────────

/** "Visitor · Acme Ltd · visiting Grace Hopper": the roll-call line for a visitor. */
export const visitorDetail = (v: { company: string | null; hostName: string | null }) =>
  ["Visitor", v.company, v.hostName ? `visiting ${v.hostName}` : null].filter(Boolean).join(" · ");

/** A visitor's host: an active member of staff or a current workspace member, with their name. */
async function resolveVisitorHost(
  db: Executor,
  workspaceId: string,
  host: KioskVisitorSignInInput["host"],
): Promise<{
  hostStaffId: string | null;
  hostUserId: string | null;
  hostName: string | null;
  /** The login to tell the visitor has arrived: the member, or the one a staff host is linked to. */
  loginUserId: string | null;
}> {
  if (!host) return { hostStaffId: null, hostUserId: null, hostName: null, loginUserId: null };
  if (host.kind === "staff") {
    const [row] = await db
      .select({ id: staff.id, firstName: staff.firstName, lastName: staff.lastName, userId: staff.userId })
      .from(staff)
      .where(
        and(
          eq(staff.id, host.id),
          eq(staff.workspaceId, workspaceId),
          eq(staff.status, "active"),
          isNull(staff.deletedAt),
        ),
      );
    if (!row) throw new ApiError(400, "host_not_found", "That host isn't on the staff list");
    return {
      hostStaffId: row.id,
      hostUserId: null,
      hostName: `${row.firstName} ${row.lastName}`,
      loginUserId: row.userId,
    };
  }
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, host.id),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!row) throw new ApiError(400, "host_not_found", "That host isn't a member of this workspace");
  return { hostStaffId: null, hostUserId: row.id, hostName: row.name, loginUserId: row.id };
}

/** Where a sign-in or sign-out came from: a kiosk now, or a kiosk replaying what it queued offline. */
export interface VisitOrigin {
  deviceId: string | null;
  /** The visitor's time; default now. Replays pass the (corrected) time it happened. */
  at?: Date;
  offline?: boolean;
}

const visitReceipt = (row: typeof attendanceVisits.$inferSelect) => ({
  id: row.id,
  firstName: row.firstName,
  signedInAt: row.signedInAt,
});

/** Deletes visits older than the workspace's retention period (run lazily on each visitor write). */
async function purgeOldVisits(db: Executor, workspaceId: string, months: number) {
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  // Roll-call entries keep the name they copied; their link to the visit goes.
  await db
    .delete(attendanceVisits)
    .where(and(eq(attendanceVisits.workspaceId, workspaceId), lt(attendanceVisits.signedInAt, cutoff)));
  // "Your visitor has arrived" notifications name the visitor too: same schedule.
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.type, "visitor_arrived"),
        lt(notifications.createdAt, cutoff),
      ),
    );
  // Refused offline visitor entries name the visitor too: they go on the same schedule.
  await db
    .delete(attendanceKioskRejections)
    .where(
      and(
        eq(attendanceKioskRejections.workspaceId, workspaceId),
        inArray(attendanceKioskRejections.type, ["visitor_in", "visitor_out"]),
        lt(attendanceKioskRejections.at, cutoff),
      ),
    );
}

export async function listVisits(db: Database, workspaceId: string, from: string, to: string) {
  const settings = await getAttendanceSettings(db, workspaceId);
  await purgeOldVisits(db, workspaceId, settings.visitorRetentionMonths);
  const window = periodWindow(from, to, { ...settings, maxShiftHours: 0 });
  const rows = await db
    .select()
    .from(attendanceVisits)
    .where(
      and(
        eq(attendanceVisits.workspaceId, workspaceId),
        gte(attendanceVisits.signedInAt, window.start),
        lte(attendanceVisits.signedInAt, window.end),
      ),
    )
    .orderBy(desc(attendanceVisits.signedInAt));
  return rows
    .filter((v) => localInPeriod(v.signedInAt, settings, { from, to }))
    .map(({ workspaceId: _ws, deletedAt: _deleted, ...v }) => v);
}

/** One visit, for its printed pass (`404` once it has been deleted after the retention period). */
export async function getVisit(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(attendanceVisits)
    .where(and(eq(attendanceVisits.workspaceId, workspaceId), eq(attendanceVisits.id, id)));
  if (!row) throw notFound("Visit");
  const { workspaceId: _ws, deletedAt: _deleted, ...visit } = row;
  return visit;
}

/** What an offline kiosk showed the visitor, sealed in the queued sign-in. */
export interface ShownAtKiosk {
  /** The site rules shown, null when there were none; absent in entries queued before kiosks sealed them. */
  siteRules?: string | null;
  /** The host's name as shown. */
  hostName?: string | null;
}

/**
 * Signs a visitor in. Live, the visit must meet today's rules: the site rules accepted when there
 * are any (`400 site_rules_required`) and a host who is still here (`400 host_not_found`).
 *
 * A replay of an offline sign-in (`origin.offline`, with what the kiosk showed) is recorded
 * whatever has changed since: the person is physically on site and must be on the on-site register
 * and in any roll call. The visit keeps the rules the kiosk showed (and their SHA-256), accepted or
 * not, and a host who has left since is kept by name only, flagged `hostMissing` for a manager to
 * check.
 */
export async function signInVisitor(
  db: Database,
  workspaceId: string,
  origin: VisitOrigin,
  input: KioskVisitorSignInInput,
  shown?: ShownAtKiosk,
) {
  const settings = await getAttendanceSettings(db, workspaceId);
  await purgeOldVisits(db, workspaceId, settings.visitorRetentionMonths);
  const replayed = origin.offline === true;
  const rules = settings.visitorSiteRules;
  if (!replayed && rules && !input.acceptedRules) {
    throw new ApiError(400, "site_rules_required", "Please read and accept the site rules to sign in");
  }
  const { receipt, notified } = await db.transaction(async (tx) => {
    if (input.clientId) {
      // A retry of the same sign-in (a timeout, or a replay) returns the visit it made.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.clientId}, 2))`);
      const [prior] = await tx
        .select()
        .from(attendanceVisits)
        .where(
          and(eq(attendanceVisits.workspaceId, workspaceId), eq(attendanceVisits.clientId, input.clientId)),
        );
      if (prior) return { receipt: { ...visitReceipt(prior), repeated: true }, notified: [] };
    }
    let host: Awaited<ReturnType<typeof resolveVisitorHost>> & { hostMissing?: boolean };
    try {
      host = await resolveVisitorHost(tx, workspaceId, input.host);
    } catch (err) {
      if (!(replayed && err instanceof ApiError && err.code === "host_not_found")) throw err;
      host = {
        hostStaffId: null,
        hostUserId: null,
        hostName: shown?.hostName ?? null,
        loginUserId: null,
        hostMissing: true,
      };
    }
    const { loginUserId, ...hostColumns } = host;
    const at = origin.at ?? new Date();
    let record: { siteRules: string | null; siteRulesHash: string | null; siteRulesAcceptedAt: Date | null };
    if (!replayed) {
      record = {
        siteRules: rules,
        siteRulesHash: rules ? sha256(rules) : null,
        siteRulesAcceptedAt: rules ? at : null,
      };
    } else if (shown?.siteRules === undefined) {
      // Queued before kiosks sealed the rules they showed: which rules, if any, isn't known.
      record = { siteRules: null, siteRulesHash: null, siteRulesAcceptedAt: input.acceptedRules ? at : null };
    } else {
      // The rules the kiosk showed, whatever is in force by the time it replays.
      const text = shown.siteRules || null;
      record = {
        siteRules: text,
        siteRulesHash: text ? sha256(text) : null,
        siteRulesAcceptedAt: text && input.acceptedRules ? at : null,
      };
    }
    const [row] = await tx
      .insert(attendanceVisits)
      .values({
        workspaceId,
        firstName: input.firstName,
        lastName: input.lastName,
        company: input.company ?? null,
        ...hostColumns,
        ...record,
        signedInAt: at,
        deviceId: origin.deviceId,
        clientId: input.clientId ?? null,
        offline: origin.offline ?? false,
      })
      .returning();
    // Tell the host (when they have a login), unless this is an old sign-in replayed late.
    const fresh = Date.now() - at.getTime() <= VISITOR_NOTIFY_MAX_AGE_MINUTES * 60_000;
    const notified =
      loginUserId && fresh ? await notifyVisitorArrived(tx, workspaceId, loginUserId, row!) : [];
    return { receipt: { ...visitReceipt(row!), repeated: false }, notified };
  });
  // After the commit, and never delaying the answer.
  void deliverNotifications(db, notified);
  return receipt;
}

/**
 * Signs a visitor out by name: the most recent open visit with that first and last name (any
 * case) that began before the sign-out. With a client id, a retry returns the same answer.
 */
export async function signOutVisitorByName(
  db: Database,
  workspaceId: string,
  origin: VisitOrigin,
  input: KioskVisitorInput,
) {
  return db.transaction(async (tx) => {
    if (input.clientId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.clientId}, 2))`);
      const [prior] = await tx
        .select({ firstName: attendanceVisits.firstName })
        .from(attendanceVisits)
        .where(
          and(
            eq(attendanceVisits.workspaceId, workspaceId),
            eq(attendanceVisits.signOutClientId, input.clientId),
          ),
        );
      if (prior) return { firstName: prior.firstName, repeated: true };
    }
    const at = origin.at ?? new Date();
    const [visit] = await tx
      .select()
      .from(attendanceVisits)
      .where(
        and(
          eq(attendanceVisits.workspaceId, workspaceId),
          isNull(attendanceVisits.signedOutAt),
          lte(attendanceVisits.signedInAt, at),
          sql`lower(${attendanceVisits.firstName}) = lower(${input.firstName})`,
          sql`lower(${attendanceVisits.lastName}) = lower(${input.lastName})`,
        ),
      )
      .orderBy(desc(attendanceVisits.signedInAt))
      .limit(1)
      .for("update");
    if (!visit) throw new ApiError(404, "visitor_not_found", "No visitor with that name is signed in");
    await tx
      .update(attendanceVisits)
      .set({
        signedOutAt: at,
        signedOutHow: "self",
        signOutClientId: input.clientId ?? null,
        signedOutOffline: origin.offline ?? false,
      })
      .where(eq(attendanceVisits.id, visit.id));
    return { firstName: visit.firstName, repeated: false };
  });
}

/** A manager (or a roll call) signing a visitor out who left without doing it. */
export async function signOutVisit(db: Database, workspaceId: string, actorId: string, id: string) {
  const [visit] = await db
    .update(attendanceVisits)
    .set({ signedOutAt: new Date(), signedOutHow: "manager", signedOutBy: actorId })
    .where(
      and(
        eq(attendanceVisits.id, id),
        eq(attendanceVisits.workspaceId, workspaceId),
        isNull(attendanceVisits.signedOutAt),
      ),
    )
    .returning();
  if (!visit) throw notFound("Open visit");
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = visit;
  return rest;
}

// ─── Devices ─────────────────────────────────────────────────────────────────

type DeviceRow = typeof attendanceDevices.$inferSelect;
const deviceView = (d: DeviceRow) => ({
  id: d.id,
  name: d.name,
  pairedAt: d.pairedAt,
  lastSeenAt: d.lastSeenAt,
  pairingExpiresAt: d.pairingCodeHash ? d.pairingExpiresAt : null,
  revokedAt: d.revokedAt,
  createdAt: d.createdAt,
});

const newPairingCode = () =>
  Array.from({ length: 8 }, () => KIOSK_PAIRING_ALPHABET[randomInt(KIOSK_PAIRING_ALPHABET.length)]).join("");

export async function listDevices(db: Database, workspaceId: string) {
  const rows = await db
    .select()
    .from(attendanceDevices)
    .where(and(eq(attendanceDevices.workspaceId, workspaceId), isNull(attendanceDevices.deletedAt)))
    .orderBy(asc(attendanceDevices.revokedAt), asc(attendanceDevices.name));
  return rows.map(deviceView);
}

/** A new kiosk with a one-time pairing code (returned once, valid for `KIOSK_PAIRING_MINUTES`). */
export async function createDevice(db: Database, workspaceId: string, actorId: string, name: string) {
  const code = newPairingCode();
  const [row] = await db
    .insert(attendanceDevices)
    .values({
      workspaceId,
      name,
      createdBy: actorId,
      pairingCodeHash: sha256(code),
      pairingExpiresAt: new Date(Date.now() + KIOSK_PAIRING_MINUTES * 60_000),
    })
    .returning();
  return { device: deviceView(row!), pairingCode: code };
}

/** A fresh pairing code for an existing kiosk (a replaced tablet): its old credential stops working. */
export async function renewPairingCode(db: Database, workspaceId: string, id: string) {
  const code = newPairingCode();
  const [row] = await db
    .update(attendanceDevices)
    .set({
      pairingCodeHash: sha256(code),
      pairingExpiresAt: new Date(Date.now() + KIOSK_PAIRING_MINUTES * 60_000),
      tokenHash: null,
      pairedAt: null,
    })
    .where(
      and(
        eq(attendanceDevices.id, id),
        eq(attendanceDevices.workspaceId, workspaceId),
        isNull(attendanceDevices.revokedAt),
      ),
    )
    .returning();
  if (!row) throw notFound("Kiosk");
  return { device: deviceView(row), pairingCode: code };
}

export async function revokeDevice(db: Database, workspaceId: string, actorId: string, id: string) {
  const [row] = await db
    .update(attendanceDevices)
    .set({ revokedAt: new Date(), revokedBy: actorId, tokenHash: null, pairingCodeHash: null })
    .where(
      and(
        eq(attendanceDevices.id, id),
        eq(attendanceDevices.workspaceId, workspaceId),
        isNull(attendanceDevices.revokedAt),
      ),
    )
    .returning();
  if (!row) throw notFound("Kiosk");
  return deviceView(row);
}

/** Swaps a pairing code for a device credential (the tablet keeps it). */
export async function pairDevice(db: Database, code: string, available: readonly ModuleId[]) {
  return db.transaction(async (tx) => {
    const [device] = await tx
      .select()
      .from(attendanceDevices)
      .where(and(eq(attendanceDevices.pairingCodeHash, sha256(code)), isNull(attendanceDevices.revokedAt)))
      .for("update");
    if (!device || !device.pairingExpiresAt || device.pairingExpiresAt < new Date()) {
      throw new ApiError(
        400,
        "pairing_code_invalid",
        "That pairing code is wrong or has expired. Ask a manager for a new one.",
      );
    }
    const [ws] = await tx
      .select({ slug: workspaces.slug, name: workspaces.name, enabledModules: workspaces.enabledModules })
      .from(workspaces)
      .where(and(eq(workspaces.id, device.workspaceId), isNull(workspaces.deletedAt)));
    if (!ws || !activeWorkspaceModules(available, ws.enabledModules).includes("attendance")) {
      throw new ApiError(404, "module_inactive", "The attendance module is not enabled in this workspace");
    }
    const token = `${KIOSK_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    await tx
      .update(attendanceDevices)
      .set({
        tokenHash: sha256(token),
        pairingCodeHash: null,
        pairingExpiresAt: null,
        pairedAt: new Date(),
        lastSeenAt: new Date(),
      })
      .where(eq(attendanceDevices.id, device.id));
    return {
      token,
      device: { id: device.id, name: device.name },
      workspace: { slug: ws.slug, name: ws.name },
    };
  });
}

export interface KioskDevice {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

/** The device behind a credential, or null. Marks it seen (at most once a minute). */
export async function authenticateDevice(db: Database, token: string): Promise<KioskDevice | null> {
  if (!token.startsWith(KIOSK_TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({ device: attendanceDevices, workspaceName: workspaces.name })
    .from(attendanceDevices)
    .innerJoin(
      workspaces,
      and(eq(workspaces.id, attendanceDevices.workspaceId), isNull(workspaces.deletedAt)),
    )
    .where(
      and(
        eq(attendanceDevices.tokenHash, sha256(token)),
        isNull(attendanceDevices.revokedAt),
        isNotNull(attendanceDevices.tokenHash),
      ),
    );
  if (!row) return null;
  if (!row.device.lastSeenAt || Date.now() - row.device.lastSeenAt.getTime() > 60_000) {
    await db
      .update(attendanceDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(attendanceDevices.id, row.device.id));
  }
  return {
    id: row.device.id,
    name: row.device.name,
    workspaceId: row.device.workspaceId,
    workspaceName: row.workspaceName,
  };
}

// ─── Kiosk clocking ──────────────────────────────────────────────────────────

/** A person's latest live clock event. */
export async function lastClockEvent(db: Executor, staffId: string) {
  const [row] = await db
    .select({ id: attendanceEvents.id, kind: attendanceEvents.kind, at: attendanceEvents.at })
    .from(attendanceEvents)
    .where(and(eq(attendanceEvents.staffId, staffId), isNull(attendanceEvents.voidedAt)))
    .orderBy(desc(attendanceEvents.at), desc(attendanceEvents.id))
    .limit(1);
  return row ?? null;
}

export async function kioskExpected(db: Executor, workspaceId: string, staffId: string) {
  const [settings, last] = await Promise.all([
    getAttendanceSettings(db, workspaceId),
    lastClockEvent(db, staffId),
  ]);
  return { expected: expectedClockKind(last, settings.maxShiftHours), last };
}

/**
 * Clocks a person in or out from a kiosk. A second tap of the same kind within two minutes
 * returns the first event instead of adding another (a double tap, or a retry after a timeout),
 * and so does a retry with the same client id.
 */
export async function kioskClock(
  db: Database,
  device: KioskDevice,
  staffId: string,
  kind: ClockKind,
  clientId?: string,
) {
  return db.transaction(async (tx) => {
    // One clock at a time per person.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${staffId}, 1))`);
    if (clientId) {
      const prior = await eventByClientId(tx, device.workspaceId, clientId);
      if (prior) return { id: prior.id, kind: prior.kind, at: prior.at, repeated: true };
    }
    const last = await lastClockEvent(tx, staffId);
    if (last && last.kind === kind && Date.now() - last.at.getTime() < 2 * 60_000) {
      return { id: last.id, kind, at: last.at, repeated: true };
    }
    const [row] = await tx
      .insert(attendanceEvents)
      .values({
        workspaceId: device.workspaceId,
        staffId,
        kind,
        at: new Date(),
        source: "kiosk",
        deviceId: device.id,
        clientId: clientId ?? null,
      })
      .returning();
    return { id: row!.id, kind, at: row!.at, repeated: false };
  });
}

export async function eventByClientId(db: Executor, workspaceId: string, clientId: string) {
  const [row] = await db
    .select({ id: attendanceEvents.id, kind: attendanceEvents.kind, at: attendanceEvents.at })
    .from(attendanceEvents)
    .where(and(eq(attendanceEvents.workspaceId, workspaceId), eq(attendanceEvents.clientId, clientId)));
  return row ?? null;
}

const DOUBLE_TAP_MS = 2 * 60_000;

/** Why an offline clock event can't go into the ledger, or that it is already there. */
export type OfflineClockOutcome =
  | { status: "accepted"; id: string; at: Date }
  | { status: "duplicate"; id: string; at: Date }
  | { status: "conflict"; message: string }
  /**
   * A clock-out with no open clock-in before it, yet: the clock-in may still be on its way from
   * another offline kiosk, so the caller retries it rather than refusing it for good.
   */
  | { status: "no_open_in"; message: string };

/**
 * Adds a clock event a kiosk queued while offline, at the time it happened. It must fit the
 * person's recorded events (live ones, voided ignored) around that time:
 *
 * - The same kind within two minutes of an existing event is that event (a double tap, or the
 *   person also clocked on another kiosk): nothing is added.
 * - A clock-in while already clocked in (the event before is an `in` within the maximum shift),
 *   or with a later clock-in already recorded within the maximum shift, contradicts the ledger.
 * - A clock-out needs an open clock-in before it (within the maximum shift): without one the
 *   outcome is `no_open_in` (not stored; the clock-in may come later from another kiosk). It
 *   contradicts a later clock-out already recorded within the maximum shift (someone closed that
 *   shift).
 *
 * Events in one replay are applied in time order, so an offline in-then-out pair fits.
 */
export async function addOfflineClockEvent(
  db: Database,
  device: KioskDevice,
  staffId: string,
  kind: ClockKind,
  at: Date,
  clientId: string,
  maxShiftHours: number,
  timeZone: string,
): Promise<OfflineClockOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${staffId}, 1))`);
    const prior = await eventByClientId(tx, device.workspaceId, clientId);
    if (prior) return { status: "duplicate", id: prior.id, at: prior.at };
    const live = and(eq(attendanceEvents.staffId, staffId), isNull(attendanceEvents.voidedAt));
    const pick = { id: attendanceEvents.id, kind: attendanceEvents.kind, at: attendanceEvents.at };
    const [prev] = await tx
      .select(pick)
      .from(attendanceEvents)
      .where(and(live, lte(attendanceEvents.at, at)))
      .orderBy(desc(attendanceEvents.at), desc(attendanceEvents.id))
      .limit(1);
    const [next] = await tx
      .select(pick)
      .from(attendanceEvents)
      .where(and(live, gte(attendanceEvents.at, at), prev ? ne(attendanceEvents.id, prev.id) : undefined))
      .orderBy(asc(attendanceEvents.at), asc(attendanceEvents.id))
      .limit(1);
    for (const near of [prev, next]) {
      if (near && near.kind === kind && Math.abs(near.at.getTime() - at.getTime()) < DOUBLE_TAP_MS) {
        return { status: "duplicate", id: near.id, at: near.at };
      }
    }
    const max = maxShiftHours * 3_600_000;
    const time = (d: Date) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    const prevOpen = prev && prev.kind === "in" && at.getTime() - prev.at.getTime() <= max;
    const nextSame = next && next.kind === kind && next.at.getTime() - at.getTime() <= max;
    if (kind === "in" && prevOpen) {
      return { status: "conflict", message: `Already clocked in since ${time(prev.at)}` };
    }
    if (kind === "out" && !prevOpen) {
      return { status: "no_open_in", message: "No clock-in before it to close" };
    }
    if (nextSame) {
      return {
        status: "conflict",
        message: `A later clock-${kind} at ${time(next.at)} is already recorded`,
      };
    }
    const [row] = await tx
      .insert(attendanceEvents)
      .values({
        workspaceId: device.workspaceId,
        staffId,
        kind,
        at,
        source: "kiosk",
        deviceId: device.id,
        clientId,
        offline: true,
      })
      .returning();
    return { status: "accepted", id: row!.id, at: row!.at };
  });
}
