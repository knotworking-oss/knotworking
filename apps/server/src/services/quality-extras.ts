import { queuePipelineEvent } from "./automation-pipeline-events";
import {
  addDaysIso,
  complaintCategoryLabels,
  complaintsPerMillion,
  monthStart,
  onOrAfterWeekday,
  programmeOccurrences,
  qualityReferencePrefixes,
  supplierSuspensionAdvice,
  trendMonths,
  type AuditProgrammeCreateInput,
  type AuditProgrammeUpdateInput,
  type ComplaintCategory,
  type RecallPrefillQuery,
  type SalesVolumeInput,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  qualityAuditProgrammes,
  qualityAudits,
  qualityComplaints,
  qualityNonconformances,
  qualitySalesVolumes,
  recordChanges,
  stockLots,
  stockMovements,
  suppliers,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { lotMassBalance, stockAmount } from "@knotworking/core";
import { ApiError, badRequest, notFound } from "../errors";
import { assertLinks, auditChange, nextReference, strip } from "./quality";
import { traceLot } from "./ports/production";
import { workspaceToday } from "./time-zone";

type ProgrammeRow = typeof qualityAuditProgrammes.$inferSelect;

// ─── Recurring audit programme ───────────────────────────────────────────────

const programmeChange = (row: ProgrammeRow): ChangeInput => ({
  entity: "quality_audit_programme",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function programmeViews(db: Executor, rows: ProgrammeRow[]) {
  const userIds = [...new Set(rows.flatMap((r) => (r.auditorUserId ? [r.auditorUserId] : [])))];
  const people = userIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
    : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    ...strip(r),
    /** The date the next audit falls on: `nextPlannedOn`, moved to the programme's weekday if it has one. */
    nextAuditOn: onOrAfterWeekday(r.nextPlannedOn, r.weekday),
    auditor: r.auditorUserId ? { id: r.auditorUserId, name: nameOf.get(r.auditorUserId) ?? "" } : null,
  }));
}

const liveProgrammes = (workspaceId: string) =>
  and(eq(qualityAuditProgrammes.workspaceId, workspaceId), isNull(qualityAuditProgrammes.deletedAt));

export async function listAuditProgrammes(db: Database, workspaceId: string) {
  const rows = await db
    .select()
    .from(qualityAuditProgrammes)
    .where(liveProgrammes(workspaceId))
    .orderBy(asc(qualityAuditProgrammes.title));
  return { programmes: await programmeViews(db, rows) };
}

async function findProgramme(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(qualityAuditProgrammes)
    .where(and(liveProgrammes(workspaceId), eq(qualityAuditProgrammes.id, id)));
  if (!row) throw notFound("Audit programme");
  return row;
}

/**
 * Plans the audits a programme is due to plan (`programmeOccurrences`) as ordinary planned audits
 * and moves `nextPlannedOn` on. Call inside a transaction that holds the workspace log lock.
 * Returns the programme as it stands.
 */
async function generateFor(
  tx: Transaction,
  workspaceId: string,
  actorId: string | null,
  programme: ProgrammeRow,
  today: string,
) {
  if (!programme.active) return programme;
  const { generate, next } = programmeOccurrences(programme, today);
  if (next === programme.nextPlannedOn) return programme;
  const changes: ChangeInput[] = [];
  const plannedIds: string[] = [];
  for (const plannedOn of generate) {
    const [existing] = await tx
      .select({ id: qualityAudits.id })
      .from(qualityAudits)
      .where(and(eq(qualityAudits.programmeId, programme.id), eq(qualityAudits.plannedOn, plannedOn)));
    if (existing) continue;
    const reference = await nextReference(
      tx,
      qualityAudits,
      workspaceId,
      qualityReferencePrefixes.audit,
      plannedOn,
    );
    const [audit] = await tx
      .insert(qualityAudits)
      .values({
        workspaceId,
        reference,
        title: programme.title,
        scope: programme.scope,
        plannedOn,
        auditorUserId: programme.auditorUserId,
        auditorName: programme.auditorName,
        programmeId: programme.id,
        createdBy: actorId,
      })
      .returning();
    changes.push(auditChange(audit!));
    plannedIds.push(audit!.id);
  }
  const [row] = await tx
    .update(qualityAuditProgrammes)
    .set({ nextPlannedOn: next })
    .where(eq(qualityAuditProgrammes.id, programme.id))
    .returning();
  changes.push(programmeChange(row!));
  await recordChanges(tx, workspaceId, actorId, changes);
  await queuePipelineEvent(tx, workspaceId, "quality.audit_planned", plannedIds, today);
  return row!;
}

