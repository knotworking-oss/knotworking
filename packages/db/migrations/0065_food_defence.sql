CREATE TABLE "defence_assessment_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text,
	"threats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_due_on" date,
	"review_trigger" text,
	"review_reason" text,
	"last_edited_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "defence_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scope" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "defence_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"control_id" uuid NOT NULL,
	"checked_on" date NOT NULL,
	"outcome" text NOT NULL,
	"notes" text,
	"action_taken" text,
	"checked_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "defence_controls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"area" text,
	"frequency_days" integer NOT NULL,
	"instructions" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "defence_exercises" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scenario" text NOT NULL,
	"held_on" date NOT NULL,
	"assessment_id" uuid,
	"participants" text,
	"outcome" text NOT NULL,
	"findings" text,
	"actions" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "defence_assessment_versions" ADD CONSTRAINT "defence_assessment_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_assessment_versions" ADD CONSTRAINT "defence_assessment_versions_assessment_id_defence_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."defence_assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_assessment_versions" ADD CONSTRAINT "defence_assessment_versions_last_edited_by_users_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_assessment_versions" ADD CONSTRAINT "defence_assessment_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_assessment_versions" ADD CONSTRAINT "defence_assessment_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_assessments" ADD CONSTRAINT "defence_assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_assessments" ADD CONSTRAINT "defence_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_checks" ADD CONSTRAINT "defence_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_checks" ADD CONSTRAINT "defence_checks_control_id_defence_controls_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."defence_controls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_checks" ADD CONSTRAINT "defence_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_checks" ADD CONSTRAINT "defence_checks_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_controls" ADD CONSTRAINT "defence_controls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_controls" ADD CONSTRAINT "defence_controls_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_exercises" ADD CONSTRAINT "defence_exercises_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_exercises" ADD CONSTRAINT "defence_exercises_assessment_id_defence_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."defence_assessments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defence_exercises" ADD CONSTRAINT "defence_exercises_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "defence_assessment_versions_number_key" ON "defence_assessment_versions" USING btree ("assessment_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "defence_assessment_versions_one_draft_key" ON "defence_assessment_versions" USING btree ("assessment_id") WHERE "defence_assessment_versions"."status" = 'draft' and "defence_assessment_versions"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "defence_assessment_versions_one_approved_key" ON "defence_assessment_versions" USING btree ("assessment_id") WHERE "defence_assessment_versions"."status" = 'approved' and "defence_assessment_versions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "defence_assessments_workspace_idx" ON "defence_assessments" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "defence_checks_control_idx" ON "defence_checks" USING btree ("control_id","checked_on");--> statement-breakpoint
CREATE INDEX "defence_checks_open_idx" ON "defence_checks" USING btree ("workspace_id") WHERE "defence_checks"."outcome" = 'fail' and "defence_checks"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "defence_controls_workspace_idx" ON "defence_controls" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "defence_exercises_workspace_idx" ON "defence_exercises" USING btree ("workspace_id","held_on");