CREATE TABLE "job_card_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"raised_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "job_card_quantities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"good" numeric(18, 4) DEFAULT 0 NOT NULL,
	"scrap" numeric(18, 4) DEFAULT 0 NOT NULL,
	"scrap_reason" text,
	"note" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "job_card_quantities_non_negative_check" CHECK ("job_card_quantities"."good" >= 0 and "job_card_quantities"."scrap" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_card_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"production_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_card_time_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"user_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"minutes" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "job_card_time_logs_minutes_check" CHECK ("job_card_time_logs"."minutes" is null or "job_card_time_logs"."minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"routing_version_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"work_centre_id" uuid NOT NULL,
	"planned_quantity" numeric(18, 4) NOT NULL,
	"expected_setup_minutes" numeric(12, 2) DEFAULT 0 NOT NULL,
	"expected_run_minutes" numeric(12, 2) DEFAULT 0 NOT NULL,
	"cost_per_hour" numeric(14, 4) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"completion_note" text,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "routing_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"work_centre_id" uuid NOT NULL,
	"setup_minutes" numeric(10, 2) DEFAULT 0 NOT NULL,
	"run_minutes" numeric(10, 2) DEFAULT 0 NOT NULL,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "routing_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"routing_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"change_note" text,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "routings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"recipe_id" uuid NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_centres" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"hours_per_day" numeric(5, 2) DEFAULT 8 NOT NULL,
	"stations" integer DEFAULT 1 NOT NULL,
	"cost_per_hour" numeric(14, 4) DEFAULT 0 NOT NULL,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "work_centres_stations_check" CHECK ("work_centres"."stations" >= 1)
);
--> statement-breakpoint
ALTER TABLE "job_card_exceptions" ADD CONSTRAINT "job_card_exceptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_exceptions" ADD CONSTRAINT "job_card_exceptions_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_exceptions" ADD CONSTRAINT "job_card_exceptions_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_exceptions" ADD CONSTRAINT "job_card_exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_quantities" ADD CONSTRAINT "job_card_quantities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_quantities" ADD CONSTRAINT "job_card_quantities_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_quantities" ADD CONSTRAINT "job_card_quantities_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_quantities" ADD CONSTRAINT "job_card_quantities_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_records" ADD CONSTRAINT "job_card_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_records" ADD CONSTRAINT "job_card_records_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_records" ADD CONSTRAINT "job_card_records_production_record_id_production_records_id_fk" FOREIGN KEY ("production_record_id") REFERENCES "public"."production_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_time_logs" ADD CONSTRAINT "job_card_time_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_time_logs" ADD CONSTRAINT "job_card_time_logs_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_time_logs" ADD CONSTRAINT "job_card_time_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_time_logs" ADD CONSTRAINT "job_card_time_logs_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_routing_version_id_routing_versions_id_fk" FOREIGN KEY ("routing_version_id") REFERENCES "public"."routing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_operation_id_routing_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_work_centre_id_work_centres_id_fk" FOREIGN KEY ("work_centre_id") REFERENCES "public"."work_centres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_version_id_routing_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."routing_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_work_centre_id_work_centres_id_fk" FOREIGN KEY ("work_centre_id") REFERENCES "public"."work_centres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_versions" ADD CONSTRAINT "routing_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_versions" ADD CONSTRAINT "routing_versions_routing_id_routings_id_fk" FOREIGN KEY ("routing_id") REFERENCES "public"."routings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_versions" ADD CONSTRAINT "routing_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_versions" ADD CONSTRAINT "routing_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routings" ADD CONSTRAINT "routings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routings" ADD CONSTRAINT "routings_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_centres" ADD CONSTRAINT "work_centres_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_card_exceptions_card_idx" ON "job_card_exceptions" USING btree ("job_card_id","status");--> statement-breakpoint
CREATE INDEX "job_card_quantities_card_idx" ON "job_card_quantities" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "job_card_records_card_idx" ON "job_card_records" USING btree ("job_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_card_records_record_key" ON "job_card_records" USING btree ("production_record_id");--> statement-breakpoint
CREATE INDEX "job_card_time_logs_card_idx" ON "job_card_time_logs" USING btree ("job_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_card_time_logs_running_key" ON "job_card_time_logs" USING btree ("job_card_id","user_id") WHERE "job_card_time_logs"."ended_at" is null and "job_card_time_logs"."voided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "job_cards_batch_position_key" ON "job_cards" USING btree ("batch_id","position") WHERE "job_cards"."status" <> 'cancelled' and "job_cards"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "job_cards_workspace_status_idx" ON "job_cards" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "job_cards_work_centre_idx" ON "job_cards" USING btree ("work_centre_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_operations_position_key" ON "routing_operations" USING btree ("version_id","position");--> statement-breakpoint
CREATE INDEX "routing_operations_work_centre_idx" ON "routing_operations" USING btree ("work_centre_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_versions_number_key" ON "routing_versions" USING btree ("routing_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_versions_one_draft_key" ON "routing_versions" USING btree ("routing_id") WHERE "routing_versions"."status" = 'draft' and "routing_versions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_versions_one_approved_key" ON "routing_versions" USING btree ("routing_id") WHERE "routing_versions"."status" = 'approved' and "routing_versions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routings_workspace_code_key" ON "routings" USING btree ("workspace_id",lower("code")) WHERE "routings"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routings_recipe_key" ON "routings" USING btree ("recipe_id") WHERE "routings"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "work_centres_workspace_code_key" ON "work_centres" USING btree ("workspace_id",lower("code")) WHERE "work_centres"."deleted_at" is null;