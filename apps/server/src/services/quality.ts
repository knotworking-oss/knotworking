import {
  addDaysIso,
  addMonthsIso,
  auditState,
  canCompleteAudit,
  canVerifyNonconformance,
  canTransitionComplaint,
  complaintCategoryLabels,
  complaintOpensNonconformance,
  isNonconformanceOverdue,
  nonconformanceDueDays,
  qualityReference,
  qualityReferencePrefixes,
  qualityReferenceSequence,
  recallTestResult,
  recallTestSchedule,
  type AuditCompleteInput,
  type AuditCreateInput,
  type AuditFindingInput,
  type AuditListQuery,
  type AuditUpdateInput,
  type ComplaintCategory,
  type ComplaintCloseInput,
  type ComplaintCreateInput,
  type ComplaintListQuery,
  type ComplaintUpdateInput,
  type ModuleAccessLevel,
  type ModuleId,
  type NonconformanceCreateInput,
  type NonconformanceListQuery,
  type NonconformanceUpdateInput,
  type QualitySeverity,
  type RecallTestCreateInput,
  type RecallTestListQuery,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  qualityAudits,
  qualityComplaints,
  qualityNonconformances,
  qualityRecallTests,
  recordChanges,
  stockLots,
  suppliers,
  users,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceToday } from "./time-zone";
import {
  audience,
  deliverNotifications,
  memberAccess,
  notifyNonconformanceAssigned,
  type NotificationRow,
} from "./notifications";

/**
 * Quality module: complaints, non-conformances (CAPA), internal audits and mock recall tests.
 *
 * Records are never deleted (a planned audit with no findings is the one exception): complaints
 * and non-conformances are closed and reopened, audits completed or cancelled, recall tests voided.
 * A complaint that is critical, or major and about food safety, opens a non-conformance in the
 * same transaction, so a food-safety problem never waits for triage.
 *
 * "Today" is the UTC date.
 */

type ComplaintRow = typeof qualityComplaints.$inferSelect;
type NonconformanceRow = typeof qualityNonconformances.$inferSelect;
type AuditRow = typeof qualityAudits.$inferSelect;
type RecallTestRow = typeof qualityRecallTests.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
const ilike = (column: unknown, q: string) => sql`${column} ilike ${like(q)} escape '!'`;

export const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

const notInFuture = (date: string, field: string, today: string) => {
  if (date > today) throw badRequest(`${field} can't be in the future`);
};

// ─── References and links ────────────────────────────────────────────────────

type ReferencedTable =
  typeof qualityComplaints | typeof qualityNonconformances | typeof qualityAudits | typeof qualityRecallTests;

/**
 * The next reference for a record dated `date`: the highest sequence used that year plus one,
 * deleted rows included so a reference is never reused. Callers hold `lockWorkspaceLog`.
 */
export async function nextReference(
  tx: Transaction,
  table: ReferencedTable,
  workspaceId: string,
  prefix: string,
  date: string,
) {
  const stem = `${prefix}-${date.slice(0, 4)}-`;
  const rows = await tx
    .select({ reference: table.reference })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), sql`${table.reference} like ${`${stem}%`}`));
  const max = rows.reduce((m, r) => Math.max(m, qualityReferenceSequence(r.reference) ?? 0), 0);
  return qualityReference(prefix, date, max + 1);
}

interface Links {
  itemId?: string | null | undefined;
  lotId?: string | null | undefined;
  supplierId?: string | null | undefined;
  userIds?: (string | null | undefined)[];
}

/** Checks that linked items, lots, suppliers and members belong to the workspace. */
export async function assertLinks(tx: Executor, workspaceId: string, links: Links) {
  if (links.itemId) {
    const [row] = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.id, links.itemId), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
    if (!row) throw badRequest("Unknown itemId");
  }
  if (links.lotId) {
    const [row] = await tx
      .select({ id: stockLots.id })
      .from(stockLots)
      .where(
        and(
          eq(stockLots.id, links.lotId),
          eq(stockLots.workspaceId, workspaceId),
          isNull(stockLots.deletedAt),
        ),
      );
    if (!row) throw badRequest("Unknown lotId");
  }
  if (links.supplierId) {
    const [row] = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, links.supplierId),
          eq(suppliers.workspaceId, workspaceId),
          isNull(suppliers.deletedAt),
        ),
      );
    if (!row) throw badRequest("Unknown supplierId");
  }
  const userIds = [...new Set((links.userIds ?? []).filter((id): id is string => Boolean(id)))];
  if (userIds.length) {
    const members = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.userId, userIds),
          isNull(workspaceMembers.deletedAt),
        ),
      );
    if (members.length !== userIds.length) throw badRequest("That person is not a member of this workspace");
  }
}

/** A lot that names an item must be a lot of that item. */
async function assertLotOfItem(tx: Executor, lotId: string | null, itemId: string | null) {
  if (!lotId || !itemId) return;
  const [lot] = await tx.select({ itemId: stockLots.itemId }).from(stockLots).where(eq(stockLots.id, lotId));
  if (lot && lot.itemId !== itemId) throw badRequest("That lot is not a lot of that item");
}

/** A lot named without its item: the item is the lot's. */
async function itemOfLot(tx: Executor, lotId: string | null | undefined) {
  if (!lotId) return undefined;
  const [lot] = await tx.select({ itemId: stockLots.itemId }).from(stockLots).where(eq(stockLots.id, lotId));
  return lot?.itemId;
}

/**
 * A patch value that differs from the stored one, else undefined. Links are only checked when they
 * change, so a row whose owner has since left the workspace can still be edited.
 */
