import { createHash } from "node:crypto";
import {
  absencesForManualEntry,
  datesBetween,
  findPayrollExportAdapter,
  payrollExportAdapters,
  type PayrollAbsenceDays,
  type PayrollRunEmployee,
  type PayrollRunSnapshot,
  type payrollRunApproveSchema,
  type payrollRunCorrectSchema,
  type payrollRunExportSchema,
  type payrollRunPrepareSchema,
  type payrollRunWithdrawSchema,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  staff,
  users,
  workforceAbsences as absences,
  workforcePayrollRunEvents as events,
  workforcePayrollRuns as runs,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { ApiError, notFound } from "../errors";
import { payrollPeriodTotals } from "./attendance";
import { executeLedgerCommand } from "./ledger-command";
import { agencyEngagementsFor } from "./workforce-rota";

/**
 * Payroll runs (Phase 3.4.4.4). A run freezes one pay period's hours (from Attendance) and absence
 * days (from Private HR records) into an immutable snapshot. One person prepares it, another
 * approves it, and exports are built from the snapshot and recorded. A correction is a new version.
 * Nothing here calculates pay, entitlement or sick pay, and nothing is synced.
 */

const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
type Run = typeof runs.$inferSelect;
type Period = { from: string; to: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
type Range = { from: string; to: string };
/** The parts of a period covered by any agency engagement, merged and in order. */
function coveredRanges(engaged: { startOn: string; endOn: string | null }[], period: Period): Range[] {
  const clipped = engaged
    .map((e) => ({
      from: e.startOn < period.from ? period.from : e.startOn,
      to: !e.endOn || e.endOn > period.to ? period.to : e.endOn,
    }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from.localeCompare(b.from));
  const merged: Range[] = [];
  for (const r of clipped) {
    const last = merged[merged.length - 1];
    if (last && r.from <= addDays(last.to, 1)) {
      if (r.to > last.to) last.to = r.to;
    } else merged.push({ ...r });
  }
  return merged;
}
function uncoveredRanges(covered: Range[], period: Period): Range[] {
  const out: Range[] = [];
  let cursor = period.from;
  for (const r of covered) {
    if (r.from > cursor) out.push({ from: cursor, to: addDays(r.from, -1) });
    cursor = addDays(r.to, 1);
  }
  if (cursor <= period.to) out.push({ from: cursor, to: period.to });
  return out;
}
const inRanges = (date: string, ranges: Range[]) => ranges.some((r) => r.from <= date && date <= r.to);

/**
 * Builds the snapshot for a period from live records, with blockers that stop a run being prepared:
 * shifts that need fixing, people still clocked in, leave still awaiting a decision, and open
 * sickness for someone who has left.
 *
 * Absence days are clipped to the period, to the person's employment dates, and (open-ended
 * sickness) to today. Someone agency-supplied for only part of the period is split: hours and
 * absence days on agency-covered dates go to the agency list (absences dropped, as the agency
 * handles them), the rest to an employee row.
 */
export async function buildPayrollSnapshot(db: Executor, ws: string, period: Period, today: string) {
  const { settings, people } = await payrollPeriodTotals(db, ws, period);
  const blockers: string[] = [];
  const issues = people.reduce((n, p) => n + p.issueShifts, 0);
  const open = people.filter((p) => p.openShifts > 0).length;
  if (issues)
    blockers.push(
      `${plural(issues, "shift has", "shifts have")} a missing or overlong clock event. Fix them in Attendance first.`,
    );
  if (open) blockers.push(`${plural(open, "person is", "people are")} still clocked in during this period.`);

  const absenceRows = await db
    .select({
      staffId: absences.staffId,
      kind: absences.kind,
      state: absences.state,
      startOn: absences.startOn,
      endOn: absences.endOn,
    })
    .from(absences)
    .where(
      and(
        eq(absences.workspaceId, ws),
        inArray(absences.state, ["pending", "approved", "reported", "recorded"]),
        lte(absences.startOn, period.to),
        or(isNull(absences.endOn), gte(absences.endOn, period.from)),
      ),
    );
  const pending = absenceRows.filter((a) => a.state === "pending").length;
  if (pending)
    blockers.push(
      `${plural(pending, "leave request overlapping this period is", "leave requests overlapping this period are")} still awaiting a decision.`,
    );

  const hoursById = new Map(people.map((p) => [p.staff.id, p]));
  const ids = [...new Set([...hoursById.keys(), ...absenceRows.map((a) => a.staffId)])];
  const staffRows = ids.length
    ? await db
        .select({
          id: staff.id,
          staffNumber: staff.staffNumber,
          payrollReference: staff.payrollReference,
          firstName: staff.firstName,
          lastName: staff.lastName,
          startDate: staff.startDate,
          endDate: staff.endDate,
          userId: staff.userId,
        })
        .from(staff)
        .where(and(eq(staff.workspaceId, ws), inArray(staff.id, ids)))
        .orderBy(asc(staff.lastName), asc(staff.firstName), asc(staff.id))
    : [];
  const staffById = new Map(staffRows.map((p) => [p.id, p]));
  const leaversWithOpenSickness = new Set(
    absenceRows
      .filter((a) => !a.endOn && a.state !== "pending" && staffById.get(a.staffId)?.endDate)
      .map((a) => a.staffId),
  ).size;
  if (leaversWithOpenSickness)
    blockers.push(
      `${plural(leaversWithOpenSickness, "person who has left has", "people who have left have")} sickness with no last day. Record the last day in Private HR records first.`,
    );

  // Days per person and kind, each day counted once per kind (overlapping records don't double count).
  const days = new Map<string, Map<keyof PayrollAbsenceDays, Set<string>>>();
  for (const a of absenceRows) {
    const p = staffById.get(a.staffId);
    if (a.state === "pending" || !p) continue;
    const lower = [period.from, a.startOn, p.startDate]
      .filter((d): d is string => !!d)
      .sort()
      .at(-1)!;
    const upper = [period.to, a.endOn ?? today, p.endDate].filter((d): d is string => !!d).sort()[0]!;
    if (lower > upper) continue;
    const byKind = days.get(a.staffId) ?? new Map<keyof PayrollAbsenceDays, Set<string>>();
    const set = byKind.get(a.kind) ?? new Set<string>();
    for (const d of datesBetween(lower, upper)) set.add(d);
    byKind.set(a.kind, set);
    days.set(a.staffId, byKind);
  }
  const unacknowledged = absenceRows.filter((a) => a.state === "reported").length;
  const engagements = await agencyEngagementsFor(db, ws, ids, period.from, period.to);

  const employees: PayrollRunEmployee[] = [];
  const agencyWorkers: PayrollRunSnapshot["agencyWorkers"] = [];
  const warnings: string[] = [];
  let partialAgency = 0;
  let overlapPeople = 0;
  const totalsFor = async (staffId: string, ranges: Range[]) => {
    const sum = { shifts: 0, basicMinutes: 0, overtimeMinutes: 0 };
    for (const r of ranges) {
      const part = (await payrollPeriodTotals(db, ws, r, [staffId])).people[0];
      if (!part) continue;
      sum.shifts += part.shifts;
      sum.basicMinutes += part.basicMinutes;
      sum.overtimeMinutes += part.overtimeMinutes;
    }
    return sum;
  };
  for (const p of staffRows) {
    const engaged = [...(engagements.get(p.id) ?? [])].sort((a, b) => b.startOn.localeCompare(a.startOn));
    const covered = coveredRanges(engaged, period);
    const whole = hoursById.get(p.id);
    let employeeHours = whole
      ? { shifts: whole.shifts, basicMinutes: whole.basicMinutes, overtimeMinutes: whole.overtimeMinutes }
      : null;
    let employeeDays: (date: string) => boolean = () => true;
    if (covered.length) {
      const fullyCovered =
        covered.length === 1 && covered[0]!.from === period.from && covered[0]!.to === period.to;
      const uncovered = uncoveredRanges(covered, period);
      const agencyHours = fullyCovered ? employeeHours : whole ? await totalsFor(p.id, covered) : null;
      if (agencyHours && agencyHours.basicMinutes + agencyHours.overtimeMinutes > 0)
        agencyWorkers.push({
          staffId: p.id,
          staffNumber: p.staffNumber,
          firstName: p.firstName,
          lastName: p.lastName,
          agencyName: engaged[0]!.agencyName,
          reference: engaged[0]!.reference,
          ...agencyHours,
        });
      if (fullyCovered) continue;
      partialAgency++;
      employeeHours = whole ? await totalsFor(p.id, uncovered) : null;
      employeeDays = (d: string) => inRanges(d, uncovered);
    }
    const byKind = days.get(p.id);
    const count = (kind: keyof PayrollAbsenceDays) => [...(byKind?.get(kind) ?? [])].filter(employeeDays);
    const absenceDays: PayrollAbsenceDays = {
      annual_leave: count("annual_leave").length,
      other_leave: count("other_leave").length,
      sickness: count("sickness").length,
    };
    const sick = new Set(count("sickness"));
    if ([...count("annual_leave"), ...count("other_leave")].some((d) => sick.has(d))) overlapPeople++;
    const minutes = employeeHours ? employeeHours.basicMinutes + employeeHours.overtimeMinutes : 0;
    if (!minutes && !absenceDays.annual_leave && !absenceDays.other_leave && !absenceDays.sickness) continue;
    employees.push({
      staffId: p.id,
      staffNumber: p.staffNumber,
      payrollReference: p.payrollReference,
      firstName: p.firstName,
      lastName: p.lastName,
      shifts: employeeHours?.shifts ?? 0,
      basicMinutes: employeeHours?.basicMinutes ?? 0,
      overtimeMinutes: employeeHours?.overtimeMinutes ?? 0,
      absenceDays,
    });
  }
  if (period.to >= today)
    warnings.push(
      "This period hasn't finished yet: later clocking and absences aren't in the run, and open sickness counts only up to today.",
    );
  if (unacknowledged)
    warnings.push(
      `${plural(unacknowledged, "sickness report hasn't", "sickness reports haven't")} been acknowledged in Private HR records yet.`,
    );
  if (overlapPeople)
    warnings.push(
      `${plural(overlapPeople, "person has", "people have")} sickness recorded during booked leave. Absence days count each kind separately; reconcile under your policy.`,
    );
  if (partialAgency)
    warnings.push(
      `${plural(partialAgency, "person was", "people were")} agency-supplied for part of the period: hours on agency-covered days are listed under agency workers and the rest as an employee. Overtime weeks that span the change count the whole week's hours towards the threshold.`,
    );
  if (employees.some((e) => !e.payrollReference))
    warnings.push("Some employees have no payroll reference: their staff number is used instead.");

  const included = new Set([...employees, ...agencyWorkers].map((e) => e.staffId));
  const snapshot: PayrollRunSnapshot = {
    version: 1,
    from: period.from,
    to: period.to,
    references: {
      sageBasicPaymentRef: settings.sageBasicPaymentRef ?? null,
      sageOvertimePaymentRef: settings.sageOvertimePaymentRef ?? null,
    },
    employees,
    agencyWorkers,
    warnings,
    linkedUserIds: [
      ...new Set(staffRows.filter((p) => included.has(p.id) && p.userId).map((p) => p.userId!)),
    ].sort(),
  };
  return { snapshot, blockers };
}

async function findRun(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.workspaceId, ws), eq(runs.id, id)));
  if (!row) throw notFound("Payroll run");
  return row;
}
async function event(
  tx: Transaction,
  ws: string,
  runId: string,
  actorId: string,
  action: string,
  detail: object,
) {
  await tx
    .insert(events)
    .values({ workspaceId: ws, runId, actorId, action, detail: detail as Record<string, unknown> });
}
const runView = (r: Run) => ({
  id: r.id,
  from: r.periodFrom,
  to: r.periodTo,
  version: r.version,
  supersedesId: r.supersedesId,
  state: r.state,
  snapshotHash: r.snapshotHash,
  note: r.note,
  preparedBy: r.preparedBy,
  approvedBy: r.approvedBy,
  approvedAt: r.approvedAt,
  approvalNote: r.approvalNote,
  supersededAt: r.supersededAt,
  revision: r.revision,
  createdAt: r.createdAt,
  employees: r.snapshot.employees.length,
  agencyWorkers: r.snapshot.agencyWorkers.length,
});

