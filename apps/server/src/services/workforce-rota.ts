import {
  datesBetween,
  onWeekday,
  shiftWindow,
  windowsOverlap,
  type RotaSkipReason,
  type agencyCreateSchema,
  type agencyEngagementCreateSchema,
  type agencyEngagementEndSchema,
  type agencyUpdateSchema,
  type rotaEntryCancelSchema,
  type rotaEntryCreateSchema,
  type rotaGenerateSchema,
  type shiftCreateSchema,
  type shiftUpdateSchema,
  type workingPatternCreateSchema,
  type workingPatternEndSchema,
} from "@knotworking/core";
import {
  jobRoles,
  productionLines,
  staff,
  staffJobRoles,
  workforceAbsences as absences,
  workforceAgencies as agencies,
  workforceAgencyEngagements as engagements,
  workforceRotaEntries as entries,
  workforceShifts as shifts,
  workforceWorkingPatterns as patterns,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { ApiError, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";

/**
 * Rotas (Phase 3.4.4.2): shifts, working patterns, dated rota entries and agency engagements.
 * Agency workers are People records. Absence data appears only as the same "unavailable" projection
 * the planning availability view gives, and only while Private HR records are enabled.
 */

const conflict = (message: string, details?: unknown) =>
  new ApiError(409, "workforce_conflict", message, details);
const stale = (what: string) => conflict(`This ${what} changed. Reload and review the latest version.`);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const MAX_ROWS = 5000;
type Shift = typeof shifts.$inferSelect;

export interface RotaOptions {
  /** Private HR records are enabled, so recorded absences can mark people unavailable. */
  absencesEnabled: boolean;
  /** The caller can read Production (line names on shifts). */
  canReadProduction?: boolean;
}

// ─── Shared lookups ──────────────────────────────────────────────────────────

async function findShift(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.workspaceId, ws), eq(shifts.id, id)));
  if (!row) throw notFound("Shift");
  return row;
}
async function findStaff(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.workspaceId, ws), eq(staff.id, id), isNull(staff.deletedAt)));
  if (!row) throw notFound("Staff member");
  return row;
}
async function assertJobRole(db: Executor, ws: string, id: string | null) {
  if (!id) return;
  const [row] = await db
    .select({ id: jobRoles.id })
    .from(jobRoles)
    .where(and(eq(jobRoles.workspaceId, ws), eq(jobRoles.id, id), isNull(jobRoles.deletedAt)));
  if (!row) throw notFound("Job role");
}
async function assertLine(db: Executor, ws: string, id: string | null) {
  if (!id) return;
  const [row] = await db
    .select({ id: productionLines.id })
    .from(productionLines)
    .where(
      and(eq(productionLines.workspaceId, ws), eq(productionLines.id, id), isNull(productionLines.deletedAt)),
    );
  if (!row) throw notFound("Production line");
}
const employedOn = (p: { status: string; startDate: string | null; endDate: string | null }, date: string) =>
  (!p.startDate || p.startDate <= date) &&
  (!p.endDate || p.endDate >= date) &&
  (p.status === "active" || !!p.endDate);

/** Recorded-absence ranges per person (approved leave, reported or recorded sickness). */
export async function unavailableRanges(
  db: Executor,
  ws: string,
  staffIds: string[],
  from: string,
  to: string,
) {
  const ranges = new Map<string, { from: string; to: string | null }[]>();
  if (!staffIds.length) return ranges;
  const rows = await db
    .select({ staffId: absences.staffId, startOn: absences.startOn, endOn: absences.endOn })
    .from(absences)
    .where(
      and(
        eq(absences.workspaceId, ws),
        inArray(absences.staffId, staffIds),
        inArray(absences.state, ["approved", "reported", "recorded"]),
        lte(absences.startOn, to),
        or(isNull(absences.endOn), gte(absences.endOn, from)),
      ),
    );
  for (const r of rows) {
    const list = ranges.get(r.staffId) ?? [];
    list.push({ from: r.startOn, to: r.endOn });
    ranges.set(r.staffId, list);
  }
  return ranges;
}
export const isUnavailable = (
  ranges: Map<string, { from: string; to: string | null }[]>,
  staffId: string,
  date: string,
) => (ranges.get(staffId) ?? []).some((r) => r.from <= date && (!r.to || r.to >= date));

