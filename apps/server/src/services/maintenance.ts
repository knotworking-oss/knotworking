import { assertNoHseIsolation } from "./ports/hse";
import {
  addFrequencyToDate,
  dateDueState,
  workOrderIsOpen,
  workOrderTotalCost,
  defaultNextMaintenanceOn,
  describeFrequency,
  dateInZone,
  endOfDayInZone,
  startOfDayInZone,
  todayInZone,
  maintenanceDueOn,
  maintenanceDueState,
  type DueState,
  type WorkOrderCancelInput,
  type WorkOrderCompleteInput,
  type WorkOrderCreateInput,
  type WorkOrderListQuery,
  type WorkOrderUpdateInput,
  type ModuleId,
  type HygieneClearanceInput,
  type MaintenanceRecordCorrectInput,
  type MaintenanceRecordCreateInput,
  type MaintenanceRecordListQuery,
  type MaintenanceTaskCreateInput,
  type MaintenanceTaskListQuery,
  type MaintenanceTaskUpdateInput,
  type SiteAssetListQuery,
  type SiteAssetUpdateInput,
  type SiteDueItem,
  type SiteFrequency,
  type SiteSource,
} from "@knotworking/core";
import {
  assets as assetRegister,
  haccpAssets,
  haccpCalibrationRecords,
  lockWorkspaceLog,
  recordChanges,
  siteAssets,
  siteMaintenanceRecords,
  siteMaintenanceTasks,
  siteWorkOrders,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceTimeZone } from "./time-zone";
import { userNames } from "./ports/production";

import {
  strip,
  stripSoft,
  change,
  nameOf,
  frequencyOf,
  momentOf,
  page,
  assertMember,
  areasById,
  areaOf,
  assertFourEyes,
} from "./operation-records";

/**
 * An asset of the register as planned maintenance sees it, with its link to a calibration
 * instrument (left joined: most assets have none). `areaId` is the asset's area.
 */
const maintainedColumns = {
  id: assetRegister.id,
  workspaceId: assetRegister.workspaceId,
  kind: assetRegister.kind,
  code: assetRegister.code,
  name: assetRegister.name,
  location: assetRegister.location,
  areaId: assetRegister.parentAreaId,
  calibrationInstrumentId: siteAssets.calibrationInstrumentId,
  status: assetRegister.status,
  createdAt: assetRegister.createdAt,
  updatedAt: assetRegister.updatedAt,
  deletedAt: assetRegister.deletedAt,
};
const maintainedAssets = (db: Executor) =>
  db.select(maintainedColumns).from(assetRegister).leftJoin(siteAssets, eq(siteAssets.id, assetRegister.id));
type AssetRow = Awaited<ReturnType<typeof maintainedAssets>>[number];
type TaskRow = typeof siteMaintenanceTasks.$inferSelect;
type MaintenanceRow = typeof siteMaintenanceRecords.$inferSelect;
// ─── Planned maintenance ─────────────────────────────────────────────────────

async function findMaintainedAsset(db: Executor, workspaceId: string, id: string) {
  const [row] = await maintainedAssets(db).where(
    and(
      eq(assetRegister.id, id),
      eq(assetRegister.workspaceId, workspaceId),
      isNull(assetRegister.deletedAt),
    ),
  );
  if (!row) throw notFound("Asset");
  return row;
}

/**
 * The HACCP calibration register's view of an instrument, read-only: where it stands now. The same
 * rule as HACCP's what's-due (the next due date the last calibration set, else its date plus the
 * frequency; a failed one stays overdue; none yet is due).
 */
async function instrumentsById(db: Executor, workspaceId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  const out = new Map<string, InstrumentView>();
  if (wanted.length === 0) return out;
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const today = todayInZone(timeZone);
  const [instruments, latest] = await Promise.all([
    db
      .select({
        id: assetRegister.id,
        code: assetRegister.code,
        name: assetRegister.name,
        status: assetRegister.status,
        deletedAt: assetRegister.deletedAt,
        measurementUnit: haccpAssets.measurementUnit,
        calibrationEvery: haccpAssets.calibrationEvery,
        calibrationUnit: haccpAssets.calibrationUnit,
      })
      .from(assetRegister)
      .leftJoin(haccpAssets, eq(haccpAssets.id, assetRegister.id))
      .where(inArray(assetRegister.id, wanted)),
    db
      .selectDistinctOn([haccpCalibrationRecords.assetId])
      .from(haccpCalibrationRecords)
      .where(
        and(
          inArray(haccpCalibrationRecords.assetId, wanted),
          sql`not exists (select 1 from ${haccpCalibrationRecords} c where c.corrects_record_id = ${haccpCalibrationRecords.id})`,
        ),
      )
      .orderBy(haccpCalibrationRecords.assetId, desc(haccpCalibrationRecords.calibratedAt)),
  ]);
  const latestOf = new Map(latest.map((r) => [r.assetId, r]));
  for (const asset of instruments) {
    const frequency = frequencyOf(asset.calibrationEvery, asset.calibrationUnit);
    const record = latestOf.get(asset.id) ?? null;
    const dueOn =
      record && frequency
        ? (record.nextDueOn ?? addFrequencyToDate(dateInZone(record.calibratedAt, timeZone), frequency))
        : null;
    out.set(asset.id, {
      id: asset.id,
      code: asset.code,
      name: asset.name,
      status: asset.status,
      measurementUnit: asset.measurementUnit,
      calibrationFrequencyText: frequency ? describeFrequency(frequency) : null,
      lastCalibration: record
        ? { id: record.id, calibratedAt: record.calibratedAt, passed: record.passed, nextDueOn: dueOn }
        : null,
      state:
        asset.deletedAt || !frequency
          ? "idle"
          : !record
            ? "due"
            : !record.passed
              ? "overdue"
              : dateDueState(dueOn!, today),
    });
  }
  return out;
}

