import {
  absenceCreateSchema,
  absenceHrCreateSchema,
  absenceDecisionSchema,
  absenceCorrectSchema,
  absenceActionSchema,
  type AbsenceState,
} from "@knotworking/core";
import {
  workforceAbsences as absences,
  workforceAbsenceEvents as events,
  staff,
  users,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  sql,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { z } from "zod";
import { ApiError, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { workspaceToday } from "./time-zone";
type Absence = typeof absences.$inferSelect;
const conflict = (message: string) => new ApiError(409, "workforce_conflict", message);
const activeStates: AbsenceState[] = ["pending", "approved", "reported", "recorded"];
const personView = (p: typeof staff.$inferSelect) => ({
  id: p.id,
  staffNumber: p.staffNumber,
  firstName: p.firstName,
  lastName: p.lastName,
});
/** Authorisation is rechecked against both the current staff link AND the original author.
 * A People manager relinking a login must not expose another person's HR history.
 */
async function ownStaff(db: Executor, ws: string, actor: string) {
  const [p] = await db
    .select()
    .from(staff)
    .where(
      and(
        eq(staff.workspaceId, ws),
        eq(staff.userId, actor),
        eq(staff.status, "active"),
        isNull(staff.deletedAt),
      ),
    );
  if (!p) throw notFound("Active staff link");
  return p;
}
async function findPerson(db: Executor, ws: string, id: string) {
  const [p] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.workspaceId, ws), eq(staff.id, id), isNull(staff.deletedAt)));
  if (!p) throw notFound("Staff member");
  return p;
}
async function findAbsence(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(absences)
    .where(and(eq(absences.workspaceId, ws), eq(absences.id, id)));
  if (!row) throw notFound("Absence");
  return row;
}
const ownView = (row: Absence) => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  startOn: row.startOn,
  endOn: row.endOn,
  staffNote: row.staffNote,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
