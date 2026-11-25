import {
  calibrationState,
  convertDeviceUnit,
  deviceKindLabels,
  measuringDeviceKinds,
  readingTiming,
  READING_VALUE_LIMIT,
  roundReadingValue,
  addFrequencyToDate,
  dateInZone,
  newId,
  type CalibrationState,
  type DeviceCreateInput,
  type DeviceReadingsPostInput,
  type DeviceReadingsQuery,
  type DeviceUpdateInput,
  type PackingWeightFromDeviceInput,
  type ReadingOutcome,
} from "@knotworking/core";
import {
  assets as assetRegister,
  haccpAssets,
  haccpCalibrationRecords,
  lockWorkspaceLog,
  productionDeviceReadings,
  productionDevices,
  recordChanges,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { getBatchPacking, insertPackingCheck, type PackingViewAccess } from "./production-packing";
import { findLine } from "./production-lines";
import { workspaceTimeZone } from "./time-zone";

/**
 * Device adapters (3.5.4): the registry of line devices and the feed their readings arrive on.
 * Rules in `@knotworking/core` production-devices.ts. A reading becomes a record only on purpose
 * (a weight sample from a scale's readings), and only while the device's calibration is in date.
 */

type DeviceRow = typeof productionDevices.$inferSelect;
type ReadingRow = typeof productionDeviceReadings.$inferSelect;

const strip = <T extends { workspaceId: string; deletedAt?: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _d, ...rest } = row;
  return rest;
};
const deviceChange = (row: DeviceRow): ChangeInput => ({
  entity: "production_device",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const readingChange = (row: ReadingRow): ChangeInput => ({
  entity: "production_device_reading",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function findDevice(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(productionDevices)
    .where(
      and(
        eq(productionDevices.id, id),
        eq(productionDevices.workspaceId, ws),
        isNull(productionDevices.deletedAt),
      ),
    );
  if (!row) throw notFound("Device");
  return row;
}

/**
 * Calibration of each device's linked equipment, evaluated at any instant: the latest calibration
 * record at or before it that no later record corrects (a correction replaces the record it
 * corrects), due again on its `nextDueOn` or, without one, its date plus the equipment's frequency
 * (as the HACCP schedule works it out). Retired or deleted equipment gives `unknown`.
 */
async function calibrationOf(db: Executor, ws: string, devices: readonly DeviceRow[]) {
  const assetIds = [...new Set(devices.map((d) => d.haccpAssetId).filter((id): id is string => !!id))];
  const assets = assetIds.length
    ? await db
        .select({
          id: assetRegister.id,
          status: assetRegister.status,
          deletedAt: assetRegister.deletedAt,
          calibrationEvery: haccpAssets.calibrationEvery,
          calibrationUnit: haccpAssets.calibrationUnit,
        })
        .from(assetRegister)
        .leftJoin(haccpAssets, eq(haccpAssets.id, assetRegister.id))
        .where(and(eq(assetRegister.workspaceId, ws), inArray(assetRegister.id, assetIds)))
    : [];
  const records = assetIds.length
    ? await db
        .select()
        .from(haccpCalibrationRecords)
        .where(
          and(
            eq(haccpCalibrationRecords.workspaceId, ws),
            inArray(haccpCalibrationRecords.assetId, assetIds),
          ),
        )
        .orderBy(desc(haccpCalibrationRecords.calibratedAt), desc(haccpCalibrationRecords.createdAt))
    : [];
  const corrected = new Set(records.map((r) => r.correctsRecordId).filter(Boolean));
  const live = records.filter((r) => !corrected.has(r.id));
  const timeZone = await workspaceTimeZone(db, ws);
  return (device: DeviceRow, at: Date) => {
    if (!device.haccpAssetId)
      return { state: "not_required" as CalibrationState, lastCalibratedAt: null, nextDueOn: null };
    const asset = assets.find((a) => a.id === device.haccpAssetId);
    if (!asset || asset.deletedAt || asset.status !== "active")
      return { state: "unknown" as CalibrationState, lastCalibratedAt: null, nextDueOn: null };
    const r = live.find((x) => x.assetId === asset.id && x.calibratedAt <= at);
    const frequency =
      asset.calibrationEvery !== null && asset.calibrationUnit !== null
        ? { every: asset.calibrationEvery, unit: asset.calibrationUnit }
        : null;
    const nextDueOn = r
      ? (r.nextDueOn ??
        (frequency ? addFrequencyToDate(dateInZone(r.calibratedAt, timeZone), frequency) : null))
      : null;
    return {
      state: calibrationState(true, r ? { passed: r.passed, nextDueOn } : null, dateInZone(at, timeZone)),
      lastCalibratedAt: r?.calibratedAt ?? null,
      nextDueOn,
    };
  };
}

/**
 * Devices as a reader sees them. The calibration state is production information (it decides
 * whether readings may become records); the equipment link and its dates are HACCP's, shown only
 * to HACCP readers.
 */
async function deviceViews(db: Executor, ws: string, devices: DeviceRow[], haccp: boolean) {
  const calibration = await calibrationOf(db, ws, devices);
  const now = new Date();
  const lastReadings = devices.length
    ? await db
        .select({
          deviceId: productionDeviceReadings.deviceId,
          last: sql<Date | null>`max(${productionDeviceReadings.receivedAt})`,
        })
        .from(productionDeviceReadings)
        .where(
          inArray(
            productionDeviceReadings.deviceId,
            devices.map((d) => d.id),
          ),
        )
        .groupBy(productionDeviceReadings.deviceId)
    : [];
  return devices.map((d) => {
    const c = calibration(d, now);
    return {
      ...strip(d),
      haccpAssetId: haccp ? d.haccpAssetId : null,
      linkedToEquipment: !!d.haccpAssetId,
      kindLabel: deviceKindLabels[d.kind],
      calibration: haccp ? c : { state: c.state, lastCalibratedAt: null, nextDueOn: null },
      lastReceivedAt: lastReadings.find((r) => r.deviceId === d.id)?.last ?? null,
    };
  });
}

/** Whether the caller may read the HACCP module (active and readable): its equipment and dates. */
export type DeviceAccess = { haccp: boolean };

export async function listDevices(db: Executor, ws: string, access: DeviceAccess) {
  const rows = await db
    .select()
    .from(productionDevices)
    .where(and(eq(productionDevices.workspaceId, ws), isNull(productionDevices.deletedAt)))
    .orderBy(asc(productionDevices.code));
  return { devices: await deviceViews(db, ws, rows, access.haccp) };
}

async function assertCodeFree(db: Executor, ws: string, code: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: productionDevices.id })
    .from(productionDevices)
    .where(
      and(
        eq(productionDevices.workspaceId, ws),
        isNull(productionDevices.deletedAt),
        sql`lower(${productionDevices.code}) = ${code.toLowerCase()}`,
        exceptId ? ne(productionDevices.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another device already has the code ${code}`);
}

/**
 * Linking HACCP equipment needs HACCP access: the equipment is that module's record. An area,
 * retired or deleted equipment reads as not found, without naming it.
 */
async function assertAsset(db: Executor, ws: string, id: string, access: DeviceAccess) {
  if (!access.haccp)
    throw new ApiError(
      403,
      "haccp_access_required",
      "Linking calibrated equipment needs access to the HACCP module",
    );
  const [asset] = await db
    .select({ kind: assetRegister.kind, status: assetRegister.status })
    .from(assetRegister)
    .where(and(eq(assetRegister.id, id), eq(assetRegister.workspaceId, ws), isNull(assetRegister.deletedAt)));
  if (!asset || asset.kind !== "equipment" || asset.status !== "active") throw notFound("Equipment");
}

export async function createDevice(
  db: Database,
  ws: string,
  actor: string,
  input: DeviceCreateInput,
  access: DeviceAccess,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    await assertCodeFree(tx, ws, input.code);
    if (input.lineId) await findLine(tx, ws, input.lineId);
    if (input.haccpAssetId) await assertAsset(tx, ws, input.haccpAssetId, access);
    const [row] = await tx
      .insert(productionDevices)
      .values({
        workspaceId: ws,
        code: input.code,
        name: input.name,
        kind: input.kind,
        unit: measuringDeviceKinds.includes(input.kind) ? (input.unit ?? null) : null,
        lineId: input.lineId ?? null,
        haccpAssetId: input.haccpAssetId ?? null,
        note: input.note || null,
        createdBy: actor,
      })
      .returning();
    await recordChanges(tx, ws, actor, [deviceChange(row!)]);
    return row!.id;
  });
  return (await deviceViews(db, ws, [await findDevice(db, ws, id)], access.haccp))[0]!;
}

export async function updateDevice(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  patch: DeviceUpdateInput,
  access: DeviceAccess,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const current = await findDevice(tx, ws, id);
    if (patch.lineId) await findLine(tx, ws, patch.lineId);
    if (patch.haccpAssetId) await assertAsset(tx, ws, patch.haccpAssetId, access);
    // Unlinking is a change to HACCP's link too.
    else if (patch.haccpAssetId === null && current.haccpAssetId && !access.haccp)
      throw new ApiError(
        403,
        "haccp_access_required",
        "Unlinking calibrated equipment needs access to the HACCP module",
      );
    const [row] = await tx
      .update(productionDevices)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.lineId !== undefined ? { lineId: patch.lineId } : {}),
        ...(patch.haccpAssetId !== undefined ? { haccpAssetId: patch.haccpAssetId } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.note !== undefined ? { note: patch.note || null } : {}),
      })
      .where(eq(productionDevices.id, id))
      .returning();
    await recordChanges(tx, ws, actor, [deviceChange(row!)]);
  });
  return (await deviceViews(db, ws, [await findDevice(db, ws, id)], access.haccp))[0]!;
}

/**
 * Takes a batch of readings from a device (or the gateway it's connected to), including readings
 * buffered while offline. Each reading is accepted, a duplicate (same reading id and value: stored
 * once), a conflict (same id, different value: refused) or rejected (with the reason). Nothing is
 * refused as a whole for one bad reading.
 */
export async function postDeviceReadings(
  db: Database,
  ws: string,
  actor: string,
  deviceId: string,
  input: DeviceReadingsPostInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, ws);
    const device = await findDevice(tx, ws, deviceId);
    if (device.status !== "active")
      throw new ApiError(409, "device_retired", `${device.code} is retired: its readings aren't taken`);
    if (!device.unit)
      throw new ApiError(
        409,
        "device_not_measuring",
        `${device.code} is a ${deviceKindLabels[device.kind].toLowerCase()}: it doesn't send measured readings`,
      );
    // Each reading is stamped with the calibration state when it was taken, not when it arrived:
    // a reading buffered through a failed calibration stays failed after a later pass.
    const calibration = await calibrationOf(tx, ws, [device]);
    const existing = await tx
      .select()
      .from(productionDeviceReadings)
      .where(
        and(
          eq(productionDeviceReadings.deviceId, deviceId),
          inArray(productionDeviceReadings.readingId, [...new Set(input.readings.map((r) => r.readingId))]),
        ),
      );
    type Known = { id: string; sentValue: number; sentUnit: string; takenAt: Date };
    const known = new Map<string, Known>(existing.map((r) => [r.readingId, r]));
    const receivedAt = new Date();
    const results: {
      readingId: string;
      outcome: ReadingOutcome;
      id?: string;
      late?: boolean;
      reason?: string;
    }[] = [];
    const rows: (typeof productionDeviceReadings.$inferInsert)[] = [];
    for (const r of input.readings) {
      const takenAt = new Date(r.takenAt);
      // Stored to 6 decimal places: compared the same way, so an exact resend is a duplicate.
      const sent = roundReadingValue(r.value);
      const prior = known.get(r.readingId);
      if (prior) {
        const same = prior.sentValue === sent && prior.sentUnit === r.unit && +prior.takenAt === +takenAt;
        results.push(
          same
            ? { readingId: r.readingId, outcome: "duplicate", id: prior.id }
            : {
                readingId: r.readingId,
                outcome: "conflict",
                id: prior.id,
                reason: "This reading id was already received with a different value, unit or time",
              },
        );
        continue;
      }
      const timing = readingTiming(takenAt, receivedAt);
      if (!timing.ok) {
        results.push({ readingId: r.readingId, outcome: "rejected", reason: timing.reason });
        continue;
      }
      const value = convertDeviceUnit(sent, r.unit, device.unit);
      if (value === null) {
        results.push({
          readingId: r.readingId,
          outcome: "rejected",
          reason: `${r.unit} doesn't convert to ${device.unit}, the unit ${device.code} reads in`,
        });
        continue;
      }
      if (Math.abs(value) >= READING_VALUE_LIMIT) {
        results.push({ readingId: r.readingId, outcome: "rejected", reason: "Out of range" });
        continue;
      }
      const id = newId();
      rows.push({
        id,
        workspaceId: ws,
        deviceId,
        readingId: r.readingId,
        takenAt,
        receivedAt,
        value,
        sentValue: sent,
        sentUnit: r.unit,
        late: timing.late,
        calibrationState: calibration(device, takenAt).state,
        recordedBy: actor,
      });
      known.set(r.readingId, { id, sentValue: sent, sentUnit: r.unit, takenAt });
      results.push({ readingId: r.readingId, outcome: "accepted", id, late: timing.late });
    }
    // One insert for the batch, so the workspace lock is held briefly.
    const inserted = rows.length ? await tx.insert(productionDeviceReadings).values(rows).returning() : [];
    if (inserted.length) await recordChanges(tx, ws, actor, inserted.map(readingChange));
    const count = (o: ReadingOutcome) => results.filter((r) => r.outcome === o).length;
    return {
      deviceId,
      // The device's state now; each reading carries its own state at the time it was taken.
      calibrationState: calibration(device, receivedAt).state,
      accepted: count("accepted"),
      duplicate: count("duplicate"),
      conflict: count("conflict"),
      rejected: count("rejected"),
      late: results.filter((r) => r.late).length,
      results,
    };
  });
}

export async function listDeviceReadings(
  db: Executor,
  ws: string,
  deviceId: string,
  q: DeviceReadingsQuery,
  access: DeviceAccess,
) {
  const device = await findDevice(db, ws, deviceId);
  const rows = await db
    .select()
    .from(productionDeviceReadings)
    .where(
      and(
        eq(productionDeviceReadings.workspaceId, ws),
        eq(productionDeviceReadings.deviceId, deviceId),
        q.from ? gte(productionDeviceReadings.takenAt, new Date(q.from)) : undefined,
        q.to ? lte(productionDeviceReadings.takenAt, new Date(q.to)) : undefined,
        q.unused === "true" ? isNull(productionDeviceReadings.appliedCheckId) : undefined,
      ),
    )
    .orderBy(desc(productionDeviceReadings.takenAt))
    .limit(q.limit);
  return {
    device: (await deviceViews(db, ws, [device], access.haccp))[0]!,
    readings: rows.map((r) => strip(r)),
  };
}

const usable: readonly CalibrationState[] = ["in_date"];

/**
 * A weight sample on an open packing run from a scale's or checkweigher's readings. The device must
 * be linked to calibrated equipment that is in date now, each reading must have been taken while it
 * was (each is stamped with the state at the time it was taken) and after the run opened, and none
 * may already be part of a record. A retired device's earlier readings may still be used.
 */
export async function recordWeightFromDevice(
  db: Database,
  ws: string,
  actor: string,
  runId: string,
  input: PackingWeightFromDeviceInput,
  view: PackingViewAccess,
) {
  const batchId = await executeLedgerCommand(
    db,
    ws,
    actor,
    "recordWeightFromDevice",
    input,
    { runId, input },
    async (tx) => {
      const device = await findDevice(tx, ws, input.deviceId);
      if (device.kind !== "scale" && device.kind !== "checkweigher")
        throw new ApiError(409, "device_not_a_scale", `${device.code} is not a scale or checkweigher`);
      if (device.unit !== "g" && device.unit !== "kg" && device.unit !== "ml" && device.unit !== "l")
        throw new ApiError(409, "device_unit", `${device.code} doesn't weigh in g, kg, ml or l`);
      const now = (await calibrationOf(tx, ws, [device]))(device, new Date()).state;
      if (now === "not_required")
        throw new ApiError(
          409,
          "device_not_calibrated",
          `${device.code} isn't linked to calibrated equipment: link it under Devices before its readings become records`,
        );
      if (!usable.includes(now))
        throw new ApiError(
          409,
          "device_calibration",
          `${device.code}: ${now.replace("_", " ")}. Readings become records only while calibration is in date`,
        );
      const rows = await tx
        .select()
        .from(productionDeviceReadings)
        .where(
          and(
            eq(productionDeviceReadings.workspaceId, ws),
            eq(productionDeviceReadings.deviceId, device.id),
            inArray(productionDeviceReadings.id, input.readingIds),
          ),
        );
      if (rows.length !== input.readingIds.length) throw notFound("Reading");
      if (rows.some((r) => r.appliedCheckId))
        throw new ApiError(409, "reading_used", "A reading is already part of another check");
      if (rows.some((r) => !usable.includes(r.calibrationState)))
        throw new ApiError(
          409,
          "device_calibration",
          "A reading was taken while the device's calibration wasn't in date",
        );
      const ordered = input.readingIds.map((id) => rows.find((r) => r.id === id)!);
      const small = device.unit === "kg" || device.unit === "l" ? 1000 : 1;
      // The same bounds as a weight sample entered by hand (a tare or zero reading isn't a pack).
      const bad = ordered.find((r) => !(r.value * small > 0 && r.value * small <= 100_000));
      if (bad)
        throw new ApiError(
          409,
          "reading_out_of_range",
          `Reading ${bad.readingId} (${bad.value} ${device.unit}) isn't a pack weight between 0 and 100 kg`,
        );
      const { check, run } = await insertPackingCheck(
        tx,
        ws,
        actor,
        runId,
        {
          kind: "weight_sample",
          readings: ordered.map((r) => Math.round(r.value * small * 1000) / 1000),
          failureAction: input.failureAction,
          note: input.note,
        },
        { deviceId: device.id, deviceCode: device.code, deviceReadingIds: input.readingIds },
      );
      if (ordered.some((r) => r.takenAt < run.openedAt))
        throw new ApiError(409, "reading_before_run", "A reading was taken before this packing run started");
      const applied = await tx
        .update(productionDeviceReadings)
        .set({ appliedCheckId: check.id })
        .where(inArray(productionDeviceReadings.id, input.readingIds))
        .returning();
      await recordChanges(tx, ws, actor, applied.map(readingChange));
      return run.batchId;
    },
  );
  return getBatchPacking(db, ws, batchId, view);
}