interface InstrumentView {
  id: string;
  code: string | null;
  name: string;
  status: string;
  measurementUnit: string | null;
  calibrationFrequencyText: string | null;
  lastCalibration: { id: string; calibratedAt: Date; passed: boolean; nextDueOn: string | null } | null;
  state: DueState;
}

/**
 * Maintained assets as the API shows them. The calibration instrument (HACCP's record) is only
 * looked up when the caller can read HACCP (`withCalibration`); otherwise it is `null`.
 */
async function describeMaintainedAssets(db: Executor, rows: AssetRow[], withCalibration: boolean) {
  if (rows.length === 0) return [];
  const [areas, instruments] = await Promise.all([
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    // One workspace per call: every row shares it.
    withCalibration
      ? instrumentsById(
          db,
          rows[0]!.workspaceId,
          rows.map((r) => r.calibrationInstrumentId),
        )
      : new Map<string, InstrumentView>(),
  ]);
  return rows.map((row) => ({
    ...stripSoft(row),
    calibrationInstrumentId: withCalibration ? row.calibrationInstrumentId : null,
    area: areaOf(areas, row.areaId),
    /** The linked HACCP calibration instrument (read-only here), or `null`. */
    calibrationInstrument:
      withCalibration && row.calibrationInstrumentId
        ? (instruments.get(row.calibrationInstrumentId) ?? null)
        : null,
  }));
}

/**
 * Equipment of the HACCP calibration register that a site asset can be linked to: kept in
 * Cleaning & calibration, read here (the route needs HACCP). `linkedAssetId` is the asset that
 * already points at it.
 */
export async function listCalibrationInstruments(db: Database, workspaceId: string) {
  const rows = await db
    .select({ id: assetRegister.id })
    .from(assetRegister)
    .innerJoin(haccpAssets, eq(haccpAssets.id, assetRegister.id))
    .where(
      and(
        eq(assetRegister.workspaceId, workspaceId),
        eq(assetRegister.kind, "equipment"),
        isNull(assetRegister.deletedAt),
        eq(assetRegister.status, "active"),
        sql`${haccpAssets.calibrationEvery} is not null`,
      ),
    )
    .orderBy(asc(assetRegister.name), asc(assetRegister.id));
  const [linked, views] = await Promise.all([
    db
      .select({ id: siteAssets.id, instrumentId: siteAssets.calibrationInstrumentId })
      .from(siteAssets)
      .innerJoin(assetRegister, eq(assetRegister.id, siteAssets.id))
      .where(
        and(
          eq(siteAssets.workspaceId, workspaceId),
          isNull(assetRegister.deletedAt),
          sql`${siteAssets.calibrationInstrumentId} is not null`,
        ),
      ),
    instrumentsById(
      db,
      workspaceId,
      rows.map((r) => r.id),
    ),
  ]);
  const assetOf = new Map(linked.map((l) => [l.instrumentId!, l.id]));
  return {
    instruments: rows.map((r) => ({ ...views.get(r.id)!, linkedAssetId: assetOf.get(r.id) ?? null })),
  };
}

/**
 * A calibration instrument must be equipment of the HACCP register with a calibration frequency,
 * and one asset at most points at it. HACCP's records are never written from here.
 */