/** Adapters as offered to the page: what each carries and its package compatibility. */
export const adapterSummaries = () =>
  payrollExportAdapters.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    compatibility: a.compatibility,
    carriesAbsences: a.carriesAbsences,
  }));

export async function previewPayrollRun(db: Database, ws: string, period: Period, today: string) {
  return { ...(await buildPayrollSnapshot(db, ws, period, today)), adapters: adapterSummaries() };
}

export async function listPayrollRuns(db: Database, ws: string, offset = 0) {
  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.workspaceId, ws))
    .orderBy(desc(runs.periodFrom), desc(runs.version), desc(runs.id))
    .limit(51)
    .offset(offset);
  return { runs: rows.slice(0, 50).map(runView), hasMore: rows.length > 50, adapters: adapterSummaries() };
}

/** A run with its history, and what the caller may do with it (for the page). */
export async function getPayrollRun(db: Database, ws: string, id: string, viewerId: string) {
  const run = await findRun(db, ws, id);
  const linked = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.workspaceId, ws), eq(staff.userId, viewerId)));
  const included = new Set([...run.snapshot.employees, ...run.snapshot.agencyWorkers].map((e) => e.staffId));
  const [pendingCorrection] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.workspaceId, ws), eq(runs.supersedesId, id), eq(runs.state, "prepared")))
    .limit(1);
  const history = await db
    .select({ ...getTableColumns(events), actorName: users.name })
    .from(events)
    .innerJoin(users, eq(users.id, events.actorId))
    .where(and(eq(events.workspaceId, ws), eq(events.runId, id)))
    .orderBy(asc(events.createdAt), asc(events.id))
    .limit(500);
  const names = new Map(
    (
      await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, [run.preparedBy, ...(run.approvedBy ? [run.approvedBy] : [])]))
    ).map((u) => [u.id, u.name]),
  );
  const canApprove =
    run.state === "prepared" &&
    run.preparedBy !== viewerId &&
    !linked.some((p) => included.has(p.id)) &&
    !(run.snapshot.linkedUserIds ?? []).includes(viewerId);
  return {
    run: {
      ...runView(run),
      preparedByName: names.get(run.preparedBy) ?? null,
      approvedByName: run.approvedBy ? (names.get(run.approvedBy) ?? null) : null,
    },
    snapshot: run.snapshot,
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      detail: h.detail,
      actorName: h.actorName,
      createdAt: h.createdAt,
    })),
    canApprove,
    pendingCorrectionId: pendingCorrection?.id ?? null,
    adapters: adapterSummaries(),
  };
}

