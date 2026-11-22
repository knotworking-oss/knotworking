CREATE TABLE "site_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"location" text,
	"area_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_checklist_check_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"item_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"prompt" text NOT NULL,
	"result" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_checklist_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_name" text NOT NULL,
	"kind" text NOT NULL,
	"area_id" uuid,
	"line" text,
	"performed_at" timestamp with time zone NOT NULL,
	"performed_by" uuid,
	"outcome" text NOT NULL,
	"note" text,
	"previous_batch_id" uuid,
	"next_batch_id" uuid,
	"sign_off_status" text DEFAULT 'pending' NOT NULL,
	"signed_off_by" uuid,
	"signed_off_at" timestamp with time zone,
	"sign_off_note" text,
	"corrects_check_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_checklist_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"prompt" text NOT NULL,
	"guidance" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_checklist_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"area_id" uuid,
	"line" text,
	"frequency_every" integer,
	"frequency_unit" text,
	"during_production" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_corrective_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"reading_id" uuid,
	"action_taken" text,
	"root_cause" text,
	"preventive_action" text,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"raised_by" uuid,
	"updated_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closure_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_glass_breakages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"item_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"quarantined" text NOT NULL,
	"clean_down" text,
	"clean_down_at" timestamp with time zone,
	"clean_down_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"raised_by" uuid,
	"updated_by" uuid,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_glass_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"condition" text NOT NULL,
	"note" text,
	"checked_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"corrects_check_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_glass_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"location" text,
	"check_every" integer NOT NULL,
	"check_unit" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_maintenance_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"area_id" uuid,
	"completed_at" timestamp with time zone NOT NULL,
	"done_by" uuid,
	"contractor" text,
	"work_done" text,
	"next_due_on" date NOT NULL,
	"note" text,
	"clearance_required" boolean DEFAULT false NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid,
	"clearance_note" text,
	"recorded_by" uuid,
	"corrects_record_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_maintenance_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"frequency_every" integer NOT NULL,
	"frequency_unit" text NOT NULL,
	"start_on" date,
	"clearance_required" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_pest_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"location" text NOT NULL,
	"area_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "site_pest_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"device_id" uuid,
	"location" text,
	"activity" text NOT NULL,
	"pest" text,
	"count" integer,
	"note" text,
	"action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_pest_visits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contractor" text NOT NULL,
	"technician" text,
	"visited_on" date NOT NULL,
	"summary" text,
	"recommendations" text,
	"actions_taken" text,
	"next_visit_on" date,
	"source" text DEFAULT 'manual' NOT NULL,
	"recorded_by" uuid,
	"corrects_visit_id" uuid,
	"correction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_storage_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"value" numeric(14, 4) NOT NULL,
	"limit_min" numeric(14, 4),
	"limit_max" numeric(14, 4),
	"unit" text NOT NULL,
	"within_limits" boolean NOT NULL,
	"deviation_reason" text,
	"note" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"corrects_reading_id" uuid,
	"correction_reason" text,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_storage_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"location" text,
	"area_id" uuid,
	"limit_min" numeric(14, 4),
	"limit_max" numeric(14, 4),
	"unit" text DEFAULT '°C' NOT NULL,
	"reading_every" integer NOT NULL,
	"reading_unit" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_check_items" ADD CONSTRAINT "site_checklist_check_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_check_items" ADD CONSTRAINT "site_checklist_check_items_check_id_site_checklist_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."site_checklist_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_check_items" ADD CONSTRAINT "site_checklist_check_items_item_id_site_checklist_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."site_checklist_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_template_id_site_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."site_checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_previous_batch_id_production_batches_id_fk" FOREIGN KEY ("previous_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_next_batch_id_production_batches_id_fk" FOREIGN KEY ("next_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_signed_off_by_users_id_fk" FOREIGN KEY ("signed_off_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_checks" ADD CONSTRAINT "site_checklist_checks_corrects_check_id_site_checklist_checks_id_fk" FOREIGN KEY ("corrects_check_id") REFERENCES "public"."site_checklist_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_items" ADD CONSTRAINT "site_checklist_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_items" ADD CONSTRAINT "site_checklist_items_template_id_site_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."site_checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_templates" ADD CONSTRAINT "site_checklist_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checklist_templates" ADD CONSTRAINT "site_checklist_templates_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_corrective_actions" ADD CONSTRAINT "site_corrective_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_corrective_actions" ADD CONSTRAINT "site_corrective_actions_reading_id_site_storage_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."site_storage_readings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_corrective_actions" ADD CONSTRAINT "site_corrective_actions_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_corrective_actions" ADD CONSTRAINT "site_corrective_actions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_corrective_actions" ADD CONSTRAINT "site_corrective_actions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_item_id_site_glass_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."site_glass_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_clean_down_by_users_id_fk" FOREIGN KEY ("clean_down_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_breakages" ADD CONSTRAINT "site_glass_breakages_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_checks" ADD CONSTRAINT "site_glass_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_checks" ADD CONSTRAINT "site_glass_checks_item_id_site_glass_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."site_glass_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_checks" ADD CONSTRAINT "site_glass_checks_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_checks" ADD CONSTRAINT "site_glass_checks_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_checks" ADD CONSTRAINT "site_glass_checks_corrects_check_id_site_glass_checks_id_fk" FOREIGN KEY ("corrects_check_id") REFERENCES "public"."site_glass_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_items" ADD CONSTRAINT "site_glass_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_glass_items" ADD CONSTRAINT "site_glass_items_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_task_id_site_maintenance_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."site_maintenance_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_asset_id_site_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."site_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_records" ADD CONSTRAINT "site_maintenance_records_corrects_record_id_site_maintenance_records_id_fk" FOREIGN KEY ("corrects_record_id") REFERENCES "public"."site_maintenance_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_tasks" ADD CONSTRAINT "site_maintenance_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_maintenance_tasks" ADD CONSTRAINT "site_maintenance_tasks_asset_id_site_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."site_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_devices" ADD CONSTRAINT "site_pest_devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_devices" ADD CONSTRAINT "site_pest_devices_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_findings" ADD CONSTRAINT "site_pest_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_findings" ADD CONSTRAINT "site_pest_findings_visit_id_site_pest_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."site_pest_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_findings" ADD CONSTRAINT "site_pest_findings_device_id_site_pest_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."site_pest_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_visits" ADD CONSTRAINT "site_pest_visits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_visits" ADD CONSTRAINT "site_pest_visits_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pest_visits" ADD CONSTRAINT "site_pest_visits_corrects_visit_id_site_pest_visits_id_fk" FOREIGN KEY ("corrects_visit_id") REFERENCES "public"."site_pest_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_readings" ADD CONSTRAINT "site_storage_readings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_readings" ADD CONSTRAINT "site_storage_readings_unit_id_site_storage_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."site_storage_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_readings" ADD CONSTRAINT "site_storage_readings_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_readings" ADD CONSTRAINT "site_storage_readings_corrects_reading_id_site_storage_readings_id_fk" FOREIGN KEY ("corrects_reading_id") REFERENCES "public"."site_storage_readings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_readings" ADD CONSTRAINT "site_storage_readings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_units" ADD CONSTRAINT "site_storage_units_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_storage_units" ADD CONSTRAINT "site_storage_units_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_assets_workspace_idx" ON "site_assets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "site_assets_workspace_code_key" ON "site_assets" USING btree ("workspace_id",lower("code")) WHERE "site_assets"."deleted_at" is null and "site_assets"."code" is not null;--> statement-breakpoint
CREATE INDEX "site_checklist_check_items_check_idx" ON "site_checklist_check_items" USING btree ("check_id","sort_order");--> statement-breakpoint
CREATE INDEX "site_checklist_checks_template_idx" ON "site_checklist_checks" USING btree ("template_id","performed_at");--> statement-breakpoint
CREATE INDEX "site_checklist_checks_workspace_idx" ON "site_checklist_checks" USING btree ("workspace_id","performed_at");--> statement-breakpoint
CREATE INDEX "site_checklist_checks_pending_idx" ON "site_checklist_checks" USING btree ("workspace_id","performed_at") WHERE "site_checklist_checks"."sign_off_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "site_checklist_checks_corrects_key" ON "site_checklist_checks" USING btree ("corrects_check_id") WHERE "site_checklist_checks"."corrects_check_id" is not null;--> statement-breakpoint
CREATE INDEX "site_checklist_items_template_idx" ON "site_checklist_items" USING btree ("template_id","sort_order");--> statement-breakpoint
CREATE INDEX "site_checklist_templates_workspace_idx" ON "site_checklist_templates" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "site_corrective_actions_workspace_idx" ON "site_corrective_actions" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "site_corrective_actions_reading_idx" ON "site_corrective_actions" USING btree ("reading_id");--> statement-breakpoint
CREATE INDEX "site_glass_breakages_workspace_idx" ON "site_glass_breakages" USING btree ("workspace_id","status","occurred_at");--> statement-breakpoint
CREATE INDEX "site_glass_checks_item_idx" ON "site_glass_checks" USING btree ("item_id","checked_at");--> statement-breakpoint
CREATE INDEX "site_glass_checks_workspace_idx" ON "site_glass_checks" USING btree ("workspace_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_glass_checks_corrects_key" ON "site_glass_checks" USING btree ("corrects_check_id") WHERE "site_glass_checks"."corrects_check_id" is not null;--> statement-breakpoint
CREATE INDEX "site_glass_items_workspace_idx" ON "site_glass_items" USING btree ("workspace_id","area_id");--> statement-breakpoint
CREATE INDEX "site_maintenance_records_task_idx" ON "site_maintenance_records" USING btree ("task_id","completed_at");--> statement-breakpoint
CREATE INDEX "site_maintenance_records_workspace_idx" ON "site_maintenance_records" USING btree ("workspace_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_maintenance_records_corrects_key" ON "site_maintenance_records" USING btree ("corrects_record_id") WHERE "site_maintenance_records"."corrects_record_id" is not null;--> statement-breakpoint
CREATE INDEX "site_maintenance_tasks_asset_idx" ON "site_maintenance_tasks" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_pest_devices_workspace_code_key" ON "site_pest_devices" USING btree ("workspace_id",lower("code")) WHERE "site_pest_devices"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "site_pest_findings_visit_idx" ON "site_pest_findings" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "site_pest_findings_device_idx" ON "site_pest_findings" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "site_pest_visits_workspace_idx" ON "site_pest_visits" USING btree ("workspace_id","visited_on");--> statement-breakpoint
CREATE UNIQUE INDEX "site_pest_visits_corrects_key" ON "site_pest_visits" USING btree ("corrects_visit_id") WHERE "site_pest_visits"."corrects_visit_id" is not null;--> statement-breakpoint
CREATE INDEX "site_storage_readings_unit_idx" ON "site_storage_readings" USING btree ("unit_id","checked_at");--> statement-breakpoint
CREATE INDEX "site_storage_readings_workspace_idx" ON "site_storage_readings" USING btree ("workspace_id","checked_at");--> statement-breakpoint
CREATE INDEX "site_storage_readings_pending_idx" ON "site_storage_readings" USING btree ("workspace_id","checked_at") WHERE "site_storage_readings"."review_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "site_storage_readings_corrects_key" ON "site_storage_readings" USING btree ("corrects_reading_id") WHERE "site_storage_readings"."corrects_reading_id" is not null;--> statement-breakpoint
CREATE INDEX "site_storage_units_workspace_idx" ON "site_storage_units" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "site_storage_units_workspace_code_key" ON "site_storage_units" USING btree ("workspace_id",lower("code")) WHERE "site_storage_units"."deleted_at" is null and "site_storage_units"."code" is not null;