async function assertInstrument(tx: Executor, workspaceId: string, instrumentId: string, assetId: string) {
  if (instrumentId === assetId) throw badRequest("An asset can't be its own calibration instrument");
  const [row] = await tx
    .select({ name: assetRegister.name, calibrationEvery: haccpAssets.calibrationEvery })
    .from(assetRegister)
    .leftJoin(haccpAssets, eq(haccpAssets.id, assetRegister.id))
    .where(
      and(
        eq(assetRegister.id, instrumentId),
        eq(assetRegister.workspaceId, workspaceId),
        eq(assetRegister.kind, "equipment"),
        isNull(assetRegister.deletedAt),
      ),
    );
  if (!row) throw notFound("Calibration instrument");
  if (row.calibrationEvery === null) {
    throw badRequest(
      `${row.name} isn't in the calibration register: give it a calibration frequency under Cleaning & calibration first`,
    );
  }
  const [taken] = await tx
    .select({ id: assetRegister.id, name: assetRegister.name })
    .from(siteAssets)
    .innerJoin(assetRegister, eq(assetRegister.id, siteAssets.id))
    .where(
      and(
        eq(siteAssets.workspaceId, workspaceId),
        eq(siteAssets.calibrationInstrumentId, instrumentId),
        isNull(assetRegister.deletedAt),
        ne(siteAssets.id, assetId),
      ),
    );
  if (taken) {
    throw new ApiError(409, "instrument_linked", `${row.name} is already linked to ${taken.name}`);
  }
}

/** Assets of the register that can be maintained (any kind), with their calibration link. */
export async function listMaintainedAssets(
  db: Database,
  workspaceId: string,
  query: SiteAssetListQuery,
  options: { withCalibration: boolean },
) {
  const where: (SQL | undefined)[] = [
    eq(assetRegister.workspaceId, workspaceId),
    isNull(assetRegister.deletedAt),
  ];
  if (query.status !== "all") where.push(eq(assetRegister.status, query.status));
  const rows = await maintainedAssets(db)
    .where(and(...where))
    .orderBy(asc(assetRegister.name), asc(assetRegister.id));
  return { assets: await describeMaintainedAssets(db, rows, options.withCalibration) };
}

/**
 * Links a maintained asset to the HACCP calibration instrument it is (or unlinks it with `null`).
 * The link needs HACCP access. The asset itself is edited in the asset register.
 */
export async function updateCalibrationLink(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: SiteAssetUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findMaintainedAsset(tx, workspaceId, id);
    if (patch.calibrationInstrumentId) {
      await assertInstrument(tx, workspaceId, patch.calibrationInstrumentId, id);
    }
    const [row] = await tx
      .insert(siteAssets)
      .values({ id, workspaceId, calibrationInstrumentId: patch.calibrationInstrumentId })
      .onConflictDoUpdate({
        target: siteAssets.id,
        set: { calibrationInstrumentId: patch.calibrationInstrumentId, updatedAt: new Date() },
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_asset", row!)]);
  });
  const row = await findMaintainedAsset(db, workspaceId, id);
  return (await describeMaintainedAssets(db, [row], true))[0]!;
}

async function findTask(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteMaintenanceTasks)
    .where(
      and(
        eq(siteMaintenanceTasks.id, id),
        eq(siteMaintenanceTasks.workspaceId, workspaceId),
        isNull(siteMaintenanceTasks.deletedAt),
      ),
    );
  if (!row) throw notFound("Maintenance task");
  return row;
}

const notCorrectedMaintenance = sql`not exists (select 1 from ${siteMaintenanceRecords} c where c.corrects_record_id = ${siteMaintenanceRecords.id})`;

/** The latest record of each task (not replaced by a correction). */
async function lastMaintenance(db: Executor, workspaceId: string, taskIds: string[]) {
  if (taskIds.length === 0) return new Map<string, MaintenanceRow>();
  const rows = await db
    .selectDistinctOn([siteMaintenanceRecords.taskId])
    .from(siteMaintenanceRecords)
    .where(
      and(
        eq(siteMaintenanceRecords.workspaceId, workspaceId),
        inArray(siteMaintenanceRecords.taskId, taskIds),
        notCorrectedMaintenance,
      ),
    )
    .orderBy(
      siteMaintenanceRecords.taskId,
      desc(siteMaintenanceRecords.completedAt),
      desc(siteMaintenanceRecords.createdAt),
      desc(siteMaintenanceRecords.id),
    );
  return new Map(rows.map((r) => [r.taskId, r]));
}

const taskFrequency = (task: TaskRow): SiteFrequency => ({
  every: task.frequencyEvery,
  unit: task.frequencyUnit,
});

function taskDue(task: TaskRow, last: MaintenanceRow | null, today: string, timeZone: string) {
  const dueOn = maintenanceDueOn({
    lastNextDueOn: last?.nextDueOn ?? null,
    lastCompletedOn: last ? dateInZone(last.completedAt, timeZone) : null,
    frequency: taskFrequency(task),
    startOn: task.startOn,
  });
  return maintenanceDueState({ dueOn, hasRecord: !!last, today });
}

