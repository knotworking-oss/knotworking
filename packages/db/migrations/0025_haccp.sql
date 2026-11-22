CREATE TABLE "haccp_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"location" text,
	"cleaning_every" integer,
	"cleaning_unit" text,
	"calibration_every" integer,
	"calibration_unit" text,
	"calibration_tolerance" numeric(14, 4),
	"measurement_unit" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "haccp_calibration_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"calibrated_at" timestamp with time zone NOT NULL,
	"reference_reading" numeric(14, 4) NOT NULL,
	"actual_reading" numeric(14, 4) NOT NULL,
	"tolerance" numeric(14, 4),
	"unit" text,
	"passed" boolean NOT NULL,
	"method" text,
	"next_due_on" date,
	"note" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haccp_ccp_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"ccp_id" uuid NOT NULL,
	"ccp_code" text NOT NULL,
	"batch_id" uuid,
	"value" numeric(14, 4),
	"passed" boolean,
	"within_limits" boolean NOT NULL,
	"deviation_reason" text,
	"note" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"corrects_log_id" uuid,
	"correction_reason" text,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haccp_ccps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"code" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"process_step" text NOT NULL,
	"hazard_type" text NOT NULL,
	"hazard" text NOT NULL,
	"limit_type" text NOT NULL,
	"limit_min" numeric(14, 4),
	"limit_max" numeric(14, 4),
	"limit_unit" text,
	"pass_criterion" text,
	"monitoring_method" text NOT NULL,
	"frequency_every" integer NOT NULL,
	"frequency_unit" text NOT NULL,
	"during_production" boolean DEFAULT false NOT NULL,
	"responsible_role" text NOT NULL,
	"corrective_action" text NOT NULL,
	"verification" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "haccp_cleaning_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"cleaned_at" timestamp with time zone NOT NULL,
	"done_by" uuid,
	"recorded_by" uuid,
	"note" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"verification_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haccp_corrective_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"log_id" uuid,
	"calibration_id" uuid,
	"batch_id" uuid,
	"lot_id" uuid,
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
CREATE TABLE "haccp_plan_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scope_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_recipe_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_note" text,
	"change_note" text,
	"effective_on" date,
	"review_due_on" date,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approval_note" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "haccp_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"review_interval_months" integer DEFAULT 12 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "haccp_assets" ADD CONSTRAINT "haccp_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" ADD CONSTRAINT "haccp_calibration_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" ADD CONSTRAINT "haccp_calibration_records_asset_id_haccp_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" ADD CONSTRAINT "haccp_calibration_records_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_plan_id_haccp_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."haccp_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_plan_version_id_haccp_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."haccp_plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_ccp_id_haccp_ccps_id_fk" FOREIGN KEY ("ccp_id") REFERENCES "public"."haccp_ccps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_corrects_log_id_haccp_ccp_logs_id_fk" FOREIGN KEY ("corrects_log_id") REFERENCES "public"."haccp_ccp_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccp_logs" ADD CONSTRAINT "haccp_ccp_logs_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccps" ADD CONSTRAINT "haccp_ccps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccps" ADD CONSTRAINT "haccp_ccps_version_id_haccp_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."haccp_plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD CONSTRAINT "haccp_cleaning_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD CONSTRAINT "haccp_cleaning_records_asset_id_haccp_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD CONSTRAINT "haccp_cleaning_records_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD CONSTRAINT "haccp_cleaning_records_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD CONSTRAINT "haccp_cleaning_records_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_log_id_haccp_ccp_logs_id_fk" FOREIGN KEY ("log_id") REFERENCES "public"."haccp_ccp_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_calibration_id_haccp_calibration_records_id_fk" FOREIGN KEY ("calibration_id") REFERENCES "public"."haccp_calibration_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_corrective_actions" ADD CONSTRAINT "haccp_corrective_actions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_versions" ADD CONSTRAINT "haccp_plan_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_versions" ADD CONSTRAINT "haccp_plan_versions_plan_id_haccp_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."haccp_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_versions" ADD CONSTRAINT "haccp_plan_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_versions" ADD CONSTRAINT "haccp_plan_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plan_versions" ADD CONSTRAINT "haccp_plan_versions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD CONSTRAINT "haccp_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_plans" ADD CONSTRAINT "haccp_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "haccp_assets_workspace_idx" ON "haccp_assets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_assets_workspace_code_key" ON "haccp_assets" USING btree ("workspace_id",lower("code")) WHERE "haccp_assets"."deleted_at" is null and "haccp_assets"."code" is not null;--> statement-breakpoint
CREATE INDEX "haccp_calibration_records_asset_idx" ON "haccp_calibration_records" USING btree ("asset_id","calibrated_at");--> statement-breakpoint
CREATE INDEX "haccp_ccp_logs_workspace_checked_idx" ON "haccp_ccp_logs" USING btree ("workspace_id","checked_at");--> statement-breakpoint
CREATE INDEX "haccp_ccp_logs_ccp_idx" ON "haccp_ccp_logs" USING btree ("plan_id","ccp_code","checked_at");--> statement-breakpoint
CREATE INDEX "haccp_ccp_logs_batch_idx" ON "haccp_ccp_logs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "haccp_ccp_logs_pending_idx" ON "haccp_ccp_logs" USING btree ("workspace_id","checked_at") WHERE "haccp_ccp_logs"."review_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_ccp_logs_corrects_key" ON "haccp_ccp_logs" USING btree ("corrects_log_id") WHERE "haccp_ccp_logs"."corrects_log_id" is not null;--> statement-breakpoint
CREATE INDEX "haccp_ccps_version_idx" ON "haccp_ccps" USING btree ("version_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_ccps_version_code_key" ON "haccp_ccps" USING btree ("version_id",lower("code"));--> statement-breakpoint
CREATE INDEX "haccp_cleaning_records_asset_idx" ON "haccp_cleaning_records" USING btree ("asset_id","cleaned_at");--> statement-breakpoint
CREATE INDEX "haccp_corrective_actions_workspace_idx" ON "haccp_corrective_actions" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "haccp_corrective_actions_log_idx" ON "haccp_corrective_actions" USING btree ("log_id");--> statement-breakpoint
CREATE INDEX "haccp_corrective_actions_batch_idx" ON "haccp_corrective_actions" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_plan_versions_number_key" ON "haccp_plan_versions" USING btree ("plan_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_plan_versions_one_draft_key" ON "haccp_plan_versions" USING btree ("plan_id") WHERE "haccp_plan_versions"."status" = 'draft' and "haccp_plan_versions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_plan_versions_one_approved_key" ON "haccp_plan_versions" USING btree ("plan_id") WHERE "haccp_plan_versions"."status" = 'approved' and "haccp_plan_versions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_plans_workspace_code_key" ON "haccp_plans" USING btree ("workspace_id",lower("code")) WHERE "haccp_plans"."deleted_at" is null;