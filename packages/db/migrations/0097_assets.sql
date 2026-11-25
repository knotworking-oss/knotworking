CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"parent_area_id" uuid,
	"location" text,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"purchased_on" date,
	"purchase_cost" numeric(14, 2),
	"warranty_expires_on" date,
	"custodian_id" uuid,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "production_devices" DROP CONSTRAINT "production_devices_haccp_asset_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" DROP CONSTRAINT "haccp_calibration_records_asset_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" DROP CONSTRAINT "haccp_cleaning_records_asset_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_assets" DROP CONSTRAINT "site_assets_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_assets" DROP CONSTRAINT "site_assets_calibration_instrument_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_checklist_checks" DROP CONSTRAINT "site_checklist_checks_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_checklist_templates" DROP CONSTRAINT "site_checklist_templates_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_glass_breakages" DROP CONSTRAINT "site_glass_breakages_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_glass_checks" DROP CONSTRAINT "site_glass_checks_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_glass_items" DROP CONSTRAINT "site_glass_items_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_maintenance_records" DROP CONSTRAINT "site_maintenance_records_asset_id_site_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_maintenance_records" DROP CONSTRAINT "site_maintenance_records_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_maintenance_tasks" DROP CONSTRAINT "site_maintenance_tasks_asset_id_site_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_pest_devices" DROP CONSTRAINT "site_pest_devices_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_storage_units" DROP CONSTRAINT "site_storage_units_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_work_orders" DROP CONSTRAINT "site_work_orders_asset_id_site_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "site_work_orders" DROP CONSTRAINT "site_work_orders_area_id_haccp_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "hse_permits" DROP CONSTRAINT "hse_permits_asset_id_site_assets_id_fk";
--> statement-breakpoint
DROP INDEX "haccp_assets_workspace_idx";--> statement-breakpoint
DROP INDEX "haccp_assets_workspace_code_key";--> statement-breakpoint
DROP INDEX "site_assets_workspace_idx";--> statement-breakpoint
DROP INDEX "site_assets_workspace_code_key";
--> statement-breakpoint
-- Data: one asset register. Every row of the HACCP register (areas and equipment) and of the
-- maintained assets becomes an asset with the same id, so every reference to it still holds once
-- the foreign keys below point at "assets". Both old tables stay as extension tables keyed by the
-- asset's id: "haccp_assets" keeps the cleaning and calibration schedule, "site_assets" the link
-- to a calibration instrument. Their generic columns are dropped at the end, after the copy.
INSERT INTO "assets" ("id", "workspace_id", "kind", "code", "name", "location", "status", "created_at", "updated_at", "deleted_at")
SELECT "id", "workspace_id", "kind", "code", "name", "location", "status", "created_at", "updated_at", "deleted_at"
FROM "haccp_assets";
--> statement-breakpoint
-- Maintained assets become equipment in the same area. Codes were unique per register, not across
-- both: a live maintained asset whose code a live HACCP asset already uses (case-insensitive) is
-- renamed to "<code>-M", or "<code>-M-<first 8 characters of its id>" when that is taken too. HACCP
-- codes never change (they are printed on probes and cleaning schedules).
INSERT INTO "assets" ("id", "workspace_id", "kind", "code", "name", "parent_area_id", "location", "status", "created_at", "updated_at", "deleted_at")
SELECT
  s."id",
  s."workspace_id",
  'equipment',
  CASE
    WHEN s."code" IS NULL OR s."deleted_at" IS NOT NULL THEN s."code"
    WHEN NOT EXISTS (
      SELECT 1 FROM "haccp_assets" h
      WHERE h."workspace_id" = s."workspace_id" AND h."deleted_at" IS NULL AND lower(h."code") = lower(s."code")
    ) THEN s."code"
    WHEN NOT EXISTS (
      SELECT 1 FROM "haccp_assets" h
      WHERE h."workspace_id" = s."workspace_id" AND h."deleted_at" IS NULL AND lower(h."code") = lower(s."code" || '-M')
    ) AND NOT EXISTS (
      SELECT 1 FROM "site_assets" o
      WHERE o."workspace_id" = s."workspace_id" AND o."deleted_at" IS NULL AND o."id" <> s."id"
        AND lower(o."code") = lower(s."code" || '-M')
    ) THEN s."code" || '-M'
    ELSE s."code" || '-M-' || left(s."id"::text, 8)
  END,
  s."name",
  s."area_id",
  s."location",
  s."status",
  s."created_at",
  s."updated_at",
  s."deleted_at"