/** Another live (prepared or approved) run whose period overlaps, other than the one being corrected. */
async function overlapping(tx: Executor, ws: string, period: Period, exceptId?: string) {
  const [row] = await tx
    .select({ id: runs.id, from: runs.periodFrom, to: runs.periodTo })
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, ws),
        inArray(runs.state, ["prepared", "approved"]),
        lte(runs.periodFrom, period.to),
        gte(runs.periodTo, period.from),
        exceptId ? ne(runs.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return row;
}

async function insertRun(
  tx: Transaction,
  ws: string,
  actorId: string,
  period: Period,
  today: string,
  extra: { version: number; supersedesId: string | null; note: string },
) {
  const { snapshot, blockers } = await buildPayrollSnapshot(tx, ws, period, today);
  if (blockers.length) throw conflict("payroll_run_blocked", blockers.join(" "), { blockers });
  const [row] = await tx
    .insert(runs)
    .values({
      workspaceId: ws,
      periodFrom: period.from,
      periodTo: period.to,
      version: extra.version,
      supersedesId: extra.supersedesId,
      snapshot,
      snapshotHash: sha256(canonical(snapshot)),
      note: extra.note,
      preparedBy: actorId,
    })
    .returning();
  await event(tx, ws, row!.id, actorId, "prepared", {
    snapshotHash: row!.snapshotHash,
    employees: snapshot.employees.length,
    agencyWorkers: snapshot.agencyWorkers.length,
    ...(extra.supersedesId ? { corrects: extra.supersedesId, reason: extra.note } : {}),
  });
  return row!;
}