async function describeTasks(db: Executor, workspaceId: string, rows: TaskRow[]) {
  if (rows.length === 0) return [];
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const today = todayInZone(timeZone);
  const [assets, last] = await Promise.all([
    maintainedAssets(db).where(inArray(assetRegister.id, [...new Set(rows.map((r) => r.assetId))])),
    lastMaintenance(
      db,
      workspaceId,
      rows.map((r) => r.id),
    ),
  ]);
  const areas = await areasById(
    db,
    assets.map((a) => a.areaId),
  );
  const assetById = new Map(assets.map((a) => [a.id, a]));
  return rows.map((row) => {
    const asset = assetById.get(row.assetId);
    const lastRecord = last.get(row.id) ?? null;
    return {
      ...stripSoft(row),
      frequency: taskFrequency(row),
      frequencyText: describeFrequency(taskFrequency(row)),
      asset: asset
        ? {
            id: asset.id,
            code: asset.code,
            name: asset.name,
            location: asset.location,
            status: asset.status,
            area: areaOf(areas, asset.areaId),
          }
        : null,
      lastRecord: lastRecord
        ? { id: lastRecord.id, completedAt: lastRecord.completedAt, nextDueOn: lastRecord.nextDueOn }
        : null,
      due: row.status === "active" ? taskDue(row, lastRecord, today, timeZone) : null,
    };
  });
}

export async function listMaintenanceTasks(
  db: Database,
  workspaceId: string,
  query: MaintenanceTaskListQuery,
) {
  const where: (SQL | undefined)[] = [
    eq(siteMaintenanceTasks.workspaceId, workspaceId),
    isNull(siteMaintenanceTasks.deletedAt),
  ];
  if (query.assetId) where.push(eq(siteMaintenanceTasks.assetId, query.assetId));
  if (query.status !== "all") where.push(eq(siteMaintenanceTasks.status, query.status));
  const rows = await db
    .select()
    .from(siteMaintenanceTasks)
    .where(and(...where))
    .orderBy(asc(siteMaintenanceTasks.title), asc(siteMaintenanceTasks.id));
  return { tasks: await describeTasks(db, workspaceId, rows) };
}

const taskFrequencyColumns = (f: SiteFrequency | undefined) =>
  f ? { frequencyEvery: f.every, frequencyUnit: f.unit } : {};

export async function createMaintenanceTask(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: MaintenanceTaskCreateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const asset = await findMaintainedAsset(tx, workspaceId, input.assetId);
    if (asset.status === "archived") {
      throw new ApiError(409, "asset_archived", `${asset.name} is archived`);
    }
    if (input.clearanceRequired && !asset.areaId) {
      throw badRequest("A return-to-service clearance needs the asset's area: give the asset an area first");
    }
    const { id, frequency, ...fields } = input;
    const [created] = await tx
      .insert(siteMaintenanceTasks)
      .values({
        ...(id ? { id } : {}),
        ...fields,
        ...taskFrequencyColumns(frequency),
        workspaceId,
      } as typeof siteMaintenanceTasks.$inferInsert)
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_maintenance_task", created!)]);
    return created!;
  });
  return (await describeTasks(db, workspaceId, [row]))[0]!;
}

export async function updateMaintenanceTask(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: MaintenanceTaskUpdateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const task = await findTask(tx, workspaceId, id);
    if (patch.clearanceRequired) {
      const asset = await findMaintainedAsset(tx, workspaceId, task.assetId);
      if (!asset.areaId) {
        throw badRequest(
          "A return-to-service clearance needs the asset's area: give the asset an area first",
        );
      }
    }
    const { frequency, ...fields } = patch;
    const [updated] = await tx
      .update(siteMaintenanceTasks)
      .set({ ...fields, ...taskFrequencyColumns(frequency) })
      .where(eq(siteMaintenanceTasks.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_maintenance_task", updated!)]);
    return updated!;
  });
  return (await describeTasks(db, workspaceId, [row]))[0]!;
}