/** Active agency engagements per person overlapping a window. */
export async function agencyEngagementsFor(
  db: Executor,
  ws: string,
  staffIds: string[],
  from: string,
  to: string,
) {
  const out = new Map<
    string,
    { agencyId: string; agencyName: string; reference: string; startOn: string; endOn: string | null }[]
  >();
  if (!staffIds.length) return out;
  const rows = await db
    .select({
      staffId: engagements.staffId,
      agencyId: agencies.id,
      agencyName: agencies.name,
      reference: engagements.reference,
      startOn: engagements.startOn,
      endOn: engagements.endOn,
    })
    .from(engagements)
    .innerJoin(agencies, eq(agencies.id, engagements.agencyId))
    .where(
      and(
        eq(engagements.workspaceId, ws),
        inArray(engagements.staffId, staffIds),
        lte(engagements.startOn, to),
        or(isNull(engagements.endOn), gte(engagements.endOn, from)),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.staffId) ?? [];
    list.push(r);
    out.set(r.staffId, list);
  }
  return out;
}
export const agencyOn = (
  map: Awaited<ReturnType<typeof agencyEngagementsFor>>,
  staffId: string,
  date: string,
) => {
  const e = (map.get(staffId) ?? []).find((x) => x.startOn <= date && (!x.endOn || x.endOn >= date));
  return e ? { id: e.agencyId, name: e.agencyName, reference: e.reference } : null;
};

/**
 * Everything needed to check proposed rota entries for some people over a window, loaded once:
 * shifts, people, held roles, existing active entries (a day either side, for night shifts) and
 * recorded absences. `register` adds a newly created entry so later checks see it.
 */
async function rotaChecker(
  tx: Executor,
  ws: string,
  staffIds: string[],
  from: string,
  to: string,
  options: RotaOptions,
) {
  const shiftRows = await tx.select().from(shifts).where(eq(shifts.workspaceId, ws));
  const shiftById = new Map(shiftRows.map((s) => [s.id, s]));
  const people = staffIds.length
    ? await tx
        .select()
        .from(staff)
        .where(and(eq(staff.workspaceId, ws), inArray(staff.id, staffIds), isNull(staff.deletedAt)))
    : [];
  const personById = new Map(people.map((p) => [p.id, p]));
  const held = new Set(
    (staffIds.length
      ? await tx
          .select({ staffId: staffJobRoles.staffId, jobRoleId: staffJobRoles.jobRoleId })
          .from(staffJobRoles)
          .where(and(inArray(staffJobRoles.staffId, staffIds), isNull(staffJobRoles.deletedAt)))
      : []
    ).map((r) => `${r.staffId}:${r.jobRoleId}`),
  );
  const existing = staffIds.length
    ? await tx
        .select({ staffId: entries.staffId, shiftId: entries.shiftId, workDate: entries.workDate })
        .from(entries)
        .where(
          and(
            eq(entries.workspaceId, ws),
            eq(entries.state, "active"),
            inArray(entries.staffId, staffIds),
            gte(entries.workDate, addDays(from, -1)),
            lte(entries.workDate, addDays(to, 1)),
          ),
        )
    : [];
  const byPerson = new Map<string, { shiftId: string; workDate: string }[]>();
  const register = (e: { staffId: string; shiftId: string; workDate: string }) => {
    const list = byPerson.get(e.staffId) ?? [];
    list.push(e);
    byPerson.set(e.staffId, list);
  };
  existing.forEach(register);
  const unavailable = options.absencesEnabled
    ? await unavailableRanges(tx, ws, staffIds, from, to)
    : new Map<string, { from: string; to: string | null }[]>();

  const check = (e: {
    staffId: string;
    shiftId: string;
    workDate: string;
    jobRoleId: string | null;
  }): RotaSkipReason | null => {
    const shift = shiftById.get(e.shiftId);
    const person = personById.get(e.staffId);
    if (!shift || !shift.active) return "shift_inactive";
    if (!person || !employedOn(person, e.workDate)) return "not_employed";
    if (e.jobRoleId && !held.has(`${e.staffId}:${e.jobRoleId}`)) return "role_not_held";
    if (isUnavailable(unavailable, e.staffId, e.workDate)) return "unavailable";
    const window = shiftWindow(e.workDate, shift);
    for (const other of byPerson.get(e.staffId) ?? []) {
      if (other.shiftId === e.shiftId && other.workDate === e.workDate) return "already_rostered";
      const otherShift = shiftById.get(other.shiftId);
      if (otherShift && windowsOverlap(window, shiftWindow(other.workDate, otherShift)))
        return "overlaps_another_shift";
    }
    return null;
  };
  return { check, register };
}