export async function preparePayrollRun(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof payrollRunPrepareSchema>,
  today: string,
) {
  return executeLedgerCommand(db, ws, actorId, "workforce.payroll.prepare", input, input, async (tx) => {
    const clash = await overlapping(tx, ws, input);
    if (clash)
      throw conflict(
        "payroll_run_overlap",
        `A payroll run for ${clash.from} to ${clash.to} overlaps this period. Correct that run instead.`,
        { runId: clash.id },
      );
    return runView(
      await insertRun(tx, ws, actorId, input, today, { version: 1, supersedesId: null, note: input.note }),
    );
  });
}

/**
 * Approval is a second person's sign-off: not whoever prepared the run, and not anyone whose own
 * hours or absences are in it. Approving a correction supersedes the run it corrects.
 */
export async function approvePayrollRun(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof payrollRunApproveSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.payroll.approve",
    input,
    { id, ...input },
    async (tx) => {
      const run = await findRun(tx, ws, id);
      if (run.revision !== input.expectedRevision)
        throw conflict("workforce_conflict", "This payroll run changed. Reload and review it again.");
      if (run.state !== "prepared")
        throw conflict("payroll_run_not_prepared", "Only a prepared payroll run can be approved");
      if (run.preparedBy === actorId)
        throw conflict(
          "payroll_run_four_eyes",
          "A payroll run must be approved by someone other than the person who prepared it",
        );
      const own = await tx
        .select({ id: staff.id })
        .from(staff)
        .where(and(eq(staff.workspaceId, ws), eq(staff.userId, actorId)));
      const included = new Set(
        [...run.snapshot.employees, ...run.snapshot.agencyWorkers].map((e) => e.staffId),
      );
      // Check both today's links and the logins linked when the run was prepared, so unlinking a
      // People record before approving doesn't get round the rule.
      if (own.some((p) => included.has(p.id)) || (run.snapshot.linkedUserIds ?? []).includes(actorId))
        throw conflict(
          "payroll_run_own_record",
          "You can't approve a payroll run that includes your own hours or absences",
        );
      const now = new Date();
      if (run.supersedesId) {
        const [previous] = await tx
          .update(runs)
          .set({
            state: "superseded",
            supersededAt: now,
            revision: sql`${runs.revision} + 1`,
            updatedAt: now,
          })
          .where(and(eq(runs.workspaceId, ws), eq(runs.id, run.supersedesId), eq(runs.state, "approved")))
          .returning();
        if (!previous) throw conflict("workforce_conflict", "The run this corrects is no longer approved");
        await event(tx, ws, previous.id, actorId, "superseded", { by: run.id, version: run.version });
      }
      const [updated] = await tx
        .update(runs)
        .set({
          state: "approved",
          approvedBy: actorId,
          approvedAt: now,
          approvalNote: input.note,
          revision: run.revision + 1,
          updatedAt: now,
        })
        .where(eq(runs.id, id))
        .returning();
      await event(tx, ws, id, actorId, "approved", { note: input.note, snapshotHash: run.snapshotHash });
      return runView(updated!);
    },
  );
}