FROM "site_assets" s;
--> statement-breakpoint
-- HACCP and Site now need Assets. Keep everyone who could use either: a member's explicit grant
-- in "haccp" or "site" gives the same level in "assets" (the higher of the two).
INSERT INTO "member_module_access" ("id", "workspace_id", "user_id", "module_id", "level")
SELECT
  gen_random_uuid(),
  g."workspace_id",
  g."user_id",
  'assets',
  (ARRAY['read', 'write', 'manage'])[g."rank"]
FROM (
  SELECT "workspace_id", "user_id",
    max(CASE "level" WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'manage' THEN 3 ELSE 0 END) AS "rank"
  FROM "member_module_access"
  WHERE "module_id" IN ('haccp', 'site') AND "deleted_at" IS NULL
  GROUP BY "workspace_id", "user_id"
) g
WHERE g."rank" > 0
ON CONFLICT ("workspace_id", "user_id", "module_id") DO NOTHING;
--> statement-breakpoint
-- A workspace's own module selection, an API token's module allowlist and the assistant's modules
-- that name HACCP or Site name Assets too, so neither is switched off by the new dependency.
UPDATE "workspaces" SET "enabled_modules" = array_append("enabled_modules", 'assets')
WHERE "enabled_modules" IS NOT NULL
  AND "enabled_modules" && ARRAY['haccp', 'site']::text[]
  AND NOT ('assets' = ANY("enabled_modules"));
--> statement-breakpoint
UPDATE "api_tokens" SET "modules" = "modules" || '["assets"]'::jsonb
WHERE jsonb_typeof("modules") = 'array'
  AND ("modules" ? 'haccp' OR "modules" ? 'site')
  AND NOT ("modules" ? 'assets');
--> statement-breakpoint
UPDATE "assistant_settings" SET "modules" = "modules" || '["assets"]'::jsonb
WHERE jsonb_typeof("modules") = 'array'
  AND ("modules" ? 'haccp' OR "modules" ? 'site')
  AND NOT ("modules" ? 'assets');
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_parent_area_id_assets_id_fk" FOREIGN KEY ("parent_area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_workspace_idx" ON "assets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "assets_workspace_kind_idx" ON "assets" USING btree ("workspace_id","kind","status");--> statement-breakpoint
CREATE INDEX "assets_parent_area_idx" ON "assets" USING btree ("parent_area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_workspace_code_key" ON "assets" USING btree ("workspace_id",lower("code")) WHERE "assets"."deleted_at" is null and "assets"."code" is not null;--> statement-breakpoint
ALTER TABLE "production_devices" ADD CONSTRAINT "production_devices_haccp_asset_id_assets_id_fk" FOREIGN KEY ("haccp_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_assets" ADD CONSTRAINT "haccp_assets_id_assets_id_fk" FOREIGN KEY ("id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" ADD CONSTRAINT "haccp_calibration_records_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD CONSTRAINT "haccp_cleaning_records_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_id_assets_id_fk" FOREIGN KEY ("id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_calibration_instrument_id_assets_id_fk" FOREIGN KEY ("calibration_instrument_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_templates" ADD CONSTRAINT "site_checklist_templates_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_checks" ADD CONSTRAINT "site_glass_checks_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_items" ADD CONSTRAINT "site_glass_items_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_tasks" ADD CONSTRAINT "site_maintenance_tasks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_devices" ADD CONSTRAINT "site_pest_devices_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_units" ADD CONSTRAINT "site_storage_units_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_area_id_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_permits" ADD CONSTRAINT "hse_permits_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_assets" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "haccp_assets" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "haccp_assets" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "haccp_assets" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "haccp_assets" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "haccp_assets" DROP COLUMN "deleted_at";--> statement-breakpoint
ALTER TABLE "site_assets" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "site_assets" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "site_assets" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "site_assets" DROP COLUMN "area_id";--> statement-breakpoint
ALTER TABLE "site_assets" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "site_assets" DROP COLUMN "deleted_at";