const skipMessages: Record<RotaSkipReason, string> = {
  already_rostered: "This person is already on that shift that day",
  overlaps_another_shift: "This shift overlaps another shift the person is rostered on",
  unavailable: "This person is recorded as unavailable that day",
  not_employed: "This person isn't employed on that date",
  role_not_held: "This person doesn't hold that job role",
  shift_inactive: "That shift is inactive",
};

// ─── Shifts ──────────────────────────────────────────────────────────────────

const shiftView = (s: Shift, lineName: string | null = null) => ({
  id: s.id,
  name: s.name,
  startTime: s.startTime,
  endTime: s.endTime,
  lineId: s.lineId,
  lineName,
  active: s.active,
  revision: s.revision,
});

/** Line names are Production data: shown only to callers who can read Production. */
export async function listShifts(db: Database, ws: string, options: { canReadProduction: boolean }) {
  const rows = await db
    .select({ shift: shifts, lineName: productionLines.name })
    .from(shifts)
    .leftJoin(productionLines, eq(productionLines.id, shifts.lineId))
    .where(eq(shifts.workspaceId, ws))
    .orderBy(sql`${shifts.active} desc`, asc(shifts.startTime), asc(shifts.name));
  return { shifts: rows.map((r) => shiftView(r.shift, options.canReadProduction ? r.lineName : null)) };
}

async function assertShiftNameFree(tx: Executor, ws: string, name: string, exceptId?: string) {
  const [dup] = await tx
    .select({ id: shifts.id })
    .from(shifts)
    .where(
      and(
        eq(shifts.workspaceId, ws),
        sql`lower(${shifts.name}) = lower(${name})`,
        exceptId ? ne(shifts.id, exceptId) : undefined,
      ),
    );
  if (dup) throw conflict("A shift with this name already exists");
}

export async function createShift(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof shiftCreateSchema>,
) {
  return executeLedgerCommand(db, ws, actorId, "workforce.shift.create", input, input, async (tx) => {
    await assertShiftNameFree(tx, ws, input.name);
    await assertLine(tx, ws, input.lineId);
    const [row] = await tx
      .insert(shifts)
      .values({
        workspaceId: ws,
        name: input.name,
        startTime: input.startTime,
        endTime: input.endTime,
        lineId: input.lineId,
        createdBy: actorId,
      })
      .returning();
    return shiftView(row!);
  });
}

/**
 * Names, lines and the active flag can change. Times can't once the shift has rota entries (past
 * entries would silently change meaning); create a new shift instead. A shift with future
 * entries can't be deactivated until they're cancelled.
 */
export async function updateShift(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof shiftUpdateSchema>,
  today: string,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.shift.update",
    input,
    { id, ...input },
    async (tx) => {
      const row = await findShift(tx, ws, id);
      if (row.revision !== input.expectedRevision) throw stale("shift");
      await assertShiftNameFree(tx, ws, input.name, id);
      await assertLine(tx, ws, input.lineId);
      const timesChanged = row.startTime !== input.startTime || row.endTime !== input.endTime;
      if (timesChanged || (row.active && !input.active)) {
        const [used] = await tx
          .select({ id: entries.id })
          .from(entries)
          .where(
            and(
              eq(entries.workspaceId, ws),
              eq(entries.shiftId, id),
              eq(entries.state, "active"),
              timesChanged ? undefined : gte(entries.workDate, today),
            ),
          )
          .limit(1);
        if (used)
          throw conflict(
            timesChanged
              ? "This shift has rota entries, so its times are fixed. Create a new shift for different times."
              : "This shift has rota entries from today onwards. Cancel them before deactivating it.",
          );
      }
      const [updated] = await tx
        .update(shifts)
        .set({
          name: input.name,
          startTime: input.startTime,
          endTime: input.endTime,
          lineId: input.lineId,
          active: input.active,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(shifts.id, id))
        .returning();
      return shiftView(updated!);
    },
  );
}