/** Prepares a corrected version of an approved run from today's records; it supersedes the original once approved. */
export async function correctPayrollRun(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof payrollRunCorrectSchema>,
  today: string,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.payroll.correct",
    input,
    { id, ...input },
    async (tx) => {
      const run = await findRun(tx, ws, id);
      if (run.revision !== input.expectedRevision)
        throw conflict("workforce_conflict", "This payroll run changed. Reload and review it again.");
      if (run.state !== "approved")
        throw conflict("payroll_run_not_approved", "Only an approved payroll run can be corrected");
      const period = { from: run.periodFrom, to: run.periodTo };
      const clash = await overlapping(tx, ws, period, run.id);
      if (clash)
        throw conflict(
          "payroll_run_overlap",
          "A correction or another run for this period is already in progress",
          {
            runId: clash.id,
          },
        );
      const correction = await insertRun(tx, ws, actorId, period, today, {
        version: run.version + 1,
        supersedesId: run.id,
        note: input.reason,
      });
      await event(tx, ws, run.id, actorId, "correction_prepared", {
        correction: correction.id,
        reason: input.reason,
      });
      return runView(correction);
    },
  );
}

/**
 * Withdraws a prepared run (wrong dates, records changed since, an unwanted correction) so it no
 * longer blocks its period. Kept with its history; an approved run is corrected instead.
 */
