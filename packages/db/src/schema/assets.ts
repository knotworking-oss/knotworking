/**
 * Assets module (`assets`): one register of areas, equipment, vehicles, IT, tools and other assets.
 * See docs/modules.md and `@knotworking/core` assets.ts.
 *
 * Other modules keep their own settings per asset in extension tables keyed by the asset's id:
 * HACCP's cleaning and calibration schedule (`haccp_assets`) and Site's link to a calibration
 * instrument (`site_assets`). Areas (kind `area`) are where things are: Site's pest devices, glass
 * items, storage units and checklists, and an asset's parent area, all point at them.
 *
 * Archived, never deleted.
 */
import type { AssetKind, AssetStatus } from "@knotworking/core";
import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, workspaceRef } from "./helpers";

export const assets = pgTable(
  "assets",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    kind: text("kind").$type<AssetKind>().notNull(),
    /** Short reference or asset tag; unique (case-insensitive) among live assets when set. */
    code: text("code"),
    name: text("name").notNull(),
    /** The area (an asset of kind `area`) it is in. */
    parentAreaId: uuid("parent_area_id").references((): AnyPgColumn => assets.id),
    location: text("location"),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    purchasedOn: date("purchased_on"),
    purchaseCost: numeric("purchase_cost", { precision: 14, scale: 2, mode: "number" }),
    warrantyExpiresOn: date("warranty_expires_on"),
    /** The member who looks after it. */
    custodianId: uuid("custodian_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    status: text("status").$type<AssetStatus>().notNull().default("active"),
    /** Bumped on every change; an update may name the revision it was based on. */
    revision: integer("revision").notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    index("assets_workspace_idx").on(t.workspaceId, t.name),
    index("assets_workspace_kind_idx").on(t.workspaceId, t.kind, t.status),
    index("assets_parent_area_idx").on(t.parentAreaId),
    uniqueIndex("assets_workspace_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null and ${t.code} is not null`),
  ],
);
