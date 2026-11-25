import {
  activityNeedsAction,
  actionableDueStates,
  changeoverAllergenRisk,
  pestTrendSeries,
  compareDueStates,
  checkOutcome,
  checkSignOffLabels,
  checkAwaitsSignOff,
  ccpLogReviewStatusLabels,
  describeFrequency,
  describeStorageLimits,
  describeStorageReading,
  evaluateStorageReading,
  glassConditionNeedsAction,
  highestActivity,
  initialReviewStatus,
  endOfDayInZone,
  startOfDayInZone,
  todayInZone,
  nextVisitState,
  reviewStatusFor,
  siteCheckDueState,
  siteDueReasonLabels,
  sortSiteDueItems,
  storageMeasureDefaultUnits,
  storageUnitOf,
  type CheckSignOffInput,
  type ChecklistCheckCorrectInput,
  type ChecklistCheckCreateInput,
  type ChecklistCheckListQuery,
  type ChecklistTemplateCreateInput,
  type ChecklistTemplateListQuery,
  type ChecklistTemplateUpdateInput,
  type DueState,
  type AllergenRollup,
  type ChangeoverRiskQuery,
  type ModuleId,
  type PestTrendFinding,
  type PestTrendQuery,
  type GlassBreakageCreateInput,
  type GlassBreakageListQuery,
  type GlassBreakageReleaseInput,
  type GlassBreakageUpdateInput,
  type GlassCheckCorrectInput,
  type GlassCheckListQuery,
  type GlassChecksCreateInput,
  type GlassItemCreateInput,
  type GlassItemListQuery,
  type GlassItemUpdateInput,
  type PestDeviceCreateInput,
  type PestDeviceListQuery,
  type PestDeviceUpdateInput,
  type PestFindingInput,
  type PestVisitCorrectInput,
  type PestVisitCreateInput,
  type PestVisitListQuery,
  type SiteActionCloseInput,
  type SiteActionCreateInput,
  type SiteActionListQuery,
  type SiteActionUpdateInput,
  type SiteDueItem,
  type SiteDueQuery,
  type SiteFrequency,
  type SiteSource,
  type StorageReadingBulkReviewInput,
  type StorageReadingCorrectInput,
  type StorageReadingCreateInput,
  type StorageReadingListQuery,
  type StorageReadingReviewInput,
  type StorageUnitCreateInput,
  type StorageUnitListQuery,
  type StorageUnitUpdateInput,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  productionBatches,
  recipeVersions,
  recordChanges,
  siteChecklistCheckItems,
  siteChecklistChecks,
  siteChecklistItems,
  siteChecklistTemplates,
  siteCorrectiveActions,
  siteGlassBreakages,
  siteGlassChecks,
  siteGlassItems,
  sitePestDevices,
  sitePestFindings,
  sitePestVisits,
  siteStorageReadings,
  siteStorageUnits,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { assertArea, listAreas as listRegisterAreas } from "./ports/assets";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceTimeZone } from "./time-zone";
import { deliverNotifications, notifyReadingOutOfLimit, type NotificationRow } from "./notifications";
import { findBatch, userNames } from "./ports/production";

import {
  FUTURE_SKEW_MS,
  strip,
  stripSoft,
  change,
  nameOf,
  frequencyOf,
  momentOf,
  page,
  areasById,
  areaOf,
  assertFourEyes,
} from "./operation-records";
import { maintenanceCounts, maintenanceDueItems } from "./maintenance";

/**
 * Site programmes module (`site`): pest control, the glass and brittle plastics register,
 * storage temperature logging, and pre-start and allergen changeover checks.
 *
 * - Records are **append-only**: visits, glass checks, storage readings and
 *   checks are never updated or deleted, except one-time stamps (a reading's review or a check's sign-off). A correction is a new row that
 *   points at the one it corrects; the corrected one no longer counts.
 * - **Sign-offs** (reviewing readings, signing off a check, releasing an area after a breakage,
 *   closing a corrective action) are a person with `manage`; the routes
 *   enforce that and refuse API tokens. The service only stamps.
 * - **API tokens** may enter data: pest visits, storage readings (held pending review), raising a
 *   breakage, corrective actions, and the registers. A storage reading outside its unit's limits
 *   opens a corrective action in the same transaction, whoever recorded it.
 * - Areas are rows of the Assets register. Maintenance contributes to the due overview when readable.
 * - **What's due** is computed on read from the frequencies and the last records.
 *
 * Nothing is in the bootstrap; every write goes to the sync log, filtered by module access.
 */

type DeviceRow = typeof sitePestDevices.$inferSelect;
type VisitRow = typeof sitePestVisits.$inferSelect;
type FindingRow = typeof sitePestFindings.$inferSelect;
type GlassItemRow = typeof siteGlassItems.$inferSelect;
type GlassCheckRow = typeof siteGlassChecks.$inferSelect;
type BreakageRow = typeof siteGlassBreakages.$inferSelect;
type UnitRow = typeof siteStorageUnits.$inferSelect;
type ReadingRow = typeof siteStorageReadings.$inferSelect;
type ActionRow = typeof siteCorrectiveActions.$inferSelect;
type TemplateRow = typeof siteChecklistTemplates.$inferSelect;
type TemplateItemRow = typeof siteChecklistItems.$inferSelect;
type CheckRow = typeof siteChecklistChecks.$inferSelect;
type CheckItemRow = typeof siteChecklistCheckItems.$inferSelect;

/** The review stamp a new reading starts with: a person's own entry is approved by them; a token's waits. */
function reviewOnEntry(source: SiteSource, actorId: string, at: Date) {
  const reviewStatus = initialReviewStatus(source);
  return reviewStatus === "approved"
    ? { reviewStatus, reviewedBy: actorId, reviewedAt: at }
    : { reviewStatus, reviewedBy: null, reviewedAt: null };
}

// ─── Areas (the asset register) ──────────────────────────────────────────────

/** Live areas of the asset register: where devices, items, assets, units and checklists are. */
export async function listAreas(db: Database, workspaceId: string) {
  return { areas: await listRegisterAreas(db, workspaceId) };
}