export async function createAuditProgramme(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: AuditProgrammeCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { id, ...fields } = input;
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertLinks(tx, workspaceId, { userIds: [fields.auditorUserId] });
    const [row] = await tx
      .insert(qualityAuditProgrammes)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId, createdBy: actorId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [programmeChange(row!)]);
    const after = await generateFor(tx, workspaceId, actorId, row!, today);
    return (await programmeViews(tx, [after]))[0]!;
  });
}

export async function updateAuditProgramme(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: AuditProgrammeUpdateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findProgramme(tx, workspaceId, id);
    if (patch.auditorUserId && patch.auditorUserId !== current.auditorUserId)
      await assertLinks(tx, workspaceId, { userIds: [patch.auditorUserId] });
    const set: Partial<ProgrammeRow> = { ...patch };
    if (patch.auditorUserId) set.auditorName = null;
    if (patch.auditorName) set.auditorUserId = null;
    const [row] = await tx
      .update(qualityAuditProgrammes)
      .set(set)
      .where(eq(qualityAuditProgrammes.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [programmeChange(row!)]);
    const after = await generateFor(tx, workspaceId, actorId, row!, today);
    return (await programmeViews(tx, [after]))[0]!;
  });
}

/** Stops the programme; audits it already planned stay on the schedule. */
export async function deleteAuditProgramme(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findProgramme(tx, workspaceId, id);
    await tx
      .update(qualityAuditProgrammes)
      .set({ deletedAt: new Date() })
      .where(eq(qualityAuditProgrammes.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "quality_audit_programme", entityId: id, action: "delete" },
    ]);
  });
}

/**
 * The sweep's job: plans the next audits of every active programme in the workspace. Each
 * programme is re-read under the workspace lock, so two instances sweeping at once plan each audit
 * once. Returns how many audits were planned.
 */
export async function generateProgrammeAudits(db: Database, workspaceId: string, today: string) {
  const due = await db
    .select({ id: qualityAuditProgrammes.id })
    .from(qualityAuditProgrammes)
    .where(
      and(
        liveProgrammes(workspaceId),
        eq(qualityAuditProgrammes.active, true),
        lte(qualityAuditProgrammes.nextPlannedOn, addDaysIso(today, 60)),
      ),
    );
  let planned = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const current = await findProgramme(tx, workspaceId, id).catch(() => null);
      if (!current) return;
      const before = await tx
        .select({ id: qualityAudits.id })
        .from(qualityAudits)
        .where(eq(qualityAudits.programmeId, id));
      await generateFor(tx, workspaceId, null, current, today);
      const after = await tx
        .select({ id: qualityAudits.id })
        .from(qualityAudits)
        .where(eq(qualityAudits.programmeId, id));
      planned += after.length - before.length;
    });
  }
  return planned;
}

// ─── Complaint trends ────────────────────────────────────────────────────────

/** Sets the units sold of a product in a month (any date in the month names it). */
export async function setSalesVolume(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: SalesVolumeInput,
) {
  const periodStart = monthStart(input.period);
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertLinks(tx, workspaceId, { itemId: input.itemId });
    const [row] = await tx
      .insert(qualitySalesVolumes)
      .values({ workspaceId, itemId: input.itemId, periodStart, units: input.units, updatedBy: actorId })
      .onConflictDoUpdate({
        target: [
          qualitySalesVolumes.workspaceId,
          qualitySalesVolumes.itemId,
          qualitySalesVolumes.periodStart,
        ],
        set: { units: input.units, updatedBy: actorId, deletedAt: null },
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "quality_sales_volume", entityId: row!.id, action: "upsert", data: strip(row!) },
    ]);
    return strip(row!);
  });
}

export async function listSalesVolumes(
  db: Database,
  workspaceId: string,
  query: { months: number; itemId?: string | undefined },
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const from = trendMonths(today, query.months)[0]!;
  const rows = await db
    .select()
    .from(qualitySalesVolumes)
    .where(
      and(
        eq(qualitySalesVolumes.workspaceId, workspaceId),
        isNull(qualitySalesVolumes.deletedAt),
        gte(qualitySalesVolumes.periodStart, from),
        query.itemId ? eq(qualitySalesVolumes.itemId, query.itemId) : undefined,
      ),
    )
    .orderBy(asc(qualitySalesVolumes.periodStart));
  return { volumes: rows.map(strip) };
}

