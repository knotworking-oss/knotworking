CREATE TABLE "workforce_agencies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_agency_engagements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"start_on" date NOT NULL,
	"end_on" date,
	"reference" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"end_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_rota_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"staff_id" uuid NOT NULL,
	"job_role_id" uuid,
	"pattern_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"line_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_staffing_requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"name" text NOT NULL,
	"headcount" integer NOT NULL,
	"job_role_id" uuid,
	"course_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weekdays" integer NOT NULL,
	"applies_when" text DEFAULT 'always' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_working_patterns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"weekdays" integer NOT NULL,
	"job_role_id" uuid,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"revision" integer DEFAULT 1 NOT NULL,
	"end_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workforce_agencies" ADD CONSTRAINT "workforce_agencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_agencies" ADD CONSTRAINT "workforce_agencies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_agency_engagements" ADD CONSTRAINT "workforce_agency_engagements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_agency_engagements" ADD CONSTRAINT "workforce_agency_engagements_agency_id_workforce_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."workforce_agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_agency_engagements" ADD CONSTRAINT "workforce_agency_engagements_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_agency_engagements" ADD CONSTRAINT "workforce_agency_engagements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_rota_entries" ADD CONSTRAINT "workforce_rota_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_rota_entries" ADD CONSTRAINT "workforce_rota_entries_shift_id_workforce_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."workforce_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_rota_entries" ADD CONSTRAINT "workforce_rota_entries_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_rota_entries" ADD CONSTRAINT "workforce_rota_entries_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_rota_entries" ADD CONSTRAINT "workforce_rota_entries_pattern_id_workforce_working_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."workforce_working_patterns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_rota_entries" ADD CONSTRAINT "workforce_rota_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_rota_entries" ADD CONSTRAINT "workforce_rota_entries_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shifts" ADD CONSTRAINT "workforce_shifts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shifts" ADD CONSTRAINT "workforce_shifts_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shifts" ADD CONSTRAINT "workforce_shifts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staffing_requirements" ADD CONSTRAINT "workforce_staffing_requirements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staffing_requirements" ADD CONSTRAINT "workforce_staffing_requirements_shift_id_workforce_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."workforce_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staffing_requirements" ADD CONSTRAINT "workforce_staffing_requirements_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staffing_requirements" ADD CONSTRAINT "workforce_staffing_requirements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_working_patterns" ADD CONSTRAINT "workforce_working_patterns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_working_patterns" ADD CONSTRAINT "workforce_working_patterns_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_working_patterns" ADD CONSTRAINT "workforce_working_patterns_shift_id_workforce_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."workforce_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_working_patterns" ADD CONSTRAINT "workforce_working_patterns_job_role_id_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."job_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_working_patterns" ADD CONSTRAINT "workforce_working_patterns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_agencies_name_key" ON "workforce_agencies" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "workforce_agency_engagements_staff_idx" ON "workforce_agency_engagements" USING btree ("workspace_id","staff_id","start_on");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_rota_entries_active_key" ON "workforce_rota_entries" USING btree ("workspace_id","staff_id","work_date","shift_id") WHERE "workforce_rota_entries"."state" = 'active';--> statement-breakpoint
CREATE INDEX "workforce_rota_entries_date_idx" ON "workforce_rota_entries" USING btree ("workspace_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_shifts_name_key" ON "workforce_shifts" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "workforce_staffing_requirements_shift_idx" ON "workforce_staffing_requirements" USING btree ("workspace_id","shift_id");--> statement-breakpoint
CREATE INDEX "workforce_working_patterns_staff_idx" ON "workforce_working_patterns" USING btree ("workspace_id","staff_id");