async function describeMaintenance(db: Executor, rows: MaintenanceRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [tasks, assets, corrections, names] = await Promise.all([
    db
      .select()
      .from(siteMaintenanceTasks)
      .where(inArray(siteMaintenanceTasks.id, [...new Set(rows.map((r) => r.taskId))])),
    maintainedAssets(db).where(inArray(assetRegister.id, [...new Set(rows.map((r) => r.assetId))])),
    db
      .select({ id: siteMaintenanceRecords.id, correctsRecordId: siteMaintenanceRecords.correctsRecordId })
      .from(siteMaintenanceRecords)
      .where(inArray(siteMaintenanceRecords.correctsRecordId, ids)),
    userNames(
      db,
      rows.flatMap((r) => [r.doneBy, r.recordedBy, r.clearedBy]),
    ),
  ]);
  const areas = await areasById(
    db,
    rows.map((r) => r.areaId),
  );
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const correctedBy = new Map(corrections.map((c) => [c.correctsRecordId!, c.id]));
  return rows.map((row) => {
    const task = taskById.get(row.taskId);
    const asset = assetById.get(row.assetId);
    const correctedByRecordId = correctedBy.get(row.id) ?? null;
    return {
      ...strip(row),
      task: task ? { id: task.id, title: task.title } : null,
      asset: asset ? { id: asset.id, code: asset.code, name: asset.name } : null,
      area: areaOf(areas, row.areaId),
      doneByName: nameOf(names, row.doneBy),
      recordedByName: nameOf(names, row.recordedBy),
      clearedByName: nameOf(names, row.clearedBy),
      correctedByRecordId,
      /** Work in a production area that still needs a person's hygiene clearance. */
      awaitingClearance: row.clearanceRequired && !row.clearedAt && !correctedByRecordId,
    };
  });
}

export async function getMaintenanceRecord(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteMaintenanceRecords)
    .where(and(eq(siteMaintenanceRecords.id, id), eq(siteMaintenanceRecords.workspaceId, workspaceId)));
  if (!row) throw notFound("Maintenance record");
  return (await describeMaintenance(db, [row]))[0]!;
}

export async function listMaintenanceRecords(
  db: Database,
  workspaceId: string,
  query: MaintenanceRecordListQuery,
) {
  const where: (SQL | undefined)[] = [eq(siteMaintenanceRecords.workspaceId, workspaceId)];
  if (query.taskId) where.push(eq(siteMaintenanceRecords.taskId, query.taskId));
  if (query.assetId) where.push(eq(siteMaintenanceRecords.assetId, query.assetId));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(siteMaintenanceRecords.completedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(siteMaintenanceRecords.completedAt, endOfDayInZone(query.to, zone!)));
  if (query.awaitingClearance) {
    where.push(
      eq(siteMaintenanceRecords.clearanceRequired, true),
      isNull(siteMaintenanceRecords.clearedAt),
      notCorrectedMaintenance,
    );
  }
  if (!query.includeCorrected) where.push(notCorrectedMaintenance);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteMaintenanceRecords)
      .where(and(...where))
      .orderBy(
        desc(siteMaintenanceRecords.completedAt),
        desc(siteMaintenanceRecords.createdAt),
        desc(siteMaintenanceRecords.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteMaintenanceRecords)
      .where(and(...where)),
  ]);
  const p = page(await describeMaintenance(db, rows), total?.n, query);
  return { records: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

type MaintenanceFields = Omit<MaintenanceRecordCreateInput, "id" | "taskId">;

async function insertMaintenance(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  task: TaskRow,
  input: MaintenanceFields & { id?: string | undefined },
  correction?: { original: MaintenanceRow; reason: string },
) {
  const original = correction?.original;
  const asset = await findMaintainedAsset(tx, workspaceId, task.assetId);
  // A correction fixes a record of work already done, so retired equipment doesn't block it.
  if (!original && asset.status === "archived") {
    throw new ApiError(409, "asset_archived", `${asset.name} is archived`);
  }
  // A correction keeps the clearance its original needed: changing the task later can't drop it.
  const clearanceRequired = task.clearanceRequired || (original?.clearanceRequired ?? false);
  if (clearanceRequired && !asset.areaId) {
    throw new ApiError(409, "area_required", "A return-to-service clearance needs the asset's area");
  }
  // A correction is a patch: what it doesn't say is kept from the original (when and by whom the
  // work was done, and so the next due date), not replaced by now and the person correcting.
  const doneBy = input.doneBy ?? original?.doneBy ?? actorId;
  if (doneBy !== actorId && doneBy !== original?.doneBy) await assertMember(tx, workspaceId, doneBy);
  const completedAt = input.completedAt
    ? momentOf(input.completedAt, new Date())
    : (original?.completedAt ?? new Date());
  const completedOn = dateInZone(completedAt, await workspaceTimeZone(tx, workspaceId));
  const nextDueOn =
    input.nextDueOn ??
    (original && !input.completedAt
      ? original.nextDueOn
      : defaultNextMaintenanceOn(completedOn, taskFrequency(task)));
  if (nextDueOn < completedOn) throw badRequest("The next due date is before the work was done");
  const [row] = await tx
    .insert(siteMaintenanceRecords)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId,
      taskId: task.id,
      assetId: asset.id,
      areaId: asset.areaId,
      completedAt,
      doneBy,
      contractor: input.contractor !== undefined ? input.contractor : (original?.contractor ?? null),
      workDone: input.workDone !== undefined ? input.workDone : (original?.workDone ?? null),
      nextDueOn,
      note: input.note !== undefined ? input.note : (original?.note ?? null),
      clearanceRequired,
      recordedBy: actorId,
      correctsRecordId: original?.id ?? null,
      correctionReason: correction?.reason ?? null,
    })
    .returning();
  await recordChanges(tx, workspaceId, actorId, [change("site_maintenance_record", row!)]);
  return row!.id;
}

