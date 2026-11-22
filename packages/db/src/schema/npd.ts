/**
 * Product development module: projects (the brief, stage, links to the item and recipe, people's
 * sign-offs) and their trials. See docs/modules.md and `@knotworking/core` npd.ts.
 */
import type {
  NpdSignoffs,
  NpdStatus,
  NpdTrialKind,
  NpdTrialOutcome,
  StorageCondition,
} from "@knotworking/core";
import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { items } from "./items";
import { recipes, recipeVersions } from "./recipes";

export const npdProjects = pgTable(
  "npd_projects",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<NpdStatus>().notNull().default("brief"),
    brief: text("brief"),
    customerName: text("customer_name"),
    targetLaunchOn: date("target_launch_on"),
    targetCost: numeric("target_cost", { precision: 14, scale: 4, mode: "number" }),
    targetShelfLifeDays: integer("target_shelf_life_days"),
    storage: text("storage").$type<StorageCondition>(),
    claims: jsonb("claims").$type<string[]>().notNull().default([]),
    constraints: text("constraints"),
    outputItemId: uuid("output_item_id").references(() => items.id),
    recipeId: uuid("recipe_id").references(() => recipes.id),
    /** HACCP review, artwork and customer sign-offs, each with who signed and who recorded it. */
    signoffs: jsonb("signoffs").$type<NpdSignoffs>().notNull().default({}),
    launchedAt: ts("launched_at"),
    launchedBy: uuid("launched_by").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("npd_projects_code_key")
      .on(t.workspaceId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} is null`),
    index("npd_projects_status_idx").on(t.workspaceId, t.status),
  ],
);

export const npdTrials = pgTable(
  "npd_trials",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => npdProjects.id, { onDelete: "cascade" }),
    /** 1, 2, … per project. */
    trialNumber: integer("trial_number").notNull(),
    kind: text("kind").$type<NpdTrialKind>().notNull(),
    heldOn: date("held_on").notNull(),
    description: text("description").notNull(),
    recipeVersionId: uuid("recipe_version_id").references(() => recipeVersions.id),
    outcome: text("outcome").$type<NpdTrialOutcome>().notNull(),
    findings: text("findings"),
    achievedShelfLifeDays: integer("achieved_shelf_life_days"),
    storage: text("storage").$type<StorageCondition>(),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("npd_trials_number_key").on(t.projectId, t.trialNumber)],
);
