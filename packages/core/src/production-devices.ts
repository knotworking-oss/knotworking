import { z } from "zod";

/**
 * Device adapters (Phase 3.5.4): a registry of line devices and a feed their readings arrive on,
 * added on top of workflows that already work by hand. Pure rules and validation schemas; no DOM
 * or Node APIs.
 *
 * - **Identity**: each device is registered (code, kind, unit); a reading names its device and
 *   carries the device's own reading id. Readings arrive through a person's or an integration's API
 *   token (a site gateway), never anonymously.
 * - **Units**: a device reads in one unit; a reading in another unit of the same dimension is
 *   converted, anything else is refused.
 * - **Calibration state**: a device may be linked to HACCP equipment; its state (in date, overdue,
 *   failed, unknown) comes from that equipment's calibration records as they stood when each
 *   reading was taken, and is stamped on it. Readings only become records (a weight sample) from a
 *   linked device whose calibration was in date then and is now.
 * - **Offline behaviour**: a device or gateway that was offline sends its buffered readings later
 *   with the time each was taken; they are accepted up to {@link READING_MAX_AGE_DAYS} old and marked
 *   late, and readings dated in the future beyond {@link READING_CLOCK_SKEW_SECONDS} are refused.
 * - **Duplicates**: the device's reading id is unique per device. Sending the same reading again is
 *   reported as a duplicate and stored once; the same id with a different value is a conflict and
 *   refused. A reading becomes part of at most one record.
 */

export const deviceKinds = [
  "scale",
  "checkweigher",
  "metal_detector",
  "temperature_probe",
  "scanner",
  "label_printer",
] as const;
export type DeviceKind = (typeof deviceKinds)[number];
export const deviceKindLabels: Record<DeviceKind, string> = {
  scale: "Scale",
  checkweigher: "Checkweigher",
  metal_detector: "Metal detector",
  temperature_probe: "Temperature probe",
  scanner: "Barcode scanner",
  label_printer: "Label printer",
};
/** Kinds whose readings are a measured value in a unit. */
export const measuringDeviceKinds: readonly DeviceKind[] = ["scale", "checkweigher", "temperature_probe"];

export const deviceUnits = ["g", "kg", "ml", "l", "°C"] as const;
export type DeviceUnit = (typeof deviceUnits)[number];
const unitFactor: Record<DeviceUnit, { dimension: string; toBase: number }> = {
  g: { dimension: "mass", toBase: 1 },
  kg: { dimension: "mass", toBase: 1000 },
  ml: { dimension: "volume", toBase: 1 },
  l: { dimension: "volume", toBase: 1000 },
  "°C": { dimension: "temperature", toBase: 1 },
};
/** Converts a value between units of one dimension; null when they can't convert. */
export function convertDeviceUnit(value: number, from: DeviceUnit, to: DeviceUnit): number | null {
  if (unitFactor[from].dimension !== unitFactor[to].dimension) return null;
  return Math.round(((value * unitFactor[from].toBase) / unitFactor[to].toBase) * 1e6) / 1e6;
}

/** The units each measuring kind may read in. */
export const deviceUnitsByKind: Partial<Record<DeviceKind, readonly DeviceUnit[]>> = {
  scale: ["g", "kg", "ml", "l"],
  checkweigher: ["g", "kg", "ml", "l"],
  temperature_probe: ["°C"],
};

export const deviceStatuses = ["active", "retired"] as const;
export type DeviceStatus = (typeof deviceStatuses)[number];

export const calibrationStates = ["in_date", "overdue", "failed", "unknown", "not_required"] as const;
export type CalibrationState = (typeof calibrationStates)[number];
export const calibrationStateLabels: Record<CalibrationState, string> = {
  in_date: "Calibration in date",
  overdue: "Calibration overdue",
  failed: "Last calibration failed",
  unknown: "No calibration on record",
  not_required: "Not linked to calibrated equipment",
};

/**
 * A device's calibration state from its HACCP equipment's latest calibration that hasn't been
 * corrected: failed, or passed and due again before `today` (overdue), or passed and in date.
 */
export function calibrationState(
  linked: boolean,
  latest: { passed: boolean; nextDueOn: string | null } | null,
  today: string,
): CalibrationState {
  if (!linked) return "not_required";
  if (!latest) return "unknown";
  if (!latest.passed) return "failed";
  if (latest.nextDueOn && latest.nextDueOn < today) return "overdue";
  return "in_date";
}