// ─── Working patterns ────────────────────────────────────────────────────────

export async function listPatterns(db: Database, ws: string, staffId?: string) {
  const rows = await db
    .select({
      pattern: patterns,
      shiftName: shifts.name,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      jobRoleName: jobRoles.name,
    })
    .from(patterns)
    .innerJoin(shifts, eq(shifts.id, patterns.shiftId))
    .innerJoin(staff, eq(staff.id, patterns.staffId))
    .leftJoin(jobRoles, eq(jobRoles.id, patterns.jobRoleId))
    .where(and(eq(patterns.workspaceId, ws), staffId ? eq(patterns.staffId, staffId) : undefined))
    .orderBy(asc(staff.lastName), asc(staff.firstName), asc(patterns.validFrom))
    .limit(501);
  return {
    patterns: rows.slice(0, 500).map((r) => ({
      ...r.pattern,
      shiftName: r.shiftName,
      staff: {
        id: r.pattern.staffId,
        staffNumber: r.staffNumber,
        firstName: r.firstName,
        lastName: r.lastName,
      },
      jobRoleName: r.jobRoleName,
    })),
    hasMore: rows.length > 500,
  };
}

export async function createPattern(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof workingPatternCreateSchema>,
) {
  return executeLedgerCommand(db, ws, actorId, "workforce.pattern.create", input, input, async (tx) => {
    const person = await findStaff(tx, ws, input.staffId);
    const shift = await findShift(tx, ws, input.shiftId);
    if (!shift.active) throw conflict("That shift is inactive");
    await assertJobRole(tx, ws, input.jobRoleId);
    if (input.jobRoleId) {
      const [heldRole] = await tx
        .select({ id: staffJobRoles.id })
        .from(staffJobRoles)
        .where(
          and(
            eq(staffJobRoles.staffId, person.id),
            eq(staffJobRoles.jobRoleId, input.jobRoleId),
            isNull(staffJobRoles.deletedAt),
          ),
        );
      if (!heldRole) throw conflict(skipMessages.role_not_held);
    }
    const [row] = await tx
      .insert(patterns)
      .values({
        workspaceId: ws,
        staffId: person.id,
        shiftId: shift.id,
        weekdays: input.weekdays,
        jobRoleId: input.jobRoleId,
        validFrom: input.validFrom,
        validTo: input.validTo,
        createdBy: actorId,
      })
      .returning();
    return row!;
  });
}

/** Ends a pattern on a date (never extends one). Entries already generated stay until cancelled. */
export async function endPattern(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof workingPatternEndSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.pattern.end",
    input,
    { id, ...input },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(patterns)
        .where(and(eq(patterns.workspaceId, ws), eq(patterns.id, id)));
      if (!row) throw notFound("Working pattern");
      if (row.revision !== input.expectedRevision) throw stale("working pattern");
      if (input.validTo < row.validFrom) throw conflict("A pattern can't end before it starts");
      if (row.validTo && input.validTo > row.validTo)
        throw conflict("A pattern can only be ended earlier, not extended");
      const [updated] = await tx
        .update(patterns)
        .set({
          validTo: input.validTo,
          endReason: input.reason,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(patterns.id, id))
        .returning();
      return updated!;
    },
  );
}

// ─── Rota entries ────────────────────────────────────────────────────────────

const entryView = (
  e: typeof entries.$inferSelect,
  person: { staffNumber: string; firstName: string; lastName: string },
  jobRoleName: string | null,
) => ({
  id: e.id,
  shiftId: e.shiftId,
  workDate: e.workDate,
  staff: { id: e.staffId, ...person },
  jobRole: e.jobRoleId ? { id: e.jobRoleId, name: jobRoleName ?? "" } : null,
  patternId: e.patternId,
  note: e.note,
  revision: e.revision,
});