const changed = <T>(next: T | undefined, current: T) =>
  next !== undefined && next !== current ? next : undefined;

/** Names for linked rows, loaded once per page. */
async function loadNames(
  db: Executor,
  ids: {
    itemIds?: (string | null)[];
    lotIds?: (string | null)[];
    supplierIds?: (string | null)[];
    userIds?: (string | null)[];
  },
) {
  const uniq = (list?: (string | null)[]) => [
    ...new Set((list ?? []).filter((x): x is string => Boolean(x))),
  ];
  const lotIds = uniq(ids.lotIds);
  const lotRows = lotIds.length
    ? await db
        .select({
          id: stockLots.id,
          lotCode: stockLots.lotCode,
          itemId: stockLots.itemId,
          expiresOn: stockLots.expiresOn,
        })
        .from(stockLots)
        .where(inArray(stockLots.id, lotIds))
    : [];
  const itemIds = uniq([...(ids.itemIds ?? []), ...lotRows.map((l) => l.itemId)]);
  const supplierIds = uniq(ids.supplierIds);
  const userIds = uniq(ids.userIds);
  const [itemRows, supplierRows, userRows] = await Promise.all([
    itemIds.length
      ? db
          .select({ id: items.id, code: items.code, name: items.name, unit: items.unit })
          .from(items)
          .where(inArray(items.id, itemIds))
      : [],
    supplierIds.length
      ? db
          .select({ id: suppliers.id, name: suppliers.name })
          .from(suppliers)
          .where(inArray(suppliers.id, supplierIds))
      : [],
    userIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : [],
  ]);
  const itemMap = new Map(itemRows.map((r) => [r.id, r]));
  const lotMap = new Map(lotRows.map((r) => [r.id, r]));
  const supplierMap = new Map(supplierRows.map((r) => [r.id, r]));
  const userMap = new Map(userRows.map((r) => [r.id, r]));
  return {
    item: (id: string | null) => (id ? (itemMap.get(id) ?? null) : null),
    lot: (id: string | null) => {
      const lot = id ? lotMap.get(id) : undefined;
      return lot ? { ...lot, item: itemMap.get(lot.itemId) ?? null } : null;
    },
    supplier: (id: string | null) => (id ? (supplierMap.get(id) ?? null) : null),
    user: (id: string | null) => (id ? (userMap.get(id) ?? null) : null),
  };
}
type Names = Awaited<ReturnType<typeof loadNames>>;

// ─── Complaints ──────────────────────────────────────────────────────────────

/** Sync data leaves out who complained and how to reach them. */
const complaintChange = (row: ComplaintRow): ChangeInput => {
  const { complainantName: _name, complainantContact: _contact, ...rest } = strip(row);
  return { entity: "quality_complaint", entityId: row.id, action: "upsert", data: rest };
};

const serializeComplaint = (row: ComplaintRow, names: Names, ncCounts: Map<string, number>) => ({
  ...strip(row),
  item: names.item(row.itemId),
  lot: names.lot(row.lotId),
  createdByName: names.user(row.createdBy)?.name ?? null,
  closedByName: names.user(row.closedBy)?.name ?? null,
  nonconformanceCount: ncCounts.get(row.id) ?? 0,
});

async function nonconformanceCounts(db: Executor, column: "complaintId" | "auditId", ids: string[]) {
  const map = new Map<string, number>();
  if (!ids.length) return map;
  const col = qualityNonconformances[column];
  const rows = await db
    .select({ id: col, n: count() })
    .from(qualityNonconformances)
    .where(and(inArray(col, ids), isNull(qualityNonconformances.deletedAt)))
    .groupBy(col);
  for (const r of rows) if (r.id) map.set(r.id, r.n);
  return map;
}

async function complaintViews(db: Executor, rows: ComplaintRow[]) {
  const names = await loadNames(db, {
    itemIds: rows.map((r) => r.itemId),
    lotIds: rows.map((r) => r.lotId),
    userIds: rows.flatMap((r) => [r.createdBy, r.closedBy]),
  });
  const counts = await nonconformanceCounts(
    db,
    "complaintId",
    rows.map((r) => r.id),
  );
  return rows.map((row) => serializeComplaint(row, names, counts));
}

