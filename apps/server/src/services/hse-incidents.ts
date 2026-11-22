import {
  newId,
  type HseIncidentCreate,
  type HseIncidentSave,
  type HseAction,
  type HsePage,
  type HseIncidentBody,
} from "@knotworking/core";
import {
  hseIncidents as incidents,
  hseIncidentEvents as events,
  staff,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, isNull, inArray, count, desc } from "drizzle-orm";
import { badRequest, notFound, ApiError } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { hseMember, hsePublic } from "./hse";
import { injuredCount, openActionCount } from "./hse-incident-follow-up";
import { workspaceToday } from "./time-zone";
const conflict = (message: string) => new ApiError(409, "hse_conflict", message);
async function find(db: Executor, ws: string, id: string) {
  const [r] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.workspaceId, ws), eq(incidents.id, id)));
  if (!r) throw notFound("Restricted HSE incident");
  return r;
}
async function validateBody(db: Executor, ws: string, b: HseIncidentBody) {
  if (b.occurredOn > (await workspaceToday(db, ws)))
    throw badRequest("An incident cannot occur in the future");
  await hseMember(db, ws, b.ownerUserId);
  for (const id of b.staffIds) {
    const [s] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.workspaceId, ws), eq(staff.id, id), isNull(staff.deletedAt)));
    if (!s) throw badRequest("Affected staff must belong to this workspace");
  }
  if (b.reportingDecision !== "not_assessed" && !b.reportingBasis)
    throw badRequest("Record the applicable reporting requirement and decision rationale");
  if (b.reportingDecision === "required" && !b.reportingDueOn)
    throw badRequest("Record the deadline determined from the applicable requirement");
}
async function audit(tx: Transaction, ws: string, actor: string, id: string, action: string, reason: string) {
  const r = await find(tx, ws, id);
  await tx.insert(events).values({
    workspaceId: ws,
    incidentId: id,
    revision: r.revision,
    action,
    reason,
    actorId: actor,
    snapshot: JSON.parse(JSON.stringify(hsePublic(r))),
  });
  return hsePublic(r);
}
/** Health details, incident metadata and audit snapshots are private: deliberately no recordChanges. */
export async function createHseIncident(db: Database, ws: string, actor: string, input: HseIncidentCreate) {
  return executeLedgerCommand(db, ws, actor, "hse.incident.create", input, input, async (tx) => {
    // The outcome is set with the people hurt (a manager's), never on its own.
    const body = { ...input.body, outcome: "none" as const };
    await validateBody(tx, ws, body);
    const id = newId();
    await tx
      .insert(incidents)
      .values({ workspaceId: ws, id, reference: `HSE-${id.slice(-12)}`, body, createdBy: actor });
    return audit(tx, ws, actor, id, "recorded", "Incident recorded");
  });
}
export async function saveHseIncident(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: HseIncidentSave,
  options: { canSeeRestricted: boolean } = { canSeeRestricted: true },
) {
  return executeLedgerCommand(db, ws, actor, "hse.incident.save", input, { id, ...input }, async (tx) => {
    const r = await find(tx, ws, id);
    if (r.revision !== input.expectedRevision) throw conflict("The incident changed; reload and review it");
    if (r.status !== "open") throw conflict("Closed investigations are immutable");
    // Only a manager reads (so only a manager changes) the health details; others save the rest of
    // the record and keep what is stored. The outcome changes only with the people hurt.
    const body = options.canSeeRestricted
      ? { ...input.body, outcome: r.body.outcome ?? "none" }
      : { ...input.body, healthDetails: r.body.healthDetails, outcome: r.body.outcome ?? "none" };
    await validateBody(tx, ws, body);
    // A near miss or unsafe condition has nobody hurt: the kind can't become one while people are
    // recorded as hurt (the message says nothing about who, for readers who can't see them).
    if (
      (body.kind === "near_miss" || body.kind === "unsafe_condition") &&
      body.kind !== r.body.kind &&
      ((r.body.outcome ?? "none") !== "none" || (await injuredCount(tx, ws, id)) > 0)
    )
      throw conflict(
        "People are recorded as hurt in this incident, so it can't be a near miss or unsafe condition",
      );
    await tx
      .update(incidents)
      .set({ body, revision: r.revision + 1, updatedAt: new Date() })
      .where(eq(incidents.id, id));
    return audit(tx, ws, actor, id, "investigated", input.reason);
  });
}
export async function closeHseIncident(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: HseAction,
) {
  return executeLedgerCommand(db, ws, actor, "hse.incident.close", input, { id, ...input }, async (tx) => {
    const r = await find(tx, ws, id);
    if (r.revision !== input.expectedRevision || r.status !== "open")
      throw conflict("Review the current open incident");
    for (const key of [
      "investigation",
      "rootCause",
      "correctiveActions",
      "effectiveness",
      "reportingBasis",
    ] as const)
      if (!r.body[key]) throw conflict(`Complete ${key} before closing`);
    if (
      r.body.reportingDecision === "not_assessed" ||
      (r.body.reportingDecision === "required" && !r.body.reportReference)
    )
      throw conflict("Complete the reporting decision and required submission evidence");
    const open = await openActionCount(tx, ws, id);
    if (open)
      throw conflict(
        `Complete or cancel ${open} open corrective action${open === 1 ? "" : "s"} before closing`,
      );
    await tx
      .update(incidents)
      .set({ status: "closed", revision: r.revision + 1, updatedAt: new Date() })
      .where(eq(incidents.id, id));
    return audit(tx, ws, actor, id, "closed", input.reason);
  });
}
export async function getHseIncident(db: Database, ws: string, id: string) {
  const row = await find(db, ws, id);
  const people = row.body.staffIds.length
    ? await db
        .select({
          id: staff.id,
          firstName: staff.firstName,
          lastName: staff.lastName,
          staffNumber: staff.staffNumber,
        })
        .from(staff)
        .where(and(eq(staff.workspaceId, ws), inArray(staff.id, row.body.staffIds)))
    : [];
  return { ...hsePublic(row), affectedPeople: people };
}
export async function listHseIncidents(
  db: Database,
  ws: string,
  q: HsePage & { status?: "open" | "closed" },
) {
  const where = and(eq(incidents.workspaceId, ws), q.status ? eq(incidents.status, q.status) : undefined);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(incidents)
      .where(where)
      .orderBy(desc(incidents.createdAt), desc(incidents.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(incidents).where(where),
  ]);
  return {
    incidents: rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      revision: r.revision,
      kind: r.body.kind,
      occurredOn: r.body.occurredOn,
      summary: r.body.summary,
    })),
    total: total!.n,
    limit: q.limit,
    offset: q.offset,
  };
}
export async function hseIncidentHistory(db: Database, ws: string, id: string, q: HsePage) {
  await find(db, ws, id);
  const where = and(eq(events.workspaceId, ws), eq(events.incidentId, id));
  const [rows, [total]] = await Promise.all([
    db.select().from(events).where(where).orderBy(desc(events.revision)).limit(q.limit).offset(q.offset),
    db.select({ n: count() }).from(events).where(where),
  ]);
  return { events: rows.map(hsePublic), total: total!.n, ...q };
}

/** Shared with the follow-up records (actions, people hurt, reports) in `hse-incident-follow-up.ts`. */
export { find as findHseIncident, audit as auditHseIncident, validateBody as validateHseIncidentBody };