export async function withdrawPayrollRun(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof payrollRunWithdrawSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.payroll.withdraw",
    input,
    { id, ...input },
    async (tx) => {
      const run = await findRun(tx, ws, id);
      if (run.revision !== input.expectedRevision)
        throw conflict("workforce_conflict", "This payroll run changed. Reload and review it again.");
      if (run.state !== "prepared")
        throw conflict(
          "payroll_run_not_prepared",
          "Only a prepared payroll run can be withdrawn; correct an approved one",
        );
      const [updated] = await tx
        .update(runs)
        .set({ state: "withdrawn", revision: run.revision + 1, updatedAt: new Date() })
        .where(eq(runs.id, id))
        .returning();
      await event(tx, ws, id, actorId, "withdrawn", { reason: input.reason });
      if (run.supersedesId)
        await event(tx, ws, run.supersedesId, actorId, "correction_withdrawn", {
          correction: id,
          reason: input.reason,
        });
      return runView(updated!);
    },
  );
}

/**
 * Builds an export from the approved snapshot (never live data) and records it: adapter, file
 * name and SHA-256, and any acknowledgement of an unverified package layout. Repeating the same
 * command returns the same file without recording it again. The file itself isn't stored.
 */
export async function exportPayrollRun(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof payrollRunExportSchema>,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const run = await findRun(tx, ws, id);
    if (run.state !== "approved")
      throw conflict(
        "payroll_run_not_approved",
        run.state === "prepared"
          ? "Approve the payroll run before exporting it"
          : "This run has been superseded by a correction. Export the corrected run.",
      );
    const adapter = findPayrollExportAdapter(input.adapterId);
    if (!adapter) throw new ApiError(400, "invalid_input", `Unknown payroll export "${input.adapterId}"`);
    if (adapter.compatibility.status === "unverified" && !input.acknowledgeUnverified)
      throw conflict(
        "payroll_adapter_unverified",
        `${adapter.label} hasn't been verified against the package's own import. ${adapter.compatibility.checkBeforeUse}`,
      );
    const problems = adapter.problems(run.snapshot);
    if (problems.length) throw conflict("payroll_export_blocked", problems.join(" "), { problems });
    const csv = adapter.build(run.snapshot);
    const fileName = adapter.fileName(run.snapshot);
    const fileHash = sha256(csv);
    const [already] = await tx
      .select({ id: events.id, actorId: events.actorId, detail: events.detail })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, ws),
          eq(events.runId, id),
          eq(events.action, "exported"),
          sql`${events.detail}->>'commandId' = ${input.commandId}`,
        ),
      )
      .limit(1);
    // A repeated command must be the same request by the same person; otherwise a different file
    // could leave the system without its own record.
    if (already && (already.actorId !== actorId || already.detail.adapterId !== adapter.id))
      throw new ApiError(409, "command_conflict", "This command ID was already used for a different export");
    if (!already)
      await event(tx, ws, id, actorId, "exported", {
        commandId: input.commandId,
        adapterId: adapter.id,
        fileName,
        fileHash,
        snapshotHash: run.snapshotHash,
        acknowledgedUnverified: adapter.compatibility.status === "unverified",
      });
    return {
      fileName,
      csv,
      fileHash,
      manualAbsences: adapter.carriesAbsences
        ? []
        : absencesForManualEntry(run.snapshot).map((e) => ({
            staffNumber: e.staffNumber,
            payrollReference: e.payrollReference,
            firstName: e.firstName,
            lastName: e.lastName,
            absenceDays: e.absenceDays,
          })),
    };
  });
}