async function entriesIn(db: Executor, ws: string, from: string, to: string, staffId?: string) {
  const rows = await db
    .select({
      entry: entries,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      jobRoleName: jobRoles.name,
    })
    .from(entries)
    .innerJoin(staff, eq(staff.id, entries.staffId))
    .leftJoin(jobRoles, eq(jobRoles.id, entries.jobRoleId))
    .where(
      and(
        eq(entries.workspaceId, ws),
        eq(entries.state, "active"),
        gte(entries.workDate, from),
        lte(entries.workDate, to),
        staffId ? eq(entries.staffId, staffId) : undefined,
      ),
    )
    .orderBy(asc(entries.workDate), asc(staff.lastName), asc(staff.firstName), asc(entries.id))
    .limit(MAX_ROWS + 1);
  if (rows.length > MAX_ROWS) throw conflict("This rota window has too many entries. Narrow the dates.");
  return rows;
}

/**
 * The rota for a window: shifts, active entries with the person, role and agency, and whether
 * each person is recorded as unavailable that day (`null` while Private HR records are off).
 */
export async function getRota(
  db: Database,
  ws: string,
  query: { from: string; to: string },
  options: RotaOptions,
) {
  const rows = await entriesIn(db, ws, query.from, query.to);
  const staffIds = [...new Set(rows.map((r) => r.entry.staffId))];
  const [shiftList, unavailable, agencyMap] = await Promise.all([
    listShifts(db, ws, { canReadProduction: !!options.canReadProduction }),
    options.absencesEnabled ? unavailableRanges(db, ws, staffIds, query.from, query.to) : null,
    agencyEngagementsFor(db, ws, staffIds, query.from, query.to),
  ]);
  return {
    from: query.from,
    to: query.to,
    absenceSourceEnabled: options.absencesEnabled,
    shifts: shiftList.shifts,
    entries: rows.map((r) => ({
      ...entryView(r.entry, r, r.jobRoleName),
      agency: agencyOn(agencyMap, r.entry.staffId, r.entry.workDate),
      unavailable: unavailable ? isUnavailable(unavailable, r.entry.staffId, r.entry.workDate) : null,
    })),
  };
}

/** The signed-in person's own shifts (via their People link). */
export async function myRota(
  db: Database,
  ws: string,
  userId: string,
  query: { from: string; to: string },
  options: { canReadProduction: boolean },
) {
  const [person] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.workspaceId, ws), eq(staff.userId, userId), isNull(staff.deletedAt)));
  if (!person) return { person: null, shifts: [], entries: [] };
  const rows = await entriesIn(db, ws, query.from, query.to, person.id);
  const shiftList = await listShifts(db, ws, options);
  const used = new Set(rows.map((r) => r.entry.shiftId));
  return {
    person: {
      id: person.id,
      staffNumber: person.staffNumber,
      firstName: person.firstName,
      lastName: person.lastName,
    },
    shifts: shiftList.shifts.filter((s) => used.has(s.id)),
    entries: rows.map((r) => entryView(r.entry, r, r.jobRoleName)),
  };
}

export async function createRotaEntry(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof rotaEntryCreateSchema>,
  options: RotaOptions,
) {
  return executeLedgerCommand(db, ws, actorId, "workforce.rota.create", input, input, async (tx) => {
    await findStaff(tx, ws, input.staffId);
    await findShift(tx, ws, input.shiftId);
    await assertJobRole(tx, ws, input.jobRoleId);
    const { check } = await rotaChecker(tx, ws, [input.staffId], input.workDate, input.workDate, options);
    const reason = check(input);
    if (reason) throw new ApiError(409, `rota_${reason}`, skipMessages[reason]);
    const [row] = await tx
      .insert(entries)
      .values({
        workspaceId: ws,
        shiftId: input.shiftId,
        workDate: input.workDate,
        staffId: input.staffId,
        jobRoleId: input.jobRoleId,
        note: input.note,
        createdBy: actorId,
      })
      .returning();
    return row!;
  });
}