export async function listComplaints(db: Database, workspaceId: string, query: ComplaintListQuery) {
  const t = qualityComplaints;
  const where: (SQL | undefined)[] = [eq(t.workspaceId, workspaceId), isNull(t.deletedAt)];
  if (query.status === "unresolved") where.push(ne(t.status, "closed"));
  else if (query.status !== "all") where.push(eq(t.status, query.status));
  if (query.category) where.push(eq(t.category, query.category));
  if (query.severity) where.push(eq(t.severity, query.severity));
  if (query.itemId) where.push(eq(t.itemId, query.itemId));
  if (query.lotId) where.push(eq(t.lotId, query.lotId));
  if (query.from) where.push(gte(t.receivedOn, query.from));
  if (query.to) where.push(lte(t.receivedOn, query.to));
  if (query.q) {
    where.push(
      or(
        ilike(t.reference, query.q),
        ilike(t.description, query.q),
        ilike(t.customer, query.q),
        ilike(t.reportedLotCode, query.q),
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.receivedOn), desc(t.reference))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(t)
      .where(and(...where)),
  ]);
  return {
    complaints: await complaintViews(db, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findComplaint(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(qualityComplaints)
    .where(
      and(
        eq(qualityComplaints.id, id),
        eq(qualityComplaints.workspaceId, workspaceId),
        isNull(qualityComplaints.deletedAt),
      ),
    );
  if (!row) throw notFound("Complaint");
  return row;
}

export async function getComplaint(db: Executor, workspaceId: string, id: string, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const row = await findComplaint(db, workspaceId, id);
  const [view] = await complaintViews(db, [row]);
  const ncs = await db
    .select()
    .from(qualityNonconformances)
    .where(and(eq(qualityNonconformances.complaintId, id), isNull(qualityNonconformances.deletedAt)))
    .orderBy(asc(qualityNonconformances.reference));
  return { ...view!, nonconformances: ncs.map((nc) => ncSummary(nc, today)) };
}

const ncSummary = (nc: NonconformanceRow, today: string) => ({
  id: nc.id,
  reference: nc.reference,
  title: nc.title,
  severity: nc.severity,
  status: nc.status,
  dueOn: nc.dueOn,
  overdue: isNonconformanceOverdue(nc, today),
});

const complaintNcTitle = (category: ComplaintCategory, reference: string) =>
  `${complaintCategoryLabels[category]} complaint ${reference}`;

export async function createComplaint(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ComplaintCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { id, ...fields } = input;
  notInFuture(fields.receivedOn, "receivedOn", today);
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertLinks(tx, workspaceId, { itemId: fields.itemId, lotId: fields.lotId });
    await assertLotOfItem(tx, fields.lotId ?? null, fields.itemId ?? null);
    if (fields.lotId && !fields.itemId) fields.itemId = await itemOfLot(tx, fields.lotId);
    const reference = await nextReference(
      tx,
      qualityComplaints,
      workspaceId,
      qualityReferencePrefixes.complaint,
      fields.receivedOn,
    );
    const [row] = await tx
      .insert(qualityComplaints)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId, reference, createdBy: actorId })
      .returning();
    const changes: ChangeInput[] = [complaintChange(row!)];
    const nc = await openNonconformanceIfDue(tx, workspaceId, actorId, row!, today);
    if (nc) changes.push(ncChange(nc));
    await recordChanges(tx, workspaceId, actorId, changes);
    return getComplaint(tx, workspaceId, row!.id, today);
  });
}

/**
 * Opens the non-conformance a complaint calls for (`complaintOpensNonconformance`) unless one has
 * been raised from it already: when it is logged, and again when its severity or category is raised
 * later, so a food-safety problem never waits for triage however it was first logged.
 */
async function openNonconformanceIfDue(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  complaint: ComplaintRow,
  today: string,
) {
  if (!complaintOpensNonconformance(complaint)) return null;
  const [existing] = await tx
    .select({ id: qualityNonconformances.id })
    .from(qualityNonconformances)
    .where(
      and(eq(qualityNonconformances.complaintId, complaint.id), isNull(qualityNonconformances.deletedAt)),
    )
    .limit(1);
  if (existing) return null;
  return insertNonconformance(tx, workspaceId, actorId, {
    raisedOn: today,
    source: "complaint",
    severity: complaint.severity,
    title: complaintNcTitle(complaint.category, complaint.reference),
    description: complaint.description,
    complaintId: complaint.id,
    itemId: complaint.itemId,
    lotId: complaint.lotId,
  });
}

const complaintClosed = () =>
  new ApiError(409, "complaint_closed", "This complaint is closed; a manager can reopen it");

export async function updateComplaint(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: ComplaintUpdateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  if (patch.receivedOn) notInFuture(patch.receivedOn, "receivedOn", today);
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findComplaint(tx, workspaceId, id);
    if (current.status === "closed") throw complaintClosed();
    if (
      patch.status &&
      patch.status !== current.status &&
      !canTransitionComplaint(current.status, patch.status)
    ) {
      throw new ApiError(
        409,
        "invalid_transition",
        `A complaint can't go from ${current.status} to ${patch.status}`,
      );
    }
    await assertLinks(tx, workspaceId, {
      itemId: changed(patch.itemId, current.itemId),
      lotId: changed(patch.lotId, current.lotId),
    });
    const set: Partial<ComplaintRow> = { ...patch };
    const lotId = patch.lotId !== undefined ? patch.lotId : current.lotId;
    const itemId = patch.itemId !== undefined ? patch.itemId : current.itemId;
    await assertLotOfItem(tx, lotId, itemId);
    if (lotId && !itemId) set.itemId = (await itemOfLot(tx, lotId)) ?? null;
    const [row] = await tx.update(qualityComplaints).set(set).where(eq(qualityComplaints.id, id)).returning();
    const changes: ChangeInput[] = [complaintChange(row!)];
    const nc = await openNonconformanceIfDue(tx, workspaceId, actorId, row!, today);
    if (nc) changes.push(ncChange(nc));
    await recordChanges(tx, workspaceId, actorId, changes);
    return getComplaint(tx, workspaceId, id, today);
  });
}

/** A manager in person: the reply to the complainant must be on record. */
export async function closeComplaint(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ComplaintCloseInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findComplaint(tx, workspaceId, id);
    if (current.status === "closed")
      throw new ApiError(409, "already_closed", "This complaint is already closed");
    const response = input.response ?? current.response;
    if (!response) throw badRequest("Record the response to the complainant before closing");
    const [row] = await tx
      .update(qualityComplaints)
      .set({
        status: "closed",
        response,
        ...(input.justified !== undefined ? { justified: input.justified } : {}),
        closeNote: input.note ?? null,
        closedAt: new Date(),
        closedBy: actorId,
      })
      .where(eq(qualityComplaints.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [complaintChange(row!)]);
    return getComplaint(tx, workspaceId, id);
  });
}