// ─── Feed rules ──────────────────────────────────────────────────────────────

export const READING_MAX_AGE_DAYS = 30;
export const READING_CLOCK_SKEW_SECONDS = 120;
/** Received this long after it was taken: marked late (it was buffered offline). */
export const READING_LATE_AFTER_SECONDS = 600;
export const READINGS_PER_REQUEST = 500;
/** Readings beyond this (in the device's unit) are refused as out of range: storage holds less. */
export const READING_VALUE_LIMIT = 1e11;
/** Readings are stored to 6 decimal places; resends compare the same way. */
export const roundReadingValue = (v: number) => Math.round(v * 1e6) / 1e6;

export type ReadingOutcome = "accepted" | "duplicate" | "conflict" | "rejected";

/** Whether a reading's time is acceptable on receipt, and whether it is late. */
export function readingTiming(
  takenAt: Date,
  receivedAt: Date,
): { ok: true; late: boolean } | { ok: false; reason: string } {
  const diff = (receivedAt.getTime() - takenAt.getTime()) / 1000;
  if (diff < -READING_CLOCK_SKEW_SECONDS)
    return { ok: false, reason: "Taken in the future: check the device's clock" };
  if (diff > READING_MAX_AGE_DAYS * 86_400)
    return { ok: false, reason: `Older than ${READING_MAX_AGE_DAYS} days` };
  return { ok: true, late: diff > READING_LATE_AFTER_SECONDS };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const code = z.string().trim().min(1).max(40);

export const deviceCreateSchema = z
  .object({
    code,
    name: z.string().trim().min(1).max(120),
    kind: z.enum(deviceKinds),
    /** Required for measuring kinds (scale, checkweigher, temperature probe). */
    unit: z.enum(deviceUnits).nullable().optional(),
    lineId: z.uuid().nullable().optional(),
    /** HACCP equipment whose calibration records give this device's calibration state. */
    haccpAssetId: z.uuid().nullable().optional(),
    note: z.string().trim().max(1000).default(""),
  })
  .strict()
  .refine((v) => !measuringDeviceKinds.includes(v.kind) || !!v.unit, {
    path: ["unit"],
    message: "A measuring device needs the unit it reads in",
  })
  .refine(
    (v) => !v.unit || !measuringDeviceKinds.includes(v.kind) || deviceUnitsByKind[v.kind]!.includes(v.unit),
    {
      path: ["unit"],
      message: "A scale or checkweigher reads in g, kg, ml or l; a temperature probe in °C",
    },
  );
export type DeviceCreateInput = z.infer<typeof deviceCreateSchema>;

export const deviceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    lineId: z.uuid().nullable().optional(),
    haccpAssetId: z.uuid().nullable().optional(),
    status: z.enum(deviceStatuses).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");
export type DeviceUpdateInput = z.infer<typeof deviceUpdateSchema>;

export const deviceReadingSchema = z
  .object({
    /** The device's own id for the reading (a sequence number, or its timestamp): unique per device. */
    readingId: z.string().trim().min(1).max(120),
    takenAt: z.iso.datetime({ offset: true }),
    value: z.number().finite().min(-1e9).max(1e9),
    unit: z.enum(deviceUnits),
  })
  .strict();
export type DeviceReadingInput = z.infer<typeof deviceReadingSchema>;

export const deviceReadingsPostSchema = z
  .object({ readings: z.array(deviceReadingSchema).min(1).max(READINGS_PER_REQUEST) })
  .strict();
export type DeviceReadingsPostInput = z.infer<typeof deviceReadingsPostSchema>;

export const deviceReadingsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  unused: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type DeviceReadingsQuery = z.infer<typeof deviceReadingsQuerySchema>;

/** A weight sample on a packing run made from a scale's or checkweigher's readings. */
export const packingWeightFromDeviceSchema = z
  .object({
    commandId: z.uuid().optional(),
    deviceId: z.uuid(),
    readingIds: z.array(z.uuid()).min(1).max(500),
    failureAction: z.string().trim().max(2000).optional(),
    note: z.string().trim().max(1000).default(""),
  })
  .strict()
  .refine((v) => new Set(v.readingIds).size === v.readingIds.length, "A reading can be used once");
export type PackingWeightFromDeviceInput = z.infer<typeof packingWeightFromDeviceSchema>;