/**
 * Complaints per million units sold, per month: overall, per product and per complaint category.
 * The units are the sales volumes entered per product and month (production is not required). A
 * product's rate uses its own units; a category's rate (and the overall one) uses the units of all
 * products. A month with no units on record has no rate. Complaints about no product only count in
 * the overall and category figures, against the total units.
 */
export async function complaintTrends(db: Database, workspaceId: string, months: number, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const periods = trendMonths(today, months);
  const from = periods[0]!;
  const [complaints, volumes] = await Promise.all([
    db
      .select({
        itemId: qualityComplaints.itemId,
        category: qualityComplaints.category,
        receivedOn: qualityComplaints.receivedOn,
      })
      .from(qualityComplaints)
      .where(
        and(
          eq(qualityComplaints.workspaceId, workspaceId),
          isNull(qualityComplaints.deletedAt),
          gte(qualityComplaints.receivedOn, from),
        ),
      ),
    db
      .select()
      .from(qualitySalesVolumes)
      .where(
        and(
          eq(qualitySalesVolumes.workspaceId, workspaceId),
          isNull(qualitySalesVolumes.deletedAt),
          gte(qualitySalesVolumes.periodStart, from),
        ),
      ),
  ]);
  const itemIds = [
    ...new Set([...complaints.flatMap((c) => (c.itemId ? [c.itemId] : [])), ...volumes.map((v) => v.itemId)]),
  ];
  const itemRows = itemIds.length
    ? await db
        .select({ id: items.id, code: items.code, name: items.name })
        .from(items)
        .where(inArray(items.id, itemIds))
    : [];
  const slot = (date: string) => periods.indexOf(monthStart(date));
  const zeros = () => periods.map((period) => ({ period, complaints: 0, units: 0 }));
  const withRate = <T extends { complaints: number; units: number }>(cells: T[]) =>
    cells.map((c) => ({ ...c, perMillion: complaintsPerMillion(c.complaints, c.units) }));
  const sum = (cells: { complaints: number; units: number }[]) => {
    const complaintsTotal = cells.reduce((t, c) => t + c.complaints, 0);
    const unitsTotal = cells.reduce((t, c) => t + c.units, 0);
    return {
      complaints: complaintsTotal,
      units: unitsTotal,
      perMillion: complaintsPerMillion(complaintsTotal, unitsTotal),
    };
  };

  const overall = zeros();
  const byProduct = new Map<string, ReturnType<typeof zeros>>();
  const byCategory = new Map<ComplaintCategory, ReturnType<typeof zeros>>();
  for (const v of volumes) {
    const i = slot(v.periodStart);
    if (i < 0) continue;
    overall[i]!.units += v.units;
    if (!byProduct.has(v.itemId)) byProduct.set(v.itemId, zeros());
    byProduct.get(v.itemId)![i]!.units += v.units;
  }
  for (const c of complaints) {
    const i = slot(c.receivedOn);
    if (i < 0) continue;
    overall[i]!.complaints += 1;
    if (c.itemId) {
      if (!byProduct.has(c.itemId)) byProduct.set(c.itemId, zeros());
      byProduct.get(c.itemId)![i]!.complaints += 1;
    }
    if (!byCategory.has(c.category)) byCategory.set(c.category, zeros());
    byCategory.get(c.category)![i]!.complaints += 1;
  }
  const nameOf = new Map(itemRows.map((r) => [r.id, r]));
  return {
    today,
    periods,
    overall: { months: withRate(overall), total: sum(overall) },
    products: [...byProduct]
      .map(([itemId, cells]) => ({
        item: nameOf.get(itemId) ?? { id: itemId, code: "", name: "" },
        months: withRate(cells),
        total: sum(cells),
      }))
      .sort((a, b) => b.total.complaints - a.total.complaints || a.item.name.localeCompare(b.item.name)),
    categories: [...byCategory]
      .map(([category, cells]) => {
        // Against all products' units in the month.
        const rated = cells.map((c, i) => ({ ...c, units: overall[i]!.units }));
        return {
          category,
          label: complaintCategoryLabels[category],
          months: withRate(rated),
          total: sum(rated),
        };
      })
      .sort((a, b) => b.total.complaints - a.total.complaints),
  };
}

// ─── Supplier non-conformances and the supplier's approval ───────────────────

/**
 * A supplier's non-conformances beside its approval status, with a suggestion (never an action)
 * to look at suspending it. The approval itself is a person's decision in the items module.
 */
