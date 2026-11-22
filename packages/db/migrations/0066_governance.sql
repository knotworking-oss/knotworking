CREATE TABLE "governance_concerns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"raised_by" uuid,
	"raised_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"investigation" text,
	"outcome" text,
	"handled_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "governance_culture_activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"planned_on" date NOT NULL,
	"owner_user_id" uuid,
	"measure" text,
	"objective_id" uuid,
	"completed_on" date,
	"participants" integer,
	"result" text,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "governance_objectives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"measure" text,
	"target" text,
	"owner_user_id" uuid,
	"due_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "governance_requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"reference" text,
	"title" text NOT NULL,
	"customer_name" text,
	"description" text,
	"owner_user_id" uuid,
	"compliance" text DEFAULT 'not_assessed' NOT NULL,
	"last_reviewed_on" date,
	"last_reviewed_by" uuid,
	"review_notes" text,
	"review_due_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "governance_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"held_on" date,
	"attendees" text,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resources" text,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follow_up_team_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"evidence" jsonb,
	"signed_at" timestamp with time zone,
	"signed_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "governance_concerns" ADD CONSTRAINT "governance_concerns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_concerns" ADD CONSTRAINT "governance_concerns_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_concerns" ADD CONSTRAINT "governance_concerns_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_culture_activities" ADD CONSTRAINT "governance_culture_activities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_culture_activities" ADD CONSTRAINT "governance_culture_activities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_culture_activities" ADD CONSTRAINT "governance_culture_activities_objective_id_governance_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."governance_objectives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_culture_activities" ADD CONSTRAINT "governance_culture_activities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_objectives" ADD CONSTRAINT "governance_objectives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_objectives" ADD CONSTRAINT "governance_objectives_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_objectives" ADD CONSTRAINT "governance_objectives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_requirements" ADD CONSTRAINT "governance_requirements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_requirements" ADD CONSTRAINT "governance_requirements_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_requirements" ADD CONSTRAINT "governance_requirements_last_reviewed_by_users_id_fk" FOREIGN KEY ("last_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_requirements" ADD CONSTRAINT "governance_requirements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_reviews" ADD CONSTRAINT "governance_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_reviews" ADD CONSTRAINT "governance_reviews_follow_up_team_id_teams_id_fk" FOREIGN KEY ("follow_up_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_reviews" ADD CONSTRAINT "governance_reviews_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_reviews" ADD CONSTRAINT "governance_reviews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_concerns_reference_key" ON "governance_concerns" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "governance_concerns_status_idx" ON "governance_concerns" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "governance_culture_planned_idx" ON "governance_culture_activities" USING btree ("workspace_id","planned_on");--> statement-breakpoint
CREATE INDEX "governance_objectives_workspace_idx" ON "governance_objectives" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "governance_requirements_workspace_idx" ON "governance_requirements" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "governance_reviews_workspace_idx" ON "governance_reviews" USING btree ("workspace_id","period_to");