/** Records completed maintenance. A person's attestation (the route refuses tokens). */
export async function recordMaintenance(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: MaintenanceRecordCreateInput,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const task = await findTask(tx, workspaceId, input.taskId);
    if (task.status === "archived") throw new ApiError(409, "task_archived", `${task.title} is archived`);
    const { taskId: _task, ...fields } = input;
    return insertMaintenance(tx, workspaceId, actorId, task, fields);
  });
  return getMaintenanceRecord(db, workspaceId, id);
}

/** Corrects a record: a new row, pointing at the old one. A cleared record's correction needs its own clearance. */
export async function correctMaintenance(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: MaintenanceRecordCorrectInput,
) {
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [original] = await tx
      .select()
      .from(siteMaintenanceRecords)
      .where(and(eq(siteMaintenanceRecords.id, id), eq(siteMaintenanceRecords.workspaceId, workspaceId)));
    if (!original) throw notFound("Maintenance record");
    const [already] = await tx
      .select({ id: siteMaintenanceRecords.id })
      .from(siteMaintenanceRecords)
      .where(eq(siteMaintenanceRecords.correctsRecordId, id));
    if (already) throw new ApiError(409, "already_corrected", "This record has already been corrected");
    const task = await findTask(tx, workspaceId, original.taskId);
    const { reason, ...fields } = input;
    return insertMaintenance(tx, workspaceId, actorId, task, fields, { original, reason });
  });
  return getMaintenanceRecord(db, workspaceId, newId);
}

/**
 * The hygiene clearance after maintenance in a production area: a person with `manage` says the
 * area is safe to restart (the route checks; tokens are refused), and not the person who did or
 * recorded the work unless they are the only manager. A one-time stamp.
 */
export async function clearMaintenance(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  input: HygieneClearanceInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [record] = await tx
      .select()
      .from(siteMaintenanceRecords)
      .where(and(eq(siteMaintenanceRecords.id, id), eq(siteMaintenanceRecords.workspaceId, workspaceId)));
    if (!record) throw notFound("Maintenance record");
    await assertNoHseIsolation(tx, workspaceId, record.assetId);
    if (!record.clearanceRequired) {
      throw new ApiError(409, "clearance_not_required", "This work didn't need return-to-service clearance");
    }
    const [corrected] = await tx
      .select({ id: siteMaintenanceRecords.id })
      .from(siteMaintenanceRecords)
      .where(eq(siteMaintenanceRecords.correctsRecordId, id));
    if (corrected) {
      throw new ApiError(
        409,
        "already_corrected",
        "A correction replaced this record; clear that one instead",
      );
    }
    if (record.clearedAt) throw new ApiError(409, "already_cleared", "This area has already been cleared");
    // Four-eyes: not whoever did the work or recorded it, unless the only manager.
    await assertFourEyes(
      tx,
      workspaceId,
      active,
      actorId,
      [record.doneBy, record.recordedBy],
      "did or recorded this work",
      "maintenance",
    );
    const [updated] = await tx
      .update(siteMaintenanceRecords)
      .set({ clearedAt: new Date(), clearedBy: actorId, clearanceNote: input.note ?? null })
      .where(and(eq(siteMaintenanceRecords.id, id), isNull(siteMaintenanceRecords.clearedAt)))
      .returning();
    if (!updated) throw new ApiError(409, "already_cleared", "This area has already been cleared");
    await recordChanges(tx, workspaceId, actorId, [change("site_maintenance_record", updated)]);
  });
  return getMaintenanceRecord(db, workspaceId, id);
}

// ─── Breakdowns and work orders ──────────────────────────────────────────────

type WorkOrderRow = typeof siteWorkOrders.$inferSelect;

