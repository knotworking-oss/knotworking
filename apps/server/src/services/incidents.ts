import {
  impactLimits,
  newId,
  roundQuantity,
  type IncidentSummary,
  type IncidentDetail,
  type IncidentCreateInput,
  type IncidentScopeInput,
  type IncidentEventInput,
  type IncidentReleaseInput,
  type IncidentCloseInput,
} from "@knotworking/core";
import {
  qualityIncidents as cases,
  qualityIncidentSnapshots as snapshots,
  qualityIncidentHolds as holds,
  qualityIncidentEvents as events,
  qualityNonconformances,
  stockLots,
  workspaceMembers,
  recordChanges,
  type Executor,
  type Database,
  type ChangeInput,
} from "@knotworking/db";
import { and, desc, eq, isNull, asc, count } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { returnViews, readDespatchImpact } from "./ports/despatch";
import { lotChange } from "./ports/stock";

type Row = typeof cases.$inferSelect;
const summary = (r: Row): IncidentSummary => ({
  id: r.id,
  reference: r.reference,
  title: r.title,
  kind: r.kind,
  severity: r.severity,
  ownerUserId: r.ownerUserId,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  closedAt: r.closedAt?.toISOString() ?? null,
  closedBy: r.closedBy,
});
const change = (r: Row): ChangeInput => ({
  entity: "quality_incident",
  entityId: r.id,
  action: "upsert",
  data: { id: r.id, status: r.status },
}); // No incident, distribution or contact details in sync.
async function find(db: Executor, ws: string, id: string, open = false) {
  const [row] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.workspaceId, ws), eq(cases.id, id)));
  if (!row) throw notFound("Incident");
  if (open && row.status !== "open") throw new ApiError(409, "incident_closed", "This case is signed closed");
  return row;
}
export async function listIncidents(db: Executor, ws: string, offset: number) {
  const rows = await db
    .select()
    .from(cases)
    .where(eq(cases.workspaceId, ws))
    .orderBy(desc(cases.createdAt), desc(cases.id))
    .limit(51)
    .offset(offset);
  return { incidents: rows.slice(0, 50).map(summary), hasMore: rows.length > 50, offset };
}
export async function getIncident(db: Executor, ws: string, id: string): Promise<IncidentDetail> {
  const row = await find(db, ws, id);
  const [ss, hh, ee] = await Promise.all([
    db
      .select()
      .from(snapshots)
      .where(and(eq(snapshots.workspaceId, ws), eq(snapshots.incidentId, id)))
      .orderBy(asc(snapshots.createdAt), asc(snapshots.id)),
    db
      .select()
      .from(holds)
      .where(and(eq(holds.workspaceId, ws), eq(holds.incidentId, id))),
    db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.incidentId, id)))
      .orderBy(asc(events.createdAt), asc(events.id)),
  ]);
  return {
    ...summary(row),
    assessment: row.assessment,
    physicalReturns: await returnViews(db, ws, [
      ...new Set(ss.flatMap((s) => s.report.deliveries.lines.map((l) => l.lineId))),
    ]),
    closure: row.closure,
    snapshots: ss.map((s) => ({
      id: s.id,
      report: s.report,
      note: s.note,
      createdAt: s.createdAt.toISOString(),
      createdBy: s.createdBy,
    })),
    holds: hh.map((h) => ({
      lotId: h.lotId,
      releasedAt: h.releasedAt?.toISOString() ?? null,
      releasedBy: h.releasedBy,
      releaseNote: h.releaseNote,
    })),
    events: ee.map((e) => ({
      id: e.id,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
      actorId: e.actorId,
    })),
  };
}
export async function createIncident(db: Database, ws: string, actor: string, input: IncidentCreateInput) {
  return executeLedgerCommand(db, ws, actor, "incident.create", input, input, async (tx) => {
    const [member] = await tx
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ws),
          eq(workspaceMembers.userId, input.ownerUserId),
          isNull(workspaceMembers.deletedAt),
        ),
      );
    if (!member) throw badRequest("The case owner must be a current workspace member");
    const id = newId();
    const [sequence] = await tx.select({ n: count() }).from(cases).where(eq(cases.workspaceId, ws));
    const [row] = await tx
      .insert(cases)
      .values({
        workspaceId: ws,
        id,
        reference: `INC-${String((sequence?.n ?? 0) + 1).padStart(6, "0")}`,
        title: input.title,
        kind: input.kind,
        severity: input.severity,
        ownerUserId: input.ownerUserId,
        assessment: input.assessment,
        createdBy: actor,
      })
      .returning();
    await recordChanges(tx, ws, actor, [change(row!)]);
    return getIncident(tx, ws, id);
  });
}
export async function containIncident(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: IncidentScopeInput,
) {
  return executeLedgerCommand(db, ws, actor, "incident.contain", input, { id, ...input }, async (tx) => {
    const row = await find(tx, ws, id, true);
    const report = await readDespatchImpact(tx, ws, input.lotId, {
      depth: input.depth,
      limit: impactLimits.exportLines,
      offset: 0,
    });
    if (report.deliveries.total > impactLimits.exportLines)
      throw new ApiError(
        413,
        "incident_scope_limit",
        "Too many delivery lines to snapshot; select a narrower root",
      );
    if (report.coverage.status === "partial" && !input.acknowledgePartial)
      throw new ApiError(
        409,
        "partial_trace",
        "This trace is partial. Review the coverage reasons and explicitly acknowledge them before containment.",
        report.coverage,
      );
    const [snapshot] = await tx
      .insert(snapshots)
      .values({ workspaceId: ws, incidentId: id, report, note: input.note, createdBy: actor })
      .returning();
    await tx.insert(events).values({
      workspaceId: ws,
      incidentId: id,
      actorId: actor,
      data: { commandId: input.commandId, kind: "containment", note: input.note, snapshotId: snapshot!.id },
    });
    const changes: ChangeInput[] = [change(row)];
    for (const lot of report.lots) {
      await tx
        .insert(holds)
        .values({ workspaceId: ws, incidentId: id, lotId: lot.id })
        .onConflictDoUpdate({
          target: [holds.incidentId, holds.lotId],
          set: { releasedAt: null, releasedBy: null, releaseNote: null },
        });
      const [updated] = await tx
        .update(stockLots)
        .set({
          status: lot.status === "rejected" ? "rejected" : "quarantine",
          statusChangedAt: new Date(),
          statusChangedBy: actor,
          statusNote: `Incident hold ${row.reference}: ${input.note}`,
        })
        .where(and(eq(stockLots.workspaceId, ws), eq(stockLots.id, lot.id)))
        .returning();
      changes.push(lotChange(updated!));
    }
    await recordChanges(tx, ws, actor, changes);
    return getIncident(tx, ws, id);
  });
}
function activeEvents(detail: IncidentDetail) {
  const corrected = new Set(
    detail.events.filter((e) => e.data.kind === "correction").map((e) => e.data.correctsEventId),
  );
  return detail.events.filter((e) => e.data.kind !== "correction" && !corrected.has(e.id));
}
export async function addIncidentEvent(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: IncidentEventInput,
) {
  return executeLedgerCommand(db, ws, actor, "incident.event", input, { id, ...input }, async (tx) => {
    const row = await find(tx, ws, id, true);
    const detail = await getIncident(tx, ws, id);
    if (
      input.kind === "correction" &&
      !activeEvents(detail).some(
        (e) =>
          e.id === input.correctsEventId && e.data.kind !== "containment" && e.data.kind !== "hold_release",
      )
    )
      throw badRequest("Choose an uncorrected event from this case");
    const delivery = detail.snapshots
      .flatMap((s) => s.report.deliveries.lines)
      .find((l) => l.lineId === input.deliveryLineId);
    if (input.deliveryLineId && !delivery) throw badRequest("Choose a delivery from this case's snapshots");
    if (input.kind === "recovery") {
      const total = activeEvents(detail)
        .filter((e) => e.data.kind === "recovery" && e.data.deliveryLineId === input.deliveryLineId)
        .reduce((s, e) => s + (e.data.quantity ?? 0), input.quantity!);
      if (roundQuantity(total) > delivery!.amount.display)
        throw badRequest(
          "Off-site dispositions exceed the snapshotted delivery quantity. Correct the earlier entry first.",
        );
    }
    await tx.insert(events).values({ workspaceId: ws, incidentId: id, actorId: actor, data: input });
    await recordChanges(tx, ws, actor, [change(row)]);
    return getIncident(tx, ws, id);
  });
}
export async function releaseIncidentHold(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: IncidentReleaseInput,
) {
  return executeLedgerCommand(db, ws, actor, "incident.release", input, { id, ...input }, async (tx) => {
    const row = await find(tx, ws, id, true);
    const [hold] = await tx
      .update(holds)
      .set({ releasedAt: new Date(), releasedBy: actor, releaseNote: input.note })
      .where(
        and(
          eq(holds.workspaceId, ws),
          eq(holds.incidentId, id),
          eq(holds.lotId, input.lotId),
          isNull(holds.releasedAt),
        ),
      )
      .returning();
    if (!hold) throw badRequest("No active hold for this case and lot");
    await tx.insert(events).values({
      workspaceId: ws,
      incidentId: id,
      actorId: actor,
      data: { commandId: input.commandId, kind: "hold_release", lotId: input.lotId, note: input.note },
    });
    // Deliberately leave QA quarantine in place. A separate stock sign-off releases stock.
    await recordChanges(tx, ws, actor, [change(row)]);
    return getIncident(tx, ws, id);
  });
}
export async function closeIncident(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: IncidentCloseInput,
) {
  return executeLedgerCommand(db, ws, actor, "incident.close", input, { id, ...input }, async (tx) => {
    await find(tx, ws, id, true);
    const detail = await getIncident(tx, ws, id);
    const active = activeEvents(detail);
    if (
      !detail.snapshots.length ||
      detail.holds.some((h) => !h.releasedAt) ||
      !active.some((e) => e.data.kind === "decision") ||
      !active.some((e) => e.data.kind === "effectiveness") ||
      active.some((e) => e.data.kind === "contact" && e.data.contactStatus === "planned")
    )
      throw new ApiError(
        409,
        "incident_incomplete",
        "Closure needs a distribution snapshot, released case holds, a decision, an effectiveness check and no outstanding planned contacts",
      );
    if (input.nonconformanceId) {
      const [nc] = await tx
        .select()
        .from(qualityNonconformances)
        .where(
          and(
            eq(qualityNonconformances.workspaceId, ws),
            eq(qualityNonconformances.id, input.nonconformanceId),
            isNull(qualityNonconformances.deletedAt),
          ),
        );
      if (!nc || nc.status !== "closed")
        throw badRequest("Link a verified, closed non-conformance from this workspace");
    }
    const [row] = await tx
      .update(cases)
      .set({ status: "closed", closedAt: new Date(), closedBy: actor, closure: input })
      .where(eq(cases.id, id))
      .returning();
    await recordChanges(tx, ws, actor, [change(row!)]);
    return getIncident(tx, ws, id);
  });
}