export async function reopenComplaint(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findComplaint(tx, workspaceId, id);
    if (current.status !== "closed")
      throw new ApiError(409, "not_closed", "Only a closed complaint can be reopened");
    const [row] = await tx
      .update(qualityComplaints)
      .set({
        status: "investigating",
        closedAt: null,
        closedBy: null,
        closeNote: null,
        reopenedAt: new Date(),
        reopenReason: reason,
      })
      .where(eq(qualityComplaints.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [complaintChange(row!)]);
    return getComplaint(tx, workspaceId, id);
  });
}

// ─── Non-conformances ────────────────────────────────────────────────────────

const ncChange = (row: NonconformanceRow): ChangeInput => ({
  entity: "quality_nonconformance",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function insertNonconformance(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  fields: Omit<NonconformanceCreateInput, "id" | "severity"> & { id?: string; severity: QualitySeverity },
) {
  const reference = await nextReference(
    tx,
    qualityNonconformances,
    workspaceId,
    qualityReferencePrefixes.nonconformance,
    fields.raisedOn,
  );
  const dueOn = fields.dueOn ?? addDaysIso(fields.raisedOn, nonconformanceDueDays[fields.severity]);
  const [row] = await tx
    .insert(qualityNonconformances)
    .values({ ...fields, workspaceId, reference, dueOn, createdBy: actorId })
    .returning();
  return row!;
}

async function ncViews(db: Executor, rows: NonconformanceRow[], today: string) {
  const names = await loadNames(db, {
    itemIds: rows.map((r) => r.itemId),
    lotIds: rows.map((r) => r.lotId),
    supplierIds: rows.map((r) => r.supplierId),
    userIds: rows.flatMap((r) => [
      r.ownerUserId,
      r.createdBy,
      r.closedBy,
      r.actionTakenBy,
      r.supplierReviewedBy,
    ]),
  });
  const complaintIds = [...new Set(rows.flatMap((r) => (r.complaintId ? [r.complaintId] : [])))];
  const auditIds = [...new Set(rows.flatMap((r) => (r.auditId ? [r.auditId] : [])))];
  const [complaints, audits] = await Promise.all([
    complaintIds.length
      ? db
          .select({
            id: qualityComplaints.id,
            reference: qualityComplaints.reference,
            status: qualityComplaints.status,
          })
          .from(qualityComplaints)
          .where(inArray(qualityComplaints.id, complaintIds))
      : [],
    auditIds.length
      ? db
          .select({ id: qualityAudits.id, reference: qualityAudits.reference, title: qualityAudits.title })
          .from(qualityAudits)
          .where(inArray(qualityAudits.id, auditIds))
      : [],
  ]);
  const complaintMap = new Map(complaints.map((c) => [c.id, c]));
  const auditMap = new Map(audits.map((a) => [a.id, a]));
  return rows.map((row) => ({
    ...strip(row),
    overdue: isNonconformanceOverdue(row, today),
    complaint: row.complaintId ? (complaintMap.get(row.complaintId) ?? null) : null,
    audit: row.auditId ? (auditMap.get(row.auditId) ?? null) : null,
    item: names.item(row.itemId),
    lot: names.lot(row.lotId),
    supplier: names.supplier(row.supplierId),
    owner: names.user(row.ownerUserId),
    createdByName: names.user(row.createdBy)?.name ?? null,
    actionTakenByName: names.user(row.actionTakenBy)?.name ?? null,
    supplierReviewedByName: names.user(row.supplierReviewedBy)?.name ?? null,
    closedByName: names.user(row.closedBy)?.name ?? null,
  }));
}

export async function listNonconformances(
  db: Database,
  workspaceId: string,
  query: NonconformanceListQuery,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const t = qualityNonconformances;
  const where: (SQL | undefined)[] = [eq(t.workspaceId, workspaceId), isNull(t.deletedAt)];
  if (query.status === "unresolved") where.push(ne(t.status, "closed"));
  else if (query.status === "overdue")
    where.push(ne(t.status, "closed"), isNotNull(t.dueOn), lt(t.dueOn, today));
  else if (query.status !== "all") where.push(eq(t.status, query.status));
  if (query.source) where.push(eq(t.source, query.source));
  if (query.severity) where.push(eq(t.severity, query.severity));
  if (query.complaintId) where.push(eq(t.complaintId, query.complaintId));
  if (query.auditId) where.push(eq(t.auditId, query.auditId));
  if (query.ownerUserId) where.push(eq(t.ownerUserId, query.ownerUserId));
  if (query.itemId) where.push(eq(t.itemId, query.itemId));
  if (query.supplierId) where.push(eq(t.supplierId, query.supplierId));
  if (query.q)
    where.push(or(ilike(t.reference, query.q), ilike(t.title, query.q), ilike(t.description, query.q)));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.raisedOn), desc(t.reference))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(t)
      .where(and(...where)),
  ]);
  return {
    nonconformances: await ncViews(db, rows, today),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findNonconformance(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(qualityNonconformances)
    .where(
      and(
        eq(qualityNonconformances.id, id),
        eq(qualityNonconformances.workspaceId, workspaceId),
        isNull(qualityNonconformances.deletedAt),
      ),
    );
  if (!row) throw notFound("Non-conformance");
  return row;
}

export async function getNonconformance(db: Executor, workspaceId: string, id: string, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const row = await findNonconformance(db, workspaceId, id);
  return (await ncViews(db, [row], today))[0]!;
}

export async function createNonconformance(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: NonconformanceCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  notInFuture(input.raisedOn, "raisedOn", today);
  if ((input.source === "complaint") !== Boolean(input.complaintId))
    throw badRequest("A non-conformance has the source complaint exactly when it is raised from one");
  if ((input.source === "audit") !== Boolean(input.auditId))
    throw badRequest("A non-conformance has the source audit exactly when it is raised from one");
  if (input.dueOn && input.dueOn < input.raisedOn)
    throw badRequest("The due date can't be before the date it was raised");
  let notified: NotificationRow[] = [];
  const created = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertLinks(tx, workspaceId, {
      itemId: input.itemId,
      lotId: input.lotId,
      supplierId: input.supplierId,
      userIds: [input.ownerUserId],
    });
    await assertLotOfItem(tx, input.lotId ?? null, input.itemId ?? null);
    const itemId = input.itemId ?? (await itemOfLot(tx, input.lotId));
    if (input.complaintId) await findComplaint(tx, workspaceId, input.complaintId);
    if (input.auditId) {
      const audit = await findAudit(tx, workspaceId, input.auditId);
      if (audit.status === "cancelled")
        throw new ApiError(409, "audit_cancelled", "That audit was cancelled");
    }
    const row = await insertNonconformance(tx, workspaceId, actorId, { ...input, itemId: itemId ?? null });
    await recordChanges(tx, workspaceId, actorId, [ncChange(row)]);
    notified = await notifyNonconformanceAssigned(tx, workspaceId, actorId, row);
    return getNonconformance(tx, workspaceId, row.id, today);
  });
  void deliverNotifications(db, notified);
  return created;
}