/** `code` must be free among live rows of a table that has `workspaceId`, `code` and `deletedAt`. */
async function assertCodeFree(
  tx: Executor,
  table: typeof sitePestDevices | typeof siteStorageUnits,
  workspaceId: string,
  code: string,
  what: string,
  exceptId?: string,
) {
  const [taken] = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.workspaceId, workspaceId),
        isNull(table.deletedAt),
        sql`lower(${table.code}) = lower(${code})`,
        exceptId ? ne(table.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another ${what} uses the code "${code}"`);
}

// ─── Pest control ────────────────────────────────────────────────────────────

const notCorrectedVisit = sql`not exists (select 1 from ${sitePestVisits} c where c.corrects_visit_id = ${sitePestVisits.id})`;

async function findDevice(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(sitePestDevices)
    .where(
      and(
        eq(sitePestDevices.id, id),
        eq(sitePestDevices.workspaceId, workspaceId),
        isNull(sitePestDevices.deletedAt),
      ),
    );
  if (!row) throw notFound("Pest control device");
  return row;
}

/** The latest finding at each device (from visits that no correction replaced). */
async function lastFindings(db: Executor, workspaceId: string, deviceIds: string[]) {
  if (deviceIds.length === 0)
    return new Map<
      string,
      { activity: string; pest: string | null; count: number | null; visitedOn: string; visitId: string }
    >();
  const rows = await db
    .selectDistinctOn([sitePestFindings.deviceId], {
      deviceId: sitePestFindings.deviceId,
      activity: sitePestFindings.activity,
      pest: sitePestFindings.pest,
      count: sitePestFindings.count,
      visitedOn: sitePestVisits.visitedOn,
      visitId: sitePestVisits.id,
    })
    .from(sitePestFindings)
    .innerJoin(sitePestVisits, eq(sitePestVisits.id, sitePestFindings.visitId))
    .where(
      and(
        eq(sitePestFindings.workspaceId, workspaceId),
        inArray(sitePestFindings.deviceId, deviceIds),
        notCorrectedVisit,
      ),
    )
    .orderBy(
      sitePestFindings.deviceId,
      desc(sitePestVisits.visitedOn),
      desc(sitePestVisits.createdAt),
      desc(sitePestVisits.id),
    );
  return new Map(rows.map((r) => [r.deviceId!, r]));
}

export async function listPestDevices(db: Database, workspaceId: string, query: PestDeviceListQuery) {
  const where: (SQL | undefined)[] = [
    eq(sitePestDevices.workspaceId, workspaceId),
    isNull(sitePestDevices.deletedAt),
  ];
  if (query.status !== "all") where.push(eq(sitePestDevices.status, query.status));
  const rows = await db
    .select()
    .from(sitePestDevices)
    .where(and(...where))
    .orderBy(asc(sitePestDevices.code), asc(sitePestDevices.id));
  return { devices: await describeDevices(db, workspaceId, rows) };
}

async function describeDevices(db: Executor, workspaceId: string, rows: DeviceRow[]) {
  const [areas, last] = await Promise.all([
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    lastFindings(
      db,
      workspaceId,
      rows.map((r) => r.id),
    ),
  ]);
  return rows.map((row) => ({
    ...stripSoft(row),
    area: areaOf(areas, row.areaId),
    lastFinding: last.get(row.id) ?? null,
  }));
}

export async function createPestDevice(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: PestDeviceCreateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertCodeFree(tx, sitePestDevices, workspaceId, input.code, "pest control device");
    if (input.areaId) await assertArea(tx, workspaceId, input.areaId);
    const { id, ...fields } = input;
    const [created] = await tx
      .insert(sitePestDevices)
      .values({ ...(id ? { id } : {}), ...fields, workspaceId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_pest_device", created!)]);
    return created!;
  });
  return (await describeDevices(db, workspaceId, [row]))[0]!;
}

export async function updatePestDevice(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: PestDeviceUpdateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findDevice(tx, workspaceId, id);
    if (patch.code)
      await assertCodeFree(tx, sitePestDevices, workspaceId, patch.code, "pest control device", id);
    if (patch.areaId) await assertArea(tx, workspaceId, patch.areaId);
    const [updated] = await tx
      .update(sitePestDevices)
      .set(patch)
      .where(eq(sitePestDevices.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_pest_device", updated!)]);
    return updated!;
  });
  return (await describeDevices(db, workspaceId, [row]))[0]!;
}

async function describeVisits(db: Executor, rows: VisitRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [findings, corrections, names] = await Promise.all([
    db
      .select({ finding: sitePestFindings, device: sitePestDevices })
      .from(sitePestFindings)
      .leftJoin(sitePestDevices, eq(sitePestDevices.id, sitePestFindings.deviceId))
      .where(inArray(sitePestFindings.visitId, ids))
      .orderBy(asc(sitePestFindings.createdAt), asc(sitePestFindings.id)),
    db
      .select({ id: sitePestVisits.id, correctsVisitId: sitePestVisits.correctsVisitId })
      .from(sitePestVisits)
      .where(inArray(sitePestVisits.correctsVisitId, ids)),
    userNames(
      db,
      rows.map((r) => r.recordedBy),
    ),
  ]);
  const correctedBy = new Map(corrections.map((c) => [c.correctsVisitId!, c.id]));
  return rows.map((row) => {
    const own = findings.filter((f) => f.finding.visitId === row.id);
    return {
      ...strip(row),
      recordedByName: nameOf(names, row.recordedBy),
      correctedByVisitId: correctedBy.get(row.id) ?? null,
      highestActivity: highestActivity(own.map((f) => f.finding)),
      findings: own.map(({ finding, device }) => ({
        ...strip(finding),
        device: device
          ? { id: device.id, code: device.code, kind: device.kind, location: device.location }
          : null,
      })),
    };
  });
}

/**
 * Findings of the visits in a range that no correction replaced, as sightings over time per
 * device, area or pest (`pestTrendSeries`).
 */
export async function getPestTrends(db: Database, workspaceId: string, query: PestTrendQuery) {
  const where: (SQL | undefined)[] = [eq(sitePestVisits.workspaceId, workspaceId), notCorrectedVisit];
  // Visit dates are calendar dates, compared as such.
  if (query.from) where.push(gte(sitePestVisits.visitedOn, query.from));
  if (query.to) where.push(sql`${sitePestVisits.visitedOn} <= ${query.to}`);
  const rows = await db
    .select({
      visitedOn: sitePestVisits.visitedOn,
      deviceId: sitePestFindings.deviceId,
      location: sitePestFindings.location,
      pest: sitePestFindings.pest,
      activity: sitePestFindings.activity,
      count: sitePestFindings.count,
      deviceCode: sitePestDevices.code,
      deviceLocation: sitePestDevices.location,
      areaId: sitePestDevices.areaId,
    })
    .from(sitePestFindings)
    .innerJoin(sitePestVisits, eq(sitePestVisits.id, sitePestFindings.visitId))
    .leftJoin(sitePestDevices, eq(sitePestDevices.id, sitePestFindings.deviceId))
    .where(and(...where))
    .orderBy(asc(sitePestVisits.visitedOn));
  const areas = await areasById(
    db,
    rows.map((r) => r.areaId),
  );
  const findings: PestTrendFinding[] = rows.map((r) => ({
    ...r,
    areaName: r.areaId ? (areas.get(r.areaId)?.name ?? null) : null,
  }));
  const visitDates = [...new Set(findings.map((f) => f.visitedOn))].sort();
  return {
    groupBy: query.groupBy,
    from: visitDates[0] ?? null,
    to: visitDates.at(-1) ?? null,
    visits: visitDates.length,
    series: pestTrendSeries(findings, query.groupBy),
  };
}

export async function getPestVisit(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(sitePestVisits)
    .where(and(eq(sitePestVisits.id, id), eq(sitePestVisits.workspaceId, workspaceId)));
  if (!row) throw notFound("Pest control visit");
  return (await describeVisits(db, [row]))[0]!;
}

/** Visits, newest first. */
export async function listPestVisits(db: Database, workspaceId: string, query: PestVisitListQuery) {
  const where: (SQL | undefined)[] = [eq(sitePestVisits.workspaceId, workspaceId)];
  if (query.from) where.push(gte(sitePestVisits.visitedOn, query.from));
  if (query.to) where.push(sql`${sitePestVisits.visitedOn} <= ${query.to}`);
  if (query.deviceId) {
    where.push(
      sql`exists (select 1 from ${sitePestFindings} f where f.visit_id = ${sitePestVisits.id} and f.device_id = ${query.deviceId})`,
    );
  }
  if (query.activity) {
    where.push(
      sql`exists (select 1 from ${sitePestFindings} f where f.visit_id = ${sitePestVisits.id} and f.activity in ('moderate', 'high'))`,
    );
  }
  if (!query.includeCorrected) where.push(notCorrectedVisit);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(sitePestVisits)
      .where(and(...where))
      .orderBy(desc(sitePestVisits.visitedOn), desc(sitePestVisits.createdAt), desc(sitePestVisits.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(sitePestVisits)
      .where(and(...where)),
  ]);
  const p = page(await describeVisits(db, rows), total?.n, query);
  return { visits: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

type VisitInput = Omit<PestVisitCreateInput, "id">;

async function insertVisit(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  source: SiteSource,
  input: VisitInput & { id?: string | undefined },
  correction?: { originalId: string; reason: string },
) {
  const timeZone = await workspaceTimeZone(tx, workspaceId);
  if (input.visitedOn > todayInZone(timeZone, Date.now() + FUTURE_SKEW_MS)) {
    throw badRequest("A visit can't be dated in the future");
  }
  const deviceIds = [...new Set(input.findings.map((f) => f.deviceId).filter((d): d is string => !!d))];
  if (deviceIds.length) {
    const found = await tx
      .select({ id: sitePestDevices.id })
      .from(sitePestDevices)
      .where(
        and(
          eq(sitePestDevices.workspaceId, workspaceId),
          isNull(sitePestDevices.deletedAt),
          inArray(sitePestDevices.id, deviceIds),
        ),
      );
    if (found.length !== deviceIds.length) throw notFound("Pest control device");
  }
  const [visit] = await tx
    .insert(sitePestVisits)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId,
      contractor: input.contractor,
      technician: input.technician ?? null,
      visitedOn: input.visitedOn,
      summary: input.summary ?? null,
      recommendations: input.recommendations ?? null,
      actionsTaken: input.actionsTaken ?? null,
      nextVisitOn: input.nextVisitOn ?? null,
      source,
      recordedBy: actorId,
      correctsVisitId: correction?.originalId ?? null,
      correctionReason: correction?.reason ?? null,
    })
    .returning();
  const findings: FindingRow[] = input.findings.length
    ? await tx
        .insert(sitePestFindings)
        .values(
          input.findings.map((f: PestFindingInput) => ({
            workspaceId,
            visitId: visit!.id,
            deviceId: f.deviceId ?? null,
            location: f.location ?? null,
            activity: f.activity,
            pest: f.pest ?? null,
            count: f.count ?? null,
            note: f.note ?? null,
            action: f.action ?? null,
          })),
        )
        .returning()
    : [];
  await recordChanges(tx, workspaceId, actorId, [
    change("site_pest_visit", visit!),
    ...findings.map((f) => change("site_pest_finding", f)),
  ]);
  return visit!.id;
}

/** Records a contractor's visit. API tokens may (an agent entering a service report). */
export async function recordPestVisit(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: PestVisitCreateInput,
  options: { source: SiteSource },
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    return insertVisit(tx, workspaceId, actorId, options.source, input);
  });
  return getPestVisit(db, workspaceId, id);
}

/** Corrects a visit: the whole visit again, pointing at the one it replaces. A person's act (the route). */
export async function correctPestVisit(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PestVisitCorrectInput,
) {
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(sitePestVisits)
      .where(and(eq(sitePestVisits.id, id), eq(sitePestVisits.workspaceId, workspaceId)));
    if (!original) throw notFound("Pest control visit");
    const [already] = await tx
      .select({ id: sitePestVisits.id })
      .from(sitePestVisits)
      .where(eq(sitePestVisits.correctsVisitId, id));
    if (already) throw new ApiError(409, "already_corrected", "This visit has already been corrected");
    const { reason, ...visit } = input;
    return insertVisit(tx, workspaceId, actorId, "manual", visit, { originalId: id, reason });
  });
  return getPestVisit(db, workspaceId, newId);
}

// ─── Glass and brittle plastics ──────────────────────────────────────────────

const notCorrectedGlassCheck = sql`not exists (select 1 from ${siteGlassChecks} c where c.corrects_check_id = ${siteGlassChecks.id})`;

async function findGlassItem(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteGlassItems)
    .where(
      and(
        eq(siteGlassItems.id, id),
        eq(siteGlassItems.workspaceId, workspaceId),
        isNull(siteGlassItems.deletedAt),
      ),
    );
  if (!row) throw notFound("Glass register item");
  return row;
}

/** The latest check of each item (not replaced by a correction). */
async function lastGlassChecks(db: Executor, workspaceId: string, itemIds: string[]) {
  if (itemIds.length === 0) return new Map<string, GlassCheckRow>();
  const rows = await db
    .selectDistinctOn([siteGlassChecks.itemId])
    .from(siteGlassChecks)
    .where(
      and(
        eq(siteGlassChecks.workspaceId, workspaceId),
        inArray(siteGlassChecks.itemId, itemIds),
        notCorrectedGlassCheck,
      ),
    )
    .orderBy(
      siteGlassChecks.itemId,
      desc(siteGlassChecks.checkedAt),
      desc(siteGlassChecks.createdAt),
      desc(siteGlassChecks.id),
    );
  return new Map(rows.map((r) => [r.itemId, r]));
}

async function describeGlassItems(db: Executor, workspaceId: string, rows: GlassItemRow[]) {
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const [areas, last] = await Promise.all([
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    lastGlassChecks(
      db,
      workspaceId,
      rows.map((r) => r.id),
    ),
  ]);
  return rows.map((row) => {
    const check = last.get(row.id) ?? null;
    const frequency = { every: row.checkEvery, unit: row.checkUnit };
    const due = siteCheckDueState({ frequency, lastAt: check?.checkedAt ?? null, timeZone });
    return {
      ...stripSoft(row),
      checkFrequency: frequency,
      frequencyText: describeFrequency({ every: row.checkEvery, unit: row.checkUnit }),
      area: areaOf(areas, row.areaId),
      lastCheck: check
        ? { id: check.id, condition: check.condition, note: check.note, checkedAt: check.checkedAt }
        : null,
      due: row.status === "active" ? due : null,
    };
  });
}

export async function listGlassItems(db: Database, workspaceId: string, query: GlassItemListQuery) {
  const where: (SQL | undefined)[] = [
    eq(siteGlassItems.workspaceId, workspaceId),
    isNull(siteGlassItems.deletedAt),
  ];
  if (query.areaId) where.push(eq(siteGlassItems.areaId, query.areaId));
  if (query.status !== "all") where.push(eq(siteGlassItems.status, query.status));
  const rows = await db
    .select()
    .from(siteGlassItems)
    .where(and(...where))
    .orderBy(asc(siteGlassItems.areaId), asc(siteGlassItems.description), asc(siteGlassItems.id));
  return { items: await describeGlassItems(db, workspaceId, rows) };
}

const glassFrequencyColumns = (f: SiteFrequency | undefined) =>
  f ? { checkEvery: f.every, checkUnit: f.unit } : {};

export async function createGlassItem(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GlassItemCreateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertArea(tx, workspaceId, input.areaId);
    const { id, checkFrequency, ...fields } = input;
    const [created] = await tx
      .insert(siteGlassItems)
      .values({
        ...(id ? { id } : {}),
        ...fields,
        ...glassFrequencyColumns(checkFrequency),
        workspaceId,
      } as typeof siteGlassItems.$inferInsert)
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_glass_item", created!)]);
    return created!;
  });
  return (await describeGlassItems(db, workspaceId, [row]))[0]!;
}

export async function updateGlassItem(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: GlassItemUpdateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findGlassItem(tx, workspaceId, id);
    if (patch.areaId) await assertArea(tx, workspaceId, patch.areaId);
    const { checkFrequency, ...fields } = patch;
    const [updated] = await tx
      .update(siteGlassItems)
      .set({ ...fields, ...glassFrequencyColumns(checkFrequency) })
      .where(eq(siteGlassItems.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_glass_item", updated!)]);
    return updated!;
  });
  return (await describeGlassItems(db, workspaceId, [row]))[0]!;
}

async function describeGlassChecks(db: Executor, rows: GlassCheckRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [items, areas, corrections, names] = await Promise.all([
    db
      .select()
      .from(siteGlassItems)
      .where(inArray(siteGlassItems.id, [...new Set(rows.map((r) => r.itemId))])),
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    db
      .select({ id: siteGlassChecks.id, correctsCheckId: siteGlassChecks.correctsCheckId })
      .from(siteGlassChecks)
      .where(inArray(siteGlassChecks.correctsCheckId, ids)),
    userNames(
      db,
      rows.map((r) => r.recordedBy),
    ),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const correctedBy = new Map(corrections.map((c) => [c.correctsCheckId!, c.id]));
  return rows.map((row) => {
    const item = itemById.get(row.itemId);
    return {
      ...strip(row),
      recordedByName: nameOf(names, row.recordedBy),
      area: areaOf(areas, row.areaId),
      item: item
        ? { id: item.id, kind: item.kind, description: item.description, location: item.location }
        : null,
      correctedByCheckId: correctedBy.get(row.id) ?? null,
    };
  });
}

export async function getGlassCheck(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteGlassChecks)
    .where(and(eq(siteGlassChecks.id, id), eq(siteGlassChecks.workspaceId, workspaceId)));
  if (!row) throw notFound("Glass check");
  return (await describeGlassChecks(db, [row]))[0]!;
}

export async function listGlassChecks(db: Database, workspaceId: string, query: GlassCheckListQuery) {
  const where: (SQL | undefined)[] = [eq(siteGlassChecks.workspaceId, workspaceId)];
  if (query.itemId) where.push(eq(siteGlassChecks.itemId, query.itemId));
  if (query.areaId) where.push(eq(siteGlassChecks.areaId, query.areaId));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(siteGlassChecks.checkedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(siteGlassChecks.checkedAt, endOfDayInZone(query.to, zone!)));
  if (query.problems) where.push(ne(siteGlassChecks.condition, "intact"));
  if (!query.includeCorrected) where.push(notCorrectedGlassCheck);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteGlassChecks)
      .where(and(...where))
      .orderBy(desc(siteGlassChecks.checkedAt), desc(siteGlassChecks.createdAt), desc(siteGlassChecks.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteGlassChecks)
      .where(and(...where)),
  ]);
  const p = page(await describeGlassChecks(db, rows), total?.n, query);
  return { checks: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

/** Records a round of condition checks. A person's attestation (the route refuses tokens). */
export async function recordGlassChecks(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GlassChecksCreateInput,
) {
  const ids = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const wanted = input.checks.map((c) => c.itemId);
    const items = await tx
      .select()
      .from(siteGlassItems)
      .where(
        and(
          eq(siteGlassItems.workspaceId, workspaceId),
          isNull(siteGlassItems.deletedAt),
          inArray(siteGlassItems.id, wanted),
        ),
      );
    if (items.length !== wanted.length) throw notFound("Glass register item");
    const removed = items.find((i) => i.status === "removed");
    if (removed) {
      throw new ApiError(409, "item_removed", `${removed.description} was removed from the register`);
    }
    const itemById = new Map(items.map((i) => [i.id, i]));
    const checkedAt = momentOf(input.checkedAt, new Date());
    const rows = await tx
      .insert(siteGlassChecks)
      .values(
        input.checks.map((c) => ({
          workspaceId,
          itemId: c.itemId,
          areaId: itemById.get(c.itemId)!.areaId,
          condition: c.condition,
          note: c.note ?? null,
          checkedAt,
          recordedBy: actorId,
        })),
      )
      .returning();
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      rows.map((r) => change("site_glass_check", r)),
    );
    return rows.map((r) => r.id);
  });
  const rows = await db
    .select()
    .from(siteGlassChecks)
    .where(and(eq(siteGlassChecks.workspaceId, workspaceId), inArray(siteGlassChecks.id, ids)))
    .orderBy(asc(siteGlassChecks.createdAt), asc(siteGlassChecks.id));
  return { checks: await describeGlassChecks(db, rows) };
}

/** Corrects a check: a new row with the right condition, pointing at the wrong one. A person's act. */
export async function correctGlassCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: GlassCheckCorrectInput,
) {
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(siteGlassChecks)
      .where(and(eq(siteGlassChecks.id, id), eq(siteGlassChecks.workspaceId, workspaceId)));
    if (!original) throw notFound("Glass check");
    const [already] = await tx
      .select({ id: siteGlassChecks.id })
      .from(siteGlassChecks)
      .where(eq(siteGlassChecks.correctsCheckId, id));
    if (already) throw new ApiError(409, "already_corrected", "This check has already been corrected");
    const [row] = await tx
      .insert(siteGlassChecks)
      .values({
        workspaceId,
        itemId: original.itemId,
        areaId: original.areaId,
        condition: input.condition,
        note: input.note ?? null,
        checkedAt: original.checkedAt,
        recordedBy: actorId,
        correctsCheckId: original.id,
        correctionReason: input.reason,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_glass_check", row!)]);
    return row!.id;
  });
  return getGlassCheck(db, workspaceId, newId);
}

// Breakages ---------------------------------------------------------------

async function describeBreakages(db: Executor, rows: BreakageRow[]) {
  if (rows.length === 0) return [];
  const itemIds = [...new Set(rows.map((r) => r.itemId).filter((i): i is string => !!i))];
  const [areas, items, names] = await Promise.all([
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    itemIds.length
      ? db.select().from(siteGlassItems).where(inArray(siteGlassItems.id, itemIds))
      : Promise.resolve([] as GlassItemRow[]),
    userNames(
      db,
      rows.flatMap((r) => [r.raisedBy, r.cleanDownBy, r.releasedBy]),
    ),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  return rows.map((row) => {
    const item = row.itemId ? itemById.get(row.itemId) : undefined;
    return {
      ...strip(row),
      area: areaOf(areas, row.areaId),
      item: item ? { id: item.id, kind: item.kind, description: item.description } : null,
      raisedByName: nameOf(names, row.raisedBy),
      cleanDownByName: nameOf(names, row.cleanDownBy),
      releasedByName: nameOf(names, row.releasedBy),
    };
  });
}

async function findBreakage(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteGlassBreakages)
    .where(and(eq(siteGlassBreakages.id, id), eq(siteGlassBreakages.workspaceId, workspaceId)));
  if (!row) throw notFound("Glass breakage");
  return row;
}

export async function getGlassBreakage(db: Executor, workspaceId: string, id: string) {
  return (await describeBreakages(db, [await findBreakage(db, workspaceId, id)]))[0]!;
}

/** Breakages, open ones first. */
export async function listGlassBreakages(db: Database, workspaceId: string, query: GlassBreakageListQuery) {
  const where: (SQL | undefined)[] = [eq(siteGlassBreakages.workspaceId, workspaceId)];
  if (query.status !== "all") where.push(eq(siteGlassBreakages.status, query.status));
  if (query.areaId) where.push(eq(siteGlassBreakages.areaId, query.areaId));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(siteGlassBreakages.occurredAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(siteGlassBreakages.occurredAt, endOfDayInZone(query.to, zone!)));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteGlassBreakages)
      .where(and(...where))
      .orderBy(
        sql`(${siteGlassBreakages.status} = 'open') desc`,
        desc(siteGlassBreakages.occurredAt),
        desc(siteGlassBreakages.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteGlassBreakages)
      .where(and(...where)),
  ]);
  const p = page(await describeBreakages(db, rows), total?.n, query);
  return { breakages: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

/** Raises a breakage: the area is held until a person releases it. API tokens may raise one. */
export async function createGlassBreakage(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: GlassBreakageCreateInput,
  options: { source: SiteSource },
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertArea(tx, workspaceId, input.areaId);
    if (input.itemId) {
      const item = await findGlassItem(tx, workspaceId, input.itemId);
      if (item.areaId !== input.areaId) throw badRequest("That item is in a different area");
    }
    const now = new Date();
    const [row] = await tx
      .insert(siteGlassBreakages)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        areaId: input.areaId,
        itemId: input.itemId ?? null,
        occurredAt: momentOf(input.occurredAt, now),
        description: input.description,
        quarantined: input.quarantined,
        ...(input.cleanDown ? { cleanDown: input.cleanDown, cleanDownAt: now, cleanDownBy: actorId } : {}),
        source: options.source,
        raisedBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_glass_breakage", row!)]);
    return row!.id;
  });
  return getGlassBreakage(db, workspaceId, id);
}

/** Records what was quarantined and the clean-down while the breakage is open. */
export async function updateGlassBreakage(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: GlassBreakageUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await findBreakage(tx, workspaceId, id);
    if (row.status !== "open") {
      throw new ApiError(409, "breakage_released", "This breakage was released and can't change");
    }
    const { cleanDown, ...fields } = patch;
    const [updated] = await tx
      .update(siteGlassBreakages)
      .set({
        ...fields,
        // Who did the clean-down and when changes only with what was done, not on every edit.
        ...(cleanDown !== undefined && cleanDown !== row.cleanDown
          ? { cleanDown, cleanDownAt: new Date(), cleanDownBy: actorId }
          : {}),
        updatedBy: actorId,
      })
      .where(eq(siteGlassBreakages.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_glass_breakage", updated!)]);
  });
  return getGlassBreakage(db, workspaceId, id);
}

/**
 * Releases the area after a breakage: the sign-off (`manage` and a signed-in person, checked by
 * the route). Needs the clean-down recorded, and a second person: not whoever reported the
 * breakage or recorded the clean-down (unless the only manager). Once; a released breakage never
 * changes.
 */
export async function releaseGlassBreakage(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  input: GlassBreakageReleaseInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await findBreakage(tx, workspaceId, id);
    if (row.status !== "open") {
      throw new ApiError(409, "already_released", "This area has already been released");
    }
    if (!row.cleanDown) {
      throw new ApiError(409, "clean_down_missing", "Record the clean-down before releasing the area");
    }
    await assertFourEyes(
      tx,
      workspaceId,
      active,
      actorId,
      [row.raisedBy, row.cleanDownBy],
      "reported this breakage or recorded its clean-down",
      "site",
    );
    const [updated] = await tx
      .update(siteGlassBreakages)
      .set({
        status: "released",
        releasedAt: new Date(),
        releasedBy: actorId,
        releaseNote: input.note ?? null,
        updatedBy: actorId,
      })
      .where(and(eq(siteGlassBreakages.id, id), eq(siteGlassBreakages.status, "open")))
      .returning();
    if (!updated) throw new ApiError(409, "already_released", "This area has already been released");
    await recordChanges(tx, workspaceId, actorId, [change("site_glass_breakage", updated)]);
  });
  return getGlassBreakage(db, workspaceId, id);
}

// ─── Storage temperatures ────────────────────────────────────────────────────

const notCorrectedReading = sql`not exists (select 1 from ${siteStorageReadings} c where c.corrects_reading_id = ${siteStorageReadings.id})`;
const notRejectedReading = ne(siteStorageReadings.reviewStatus, "rejected");

async function findUnit(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteStorageUnits)
    .where(
      and(
        eq(siteStorageUnits.id, id),
        eq(siteStorageUnits.workspaceId, workspaceId),
        isNull(siteStorageUnits.deletedAt),
      ),
    );
  if (!row) throw notFound("Storage unit");
  return row;
}

/** The latest reading of each unit that counts: not replaced by a correction, not rejected. */
async function lastReadings(db: Executor, workspaceId: string, unitIds: string[]) {
  if (unitIds.length === 0) return new Map<string, ReadingRow>();
  const rows = await db
    .selectDistinctOn([siteStorageReadings.unitId])
    .from(siteStorageReadings)
    .where(
      and(
        eq(siteStorageReadings.workspaceId, workspaceId),
        inArray(siteStorageReadings.unitId, unitIds),
        notCorrectedReading,
        notRejectedReading,
      ),
    )
    .orderBy(
      siteStorageReadings.unitId,
      desc(siteStorageReadings.checkedAt),
      desc(siteStorageReadings.createdAt),
      desc(siteStorageReadings.id),
    );
  return new Map(rows.map((r) => [r.unitId, r]));
}

const unitFrequency = (unit: UnitRow): SiteFrequency => ({
  every: unit.readingEvery,
  unit: unit.readingUnit,
});
const limitsOf = (row: { limitMin: number | null; limitMax: number | null }) => ({
  limitMin: row.limitMin,
  limitMax: row.limitMax,
});

async function describeUnits(db: Executor, workspaceId: string, rows: UnitRow[]) {
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const [areas, last] = await Promise.all([
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    lastReadings(
      db,
      workspaceId,
      rows.map((r) => r.id),
    ),
  ]);
  return rows.map((row) => {
    const reading = last.get(row.id) ?? null;
    return {
      ...stripSoft(row),
      readingFrequency: unitFrequency(row),
      frequencyText: describeFrequency(unitFrequency(row)),
      limitsText: describeStorageLimits(limitsOf(row), row.unit),
      area: areaOf(areas, row.areaId),
      lastReading: reading
        ? {
            id: reading.id,
            value: reading.value,
            text: describeStorageReading(reading.value, reading.unit),
            withinLimits: reading.withinLimits,
            checkedAt: reading.checkedAt,
            reviewStatus: reading.reviewStatus,
          }
        : null,
      due:
        row.status === "active"
          ? siteCheckDueState({ frequency: unitFrequency(row), lastAt: reading?.checkedAt ?? null, timeZone })
          : null,
    };
  });
}

export async function listStorageUnits(db: Database, workspaceId: string, query: StorageUnitListQuery) {
  const where: (SQL | undefined)[] = [
    eq(siteStorageUnits.workspaceId, workspaceId),
    isNull(siteStorageUnits.deletedAt),
  ];
  if (query.kind) where.push(eq(siteStorageUnits.kind, query.kind));
  if (query.measure) where.push(eq(siteStorageUnits.measure, query.measure));
  if (query.status !== "all") where.push(eq(siteStorageUnits.status, query.status));
  const rows = await db
    .select()
    .from(siteStorageUnits)
    .where(and(...where))
    .orderBy(asc(siteStorageUnits.name), asc(siteStorageUnits.id));
  return { units: await describeUnits(db, workspaceId, rows) };
}

const unitFrequencyColumns = (f: SiteFrequency | undefined) =>
  f ? { readingEvery: f.every, readingUnit: f.unit } : {};

export async function createStorageUnit(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StorageUnitCreateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.code) await assertCodeFree(tx, siteStorageUnits, workspaceId, input.code, "storage unit");
    if (input.areaId) await assertArea(tx, workspaceId, input.areaId);
    const { id, readingFrequency, ...fields } = input;
    const [created] = await tx
      .insert(siteStorageUnits)
      .values({
        ...(id ? { id } : {}),
        ...fields,
        // The measure's own unit (°C, %RH, Pa) unless one was given.
        unit: storageUnitOf(input.measure, input.unit),
        ...unitFrequencyColumns(readingFrequency),
        workspaceId,
      } as typeof siteStorageUnits.$inferInsert)
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_storage_unit", created!)]);
    return created!;
  });
  return (await describeUnits(db, workspaceId, [row]))[0]!;
}

/**
 * Edits a unit. New limits apply to readings from then on; readings already recorded keep the
 * limits they were judged against.
 */
export async function updateStorageUnit(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: StorageUnitUpdateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const unit = await findUnit(tx, workspaceId, id);
    if (patch.code) await assertCodeFree(tx, siteStorageUnits, workspaceId, patch.code, "storage unit", id);
    if (patch.areaId) await assertArea(tx, workspaceId, patch.areaId);
    const min = patch.limitMin !== undefined ? patch.limitMin : unit.limitMin;
    const max = patch.limitMax !== undefined ? patch.limitMax : unit.limitMax;
    if (min === null && max === null) throw badRequest("A storage unit needs a minimum, a maximum or both");
    if (min !== null && max !== null && min > max) throw badRequest("The maximum is below the minimum");
    const measure = patch.measure ?? unit.measure;
    if (
      measure === "humidity" &&
      ((min !== null && (min < 0 || min > 100)) || (max !== null && (max < 0 || max > 100)))
    ) {
      throw badRequest("Relative humidity limits are between 0 and 100");
    }
    let unitText = patch.unit;
    if (patch.measure && patch.measure !== unit.measure) {
      // What a unit measures is fixed once it has readings: they would change meaning.
      const [read] = await tx
        .select({ id: siteStorageReadings.id })
        .from(siteStorageReadings)
        .where(eq(siteStorageReadings.unitId, id))
        .limit(1);
      if (read) {
        throw new ApiError(
          409,
          "measure_has_readings",
          "This unit already has readings, so what it measures can't change. Archive it and add a new unit.",
        );
      }
      unitText = patch.unit ?? storageMeasureDefaultUnits[patch.measure] ?? undefined;
      if (!unitText) throw badRequest("Give the unit this measure is read in");
    }
    const { readingFrequency, ...fields } = patch;
    const [updated] = await tx
      .update(siteStorageUnits)
      .set({
        ...fields,
        ...(unitText !== undefined ? { unit: unitText } : {}),
        ...unitFrequencyColumns(readingFrequency),
      })
      .where(eq(siteStorageUnits.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_storage_unit", updated!)]);
    return updated!;
  });
  return (await describeUnits(db, workspaceId, [row]))[0]!;
}

async function describeReadings(db: Executor, rows: ReadingRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [units, corrections, actions, names] = await Promise.all([
    db
      .select()
      .from(siteStorageUnits)
      .where(inArray(siteStorageUnits.id, [...new Set(rows.map((r) => r.unitId))])),
    db
      .select({ id: siteStorageReadings.id, correctsReadingId: siteStorageReadings.correctsReadingId })
      .from(siteStorageReadings)
      .where(inArray(siteStorageReadings.correctsReadingId, ids)),
    db
      .select({
        id: siteCorrectiveActions.id,
        readingId: siteCorrectiveActions.readingId,
        title: siteCorrectiveActions.title,
        status: siteCorrectiveActions.status,
      })
      .from(siteCorrectiveActions)
      .where(and(inArray(siteCorrectiveActions.readingId, ids), isNull(siteCorrectiveActions.deletedAt))),
    userNames(
      db,
      rows.flatMap((r) => [r.recordedBy, r.reviewedBy]),
    ),
  ]);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const correctedBy = new Map(corrections.map((c) => [c.correctsReadingId!, c.id]));
  return rows.map((row) => {
    const unit = unitById.get(row.unitId);
    return {
      ...strip(row),
      readingText: describeStorageReading(row.value, row.unit),
      limitsText: describeStorageLimits(limitsOf(row), row.unit),
      recordedByName: nameOf(names, row.recordedBy),
      reviewedByName: nameOf(names, row.reviewedBy),
      unit: unit ? { id: unit.id, code: unit.code, name: unit.name, kind: unit.kind } : null,
      /** The reading that corrected this one, if any: this reading no longer counts. */
      correctedByReadingId: correctedBy.get(row.id) ?? null,
      correctiveActions: actions.filter((a) => a.readingId === row.id).map(({ readingId: _r, ...a }) => a),
    };
  });
}

export async function getStorageReading(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteStorageReadings)
    .where(and(eq(siteStorageReadings.id, id), eq(siteStorageReadings.workspaceId, workspaceId)));
  if (!row) throw notFound("Storage reading");
  return (await describeReadings(db, [row]))[0]!;
}

/** Storage readings, newest first. */
export async function listStorageReadings(db: Database, workspaceId: string, query: StorageReadingListQuery) {
  const where: (SQL | undefined)[] = [eq(siteStorageReadings.workspaceId, workspaceId)];
  if (query.unitId) where.push(eq(siteStorageReadings.unitId, query.unitId));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(siteStorageReadings.checkedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(siteStorageReadings.checkedAt, endOfDayInZone(query.to, zone!)));
  if (query.outOfLimits !== undefined) where.push(eq(siteStorageReadings.withinLimits, !query.outOfLimits));
  if (query.source) where.push(eq(siteStorageReadings.source, query.source));
  if (query.review) where.push(eq(siteStorageReadings.reviewStatus, query.review));
  if (!query.includeCorrected) where.push(notCorrectedReading);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteStorageReadings)
      .where(and(...where))
      .orderBy(
        desc(siteStorageReadings.checkedAt),
        desc(siteStorageReadings.createdAt),
        desc(siteStorageReadings.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteStorageReadings)
      .where(and(...where)),
  ]);
  const p = page(await describeReadings(db, rows), total?.n, query);
  return { readings: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

/** The corrective action an out-of-limit reading opens. */
function excursionAction(
  workspaceId: string,
  actorId: string,
  source: SiteSource,
  unit: UnitRow,
  reading: ReadingRow,
  details: StorageReadingCreateInput["correctiveAction"],
) {
  return {
    workspaceId,
    title:
      `${unit.name}: ${describeStorageReading(reading.value, reading.unit)} (limit ${describeStorageLimits(limitsOf(reading), reading.unit)})`.slice(
        0,
        200,
      ),
    readingId: reading.id,
    actionTaken: details?.actionTaken ?? null,
    rootCause: details?.rootCause ?? null,
    preventiveAction: details?.preventiveAction ?? null,
    source,
    raisedBy: actorId,
    updatedBy: actorId,
  };
}

/**
 * Records a storage reading and flags it against the unit's limits. An out-of-limit reading opens
 * a corrective action in the same transaction, whoever recorded it: a deviation never waits for
 * review. `source` follows the credential (`api` for an API token: a sensor feed or an agent). A
 * person's reading is approved as they enter it; a token's is `pending` until a person with
 * `manage` reviews it.
 */
export async function recordStorageReading(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StorageReadingCreateInput,
  options: { source: SiteSource },
) {
  let notified: NotificationRow[] = [];
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const unit = await findUnit(tx, workspaceId, input.unitId);
    if (unit.status === "archived") {
      throw new ApiError(
        409,
        "unit_archived",
        `${unit.name} is archived; nothing more is recorded against it`,
      );
    }
    const now = new Date();
    const evaluation = evaluateStorageReading(limitsOf(unit), input.value);
    const [reading] = await tx
      .insert(siteStorageReadings)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        unitId: unit.id,
        value: input.value,
        ...limitsOf(unit),
        unit: unit.unit,
        withinLimits: evaluation.withinLimits,
        deviationReason: evaluation.reason,
        note: input.note ?? null,
        source: options.source,
        checkedAt: momentOf(input.checkedAt, now),
        recordedBy: actorId,
        ...reviewOnEntry(options.source, actorId, now),
      })
      .returning();
    const changes: ChangeInput[] = [change("site_storage_reading", reading!)];
    if (!evaluation.withinLimits) {
      const [action] = await tx
        .insert(siteCorrectiveActions)
        .values(excursionAction(workspaceId, actorId, options.source, unit, reading!, input.correctiveAction))
        .returning();
      changes.push(change("site_corrective_action", action!));
      notified = await notifyReadingOutOfLimit(tx, workspaceId, actorId, "site", {
        id: reading!.id,
        title: action!.title,
      });
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return reading!.id;
  });
  void deliverNotifications(db, notified);
  return getStorageReading(db, workspaceId, id);
}

/**
 * Corrects a reading: a new reading for the same unit and time, judged against the limits the
 * original was, pointing at the one it corrects. A signed-in person only (the route); correcting
 * an out-of-limit reading also needs `manage`, so a deviation can't be quietly written away. A
 * correction that is still out of limits reuses an open corrective action of the chain of
 * corrections back to the original reading, or opens a new one, which notifies managers like an
 * out-of-limit reading (`reading_out_of_limit`, emailed after commit). The correction is a
 * person's own entry, so it is approved as written; a pending reading it replaces leaves the
 * review queue.
 */
export async function correctStorageReading(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: StorageReadingCorrectInput,
  options: { canManage: boolean },
) {
  let notified: NotificationRow[] = [];
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(siteStorageReadings)
      .where(and(eq(siteStorageReadings.id, id), eq(siteStorageReadings.workspaceId, workspaceId)));
    if (!original) throw notFound("Storage reading");
    const [already] = await tx
      .select({ id: siteStorageReadings.id })
      .from(siteStorageReadings)
      .where(eq(siteStorageReadings.correctsReadingId, id));
    if (already) throw new ApiError(409, "already_corrected", "This reading has already been corrected");
    if (!original.withinLimits && !options.canManage) {
      throw new ApiError(
        403,
        "module_forbidden",
        "Correcting an out-of-limit reading needs manage access to the site module",
      );
    }
    const unit = await findUnit(tx, workspaceId, original.unitId);
    const evaluation = evaluateStorageReading(limitsOf(original), input.value);
    const [reading] = await tx
      .insert(siteStorageReadings)
      .values({
        workspaceId,
        unitId: original.unitId,
        value: input.value,
        ...limitsOf(original),
        unit: original.unit,
        withinLimits: evaluation.withinLimits,
        deviationReason: evaluation.reason,
        note: input.note ?? null,
        source: "manual",
        checkedAt: original.checkedAt,
        recordedBy: actorId,
        correctsReadingId: original.id,
        correctionReason: input.reason,
        ...reviewOnEntry("manual", actorId, new Date()),
      })
      .returning();
    const changes: ChangeInput[] = [change("site_storage_reading", reading!)];
    if (!evaluation.withinLimits) {
      const chain = [original.id];
      for (let previous = original.correctsReadingId; previous;) {
        chain.push(previous);
        const [row] = await tx
          .select({ correctsReadingId: siteStorageReadings.correctsReadingId })
          .from(siteStorageReadings)
          .where(eq(siteStorageReadings.id, previous));
        previous = row?.correctsReadingId ?? null;
      }
      const [existing] = await tx
        .select({ id: siteCorrectiveActions.id })
        .from(siteCorrectiveActions)
        // Only an open action carries over: a closed one dealt with the earlier excursion, and a
        // reading that is still out of limits needs something open for a person to close.
        .where(and(inArray(siteCorrectiveActions.readingId, chain), eq(siteCorrectiveActions.status, "open")))
        .limit(1);
      if (!existing) {
        const [action] = await tx
          .insert(siteCorrectiveActions)
          .values(excursionAction(workspaceId, actorId, "manual", unit, reading!, undefined))
          .returning();
        changes.push(change("site_corrective_action", action!));
        // A new excursion: managers hear about it as about a reading recorded out of limits.
        notified = await notifyReadingOutOfLimit(tx, workspaceId, actorId, "site", {
          id: reading!.id,
          title: action!.title,
        });
      }
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return reading!.id;
  });
  void deliverNotifications(db, notified);
  return getStorageReading(db, workspaceId, newId);
}

/**
 * Reviews readings an API token recorded: a person with `manage` (checked by the route) approves
 * or rejects them, all of them or none. Every reading must exist, be `pending` and not have been
 * corrected. A rejected reading no longer counts as done, so the check is due again; a corrective
 * action it opened stays open for a person to close (the excursion may still be real).
 */
export async function reviewStorageReadings(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StorageReadingBulkReviewInput,
) {
  const ids = [...new Set(input.ids)];
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const rows = await tx
      .select()
      .from(siteStorageReadings)
      .where(and(eq(siteStorageReadings.workspaceId, workspaceId), inArray(siteStorageReadings.id, ids)));
    if (rows.length !== ids.length) throw notFound("Storage reading");
    const reviewed = rows.filter((r) => r.reviewStatus !== "pending");
    if (reviewed.length) {
      throw new ApiError(
        409,
        "already_reviewed",
        `A reading is already ${ccpLogReviewStatusLabels[reviewed[0]!.reviewStatus].toLowerCase()}; nothing was reviewed`,
        { ids: reviewed.map((r) => r.id) },
      );
    }
    const corrected = await tx
      .select({ correctsReadingId: siteStorageReadings.correctsReadingId })
      .from(siteStorageReadings)
      .where(inArray(siteStorageReadings.correctsReadingId, ids));
    if (corrected.length) {
      throw new ApiError(
        409,
        "already_corrected",
        "A correction has replaced a reading, so there is nothing to review; nothing was reviewed",
        { ids: corrected.map((r) => r.correctsReadingId) },
      );
    }
    const updated = await tx
      .update(siteStorageReadings)
      .set({
        reviewStatus: reviewStatusFor(input.decision),
        reviewedBy: actorId,
        reviewedAt: new Date(),
        reviewNote: input.note ?? null,
      })
      .where(and(inArray(siteStorageReadings.id, ids), eq(siteStorageReadings.reviewStatus, "pending")))
      .returning();
    if (updated.length !== ids.length) {
      throw new ApiError(409, "already_reviewed", "Someone else reviewed these readings first");
    }
    await recordChanges(
      tx,
      workspaceId,
      actorId,
      updated.map((row) => change("site_storage_reading", row)),
    );
  });
  const rows = await db
    .select()
    .from(siteStorageReadings)
    .where(and(eq(siteStorageReadings.workspaceId, workspaceId), inArray(siteStorageReadings.id, ids)))
    .orderBy(desc(siteStorageReadings.checkedAt), desc(siteStorageReadings.id));
  return { readings: await describeReadings(db, rows), reviewed: rows.length };
}

export async function reviewStorageReading(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: StorageReadingReviewInput,
) {
  await reviewStorageReadings(db, workspaceId, actorId, { ...input, ids: [id] });
  return getStorageReading(db, workspaceId, id);
}

// Corrective actions ----------------------------------------------------------

async function findAction(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteCorrectiveActions)
    .where(
      and(
        eq(siteCorrectiveActions.id, id),
        eq(siteCorrectiveActions.workspaceId, workspaceId),
        isNull(siteCorrectiveActions.deletedAt),
      ),
    );
  if (!row) throw notFound("Corrective action");
  return row;
}

async function describeActions(db: Executor, rows: ActionRow[]) {
  if (rows.length === 0) return [];
  const readingIds = [...new Set(rows.map((r) => r.readingId).filter((i): i is string => !!i))];
  const [readings, names] = await Promise.all([
    readingIds.length
      ? db
          .select({ reading: siteStorageReadings, unit: siteStorageUnits })
          .from(siteStorageReadings)
          .innerJoin(siteStorageUnits, eq(siteStorageUnits.id, siteStorageReadings.unitId))
          .where(inArray(siteStorageReadings.id, readingIds))
      : Promise.resolve([] as { reading: ReadingRow; unit: UnitRow }[]),
    userNames(
      db,
      rows.flatMap((r) => [r.raisedBy, r.updatedBy, r.closedBy]),
    ),
  ]);
  const readingById = new Map(readings.map((r) => [r.reading.id, r]));
  return rows.map((row) => {
    const found = row.readingId ? readingById.get(row.readingId) : undefined;
    return {
      ...stripSoft(row),
      raisedByName: nameOf(names, row.raisedBy),
      closedByName: nameOf(names, row.closedBy),
      reading: found
        ? {
            id: found.reading.id,
            text: describeStorageReading(found.reading.value, found.reading.unit),
            limitsText: describeStorageLimits(limitsOf(found.reading), found.reading.unit),
            checkedAt: found.reading.checkedAt,
            unit: { id: found.unit.id, name: found.unit.name },
          }
        : null,
      /** What a person must still record before closing. */
      missing: missingForClose(row),
    };
  });
}

const missingForClose = (row: Pick<ActionRow, "actionTaken" | "rootCause" | "preventiveAction">) =>
  (
    [
      ["actionTaken", row.actionTaken],
      ["rootCause", row.rootCause],
      ["preventiveAction", row.preventiveAction],
    ] as const
  )
    .filter(([, v]) => !v?.trim())
    .map(([k]) => k);

export async function getSiteAction(db: Executor, workspaceId: string, id: string) {
  return (await describeActions(db, [await findAction(db, workspaceId, id)]))[0]!;
}

export async function listSiteActions(db: Database, workspaceId: string, query: SiteActionListQuery) {
  const where: (SQL | undefined)[] = [
    eq(siteCorrectiveActions.workspaceId, workspaceId),
    isNull(siteCorrectiveActions.deletedAt),
  ];
  if (query.status !== "all") where.push(eq(siteCorrectiveActions.status, query.status));
  if (query.readingId) where.push(eq(siteCorrectiveActions.readingId, query.readingId));
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteCorrectiveActions)
      .where(and(...where))
      .orderBy(
        sql`(${siteCorrectiveActions.status} = 'open') desc`,
        desc(siteCorrectiveActions.createdAt),
        desc(siteCorrectiveActions.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteCorrectiveActions)
      .where(and(...where)),
  ]);
  const p = page(await describeActions(db, rows), total?.n, query);
  return { actions: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

/** Raises a corrective action (a person, or an agent proposing one). */
export async function createSiteAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: SiteActionCreateInput,
  options: { source: SiteSource },
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.readingId) {
      const [reading] = await tx
        .select()
        .from(siteStorageReadings)
        .where(
          and(eq(siteStorageReadings.id, input.readingId), eq(siteStorageReadings.workspaceId, workspaceId)),
        );
      if (!reading) throw notFound("Storage reading");
      if (reading.withinLimits) {
        throw badRequest("That reading was within its limits; there is no excursion to act on");
      }
      // An out-of-limit reading opens its own action; a second open one for it would split the
      // follow-up (an agent proposing an action for a reading it just recorded, for example).
      const [open] = await tx
        .select({ id: siteCorrectiveActions.id })
        .from(siteCorrectiveActions)
        .where(and(eq(siteCorrectiveActions.readingId, reading.id), eq(siteCorrectiveActions.status, "open")))
        .limit(1);
      if (open) {
        throw new ApiError(409, "site_action_exists", "That reading already has an open corrective action", {
          actionId: open.id,
        });
      }
    }
    const [row] = await tx
      .insert(siteCorrectiveActions)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        title: input.title,
        readingId: input.readingId ?? null,
        actionTaken: input.actionTaken ?? null,
        rootCause: input.rootCause ?? null,
        preventiveAction: input.preventiveAction ?? null,
        source: options.source,
        raisedBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_corrective_action", row!)]);
    return row!.id;
  });
  return getSiteAction(db, workspaceId, id);
}

const assertActionOpen = (row: ActionRow) => {
  if (row.status !== "open") {
    throw new ApiError(409, "site_action_closed", "This corrective action is closed and can't change");
  }
};

export async function updateSiteAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: SiteActionUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    assertActionOpen(await findAction(tx, workspaceId, id));
    const [row] = await tx
      .update(siteCorrectiveActions)
      .set({ ...patch, updatedBy: actorId })
      .where(eq(siteCorrectiveActions.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_corrective_action", row!)]);
  });
  return getSiteAction(db, workspaceId, id);
}

/** The sign-off that closes a corrective action: needs all three fields recorded. */
export async function closeSiteAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: SiteActionCloseInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const action = await findAction(tx, workspaceId, id);
    assertActionOpen(action);
    const missing = missingForClose(action);
    if (missing.length) {
      throw new ApiError(
        409,
        "site_action_incomplete",
        "Record what was done, the root cause and the preventive action before closing",
        { missing },
      );
    }
    const [row] = await tx
      .update(siteCorrectiveActions)
      .set({
        status: "closed",
        closedAt: new Date(),
        closedBy: actorId,
        closureNote: input.note ?? null,
        updatedBy: actorId,
      })
      .where(eq(siteCorrectiveActions.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_corrective_action", row!)]);
  });
  return getSiteAction(db, workspaceId, id);
}

// ─── Pre-start and allergen changeover checks ────────────────────────────────

async function findTemplate(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteChecklistTemplates)
    .where(
      and(
        eq(siteChecklistTemplates.id, id),
        eq(siteChecklistTemplates.workspaceId, workspaceId),
        isNull(siteChecklistTemplates.deletedAt),
      ),
    );
  if (!row) throw notFound("Checklist");
  return row;
}

const liveItemsOf = (db: Executor, templateIds: string[]) =>
  templateIds.length
    ? db
        .select()
        .from(siteChecklistItems)
        .where(and(inArray(siteChecklistItems.templateId, templateIds), isNull(siteChecklistItems.deletedAt)))
        .orderBy(asc(siteChecklistItems.sortOrder), asc(siteChecklistItems.id))
    : Promise.resolve([] as TemplateItemRow[]);

const notCorrectedCheck = sql`not exists (select 1 from ${siteChecklistChecks} c where c.corrects_check_id = ${siteChecklistChecks.id})`;
/** A check that counts as done for what's due: replaced by nothing, not held, and passed. */
const countsAsDoneCheck = and(
  notCorrectedCheck,
  ne(siteChecklistChecks.signOffStatus, "rejected"),
  eq(siteChecklistChecks.outcome, "passed"),
);

/** The latest check of each template that counts as done. */
async function lastDoneChecks(db: Executor, workspaceId: string, templateIds: string[]) {
  if (templateIds.length === 0) return new Map<string, CheckRow>();
  const rows = await db
    .selectDistinctOn([siteChecklistChecks.templateId])
    .from(siteChecklistChecks)
    .where(
      and(
        eq(siteChecklistChecks.workspaceId, workspaceId),
        inArray(siteChecklistChecks.templateId, templateIds),
        countsAsDoneCheck,
      ),
    )
    .orderBy(
      siteChecklistChecks.templateId,
      desc(siteChecklistChecks.performedAt),
      desc(siteChecklistChecks.createdAt),
      desc(siteChecklistChecks.id),
    );
  return new Map(rows.map((r) => [r.templateId, r]));
}

const templateFrequency = (t: TemplateRow) => frequencyOf(t.frequencyEvery, t.frequencyUnit);

/** Whether any production batch is in progress (checks made only during production are idle otherwise). */
async function isProducing(db: Executor, workspaceId: string) {
  const [row] = await db
    .select({ id: productionBatches.id })
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
        eq(productionBatches.status, "in_progress"),
      ),
    )
    .limit(1);
  return !!row;
}

async function describeTemplates(db: Executor, workspaceId: string, rows: TemplateRow[]) {
  if (rows.length === 0) return [];
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const ids = rows.map((r) => r.id);
  const [items, areas, last, producing] = await Promise.all([
    liveItemsOf(db, ids),
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    lastDoneChecks(db, workspaceId, ids),
    isProducing(db, workspaceId),
  ]);
  return rows.map((row) => {
    const frequency = templateFrequency(row);
    const lastCheck = last.get(row.id) ?? null;
    return {
      ...stripSoft(row),
      frequency,
      frequencyText: frequency ? describeFrequency(frequency) : null,
      area: areaOf(areas, row.areaId),
      items: items
        .filter((i) => i.templateId === row.id)
        .map((i) => ({ id: i.id, sortOrder: i.sortOrder, prompt: i.prompt, guidance: i.guidance })),
      lastCheck: lastCheck
        ? { id: lastCheck.id, performedAt: lastCheck.performedAt, signOffStatus: lastCheck.signOffStatus }
        : null,
      due:
        row.status === "active" && frequency
          ? siteCheckDueState({
              frequency,
              lastAt: lastCheck?.performedAt ?? null,
              timeZone,
              duringProduction: row.duringProduction,
              producing,
            })
          : null,
    };
  });
}

export async function listChecklistTemplates(
  db: Database,
  workspaceId: string,
  query: ChecklistTemplateListQuery,
) {
  const where: (SQL | undefined)[] = [
    eq(siteChecklistTemplates.workspaceId, workspaceId),
    isNull(siteChecklistTemplates.deletedAt),
  ];
  if (query.kind) where.push(eq(siteChecklistTemplates.kind, query.kind));
  if (query.status !== "all") where.push(eq(siteChecklistTemplates.status, query.status));
  const rows = await db
    .select()
    .from(siteChecklistTemplates)
    .where(and(...where))
    .orderBy(asc(siteChecklistTemplates.name), asc(siteChecklistTemplates.id));
  return { templates: await describeTemplates(db, workspaceId, rows) };
}

export async function getChecklistTemplate(db: Executor, workspaceId: string, id: string) {
  return (await describeTemplates(db, workspaceId, [await findTemplate(db, workspaceId, id)]))[0]!;
}

const templateFrequencyColumns = (f: SiteFrequency | null | undefined) =>
  f === undefined ? {} : { frequencyEvery: f?.every ?? null, frequencyUnit: f?.unit ?? null };

export async function createChecklistTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ChecklistTemplateCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.areaId) await assertArea(tx, workspaceId, input.areaId);
    if (input.duringProduction && !input.frequency) {
      throw badRequest("A check made only during production needs a frequency");
    }
    const { id, items: itemInputs, frequency, ...fields } = input;
    const [template] = await tx
      .insert(siteChecklistTemplates)
      .values({
        ...(id ? { id } : {}),
        ...fields,
        ...templateFrequencyColumns(frequency),
        workspaceId,
      } as typeof siteChecklistTemplates.$inferInsert)
      .returning();
    const items = await tx
      .insert(siteChecklistItems)
      .values(
        itemInputs.map((item, index) => ({
          workspaceId,
          templateId: template!.id,
          sortOrder: index,
          prompt: item.prompt,
          guidance: item.guidance ?? null,
        })),
      )
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      change("site_checklist_template", template!),
      ...items.map((i) => change("site_checklist_item", i)),
    ]);
    return template!.id;
  });
  return getChecklistTemplate(db, workspaceId, id);
}

/**
 * Edits a checklist. Sending `items` replaces the list: items that keep their `id` stay the same
 * item (history follows them), new ones are added and the ones left out are removed. Checks already
 * done keep the wording they were done against.
 */
export async function updateChecklistTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: ChecklistTemplateUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const template = await findTemplate(tx, workspaceId, id);
    if (patch.areaId) await assertArea(tx, workspaceId, patch.areaId);
    const frequency = patch.frequency !== undefined ? patch.frequency : templateFrequency(template);
    const during = patch.duringProduction ?? template.duringProduction;
    if (during && !frequency) throw badRequest("A check made only during production needs a frequency");
    const { items: itemInputs, frequency: freqPatch, ...fields } = patch;
    const changes: ChangeInput[] = [];
    const [updated] = await tx
      .update(siteChecklistTemplates)
      .set({ ...fields, ...templateFrequencyColumns(freqPatch), updatedAt: new Date() })
      .where(eq(siteChecklistTemplates.id, id))
      .returning();
    changes.push(change("site_checklist_template", updated!));
    if (itemInputs) {
      const existing = (await liveItemsOf(tx, [id])).filter((i) => i.templateId === id);
      const byId = new Map(existing.map((i) => [i.id, i]));
      for (const item of itemInputs) {
        if (item.id && !byId.has(item.id)) throw badRequest("An item doesn't belong to this checklist");
      }
      const keep = new Set(itemInputs.map((i) => i.id).filter((i): i is string => !!i));
      for (const gone of existing.filter((i) => !keep.has(i.id))) {
        const [row] = await tx
          .update(siteChecklistItems)
          .set({ deletedAt: new Date() })
          .where(eq(siteChecklistItems.id, gone.id))
          .returning();
        changes.push({ entity: "site_checklist_item", entityId: row!.id, action: "delete" });
      }
      for (const [index, item] of itemInputs.entries()) {
        if (item.id) {
          const [row] = await tx
            .update(siteChecklistItems)
            .set({ sortOrder: index, prompt: item.prompt, guidance: item.guidance ?? null })
            .where(eq(siteChecklistItems.id, item.id))
            .returning();
          changes.push(change("site_checklist_item", row!));
        } else {
          const [row] = await tx
            .insert(siteChecklistItems)
            .values({
              workspaceId,
              templateId: id,
              sortOrder: index,
              prompt: item.prompt,
              guidance: item.guidance ?? null,
            })
            .returning();
          changes.push(change("site_checklist_item", row!));
        }
      }
    }
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getChecklistTemplate(db, workspaceId, id);
}

// Checks --------------------------------------------------------------------

/** The oldest open glass breakage in each of the areas, by area id. */
async function openBreakagesByArea(db: Executor, areaIds: (string | null)[]) {
  const ids = [...new Set(areaIds.filter((a): a is string => !!a))];
  const held = new Map<string, { id: string; description: string; occurredAt: Date }>();
  if (ids.length === 0) return held;
  const rows = await db
    .select({
      id: siteGlassBreakages.id,
      areaId: siteGlassBreakages.areaId,
      description: siteGlassBreakages.description,
      occurredAt: siteGlassBreakages.occurredAt,
    })
    .from(siteGlassBreakages)
    .where(and(inArray(siteGlassBreakages.areaId, ids), eq(siteGlassBreakages.status, "open")))
    .orderBy(asc(siteGlassBreakages.occurredAt), asc(siteGlassBreakages.id));
  for (const r of rows) if (!held.has(r.areaId)) held.set(r.areaId, r);
  return held;
}

/** The allergens each batch's recipe version was approved with (`null` if none were recorded). */
async function batchAllergens(db: Executor, batchIds: string[]) {
  const out = new Map<string, AllergenRollup>();
  if (batchIds.length === 0) return out;
  const rows = await db
    .select({ id: productionBatches.id, allergens: recipeVersions.approvedAllergens })
    .from(productionBatches)
    .innerJoin(recipeVersions, eq(recipeVersions.id, productionBatches.recipeVersionId))
    .where(inArray(productionBatches.id, batchIds));
  for (const r of rows) if (r.allergens) out.set(r.id, r.allergens);
  return out;
}

/** The allergen risk of running one batch after another on a line, before a check is recorded. */
export async function getChangeoverRisk(db: Database, workspaceId: string, query: ChangeoverRiskQuery) {
  for (const id of [query.previousBatchId, query.nextBatchId]) await assertBatchRef(db, workspaceId, id);
  const ids = [query.previousBatchId, query.nextBatchId].filter((b): b is string => !!b);
  const allergensOf = await batchAllergens(db, ids);
  return changeoverAllergenRisk({
    previous: query.previousBatchId ? (allergensOf.get(query.previousBatchId) ?? null) : null,
    next: query.nextBatchId ? (allergensOf.get(query.nextBatchId) ?? null) : null,
    previousNamed: !!query.previousBatchId,
    nextNamed: !!query.nextBatchId,
  });
}

async function describeChecks(db: Executor, rows: CheckRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const batchIds = [
    ...new Set(rows.flatMap((r) => [r.previousBatchId, r.nextBatchId]).filter((b): b is string => !!b)),
  ];
  const [items, areas, corrections, batches, names, holds] = await Promise.all([
    db
      .select()
      .from(siteChecklistCheckItems)
      .where(inArray(siteChecklistCheckItems.checkId, ids))
      .orderBy(asc(siteChecklistCheckItems.sortOrder), asc(siteChecklistCheckItems.id)),
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    db
      .select({ id: siteChecklistChecks.id, correctsCheckId: siteChecklistChecks.correctsCheckId })
      .from(siteChecklistChecks)
      .where(inArray(siteChecklistChecks.correctsCheckId, ids)),
    batchIds.length
      ? db
          .select({ id: productionBatches.id, batchCode: productionBatches.batchCode })
          .from(productionBatches)
          .where(inArray(productionBatches.id, batchIds))
      : Promise.resolve([] as { id: string; batchCode: string }[]),
    userNames(
      db,
      rows.flatMap((r) => [r.performedBy, r.signedOffBy]),
    ),
    openBreakagesByArea(
      db,
      rows.filter((r) => r.signOffStatus === "pending").map((r) => r.areaId),
    ),
  ]);
  const correctedBy = new Map(corrections.map((c) => [c.correctsCheckId!, c.id]));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const allergensOf = await batchAllergens(db, batchIds);
  return rows.map((row) => {
    const correctedByCheckId = correctedBy.get(row.id) ?? null;
    const own = items.filter((i: CheckItemRow) => i.checkId === row.id);
    return {
      ...strip(row),
      /** Allergen changeovers only: what the batch before leaves behind. A warning, never a block. */
      allergenRisk:
        row.kind === "allergen_changeover"
          ? changeoverAllergenRisk({
              previous: row.previousBatchId ? (allergensOf.get(row.previousBatchId) ?? null) : null,
              next: row.nextBatchId ? (allergensOf.get(row.nextBatchId) ?? null) : null,
              previousNamed: !!row.previousBatchId,
              nextNamed: !!row.nextBatchId,
            })
          : null,
      performedByName: nameOf(names, row.performedBy),
      signedOffByName: nameOf(names, row.signedOffBy),
      area: areaOf(areas, row.areaId),
      previousBatch: row.previousBatchId ? (batchById.get(row.previousBatchId) ?? null) : null,
      nextBatch: row.nextBatchId ? (batchById.get(row.nextBatchId) ?? null) : null,
      correctedByCheckId,
      awaitingSignOff: checkAwaitsSignOff({ signOffStatus: row.signOffStatus, correctedByCheckId }),
      /** The open glass breakage that holds this check's area, so it can't be signed off yet. */
      areaHold:
        row.signOffStatus === "pending" && !correctedByCheckId && row.areaId
          ? (holds.get(row.areaId) ?? null)
          : null,
      signOffLabel: checkSignOffLabels[row.signOffStatus],
      results: own.map(({ checkId: _c, workspaceId: _w, ...item }) => item),
      failedCount: own.filter((i) => i.result === "fail").length,
    };
  });
}

export async function getChecklistCheck(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteChecklistChecks)
    .where(and(eq(siteChecklistChecks.id, id), eq(siteChecklistChecks.workspaceId, workspaceId)));
  if (!row) throw notFound("Check");
  return (await describeChecks(db, [row]))[0]!;
}

/** Checks, newest first. */
export async function listChecklistChecks(db: Database, workspaceId: string, query: ChecklistCheckListQuery) {
  const where: (SQL | undefined)[] = [eq(siteChecklistChecks.workspaceId, workspaceId)];
  if (query.templateId) where.push(eq(siteChecklistChecks.templateId, query.templateId));
  if (query.kind) where.push(eq(siteChecklistChecks.kind, query.kind));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(siteChecklistChecks.performedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(siteChecklistChecks.performedAt, endOfDayInZone(query.to, zone!)));
  if (query.outcome) where.push(eq(siteChecklistChecks.outcome, query.outcome));
  if (query.signOff) where.push(eq(siteChecklistChecks.signOffStatus, query.signOff));
  if (query.batchId) {
    where.push(
      or(
        eq(siteChecklistChecks.previousBatchId, query.batchId),
        eq(siteChecklistChecks.nextBatchId, query.batchId),
      ),
    );
  }
  if (!query.includeCorrected) where.push(notCorrectedCheck);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteChecklistChecks)
      .where(and(...where))
      .orderBy(
        desc(siteChecklistChecks.performedAt),
        desc(siteChecklistChecks.createdAt),
        desc(siteChecklistChecks.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteChecklistChecks)
      .where(and(...where)),
  ]);
  const p = page(await describeChecks(db, rows), total?.n, query);
  return { checks: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

/** One result per item, no more and no fewer: `expected` are the item ids the check must cover. */
function assertCovers(expected: string[], results: { itemId: string }[]) {
  const given = new Set(results.map((r) => r.itemId));
  const missing = expected.filter((id) => !given.has(id));
  const unknown = results.filter((r) => !expected.includes(r.itemId));
  if (unknown.length) throw badRequest("A result is for an item that isn't on this checklist");
  if (missing.length) {
    throw new ApiError(400, "invalid_input", "Every item on the checklist needs a result", { missing });
  }
}

async function assertBatchRef(tx: Executor, workspaceId: string, id: string | null | undefined) {
  if (id) await findBatch(tx, workspaceId, id);
}

/**
 * Records a completed check against a checklist: one result per item (the wording is copied, so a
 * later edit doesn't rewrite it). A person's attestation (the route refuses tokens). It starts
 * `pending`; a person with `manage` signs it off before production starts.
 */
export async function recordChecklistCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ChecklistCheckCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const template = await findTemplate(tx, workspaceId, input.templateId);
    if (template.status === "archived") {
      throw new ApiError(409, "checklist_archived", `${template.name} is archived`);
    }
    const items = (await liveItemsOf(tx, [template.id])).filter((i) => i.templateId === template.id);
    assertCovers(
      items.map((i) => i.id),
      input.results,
    );
    if (template.kind !== "allergen_changeover" && (input.previousBatchId || input.nextBatchId)) {
      throw badRequest("Only an allergen changeover check refers to the batches before and after it");
    }
    if (input.previousBatchId && input.previousBatchId === input.nextBatchId) {
      throw badRequest("The batch before and the batch after are the same");
    }
    await assertBatchRef(tx, workspaceId, input.previousBatchId);
    await assertBatchRef(tx, workspaceId, input.nextBatchId);
    const itemById = new Map(items.map((i) => [i.id, i]));
    return insertCheck(tx, workspaceId, actorId, {
      id: input.id,
      templateId: template.id,
      templateName: template.name,
      kind: template.kind,
      areaId: template.areaId,
      line: template.line,
      performedAt: momentOf(input.performedAt, new Date()),
      note: input.note ?? null,
      previousBatchId: input.previousBatchId ?? null,
      nextBatchId: input.nextBatchId ?? null,
      results: input.results.map((r) => ({
        itemId: r.itemId,
        prompt: itemById.get(r.itemId)!.prompt,
        sortOrder: itemById.get(r.itemId)!.sortOrder,
        result: r.result,
        note: r.note ?? null,
      })),
    });
  });
  return getChecklistCheck(db, workspaceId, id);
}

interface CheckToInsert {
  id?: string | undefined;
  templateId: string;
  templateName: string;
  kind: CheckRow["kind"];
  areaId: string | null;
  line: string | null;
  performedAt: Date;
  note: string | null;
  previousBatchId: string | null;
  nextBatchId: string | null;
  results: {
    itemId: string | null;
    prompt: string;
    sortOrder: number;
    result: CheckItemRow["result"];
    note: string | null;
  }[];
  correction?: { originalId: string; reason: string };
}

async function insertCheck(tx: Transaction, workspaceId: string, actorId: string, check: CheckToInsert) {
  const [row] = await tx
    .insert(siteChecklistChecks)
    .values({
      ...(check.id ? { id: check.id } : {}),
      workspaceId,
      templateId: check.templateId,
      templateName: check.templateName,
      kind: check.kind,
      areaId: check.areaId,
      line: check.line,
      performedAt: check.performedAt,
      performedBy: actorId,
      outcome: checkOutcome(check.results),
      note: check.note,
      previousBatchId: check.previousBatchId,
      nextBatchId: check.nextBatchId,
      correctsCheckId: check.correction?.originalId ?? null,
      correctionReason: check.correction?.reason ?? null,
    })
    .returning();
  const results = await tx
    .insert(siteChecklistCheckItems)
    .values(check.results.map((r) => ({ workspaceId, checkId: row!.id, ...r })))
    .returning();
  await recordChanges(tx, workspaceId, actorId, [
    change("site_checklist_check", row!),
    ...results.map((r) => change("site_checklist_check_item", r)),
  ]);
  return row!.id;
}

/**
 * Corrects a check: the results again, as a new check pointing at the old one (same checklist,
 * time and batches). A person's act. The replaced check no longer counts and leaves the sign-off
 * queue; the new one needs its own sign-off.
 */
export async function correctChecklistCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ChecklistCheckCorrectInput,
) {
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(siteChecklistChecks)
      .where(and(eq(siteChecklistChecks.id, id), eq(siteChecklistChecks.workspaceId, workspaceId)));
    if (!original) throw notFound("Check");
    const [already] = await tx
      .select({ id: siteChecklistChecks.id })
      .from(siteChecklistChecks)
      .where(eq(siteChecklistChecks.correctsCheckId, id));
    if (already) throw new ApiError(409, "already_corrected", "This check has already been corrected");
    const originalItems = await tx
      .select()
      .from(siteChecklistCheckItems)
      .where(eq(siteChecklistCheckItems.checkId, id));
    const itemKey = (i: CheckItemRow) => i.itemId ?? i.id;
    assertCovers(originalItems.map(itemKey), input.results);
    const byKey = new Map(originalItems.map((i) => [itemKey(i), i]));
    return insertCheck(tx, workspaceId, actorId, {
      templateId: original.templateId,
      templateName: original.templateName,
      kind: original.kind,
      areaId: original.areaId,
      line: original.line,
      performedAt: original.performedAt,
      note: input.note ?? null,
      previousBatchId: original.previousBatchId,
      nextBatchId: original.nextBatchId,
      results: input.results.map((r) => {
        const old = byKey.get(r.itemId)!;
        return {
          itemId: old.itemId,
          prompt: old.prompt,
          sortOrder: old.sortOrder,
          result: r.result,
          note: r.note ?? null,
        };
      }),
      correction: { originalId: id, reason: input.reason },
    });
  });
  return getChecklistCheck(db, workspaceId, newId);
}

/**
 * The sign-off before production starts: a person with `manage` (checked by the route; tokens are
 * refused) signs a check off or holds it. A check with failed items can only be held: it is done
 * again once what failed is put right. A one-time stamp; a replaced (corrected) check can't be
 * signed off.
 */
export async function signOffChecklistCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CheckSignOffInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [check] = await tx
      .select()
      .from(siteChecklistChecks)
      .where(and(eq(siteChecklistChecks.id, id), eq(siteChecklistChecks.workspaceId, workspaceId)));
    if (!check) throw notFound("Check");
    if (check.signOffStatus !== "pending") {
      throw new ApiError(409, "already_signed_off", "This check has already been signed off or held");
    }
    const [corrected] = await tx
      .select({ id: siteChecklistChecks.id })
      .from(siteChecklistChecks)
      .where(eq(siteChecklistChecks.correctsCheckId, id));
    if (corrected) {
      throw new ApiError(
        409,
        "already_corrected",
        "A correction has replaced this check; sign that one off instead",
      );
    }
    if (input.decision === "approve" && check.areaId) {
      // An open glass breakage holds its area: no production starts there until a person releases it.
      const breakage = (await openBreakagesByArea(tx, [check.areaId])).get(check.areaId);
      if (breakage) {
        throw new ApiError(
          409,
          "area_on_hold",
          `This area is on hold after a glass breakage (${breakage.description}). Release the breakage before signing off`,
        );
      }
    }
    if (input.decision === "approve" && check.outcome === "failed") {
      throw new ApiError(
        409,
        "check_failed",
        "Items failed on this check, so production can't be signed off. Hold it, put the failures right and check again",
      );
    }
    const [updated] = await tx
      .update(siteChecklistChecks)
      .set({
        signOffStatus: input.decision === "approve" ? "approved" : "rejected",
        signedOffBy: actorId,
        signedOffAt: new Date(),
        signOffNote: input.note ?? null,
      })
      .where(and(eq(siteChecklistChecks.id, id), eq(siteChecklistChecks.signOffStatus, "pending")))
      .returning();
    if (!updated) throw new ApiError(409, "already_signed_off", "Someone else signed this check off first");
    await recordChanges(tx, workspaceId, actorId, [change("site_checklist_check", updated)]);
  });
  return getChecklistCheck(db, workspaceId, id);
}

// ─── What is due ─────────────────────────────────────────────────────────────

/**
 * Everything scheduled across the programmes and where it stands, most urgent first, computed on
 * read. `include: "due"` keeps overdue and due items only. Glass checks are grouped by area (one
 * line per area with how many items are due). `counts` holds what waits for a person: readings to
 * review, checks to sign off, clearances to give, breakages to release, open corrective actions,
 * damaged or missing glass, and pest activity on the last visit.
 */
export interface SiteDueOptions {
  withMaintenance?: boolean;
  /** The moment to decide due states at (the notification sweep passes its own); default now. */
  now?: Date;
  /**
   * Filled with each due glass area's latest item due date. The area's line shows the earliest,
   * which moves when the oldest item is checked; the latest only moves when another item falls
   * due, so the notification sweep keys on it.
   */
  glassLatestDueOn?: Map<string, string>;
}

export async function getSiteDue(
  db: Database,
  workspaceId: string,
  query: SiteDueQuery,
  options: SiteDueOptions = {},
) {
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const now = options.now ?? new Date();
  const today = todayInZone(timeZone, now);
  const items: SiteDueItem[] = [];
  const want = (programme: SiteDueItem["programme"]) => !query.programme || query.programme === programme;

  // Pest control: the next visit the latest visit set.
  if (want("pest")) {
    const [last] = await db
      .select()
      .from(sitePestVisits)
      .where(and(eq(sitePestVisits.workspaceId, workspaceId), notCorrectedVisit))
      .orderBy(desc(sitePestVisits.visitedOn), desc(sitePestVisits.createdAt), desc(sitePestVisits.id))
      .limit(1);
    if (!last) {
      // Devices are in place but nobody has visited: that needs attention. No devices, no programme yet.
      const [device] = await db
        .select({ id: sitePestDevices.id })
        .from(sitePestDevices)
        .where(
          and(
            eq(sitePestDevices.workspaceId, workspaceId),
            isNull(sitePestDevices.deletedAt),
            eq(sitePestDevices.status, "active"),
          ),
        )
        .limit(1);
      if (device) {
        items.push({
          programme: "pest",
          subjectId: "pest-visit",
          title: "Pest control visit",
          where: null,
          state: "due",
          dueOn: null,
          dueAt: null,
          lastAt: null,
          note: siteDueReasonLabels.no_visit_recorded,
          reason: "no_visit_recorded",
        });
      }
    } else {
      const noNext = !last.nextVisitOn;
      items.push({
        programme: "pest",
        subjectId: "pest-visit",
        title: `Pest control visit (${last.contractor})`,
        where: null,
        // Without a next date nothing says when the contractor returns: treat it as needing attention.
        state: last.nextVisitOn ? nextVisitState(last.nextVisitOn, today) : "due",
        dueOn: last.nextVisitOn,
        dueAt: null,
        lastAt: last.visitedOn,
        note: noNext ? siteDueReasonLabels.no_next_visit : null,
        reason: noNext ? "no_next_visit" : null,
      });
    }
  }

  // Glass: one line per area.
  if (want("glass")) {
    const glass = await db
      .select()
      .from(siteGlassItems)
      .where(
        and(
          eq(siteGlassItems.workspaceId, workspaceId),
          isNull(siteGlassItems.deletedAt),
          eq(siteGlassItems.status, "active"),
        ),
      );
    const [last, areas] = await Promise.all([
      lastGlassChecks(
        db,
        workspaceId,
        glass.map((g) => g.id),
      ),
      areasById(
        db,
        glass.map((g) => g.areaId),
      ),
    ]);
    const byArea = new Map<
      string,
      { states: DueState[]; dueOn: string | null; latestDueOn: string | null; lastAt: Date | null; n: number }
    >();
    for (const item of glass) {
      const check = last.get(item.id);
      const due = siteCheckDueState({
        frequency: { every: item.checkEvery, unit: item.checkUnit },
        lastAt: check?.checkedAt ?? null,
        now,
        timeZone,
      });
      if (query.include === "due" && !(actionableDueStates as readonly string[]).includes(due.state))
        continue;
      const entry = byArea.get(item.areaId) ?? {
        states: [],
        dueOn: null,
        latestDueOn: null,
        lastAt: null,
        n: 0,
      };
      entry.states.push(due.state);
      entry.n += 1;
      if (due.dueOn && (!entry.dueOn || due.dueOn < entry.dueOn)) entry.dueOn = due.dueOn;
      if (due.dueOn && (!entry.latestDueOn || due.dueOn > entry.latestDueOn)) entry.latestDueOn = due.dueOn;
      if (check && (!entry.lastAt || check.checkedAt > entry.lastAt)) entry.lastAt = check.checkedAt;
      byArea.set(item.areaId, entry);
    }
    for (const [areaId, entry] of byArea) {
      if (entry.latestDueOn) options.glassLatestDueOn?.set(areaId, entry.latestDueOn);
      const area = areas.get(areaId);
      items.push({
        programme: "glass",
        subjectId: areaId,
        title: `Glass and brittle plastics checks${area ? `: ${area.name}` : ""}`,
        where: area?.name ?? null,
        state: [...entry.states].sort(compareDueStates)[0] ?? "ok",
        dueOn: entry.dueOn,
        dueAt: null,
        lastAt: entry.lastAt?.toISOString() ?? null,
        note: `${entry.n} ${entry.n === 1 ? "item" : "items"}`,
      });
    }
  }

  if (options.withMaintenance && want("maintenance")) {
    items.push(...(await maintenanceDueItems(db, workspaceId, today, timeZone)));
  }

  // Storage: each active unit.
  if (want("storage")) {
    const units = await db
      .select()
      .from(siteStorageUnits)
      .where(
        and(
          eq(siteStorageUnits.workspaceId, workspaceId),
          isNull(siteStorageUnits.deletedAt),
          eq(siteStorageUnits.status, "active"),
        ),
      );
    const last = await lastReadings(
      db,
      workspaceId,
      units.map((u) => u.id),
    );
    for (const unit of units) {
      const reading = last.get(unit.id) ?? null;
      const due = siteCheckDueState({
        frequency: unitFrequency(unit),
        lastAt: reading?.checkedAt ?? null,
        now,
        timeZone,
      });
      items.push({
        programme: "storage",
        subjectId: unit.id,
        title: `${unit.name}: temperature reading`,
        where: unit.location,
        state: due.state,
        dueOn: due.dueOn,
        dueAt: due.dueAt,
        lastAt: reading?.checkedAt.toISOString() ?? null,
        note: describeFrequency(unitFrequency(unit)),
      });
    }
  }

  // Checklists: templates with a frequency.
  if (want("checklist")) {
    const templates = await db
      .select()
      .from(siteChecklistTemplates)
      .where(
        and(
          eq(siteChecklistTemplates.workspaceId, workspaceId),
          isNull(siteChecklistTemplates.deletedAt),
          eq(siteChecklistTemplates.status, "active"),
          sql`${siteChecklistTemplates.frequencyEvery} is not null`,
        ),
      );
    const [last, producing, areas] = await Promise.all([
      lastDoneChecks(
        db,
        workspaceId,
        templates.map((t) => t.id),
      ),
      isProducing(db, workspaceId),
      areasById(
        db,
        templates.map((t) => t.areaId),
      ),
    ]);
    for (const template of templates) {
      const frequency = templateFrequency(template)!;
      const check = last.get(template.id) ?? null;
      const due = siteCheckDueState({
        frequency,
        lastAt: check?.performedAt ?? null,
        now,
        timeZone,
        duringProduction: template.duringProduction,
        producing,
      });
      items.push({
        programme: "checklist",
        subjectId: template.id,
        title: template.name,
        where: template.line ?? areaOf(areas, template.areaId)?.name ?? null,
        state: due.state,
        dueOn: due.dueOn,
        dueAt: due.dueAt,
        lastAt: check?.performedAt.toISOString() ?? null,
        note: describeFrequency(frequency),
      });
    }
  }

  const shown =
    query.include === "all"
      ? items
      : items.filter((i) => (actionableDueStates as readonly string[]).includes(i.state));

  const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [
    awaitingReview,
    awaitingSignOff,
    openBreakages,
    openActions,
    pestActivity,
    glassProblems,
    maintenance,
  ] = await Promise.all([
    one(
      db
        .select({ n: count() })
        .from(siteStorageReadings)
        .where(
          and(
            eq(siteStorageReadings.workspaceId, workspaceId),
            eq(siteStorageReadings.reviewStatus, "pending"),
            notCorrectedReading,
          ),
        ),
    ),
    one(
      db
        .select({ n: count() })
        .from(siteChecklistChecks)
        .where(
          and(
            eq(siteChecklistChecks.workspaceId, workspaceId),
            eq(siteChecklistChecks.signOffStatus, "pending"),
            notCorrectedCheck,
          ),
        ),
    ),
    one(
      db
        .select({ n: count() })
        .from(siteGlassBreakages)
        .where(and(eq(siteGlassBreakages.workspaceId, workspaceId), eq(siteGlassBreakages.status, "open"))),
    ),
    one(
      db
        .select({ n: count() })
        .from(siteCorrectiveActions)
        .where(
          and(
            eq(siteCorrectiveActions.workspaceId, workspaceId),
            eq(siteCorrectiveActions.status, "open"),
            isNull(siteCorrectiveActions.deletedAt),
          ),
        ),
    ),
    pestActivityOnLastVisit(db, workspaceId),
    glassNeedingAction(db, workspaceId),
    options.withMaintenance
      ? maintenanceCounts(db, workspaceId)
      : { awaitingClearance: 0, openWorkOrders: 0 },
  ]);

  return {
    today,
    items: sortSiteDueItems(shown),
    counts: {
      overdue: items.filter((i) => i.state === "overdue").length,
      due: items.filter((i) => i.state === "due").length,
      awaitingReview,
      awaitingSignOff,
      openBreakages,
      openActions,
      pestActivity,
      glassProblems,
      ...maintenance,
    },
  };
}

/** Findings of moderate or high activity on the latest visit. */
async function pestActivityOnLastVisit(db: Executor, workspaceId: string) {
  const [last] = await db
    .select({ id: sitePestVisits.id })
    .from(sitePestVisits)
    .where(and(eq(sitePestVisits.workspaceId, workspaceId), notCorrectedVisit))
    .orderBy(desc(sitePestVisits.visitedOn), desc(sitePestVisits.createdAt), desc(sitePestVisits.id))
    .limit(1);
  if (!last) return 0;
  const findings = await db.select().from(sitePestFindings).where(eq(sitePestFindings.visitId, last.id));
  return findings.filter((f) => activityNeedsAction(f.activity)).length;
}

/** Active items whose latest check found them damaged or missing. */
async function glassNeedingAction(db: Executor, workspaceId: string) {
  const items = await db
    .select({ id: siteGlassItems.id })
    .from(siteGlassItems)
    .where(
      and(
        eq(siteGlassItems.workspaceId, workspaceId),
        isNull(siteGlassItems.deletedAt),
        eq(siteGlassItems.status, "active"),
      ),
    );
  const last = await lastGlassChecks(
    db,
    workspaceId,
    items.map((i) => i.id),
  );
  return [...last.values()].filter((c) => glassConditionNeedsAction(c.condition)).length;
}
