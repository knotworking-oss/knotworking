CREATE TABLE "haccp_day_signoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"day" date NOT NULL,
	"signed_by" uuid,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"check_count" integer NOT NULL,
	"deviation_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haccp_process_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"hazards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" ADD COLUMN "corrects_record_id" uuid;--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "haccp_ccps" ADD COLUMN "step_id" uuid;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD COLUMN "corrects_record_id" uuid;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "haccp_day_signoffs" ADD CONSTRAINT "haccp_day_signoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_day_signoffs" ADD CONSTRAINT "haccp_day_signoffs_plan_id_haccp_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."haccp_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_day_signoffs" ADD CONSTRAINT "haccp_day_signoffs_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_process_steps" ADD CONSTRAINT "haccp_process_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_process_steps" ADD CONSTRAINT "haccp_process_steps_version_id_haccp_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."haccp_plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_day_signoffs_plan_day_key" ON "haccp_day_signoffs" USING btree ("plan_id","day");--> statement-breakpoint
CREATE INDEX "haccp_process_steps_version_idx" ON "haccp_process_steps" USING btree ("version_id","sort_order");--> statement-breakpoint
ALTER TABLE "haccp_calibration_records" ADD CONSTRAINT "haccp_calibration_records_corrects_record_id_haccp_calibration_records_id_fk" FOREIGN KEY ("corrects_record_id") REFERENCES "public"."haccp_calibration_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_ccps" ADD CONSTRAINT "haccp_ccps_step_id_haccp_process_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."haccp_process_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "haccp_cleaning_records" ADD CONSTRAINT "haccp_cleaning_records_corrects_record_id_haccp_cleaning_records_id_fk" FOREIGN KEY ("corrects_record_id") REFERENCES "public"."haccp_cleaning_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_calibration_records_corrects_key" ON "haccp_calibration_records" USING btree ("corrects_record_id") WHERE "haccp_calibration_records"."corrects_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "haccp_cleaning_records_corrects_key" ON "haccp_cleaning_records" USING btree ("corrects_record_id") WHERE "haccp_cleaning_records"."corrects_record_id" is not null;