const ncClosed = () =>
  new ApiError(409, "nonconformance_closed", "This non-conformance is closed; a manager can reopen it");

export async function updateNonconformance(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: NonconformanceUpdateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  if (patch.raisedOn) notInFuture(patch.raisedOn, "raisedOn", today);
  let notified: NotificationRow[] = [];
  const updated = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findNonconformance(tx, workspaceId, id);
    if (current.status === "closed") throw ncClosed();
    await assertLinks(tx, workspaceId, {
      itemId: changed(patch.itemId, current.itemId),
      lotId: changed(patch.lotId, current.lotId),
      supplierId: changed(patch.supplierId, current.supplierId),
      userIds: [changed(patch.ownerUserId, current.ownerUserId)],
    });
    const lotId = patch.lotId !== undefined ? patch.lotId : current.lotId;
    const itemId = patch.itemId !== undefined ? patch.itemId : current.itemId;
    await assertLotOfItem(tx, lotId, itemId);
    const raisedOn = patch.raisedOn ?? current.raisedOn;
    const dueOn = patch.dueOn ?? current.dueOn;
    if (dueOn && dueOn < raisedOn) throw badRequest("The due date can't be before the date it was raised");
    if (patch.source && patch.source !== current.source) {
      if (current.complaintId || current.auditId)
        throw badRequest("The source of a non-conformance from a complaint or an audit can't change");
      if (patch.source === "complaint" || patch.source === "audit")
        throw badRequest("Raise it from the complaint or the audit instead");
    }
    const set: Partial<NonconformanceRow> = { ...patch };
    if (lotId && !itemId) set.itemId = (await itemOfLot(tx, lotId)) ?? null;
    const status = patch.status ?? current.status;
    const action = patch.correctiveAction !== undefined ? patch.correctiveAction : current.correctiveAction;
    if (status === "action_taken" && !action)
      throw badRequest("Record the corrective action before marking it taken");
    if (status === "action_taken" && current.status !== "action_taken") {
      set.actionTakenAt = new Date();
      set.actionTakenBy = actorId;
    }
    // Back to open: the action wasn't enough, so it is no longer "taken".
    if (status === "open" && current.status === "action_taken") {
      set.actionTakenAt = null;
      set.actionTakenBy = null;
    }
    const [row] = await tx
      .update(qualityNonconformances)
      .set(set)
      .where(eq(qualityNonconformances.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [ncChange(row!)]);
    if (row!.ownerUserId !== current.ownerUserId) {
      notified = await notifyNonconformanceAssigned(tx, workspaceId, actorId, row!);
    }
    return getNonconformance(tx, workspaceId, id, today);
  });
  void deliverNotifications(db, notified);
  return updated;
}

/**
 * Verifying the action worked: a manager in person, once the action is taken and its root cause
 * known. Four-eyes: not whoever marked the action taken, unless they are the only manager
 * (`canVerifyNonconformance`). `active` is the environment's active modules.
 */
export async function closeNonconformance(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  verificationNote: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findNonconformance(tx, workspaceId, id);
    if (current.status === "closed")
      throw new ApiError(409, "already_closed", "This non-conformance is already closed");
    if (current.status !== "action_taken")
      throw new ApiError(409, "action_not_taken", "Mark the corrective action as taken before verifying it");
    if (!current.rootCause) throw badRequest("Record the root cause before closing");
    const managerIds = audience(await memberAccess(tx, workspaceId, active), "quality", "manage");
    if (!canVerifyNonconformance({ actionTakenBy: current.actionTakenBy, verifierId: actorId, managerIds }))
      throw new ApiError(
        403,
        "four_eyes",
        "You marked the action as taken, so someone else with manage access to quality must verify it",
      );
    const [row] = await tx
      .update(qualityNonconformances)
      .set({ status: "closed", closedAt: new Date(), closedBy: actorId, verificationNote })
      .where(eq(qualityNonconformances.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [ncChange(row!)]);
    return getNonconformance(tx, workspaceId, id);
  });
}