async function describeWorkOrders(db: Executor, rows: WorkOrderRow[]) {
  if (rows.length === 0) return [];
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((t): t is string => !!t))];
  const [assets, tasks, areas, names] = await Promise.all([
    maintainedAssets(db).where(inArray(assetRegister.id, [...new Set(rows.map((r) => r.assetId))])),
    taskIds.length
      ? db
          .select({ id: siteMaintenanceTasks.id, title: siteMaintenanceTasks.title })
          .from(siteMaintenanceTasks)
          .where(inArray(siteMaintenanceTasks.id, taskIds))
      : Promise.resolve([] as { id: string; title: string }[]),
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    userNames(
      db,
      rows.flatMap((r) => [r.requestedBy, r.assignedTo, r.completedBy, r.doneBy, r.cancelledBy]),
    ),
  ]);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return rows.map((row) => {
    const asset = assetById.get(row.assetId);
    return {
      ...stripSoft(row),
      asset: asset ? { id: asset.id, code: asset.code, name: asset.name } : null,
      task: row.taskId ? (taskById.get(row.taskId) ?? null) : null,
      area: areaOf(areas, row.areaId),
      requestedByName: nameOf(names, row.requestedBy),
      assignedToName: nameOf(names, row.assignedTo),
      completedByName: nameOf(names, row.completedBy),
      doneByName: nameOf(names, row.doneBy),
      cancelledByName: nameOf(names, row.cancelledBy),
      isOpen: workOrderIsOpen(row.status),
      totalCost: workOrderTotalCost(row),
    };
  });
}

async function findWorkOrder(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(siteWorkOrders)
    .where(
      and(
        eq(siteWorkOrders.id, id),
        eq(siteWorkOrders.workspaceId, workspaceId),
        isNull(siteWorkOrders.deletedAt),
      ),
    );
  if (!row) throw notFound("Work order");
  return row;
}

function assertWorkOrderOpen(row: WorkOrderRow) {
  if (!workOrderIsOpen(row.status)) {
    throw new ApiError(409, "work_order_closed", `This work order is ${row.status} and can't change`);
  }
}

export async function getWorkOrder(db: Executor, workspaceId: string, id: string) {
  return (await describeWorkOrders(db, [await findWorkOrder(db, workspaceId, id)]))[0]!;
}

