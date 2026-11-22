/**
 * Dashboards module (`bi`): stored dashboard specs, their version history and frozen board
 * snapshots. See `@knotworking/core` bi/dashboard.ts.
 *
 * Definitions and their history are synced (`bi_dashboard`, `bi_dashboard_version`), filtered by
 * audience in `redactChanges`. Query results are never stored here; snapshot figures never enter
 * the sync log.
 */
import type { BiAudience, BiBoardPackItem, BiDashboardSpec, BiDashboardStatus } from "@knotworking/core";
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";

export const biDashboards = pgTable(
  "bi_dashboards",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** `workspace`, or `module:<id>` for a module's own dashboards. */
    scope: text("scope").notNull().default("workspace"),
    title: text("title").notNull(),
    description: text("description"),
    spec: jsonb("spec").$type<BiDashboardSpec>().notNull(),
    status: text("status").$type<BiDashboardStatus>().notNull().default("draft"),
    /** Who may open it once published. */
    audience: text("audience").$type<BiAudience>().notNull().default("workspace"),
    /** For audience `members`: the user ids named. */
    audienceUserIds: jsonb("audience_user_ids").$type<string[]>().notNull().default([]),
    /** Increases with every saved change of title, description, scope or spec. */
    version: integer("version").notNull().default(1),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    publishedAt: ts("published_at"),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    archivedAt: ts("archived_at"),
    archivedBy: uuid("archived_by").references(() => users.id, { onDelete: "set null" }),
    /** Offered as a starting point under "New dashboard" (to the people who can open it). */
    isTemplate: boolean("is_template").notNull().default(false),
    ...timestamps(),
  },
  (t) => [index("bi_dashboards_workspace_idx").on(t.workspaceId, t.scope, t.status)],
);

/** Every saved version of a dashboard: undo and audit. Append-only. */
export const biDashboardVersions = pgTable(
  "bi_dashboard_versions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => biDashboards.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    scope: text("scope").notNull(),
    spec: jsonb("spec").$type<BiDashboardSpec>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bi_dashboard_versions_key").on(t.dashboardId, t.version)],
);

/**
 * A board snapshot: a dashboard frozen "as at" a date, with its resolved results, the catalogue
 * version and the definition of every metric shown. Append-only; never re-queried (phase 7).
 */
export const biSnapshots = pgTable(
  "bi_snapshots",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    dashboardId: uuid("dashboard_id").references(() => biDashboards.id, { onDelete: "set null" }),
    dashboardVersion: integer("dashboard_version").notNull(),
    title: text("title").notNull(),
    asAt: date("as_at").notNull(),
    spec: jsonb("spec").$type<BiDashboardSpec>().notNull(),
    results: jsonb("results").$type<Record<string, unknown>>().notNull(),
    catalogueVersion: integer("catalogue_version").notNull(),
    definitions: jsonb("definitions").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * `dashboard`: a dashboard frozen as at a date. `analysis`: an agent analysis verified against
     * its sources (phase 9); its figures, sources and formulas are in `results.analysis`.
     */
    kind: text("kind").$type<"dashboard" | "analysis">().notNull().default("dashboard"),
    /** The view it was taken with: the period and filter values (`BiDashboardViewParams`). */
    view: jsonb("view").$type<Record<string, unknown>>().notNull().default({}),
    takenBy: uuid("taken_by").references(() => users.id, { onDelete: "set null" }),
    takenAt: ts("taken_at").notNull().defaultNow(),
  },
  (t) => [index("bi_snapshots_dashboard_idx").on(t.workspaceId, t.dashboardId, t.takenAt)],
);

/**
 * A board pack: an ordered set of snapshots with commentary, a cover and the definitions of every
 * figure (phase 7). Edited while a draft; once issued it never changes (a new pack replaces it).
 * Its header is synced (to managers and, once issued, its audience); figures stay in the snapshots.
 */
export const biBoardPacks = pgTable(
  "bi_board_packs",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    /** The meeting or reporting date the pack is for. */
    asAt: date("as_at").notNull(),
    /** Cover text: the purpose, the meeting, who it is for. Commentary, never figures. */
    cover: text("cover"),
    /** In order: each snapshot with the commentary shown above it. */
    items: jsonb("items").$type<BiBoardPackItem[]>().notNull().default([]),
    status: text("status").$type<"draft" | "issued">().notNull().default("draft"),
    audience: text("audience").$type<BiAudience>().notNull().default("members"),
    audienceUserIds: jsonb("audience_user_ids").$type<string[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    issuedAt: ts("issued_at"),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [index("bi_board_packs_workspace_idx").on(t.workspaceId, t.status)],
);