export async function reopenNonconformance(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findNonconformance(tx, workspaceId, id);
    if (current.status !== "closed")
      throw new ApiError(409, "not_closed", "Only a closed non-conformance can be reopened");
    const [row] = await tx
      .update(qualityNonconformances)
      .set({
        status: "open",
        closedAt: null,
        closedBy: null,
        verificationNote: null,
        actionTakenAt: null,
        actionTakenBy: null,
        reopenedAt: new Date(),
        reopenReason: reason,
      })
      .where(eq(qualityNonconformances.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [ncChange(row!)]);
    return getNonconformance(tx, workspaceId, id);
  });
}

// ─── Internal audits ─────────────────────────────────────────────────────────

export const auditChange = (row: AuditRow): ChangeInput => ({
  entity: "quality_audit",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function auditViews(db: Executor, rows: AuditRow[], today: string) {
  const names = await loadNames(db, {
    userIds: rows.flatMap((r) => [r.auditorUserId, r.completedBy, r.cancelledBy]),
  });
  const ids = rows.map((r) => r.id);
  const findingRows = ids.length
    ? await db
        .select({
          auditId: qualityNonconformances.auditId,
          status: qualityNonconformances.status,
          n: count(),
        })
        .from(qualityNonconformances)
        .where(and(inArray(qualityNonconformances.auditId, ids), isNull(qualityNonconformances.deletedAt)))
        .groupBy(qualityNonconformances.auditId, qualityNonconformances.status)
    : [];
  const findings = new Map<string, { total: number; open: number }>();
  for (const f of findingRows) {
    if (!f.auditId) continue;
    const entry = findings.get(f.auditId) ?? { total: 0, open: 0 };
    entry.total += f.n;
    if (f.status !== "closed") entry.open += f.n;
    findings.set(f.auditId, entry);
  }
  return rows.map((row) => ({
    ...strip(row),
    state: auditState(row, today),
    auditor: names.user(row.auditorUserId),
    completedByName: names.user(row.completedBy)?.name ?? null,
    cancelledByName: names.user(row.cancelledBy)?.name ?? null,
    findings: findings.get(row.id) ?? { total: 0, open: 0 },
  }));
}

export async function listAudits(db: Database, workspaceId: string, query: AuditListQuery, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const t = qualityAudits;
  const where: (SQL | undefined)[] = [eq(t.workspaceId, workspaceId), isNull(t.deletedAt)];
  if (query.status !== "all") where.push(eq(t.status, query.status));
  if (query.from) where.push(gte(t.plannedOn, query.from));
  if (query.to) where.push(lte(t.plannedOn, query.to));
  if (query.q) where.push(or(ilike(t.reference, query.q), ilike(t.title, query.q), ilike(t.scope, query.q)));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.plannedOn), desc(t.reference))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(t)
      .where(and(...where)),
  ]);
  return {
    audits: await auditViews(db, rows, today),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findAudit(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(qualityAudits)
    .where(
      and(
        eq(qualityAudits.id, id),
        eq(qualityAudits.workspaceId, workspaceId),
        isNull(qualityAudits.deletedAt),
      ),
    );
  if (!row) throw notFound("Audit");
  return row;
}

export async function getAudit(db: Executor, workspaceId: string, id: string, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const row = await findAudit(db, workspaceId, id);
  const [view] = await auditViews(db, [row], today);
  const ncs = await db
    .select()
    .from(qualityNonconformances)
    .where(and(eq(qualityNonconformances.auditId, id), isNull(qualityNonconformances.deletedAt)))
    .orderBy(asc(qualityNonconformances.reference));
  return { ...view!, nonconformances: ncs.map((nc) => ncSummary(nc, today)) };
}

export async function createAudit(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: AuditCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { id, ...fields } = input;
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertLinks(tx, workspaceId, { userIds: [fields.auditorUserId] });
    const reference = await nextReference(
      tx,
      qualityAudits,
      workspaceId,
      qualityReferencePrefixes.audit,
      fields.plannedOn,
    );
    const [row] = await tx
      .insert(qualityAudits)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId, reference, createdBy: actorId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [auditChange(row!)]);
    return getAudit(tx, workspaceId, row!.id, today);
  });
}

const auditNotPlanned = () => new ApiError(409, "audit_not_planned", "Only a planned audit can be changed");

export async function updateAudit(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: AuditUpdateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findAudit(tx, workspaceId, id);
    if (current.status !== "planned") throw auditNotPlanned();
    await assertLinks(tx, workspaceId, { userIds: [changed(patch.auditorUserId, current.auditorUserId)] });
    const set: Partial<AuditRow> = { ...patch };
    // One auditor: naming a member clears the outside name, and the other way round.
    if (patch.auditorUserId) set.auditorName = null;
    if (patch.auditorName) set.auditorUserId = null;
    const [row] = await tx.update(qualityAudits).set(set).where(eq(qualityAudits.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [auditChange(row!)]);
    return getAudit(tx, workspaceId, id, today);
  });
}

/**
 * Records the outcome, in person: the member auditor, or someone with `manage`, who heads quality
 * and records an outside auditor's audit (`canCompleteAudit`). Each finding becomes a
 * non-conformance in the same transaction.
 */