/** Open work orders first (most urgent, newest), then the closed ones, newest first. */
export async function listWorkOrders(db: Database, workspaceId: string, query: WorkOrderListQuery) {
  const where: (SQL | undefined)[] = [
    eq(siteWorkOrders.workspaceId, workspaceId),
    isNull(siteWorkOrders.deletedAt),
  ];
  if (query.status === "open") where.push(inArray(siteWorkOrders.status, ["requested", "in_progress"]));
  else if (query.status !== "all") where.push(eq(siteWorkOrders.status, query.status));
  if (query.assetId) where.push(eq(siteWorkOrders.assetId, query.assetId));
  if (query.priority) where.push(eq(siteWorkOrders.priority, query.priority));
  if (query.kind) where.push(eq(siteWorkOrders.kind, query.kind));
  const priorityRank = sql`case ${siteWorkOrders.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteWorkOrders)
      .where(and(...where))
      .orderBy(
        sql`(${siteWorkOrders.status} in ('requested', 'in_progress')) desc`,
        priorityRank,
        desc(siteWorkOrders.createdAt),
        desc(siteWorkOrders.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteWorkOrders)
      .where(and(...where)),
  ]);
  const p = page(await describeWorkOrders(db, rows), total?.n, query);
  return { workOrders: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

/** Raises a breakdown or work request (an API token may). The asset's area is copied. */
export async function createWorkOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: WorkOrderCreateInput,
  options: { source: SiteSource },
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const asset = await findMaintainedAsset(tx, workspaceId, input.assetId);
    if (asset.status === "archived") throw new ApiError(409, "asset_archived", `${asset.name} is archived`);
    if (input.taskId) {
      const task = await findTask(tx, workspaceId, input.taskId);
      if (task.assetId !== asset.id) throw badRequest("That task is on a different asset");
    }
    if (input.assignedTo) await assertMember(tx, workspaceId, input.assignedTo);
    const [row] = await tx
      .insert(siteWorkOrders)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        assetId: asset.id,
        taskId: input.taskId ?? null,
        areaId: asset.areaId,
        kind: input.kind,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        stopsProduction: input.stopsProduction,
        assignedTo: input.assignedTo ?? null,
        contractor: input.contractor ?? null,
        source: options.source,
        requestedBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_work_order", row!)]);
    return row!.id;
  });
  return getWorkOrder(db, workspaceId, id);
}

/** Edits an open work order, or starts it (`status: in_progress`). Closed ones never change. */
export async function updateWorkOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: WorkOrderUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await findWorkOrder(tx, workspaceId, id);
    assertWorkOrderOpen(row);
    if (patch.assignedTo) await assertMember(tx, workspaceId, patch.assignedTo);
    const starting = patch.status === "in_progress" && row.status !== "in_progress";
    const [updated] = await tx
      .update(siteWorkOrders)
      .set({ ...patch, ...(starting ? { startedAt: new Date() } : {}), updatedBy: actorId })
      .where(eq(siteWorkOrders.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_work_order", updated!)]);
  });
  return getWorkOrder(db, workspaceId, id);
}

/**
 * Completes a work order: what was done, the spares and costs. A person's attestation (the route
 * refuses tokens). Once.
 */
export async function completeWorkOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: WorkOrderCompleteInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await findWorkOrder(tx, workspaceId, id);
    assertWorkOrderOpen(row);
    const doneBy = input.doneBy ?? actorId;
    if (doneBy !== actorId) await assertMember(tx, workspaceId, doneBy);
    const completedAt = momentOf(input.completedAt, new Date());
    const [updated] = await tx
      .update(siteWorkOrders)
      .set({
        status: "completed",
        completedAt,
        completedBy: actorId,
        doneBy,
        workDone: input.workDone,
        downtimeMinutes: input.downtimeMinutes ?? null,
        // What was entered while the work was open stays unless the completion says otherwise.
        ...(input.sparesUsed !== undefined ? { sparesUsed: input.sparesUsed } : {}),
        ...(input.partsCost !== undefined ? { partsCost: input.partsCost } : {}),
        ...(input.labourCost !== undefined ? { labourCost: input.labourCost } : {}),
        ...(input.contractorCost !== undefined ? { contractorCost: input.contractorCost } : {}),
        updatedBy: actorId,
      })
      .where(and(eq(siteWorkOrders.id, id), inArray(siteWorkOrders.status, ["requested", "in_progress"])))
      .returning();
    if (!updated) throw new ApiError(409, "work_order_closed", "This work order has already been closed");
    await recordChanges(tx, workspaceId, actorId, [change("site_work_order", updated)]);
  });
  return getWorkOrder(db, workspaceId, id);
}

export async function cancelWorkOrder(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: WorkOrderCancelInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const row = await findWorkOrder(tx, workspaceId, id);
    assertWorkOrderOpen(row);
    const [updated] = await tx
      .update(siteWorkOrders)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: actorId,
        cancelReason: input.reason,
        updatedBy: actorId,
      })
      .where(eq(siteWorkOrders.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("site_work_order", updated!)]);
  });
  return getWorkOrder(db, workspaceId, id);
}

/** Active scheduled tasks for the Maintenance board, Site overview and reminders. */
export async function maintenanceDueItems(
  db: Database,
  workspaceId: string,
  today: string,
  timeZone: string,
): Promise<SiteDueItem[]> {
  const items: SiteDueItem[] = [];
  const tasks = await db
    .select()
    .from(siteMaintenanceTasks)
    .where(
      and(
        eq(siteMaintenanceTasks.workspaceId, workspaceId),
        isNull(siteMaintenanceTasks.deletedAt),
        eq(siteMaintenanceTasks.status, "active"),
      ),
    );
  const [last, assets] = await Promise.all([
    lastMaintenance(
      db,
      workspaceId,
      tasks.map((t) => t.id),
    ),
    tasks.length
      ? maintainedAssets(db).where(
          and(
            inArray(assetRegister.id, [...new Set(tasks.map((t) => t.assetId))]),
            eq(assetRegister.status, "active"),
            isNull(assetRegister.deletedAt),
          ),
        )
      : Promise.resolve([] as AssetRow[]),
  ]);
  const areas = await areasById(
    db,
    assets.map((a) => a.areaId),
  );
  const assetById = new Map(assets.map((a) => [a.id, a]));
  for (const task of tasks) {
    const asset = assetById.get(task.assetId);
    if (!asset) continue; // an archived asset isn't maintained
    const record = last.get(task.id) ?? null;
    const due = taskDue(task, record, today, timeZone);
    items.push({
      programme: "maintenance",
      subjectId: task.id,
      title: `${asset.name}: ${task.title}`,
      where: areaOf(areas, asset.areaId)?.name ?? asset.location ?? null,
      state: due.state,
      dueOn: due.dueOn,
      dueAt: null,
      lastAt: record?.completedAt.toISOString() ?? null,
      note: describeFrequency(taskFrequency(task)),
    });
  }
  return items;
}

export async function maintenanceCounts(db: Database, workspaceId: string) {
  const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [awaitingClearance, openWorkOrders] = await Promise.all([
    one(
      db
        .select({ n: count() })
        .from(siteMaintenanceRecords)
        .where(
          and(
            eq(siteMaintenanceRecords.workspaceId, workspaceId),
            eq(siteMaintenanceRecords.clearanceRequired, true),
            isNull(siteMaintenanceRecords.clearedAt),
            notCorrectedMaintenance,
          ),
        ),
    ),
    one(
      db
        .select({ n: count() })
        .from(siteWorkOrders)
        .where(
          and(
            eq(siteWorkOrders.workspaceId, workspaceId),
            inArray(siteWorkOrders.status, ["requested", "in_progress"]),
            isNull(siteWorkOrders.deletedAt),
          ),
        ),
    ),
  ]);
  return { awaitingClearance, openWorkOrders };
}