export async function cancelRotaEntry(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof rotaEntryCancelSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.rota.cancel",
    input,
    { id, ...input },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.workspaceId, ws), eq(entries.id, id)));
      if (!row) throw notFound("Rota entry");
      if (row.revision !== input.expectedRevision) throw stale("rota entry");
      if (row.state !== "active") throw conflict("This rota entry is already cancelled");
      const [updated] = await tx
        .update(entries)
        .set({
          state: "cancelled",
          cancelledBy: actorId,
          cancelledAt: new Date(),
          cancelReason: input.reason,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(entries.id, id))
        .returning();
      return updated!;
    },
  );
}

/**
 * Turns working patterns into rota entries for a window (optionally some people only). Each date a
 * pattern covers either becomes an entry or is reported as skipped with its reason; nothing is
 * overwritten. Repeating the command returns its first result; running it again with a new command
 * skips what already exists.
 */
export async function generateRota(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof rotaGenerateSchema>,
  options: RotaOptions,
) {
  return executeLedgerCommand(db, ws, actorId, "workforce.rota.generate", input, input, async (tx) => {
    const active = await tx
      .select()
      .from(patterns)
      .where(
        and(
          eq(patterns.workspaceId, ws),
          lte(patterns.validFrom, input.to),
          or(isNull(patterns.validTo), gte(patterns.validTo, input.from)),
          input.staffIds?.length ? inArray(patterns.staffId, input.staffIds) : undefined,
        ),
      )
      .orderBy(asc(patterns.validFrom), asc(patterns.id));
    const staffIds = [...new Set(active.map((p) => p.staffId))];
    const { check, register } = await rotaChecker(tx, ws, staffIds, input.from, input.to, options);
    const toCreate: (typeof entries.$inferInsert)[] = [];
    const skipped: { staffId: string; shiftId: string; workDate: string; reason: RotaSkipReason }[] = [];
    for (const date of datesBetween(input.from, input.to)) {
      for (const p of active) {
        if (p.validFrom > date || (p.validTo && p.validTo < date) || !onWeekday(p.weekdays, date)) continue;
        const proposal = { staffId: p.staffId, shiftId: p.shiftId, workDate: date, jobRoleId: p.jobRoleId };
        const reason = check(proposal);
        if (reason) {
          skipped.push({ staffId: p.staffId, shiftId: p.shiftId, workDate: date, reason });
          continue;
        }
        register(proposal);
        toCreate.push({ workspaceId: ws, ...proposal, patternId: p.id, createdBy: actorId });
      }
    }
    if (toCreate.length > MAX_ROWS)
      throw conflict("That would create too many entries at once. Narrow the dates.");
    for (let i = 0; i < toCreate.length; i += 500)
      await tx.insert(entries).values(toCreate.slice(i, i + 500));
    return { created: toCreate.length, skipped: skipped.slice(0, 500), skippedCount: skipped.length };
  });
}

// ─── Agencies and engagements ────────────────────────────────────────────────