export async function supplierQualityStanding(
  db: Database,
  workspaceId: string,
  supplierId: string,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const [supplier] = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      approvalStatus: suppliers.approvalStatus,
      approvalChangedAt: suppliers.approvalChangedAt,
    })
    .from(suppliers)
    .where(
      and(eq(suppliers.id, supplierId), eq(suppliers.workspaceId, workspaceId), isNull(suppliers.deletedAt)),
    );
  if (!supplier) throw notFound("Supplier");
  const n = qualityNonconformances;
  const rows = await db
    .select({
      id: n.id,
      reference: n.reference,
      title: n.title,
      severity: n.severity,
      status: n.status,
      dueOn: n.dueOn,
      raisedOn: n.raisedOn,
      supplierReviewedAt: n.supplierReviewedAt,
      supplierReviewStatus: n.supplierReviewStatus,
    })
    .from(n)
    .where(and(eq(n.workspaceId, workspaceId), eq(n.supplierId, supplierId), isNull(n.deletedAt)))
    .orderBy(asc(n.raisedOn));
  const open = rows
    .filter((r) => r.status !== "closed")
    .map((r) => ({ ...r, overdue: !!r.dueOn && r.dueOn < today }));
  return {
    supplier,
    open,
    closedCount: rows.length - open.length,
    advice: supplierSuspensionAdvice(rows, supplier.approvalStatus),
  };
}

/**
 * Open non-conformances per supplier, with quality's suggestion to look at the approval (never an
 * action): the warning purchasing shows beside a supplier. Suppliers with none are absent. Callers
 * only use this where quality is active and readable by the caller.
 */
export async function supplierQualityFlags(
  db: Executor,
  workspaceId: string,
  supplierIds: readonly string[],
  todayOn?: string,
) {
  const flags = new Map<
    string,
    { open: number; critical: number; major: number; overdue: number; suggest: boolean; reasons: string[] }
  >();
  if (!supplierIds.length) return flags;
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const n = qualityNonconformances;
  const rows = await db
    .select({
      supplierId: n.supplierId,
      severity: n.severity,
      status: n.status,
      dueOn: n.dueOn,
      approvalStatus: suppliers.approvalStatus,
    })
    .from(n)
    .innerJoin(suppliers, eq(suppliers.id, n.supplierId))
    .where(
      and(
        eq(n.workspaceId, workspaceId),
        inArray(n.supplierId, [...supplierIds]),
        isNull(n.deletedAt),
        ne(n.status, "closed"),
      ),
    );
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.supplierId!, [...(by.get(r.supplierId!) ?? []), r]);
  for (const [id, list] of by) {
    const advice = supplierSuspensionAdvice(list, list[0]!.approvalStatus);
    flags.set(id, {
      open: list.length,
      critical: list.filter((r) => r.severity === "critical").length,
      major: list.filter((r) => r.severity === "major").length,
      overdue: list.filter((r) => r.dueOn !== null && r.dueOn < today).length,
      suggest: advice.suggest,
      reasons: advice.reasons,
    });
  }
  return flags;
}

/**
 * A manager records that these supplier non-conformances were weighed when the supplier's approval
 * was decided: the supplier's approval status at that time is stored on each. Changes no approval.
 * The supplier's approval must have been decided since the earliest of them was raised.
 */
export async function recordSupplierReview(
  db: Database,
  workspaceId: string,
  actorId: string,
  supplierId: string,
  nonconformanceIds: string[],
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [supplier] = await tx
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, supplierId),
          eq(suppliers.workspaceId, workspaceId),
          isNull(suppliers.deletedAt),
        ),
      );
    if (!supplier) throw notFound("Supplier");
    if (!supplier.approvalChangedAt)
      throw new ApiError(409, "no_approval_decision", "Decide the supplier's approval first");
    const n = qualityNonconformances;
    const rows = await tx
      .select()
      .from(n)
      .where(
        and(
          eq(n.workspaceId, workspaceId),
          eq(n.supplierId, supplierId),
          inArray(n.id, nonconformanceIds),
          isNull(n.deletedAt),
          ne(n.status, "closed"),
        ),
      );
    if (rows.length !== new Set(nonconformanceIds).size)
      throw badRequest("Each must be an open non-conformance of this supplier");
    const updated = await tx
      .update(n)
      .set({
        supplierReviewedAt: supplier.approvalChangedAt,
        supplierReviewedBy: supplier.approvalChangedBy ?? actorId,
        supplierReviewStatus: supplier.approvalStatus,
      })
      .where(inArray(n.id, nonconformanceIds))
      .returning();
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      updated.map((row) => ({
        entity: "quality_nonconformance" as const,
        entityId: row.id,
        action: "upsert" as const,
        data: strip(row),
      })),
    );
    return { recorded: updated.length, approvalStatus: supplier.approvalStatus };
  });
}

