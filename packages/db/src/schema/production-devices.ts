/**
 * Device adapters (3.5.4): line devices and the readings they send. See `@knotworking/core`
 * production-devices.ts. In its own file because it links production lines and packing checks to
 * HACCP equipment, and the HACCP schema already imports production's.
 */
import type { CalibrationState, DeviceKind, DeviceStatus, DeviceUnit } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { boolean, index, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { assets } from "./assets";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { productionLines, productionPackingChecks } from "./production";

/** A registered device. Retired, never deleted. */
export const productionDevices = pgTable(
  "production_devices",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Unique among live devices, case-insensitively: how a gateway names it. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<DeviceKind>().notNull(),
    /** The unit it reads in (measuring kinds). */
    unit: text("unit").$type<DeviceUnit>(),
    lineId: uuid("line_id").references(() => productionLines.id),
    /** HACCP equipment whose calibration records give this device's calibration state. */
    haccpAssetId: uuid("haccp_asset_id").references(() => assets.id),
    status: text("status").$type<DeviceStatus>().notNull().default("active"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("production_devices_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * A reading a device sent. Stored once per device reading id; `value` is in the device's unit
 * (converted from what was sent, which is kept). Becomes part of at most one record.
 */
export const productionDeviceReadings = pgTable(
  "production_device_readings",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => productionDevices.id),
    readingId: text("reading_id").notNull(),
    takenAt: ts("taken_at").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    value: numeric("value", { precision: 18, scale: 6, mode: "number" }).notNull(),
    sentValue: numeric("sent_value", { precision: 18, scale: 6, mode: "number" }).notNull(),
    sentUnit: text("sent_unit").$type<DeviceUnit>().notNull(),
    /** Received long after it was taken: buffered while offline. */
    late: boolean("late").notNull().default(false),
    calibrationState: text("calibration_state").$type<CalibrationState>().notNull(),
    /** The packing check it became part of. */
    appliedCheckId: uuid("applied_check_id").references(() => productionPackingChecks.id),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("production_device_readings_key").on(t.deviceId, t.readingId),
    index("production_device_readings_taken_idx").on(t.deviceId, t.takenAt),
  ],
);