export async function listAgencies(db: Database, ws: string) {
  const agencyRows = await db
    .select()
    .from(agencies)
    .where(eq(agencies.workspaceId, ws))
    .orderBy(sql`${agencies.active} desc`, asc(agencies.name));
  const engagementRows = await db
    .select({
      engagement: engagements,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(engagements)
    .innerJoin(staff, eq(staff.id, engagements.staffId))
    .where(eq(engagements.workspaceId, ws))
    .orderBy(sql`${engagements.endOn} is null desc`, asc(engagements.startOn))
    .limit(1001);
  return {
    agencies: agencyRows,
    engagements: engagementRows.slice(0, 1000).map((r) => ({
      ...r.engagement,
      staff: {
        id: r.engagement.staffId,
        staffNumber: r.staffNumber,
        firstName: r.firstName,
        lastName: r.lastName,
      },
    })),
    engagementsTruncated: engagementRows.length > 1000,
  };
}

async function assertAgencyNameFree(tx: Executor, ws: string, name: string, exceptId?: string) {
  const [dup] = await tx
    .select({ id: agencies.id })
    .from(agencies)
    .where(
      and(
        eq(agencies.workspaceId, ws),
        sql`lower(${agencies.name}) = lower(${name})`,
        exceptId ? ne(agencies.id, exceptId) : undefined,
      ),
    );
  if (dup) throw conflict("An agency with this name already exists");
}

export async function createAgency(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof agencyCreateSchema>,
) {
  return executeLedgerCommand(db, ws, actorId, "workforce.agency.create", input, input, async (tx) => {
    await assertAgencyNameFree(tx, ws, input.name);
    const [row] = await tx
      .insert(agencies)
      .values({ workspaceId: ws, name: input.name, contact: input.contact, createdBy: actorId })
      .returning();
    return row!;
  });
}

export async function updateAgency(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof agencyUpdateSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.agency.update",
    input,
    { id, ...input },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(agencies)
        .where(and(eq(agencies.workspaceId, ws), eq(agencies.id, id)));
      if (!row) throw notFound("Agency");
      if (row.revision !== input.expectedRevision) throw stale("agency");
      await assertAgencyNameFree(tx, ws, input.name, id);
      const [updated] = await tx
        .update(agencies)
        .set({
          name: input.name,
          contact: input.contact,
          active: input.active,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(agencies.id, id))
        .returning();
      return updated!;
    },
  );
}

async function assertNoOverlappingEngagement(
  tx: Transaction,
  ws: string,
  staffId: string,
  startOn: string,
  endOn: string | null,
  exceptId?: string,
) {
  const [overlap] = await tx
    .select({ id: engagements.id })
    .from(engagements)
    .where(
      and(
        eq(engagements.workspaceId, ws),
        eq(engagements.staffId, staffId),
        exceptId ? ne(engagements.id, exceptId) : undefined,
        endOn ? lte(engagements.startOn, endOn) : undefined,
        or(isNull(engagements.endOn), gte(engagements.endOn, startOn)),
      ),
    );
  if (overlap) throw conflict("This person already has an agency engagement over those dates");
}

export async function createEngagement(
  db: Database,
  ws: string,
  actorId: string,
  input: z.infer<typeof agencyEngagementCreateSchema>,
) {
  return executeLedgerCommand(db, ws, actorId, "workforce.engagement.create", input, input, async (tx) => {
    const [agency] = await tx
      .select()
      .from(agencies)
      .where(and(eq(agencies.workspaceId, ws), eq(agencies.id, input.agencyId)));
    if (!agency) throw notFound("Agency");
    if (!agency.active) throw conflict("That agency is inactive");
    const person = await findStaff(tx, ws, input.staffId);
    if (person.startDate && input.startOn < person.startDate)
      throw conflict("The engagement can't start before the person's start date in People");
    if (person.endDate && (!input.endOn || input.endOn > person.endDate))
      throw conflict("The engagement must end by the person's end date in People");
    await assertNoOverlappingEngagement(tx, ws, person.id, input.startOn, input.endOn);
    const [row] = await tx
      .insert(engagements)
      .values({
        workspaceId: ws,
        agencyId: agency.id,
        staffId: person.id,
        startOn: input.startOn,
        endOn: input.endOn,
        reference: input.reference,
        createdBy: actorId,
      })
      .returning();
    return row!;
  });
}

/** Ends an engagement on a date (never extends one). */
export async function endEngagement(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof agencyEngagementEndSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.engagement.end",
    input,
    { id, ...input },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(engagements)
        .where(and(eq(engagements.workspaceId, ws), eq(engagements.id, id)));
      if (!row) throw notFound("Agency engagement");
      if (row.revision !== input.expectedRevision) throw stale("agency engagement");
      if (input.endOn < row.startOn) throw conflict("An engagement can't end before it starts");
      if (row.endOn && input.endOn > row.endOn)
        throw conflict("An engagement can only be ended earlier, not extended");
      const [updated] = await tx
        .update(engagements)
        .set({
          endOn: input.endOn,
          endReason: input.reason,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(engagements.id, id))
        .returning();
      return updated!;
    },
  );
}