function reviewed(row: Absence, revision: number) {
  if (row.revision !== revision) throw conflict("This absence changed. Reload and review the latest record.");
}
async function audit(
  tx: Transaction,
  ws: string,
  actor: string,
  row: Absence,
  action: string,
  reason: string,
) {
  // Employment and health records have a private audit trail, deliberately outside shared sync.
  await tx.insert(events).values({
    workspaceId: ws,
    absenceId: row.id,
    revision: row.revision,
    actorId: actor,
    action,
    reason,
    snapshot: {
      staffId: row.staffId,
      kind: row.kind,
      state: row.state,
      startOn: row.startOn,
      endOn: row.endOn,
      staffNote: row.staffNote,
      hrNote: row.hrNote,
    },
  });
}
async function validDates(
  db: Executor,
  ws: string,
  p: typeof staff.$inferSelect,
  input: Pick<Absence, "kind" | "startOn" | "endOn">,
) {
  if (input.kind !== "sickness" && !input.endOn) throw conflict("Leave needs an end date");
  if (input.endOn && input.endOn < input.startOn) throw conflict("End date is before the start date");
  if (p.startDate && input.startOn < p.startDate)
    throw conflict("The absence begins before employment starts");
  if (p.endDate && (!input.endOn || input.endOn > p.endDate))
    throw conflict("The absence runs beyond employment end; use a closed historical range");
  if (input.kind === "sickness" && input.startOn > (await workspaceToday(db, ws)))
    throw conflict("A sickness report cannot begin in the future");
}
async function noOverlap(
  db: Executor,
  ws: string,
  staffId: string,
  startOn: string,
  endOn: string | null,
  exclude?: string,
  sickness = false,
) {
  const [overlap] = await db
    .select({ id: absences.id })
    .from(absences)
    .where(
      and(
        eq(absences.workspaceId, ws),
        eq(absences.staffId, staffId),
        inArray(absences.state, activeStates),
        sickness ? eq(absences.kind, "sickness") : undefined,
        endOn ? lte(absences.startOn, endOn) : undefined,
        or(isNull(absences.endOn), gte(absences.endOn, startOn)),
        exclude ? ne(absences.id, exclude) : undefined,
      ),
    )
    .limit(1);
  if (overlap)
    throw conflict("This overlaps another active absence. HR must review or correct that record first.");
}
async function create(
  tx: Transaction,
  ws: string,
  actor: string,
  staffId: string,
  requestedBy: string | null,
  input: z.infer<typeof absenceCreateSchema> & { hrNote?: string },
) {
  const p = await findPerson(tx, ws, staffId);
  await validDates(tx, ws, p, input);
  await noOverlap(tx, ws, staffId, input.startOn, input.endOn, undefined, input.kind === "sickness");
  const [row] = await tx
    .insert(absences)
    .values({
      workspaceId: ws,
      staffId,
      requestedBy,
      createdBy: actor,
      kind: input.kind,
      state: input.kind === "sickness" ? "reported" : "pending",
      startOn: input.startOn,
      endOn: input.endOn,
      staffNote: input.staffNote,
      hrNote: input.hrNote ?? "",
    })
    .returning();
  await audit(
    tx,
    ws,
    actor,
    row!,
    "submitted",
    input.kind === "sickness" ? "Sickness reported" : "Leave requested",
  );
  return row!;
}
export async function myAbsences(db: Database, ws: string, actor: string, offset = 0) {
  const p = await ownStaff(db, ws, actor);
  const rows = await db
    .select()
    .from(absences)
    .where(and(eq(absences.workspaceId, ws), eq(absences.staffId, p.id), eq(absences.requestedBy, actor)))
    .orderBy(desc(absences.createdAt), desc(absences.id))
    .limit(51)
    .offset(offset);
  return { person: personView(p), absences: rows.slice(0, 50).map(ownView), hasMore: rows.length > 50 };
}
export async function submitMyAbsence(
  db: Database,
  ws: string,
  actor: string,
  input: z.infer<typeof absenceCreateSchema>,
) {
  await ownStaff(db, ws, actor); // Also recheck before replaying a receipt.
  return executeLedgerCommand(db, ws, actor, "workforce.self.submit", input, input, async (tx) => {
    const p = await ownStaff(tx, ws, actor);
    return ownView(await create(tx, ws, actor, p.id, actor, input));
  });
}
export async function withdrawMyAbsence(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: z.infer<typeof absenceActionSchema>,
) {
  async function owned(ex: Executor) {
    const p = await ownStaff(ex, ws, actor);
    const row = await findAbsence(ex, ws, id);
    if (row.staffId !== p.id || row.requestedBy !== actor) throw notFound("Absence");
    return row;
  }
  await owned(db);
  return executeLedgerCommand(
    db,
    ws,
    actor,
    "workforce.self.withdraw",
    input,
    { id, ...input },
    async (tx) => {
      const row = await owned(tx);
      reviewed(row, input.expectedRevision);
      if (row.state !== "pending" || row.kind === "sickness")
        throw conflict(
          "Only pending leave can be withdrawn. Ask HR to correct an approved or sickness record.",
        );
      const [updated] = await tx
        .update(absences)
        .set({ state: "cancelled", revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(absences.id, id))
        .returning();
      await audit(tx, ws, actor, updated!, "withdrawn", input.reason);
      return ownView(updated!);
    },
  );
}
export async function createHrAbsence(
  db: Database,
  ws: string,
  actor: string,
  input: z.infer<typeof absenceHrCreateSchema>,
) {
  return executeLedgerCommand(db, ws, actor, "workforce.hr.submit", input, input, (tx) =>
    create(tx, ws, actor, input.staffId, null, input),
  );
}
export async function listHrAbsences(
  db: Database,
  ws: string,
  query: { offset?: number; state?: AbsenceState; staffId?: string },
) {
  const rows = await db
    .select({
      ...getTableColumns(absences),
      overlapNeedsReview: sql<boolean>`exists (select 1 from workforce_absences other where other.workspace_id = ${absences.workspaceId} and other.staff_id = ${absences.staffId} and other.id <> ${absences.id} and other.state in ('pending','approved','reported','recorded') and ${absences.state} in ('pending','approved','reported','recorded') and (other.end_on is null or other.end_on >= ${absences.startOn}) and (${absences.endOn} is null or other.start_on <= ${absences.endOn}))`,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(absences)
    .innerJoin(staff, eq(staff.id, absences.staffId))
    .where(
      and(
        eq(absences.workspaceId, ws),
        eq(staff.workspaceId, ws),
        query.state ? eq(absences.state, query.state) : undefined,
        query.staffId ? eq(absences.staffId, query.staffId) : undefined,
      ),
    )
    .orderBy(desc(absences.createdAt), desc(absences.id))
    .limit(51)
    .offset(query.offset ?? 0);
  return { absences: rows.slice(0, 50), hasMore: rows.length > 50 };
}
export async function absenceHistory(db: Database, ws: string, id: string, offset = 0) {
  const absence = await findAbsence(db, ws, id);
  const rows = await db
    .select({ ...getTableColumns(events), actorName: users.name })
    .from(events)
    .innerJoin(users, eq(users.id, events.actorId))
    .where(and(eq(events.workspaceId, ws), eq(events.absenceId, id)))
    .orderBy(asc(events.revision), asc(events.id))
    .limit(51)
    .offset(offset);
  return { absence, events: rows.slice(0, 50), hasMore: rows.length > 50 };
}
export async function decideAbsence(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: z.infer<typeof absenceDecisionSchema>,
) {
  return executeLedgerCommand(db, ws, actor, "workforce.hr.decide", input, { id, ...input }, async (tx) => {
    const row = await findAbsence(tx, ws, id);
    reviewed(row, input.expectedRevision);
    const p = await findPerson(tx, ws, row.staffId);
    if (row.requestedBy === actor || p.userId === actor)
      throw conflict("Another HR manager must review your own absence");
    const next: AbsenceState =
      input.action === "approve" && row.state === "pending" && row.kind !== "sickness"
        ? "approved"
        : input.action === "reject" && row.state === "pending" && row.kind !== "sickness"
          ? "rejected"
          : input.action === "record" && row.state === "reported" && row.kind === "sickness"
            ? "recorded"
            : input.action === "cancel" && activeStates.includes(row.state)
              ? "cancelled"
              : (() => {
                  throw conflict("This action is not available for the current absence state");
                })();
    if (next === "approved" || next === "recorded") {
      await validDates(tx, ws, p, row);
      await noOverlap(tx, ws, row.staffId, row.startOn, row.endOn, id, row.kind === "sickness");
    }
    const [updated] = await tx
      .update(absences)
      .set({
        state: next,
        hrNote: input.hrNote ?? row.hrNote,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(absences.id, id))
      .returning();
    await audit(tx, ws, actor, updated!, input.action, input.reason);
    return updated!;
  });
}
export async function correctAbsence(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: z.infer<typeof absenceCorrectSchema>,
) {
  return executeLedgerCommand(db, ws, actor, "workforce.hr.correct", input, { id, ...input }, async (tx) => {
    const row = await findAbsence(tx, ws, id);
    reviewed(row, input.expectedRevision);
    if (!activeStates.includes(row.state))
      throw conflict("A closed record is retained; create a new record for a new absence");
    const p = await findPerson(tx, ws, row.staffId);
    if (row.requestedBy === actor || p.userId === actor)
      throw conflict("Another HR manager must correct your own absence");
    await validDates(tx, ws, p, { ...row, ...input });
    await noOverlap(tx, ws, row.staffId, input.startOn, input.endOn, id, row.kind === "sickness");
    const [updated] = await tx
      .update(absences)
      .set({
        startOn: input.startOn,
        endOn: input.endOn,
        hrNote: input.hrNote ?? row.hrNote,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(absences.id, id))
      .returning();
    await audit(tx, ws, actor, updated!, "corrected", input.reason);
    return updated!;
  });
}
export async function workforceAvailability(
  db: Database,
  ws: string,
  query: { from: string; to: string; offset?: number },
) {
  const rows = await db
    .select({
      staffId: staff.id,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      startOn: absences.startOn,
      endOn: absences.endOn,
    })
    .from(absences)
    .innerJoin(staff, eq(staff.id, absences.staffId))
    .where(
      and(
        eq(absences.workspaceId, ws),
        eq(staff.workspaceId, ws),
        isNull(staff.deletedAt),
        inArray(absences.state, ["approved", "reported", "recorded"]),
        lte(absences.startOn, query.to),
        or(isNull(absences.endOn), gte(absences.endOn, query.from)),
      ),
    )
    .orderBy(asc(staff.id), asc(absences.startOn), asc(absences.id))
    .limit(5001);
  if (rows.length > 5000)
    throw conflict("This availability window has too many records. Narrow the dates before planning.");
  type Range = {
    staffId: string;
    staffNumber: string;
    firstName: string;
    lastName: string;
    from: string;
    to: string;
    availability: "unavailable";
  };
  const merged: Range[] = [];
  for (const row of rows) {
    const from = row.startOn < query.from ? query.from : row.startOn;
    const to = !row.endOn || row.endOn > query.to ? query.to : row.endOn;
    const last = merged[merged.length - 1];
    if (last && last.staffId === row.staffId && from <= last.to) {
      if (to > last.to) last.to = to;
    } else
      merged.push({
        staffId: row.staffId,
        staffNumber: row.staffNumber,
        firstName: row.firstName,
        lastName: row.lastName,
        from,
        to,
        availability: "unavailable",
      });
  }
  merged.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.lastName.localeCompare(b.lastName) ||
      a.staffId.localeCompare(b.staffId),
  );
  const offset = query.offset ?? 0;
  return { availability: merged.slice(offset, offset + 100), hasMore: merged.length > offset + 100 };
}
export async function workforceStaff(db: Database, ws: string, q: string) {
  const rows = await db
    .select({
      id: staff.id,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      status: staff.status,
    })
    .from(staff)
    .where(
      and(
        eq(staff.workspaceId, ws),
        isNull(staff.deletedAt),
        q
          ? or(
              ilike(staff.firstName, `%${q}%`),
              ilike(staff.lastName, `%${q}%`),
              ilike(staff.staffNumber, `%${q}%`),
            )
          : undefined,
      ),
    )
    .orderBy(asc(staff.lastName), asc(staff.id))
    .limit(101);
  return { staff: rows.slice(0, 100), hasMore: rows.length > 100 };
}
export async function hasWorkforceRecords(db: Executor, staffId: string) {
  const [row] = await db
    .select({ id: absences.id })
    .from(absences)
    .where(eq(absences.staffId, staffId))
    .limit(1);
  return !!row;
}