export async function completeAudit(
  db: Database,
  workspaceId: string,
  actor: { userId: string; level: ModuleAccessLevel | undefined },
  id: string,
  input: AuditCompleteInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const actorId = actor.userId;
  notInFuture(input.completedOn, "completedOn", today);
  const notified: NotificationRow[] = [];
  const completed = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findAudit(tx, workspaceId, id);
    if (current.status !== "planned") throw auditNotPlanned();
    if (!canCompleteAudit(current, actor))
      throw new ApiError(
        403,
        "not_auditor",
        current.auditorUserId
          ? "Only the audit's auditor, or someone with manage access to quality, can sign it off"
          : "Someone with manage access to quality signs off an audit by an outside auditor",
      );
    if (input.findings.some((f) => f.dueOn && f.dueOn < input.completedOn))
      throw badRequest("A finding can't be due before the audit was completed");
    await assertLinks(tx, workspaceId, { userIds: input.findings.map((f) => f.ownerUserId) });
    const [row] = await tx
      .update(qualityAudits)
      .set({
        status: "completed",
        completedOn: input.completedOn,
        summary: input.summary,
        completedBy: actorId,
        completedAt: new Date(),
      })
      .where(eq(qualityAudits.id, id))
      .returning();
    const changes: ChangeInput[] = [auditChange(row!)];
    // Each insert is visible to the next reference lookup in this transaction.
    for (const finding of input.findings) {
      const nc = await insertNonconformance(
        tx,
        workspaceId,
        actorId,
        findingFields(finding, id, input.completedOn),
      );
      changes.push(ncChange(nc));
      notified.push(...(await notifyNonconformanceAssigned(tx, workspaceId, actorId, nc)));
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return getAudit(tx, workspaceId, id, today);
  });
  void deliverNotifications(db, notified);
  return completed;
}

const findingFields = (finding: AuditFindingInput, auditId: string, raisedOn: string) => ({
  raisedOn,
  source: "audit" as const,
  severity: finding.severity,
  title: finding.title,
  description: finding.description,
  auditId,
  correctiveAction: finding.correctiveAction ?? null,
  ownerUserId: finding.ownerUserId ?? null,
  dueOn: finding.dueOn ?? null,
});

export async function cancelAudit(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findAudit(tx, workspaceId, id);
    if (current.status !== "planned") throw auditNotPlanned();
    const [row] = await tx
      .update(qualityAudits)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: actorId, cancelReason: reason })
      .where(eq(qualityAudits.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [auditChange(row!)]);
    return getAudit(tx, workspaceId, id, today);
  });
}

/** Only a planned audit with no findings: anything else is on the record. */
export async function deleteAudit(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findAudit(tx, workspaceId, id);
    if (current.status !== "planned") throw auditNotPlanned();
    const [finding] = await tx
      .select({ id: qualityNonconformances.id })
      .from(qualityNonconformances)
      .where(eq(qualityNonconformances.auditId, id))
      .limit(1);
    if (finding) throw new ApiError(409, "audit_has_findings", "This audit has findings; cancel it instead");
    await tx.update(qualityAudits).set({ deletedAt: new Date() }).where(eq(qualityAudits.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "quality_audit", entityId: id, action: "delete" },
    ]);
  });
}

// ─── Mock recall tests ───────────────────────────────────────────────────────

const recallChange = (row: RecallTestRow): ChangeInput => ({
  entity: "quality_recall_test",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function recallViews(db: Executor, rows: RecallTestRow[]) {
  const names = await loadNames(db, {
    lotIds: rows.map((r) => r.lotId),
    userIds: rows.flatMap((r) => [r.recordedBy, r.voidedBy]),
  });
  return rows.map((row) => ({
    ...strip(row),
    lot: names.lot(row.lotId),
    recordedByName: names.user(row.recordedBy)?.name ?? null,
    voidedByName: names.user(row.voidedBy)?.name ?? null,
  }));
}

export async function listRecallTests(db: Database, workspaceId: string, query: RecallTestListQuery) {
  const t = qualityRecallTests;
  const where: (SQL | undefined)[] = [eq(t.workspaceId, workspaceId), isNull(t.deletedAt)];
  if (query.lotId) where.push(eq(t.lotId, query.lotId));
  if (query.includeVoided !== "true") where.push(isNull(t.voidedAt));
  if (query.q) where.push(or(ilike(t.reference, query.q), ilike(t.scenario, query.q)));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.conductedOn), desc(t.reference))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(t)
      .where(and(...where)),
  ]);
  return {
    recallTests: await recallViews(db, rows),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findRecallTest(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(qualityRecallTests)
    .where(
      and(
        eq(qualityRecallTests.id, id),
        eq(qualityRecallTests.workspaceId, workspaceId),
        isNull(qualityRecallTests.deletedAt),
      ),
    );
  if (!row) throw notFound("Recall test");
  return row;
}

export async function getRecallTest(db: Executor, workspaceId: string, id: string) {
  return (await recallViews(db, [await findRecallTest(db, workspaceId, id)]))[0]!;
}

/** A person's record of the exercise; the result is worked out here, once, and never changes. */
export async function createRecallTest(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: RecallTestCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { id, ...fields } = input;
  notInFuture(fields.conductedOn, "conductedOn", today);
  if (new Date(fields.completedAt).getTime() > Date.now() + 60_000)
    throw badRequest("completedAt can't be in the future");
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [lot] = await tx
      .select({ id: stockLots.id, unit: items.unit })
      .from(stockLots)
      .innerJoin(items, eq(items.id, stockLots.itemId))
      .where(
        and(
          eq(stockLots.id, fields.lotId),
          eq(stockLots.workspaceId, workspaceId),
          isNull(stockLots.deletedAt),
        ),
      );
    if (!lot) throw badRequest("Unknown lotId");
    const result = recallTestResult(fields);
    const reference = await nextReference(
      tx,
      qualityRecallTests,
      workspaceId,
      qualityReferencePrefixes.recallTest,
      fields.conductedOn,
    );
    const [row] = await tx
      .insert(qualityRecallTests)
      .values({
        ...fields,
        ...(id ? { id } : {}),
        workspaceId,
        reference,
        startedAt: new Date(fields.startedAt),
        completedAt: new Date(fields.completedAt),
        unit: lot.unit,
        durationMinutes: result.durationMinutes,
        reconciledPercent: result.reconciledPercent,
        passed: result.passed,
        recordedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [recallChange(row!)]);
    return getRecallTest(tx, workspaceId, row!.id);
  });
}