// ─── Recall test prefill ─────────────────────────────────────────────────────

/**
 * What a mock recall of this lot starts from: the lot's mass balance from the stock ledger and,
 * when production is switched on and readable, where it went (the batches that used it and the
 * lots they made, or the batch that made it and the lots it used). `quantityExpected` is
 * what came in (received and produced); `quantityTraced` is what the records account for (on hand,
 * used and wasted), so adjustments and stocktake differences show up as a shortfall to explain.
 * The person checks and edits the figures before recording the test.
 */
export async function recallTestPrefill(
  db: Database,
  workspaceId: string,
  query: RecallPrefillQuery,
  withProduction: boolean,
) {
  const [lot] = await db
    .select({
      id: stockLots.id,
      lotCode: stockLots.lotCode,
      itemCode: items.code,
      itemName: items.name,
      unit: items.unit,
    })
    .from(stockLots)
    .innerJoin(items, eq(items.id, stockLots.itemId))
    .where(
      and(eq(stockLots.id, query.lotId), eq(stockLots.workspaceId, workspaceId), isNull(stockLots.deletedAt)),
    );
  if (!lot) throw notFound("Lot");
  const movements = await db
    .select({ type: stockMovements.type, quantity: stockMovements.quantity })
    .from(stockMovements)
    .where(eq(stockMovements.lotId, query.lotId));
  const base = lotMassBalance(movements);
  // Movements are in the base unit; the test is recorded in the item's unit.
  const shown = (x: number) => stockAmount(x, { unit: lot.unit }).display;
  const balance = {
    received: shown(base.received),
    returned: shown(base.returned),
    produced: shown(base.produced),
    consumed: shown(base.consumed),
    despatched: shown(base.despatched),
    wasted: shown(base.wasted),
    adjusted: shown(base.adjusted),
    onHand: shown(base.onHand),
    input: shown(base.input),
  };
  const quantityExpected = balance.input;
  const quantityTraced = shown(base.onHand + base.consumed + base.wasted + base.despatched);

  const lines: string[] = [
    `Lot ${lot.lotCode} of ${lot.itemCode} ${lot.itemName}, in ${lot.unit}.`,
    `Mass balance: received ${balance.received}, customer returns ${balance.returned}, produced ${balance.produced}, used in batches ${balance.consumed}, wasted ${balance.wasted}, despatched ${balance.despatched}, on hand ${balance.onHand}, adjustments and stocktakes ${balance.adjusted}.`,
  ];
  let trace: Awaited<ReturnType<typeof traceLot>> | null = null;
  if (withProduction) {
    trace = await traceLot(db, workspaceId, query.lotId, { depth: 5 });
    if (query.direction !== "backward")
      for (const f of trace.forward)
        lines.push(
          `Forward: ${f.consumed.amount.display} ${f.consumed.amount.displayUnit} of ${f.consumed.lot.lotCode} used in batch ${f.batch.batchCode} (${f.batch.recipe.name})` +
            (f.outputs.length
              ? `, making ${f.outputs.map((o) => `${o.lot.item.name} lot ${o.lot.lotCode} (${o.amount.display} ${o.amount.displayUnit})`).join(", ")}`
              : ""),
        );
    if (query.direction !== "forward")
      for (const b of trace.backward)
        lines.push(
          `Backward: ${b.produced.lot.lotCode} made in batch ${b.batch.batchCode} (${b.batch.recipe.name}) from ${b.inputs
            .map(
              (i) =>
                `${i.lot.item.name} lot ${i.lot.lotCode}${i.lot.supplierName ? ` (${i.lot.supplierName})` : ""}`,
            )
            .join(", ")}`,
        );
    if (!trace.forward.length && !trace.backward.length) lines.push("No batch records name this lot.");
  } else lines.push("Batch records were not traced (production is not switched on for you).");
  return {
    lotId: lot.id,
    lotCode: lot.lotCode,
    unit: lot.unit,
    massBalance: balance,
    quantityExpected,
    quantityTraced,
    trace,
    notes: lines.join("\n"),
  };
}