export async function voidRecallTest(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findRecallTest(tx, workspaceId, id);
    if (current.voidedAt) throw new ApiError(409, "already_voided", "This recall test is already voided");
    const [row] = await tx
      .update(qualityRecallTests)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: reason })
      .where(eq(qualityRecallTests.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [recallChange(row!)]);
    return getRecallTest(tx, workspaceId, id);
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────────

/** What needs attention: open complaints and non-conformances, audits due, and the yearly recall test. */
export async function qualitySummary(db: Database, workspaceId: string, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const yearAgo = addMonthsIso(today, -12);
  const monthAgo = addDaysIso(today, -30);
  const c = qualityComplaints;
  const n = qualityNonconformances;
  const a = qualityAudits;
  const r = qualityRecallTests;
  const [
    complaintStatus,
    complaintsByCategory,
    recentComplaints,
    ncRows,
    auditRows,
    completedAudits,
    [lastTest],
    [lastPassedTest],
  ] = await Promise.all([
    db
      .select({ status: c.status, n: count() })
      .from(c)
      .where(and(eq(c.workspaceId, workspaceId), isNull(c.deletedAt)))
      .groupBy(c.status),
    db
      .select({ category: c.category, n: count() })
      .from(c)
      .where(and(eq(c.workspaceId, workspaceId), isNull(c.deletedAt), gte(c.receivedOn, yearAgo)))
      .groupBy(c.category),
    db
      .select({ n: count() })
      .from(c)
      .where(and(eq(c.workspaceId, workspaceId), isNull(c.deletedAt), gte(c.receivedOn, monthAgo))),
    db
      .select({ status: n.status, dueOn: n.dueOn })
      .from(n)
      .where(and(eq(n.workspaceId, workspaceId), isNull(n.deletedAt), ne(n.status, "closed"))),
    db
      .select()
      .from(a)
      .where(and(eq(a.workspaceId, workspaceId), isNull(a.deletedAt), eq(a.status, "planned")))
      .orderBy(asc(a.plannedOn), asc(a.reference)),
    db
      .select({ n: count() })
      .from(a)
      .where(
        and(
          eq(a.workspaceId, workspaceId),
          isNull(a.deletedAt),
          eq(a.status, "completed"),
          gte(a.completedOn, yearAgo),
        ),
      ),
    db
      .select({ id: r.id, reference: r.reference, conductedOn: r.conductedOn, passed: r.passed })
      .from(r)
      .where(and(eq(r.workspaceId, workspaceId), isNull(r.deletedAt), isNull(r.voidedAt)))
      .orderBy(desc(r.conductedOn), desc(r.reference))
      .limit(1),
    // On its own: however many failed re-runs came after it, the last pass sets the schedule.
    db
      .select({ id: r.id, reference: r.reference, conductedOn: r.conductedOn, passed: r.passed })
      .from(r)
      .where(and(eq(r.workspaceId, workspaceId), isNull(r.deletedAt), isNull(r.voidedAt), eq(r.passed, true)))
      .orderBy(desc(r.conductedOn), desc(r.reference))
      .limit(1),
  ]);
  const statusCount = (s: string) => complaintStatus.find((x) => x.status === s)?.n ?? 0;
  const states = auditRows.map((row) => ({ row, state: auditState(row, today) }));
  // The yearly test is a passing one: a failed test is repeated.
  const lastPassed = lastPassedTest ?? null;
  const schedule = recallTestSchedule(lastPassed?.conductedOn ?? null, today);
  const next = states.find((s) => s.state !== "overdue")?.row ?? null;
  return {
    today,
    complaints: {
      open: statusCount("open"),
      investigating: statusCount("investigating"),
      receivedLast30Days: recentComplaints[0]?.n ?? 0,
      byCategoryLast12Months: complaintsByCategory
        .map((x) => ({ category: x.category, count: x.n }))
        .sort((x, y) => y.count - x.count),
    },
    nonconformances: {
      open: ncRows.filter((x) => x.status === "open").length,
      awaitingVerification: ncRows.filter((x) => x.status === "action_taken").length,
      overdue: ncRows.filter((x) => isNonconformanceOverdue(x, today)).length,
    },
    audits: {
      overdue: states.filter((s) => s.state === "overdue").length,
      soon: states.filter((s) => s.state === "soon").length,
      completedLast12Months: completedAudits[0]?.n ?? 0,
      next: next
        ? { id: next.id, reference: next.reference, title: next.title, plannedOn: next.plannedOn }
        : null,
    },
    recallTest: {
      last: lastTest ?? null,
      lastPassed,
      dueOn: schedule.dueOn,
      state: schedule.state,
    },
  };
}
