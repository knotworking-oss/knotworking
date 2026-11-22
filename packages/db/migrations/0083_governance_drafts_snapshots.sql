CREATE TABLE "governance_clause_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"clause_id" uuid NOT NULL,
	"standard_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text NOT NULL,
	"rationale" text,
	"owner_user_id" uuid,
	"due_on" date,
	"drafted_via" text NOT NULL,
	"drafted_by" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"assessment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "governance_gap_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"standard_id" uuid NOT NULL,
	"label" text NOT NULL,
	"taken_on" date NOT NULL,
	"taken_by" uuid,
	"clause_count" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "governance_clause_drafts" ADD CONSTRAINT "governance_clause_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_drafts" ADD CONSTRAINT "governance_clause_drafts_clause_id_governance_standard_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."governance_standard_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_drafts" ADD CONSTRAINT "governance_clause_drafts_standard_id_governance_standards_id_fk" FOREIGN KEY ("standard_id") REFERENCES "public"."governance_standards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_drafts" ADD CONSTRAINT "governance_clause_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_drafts" ADD CONSTRAINT "governance_clause_drafts_drafted_by_users_id_fk" FOREIGN KEY ("drafted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_drafts" ADD CONSTRAINT "governance_clause_drafts_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_drafts" ADD CONSTRAINT "governance_clause_drafts_assessment_id_governance_clause_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."governance_clause_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_gap_snapshots" ADD CONSTRAINT "governance_gap_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_gap_snapshots" ADD CONSTRAINT "governance_gap_snapshots_standard_id_governance_standards_id_fk" FOREIGN KEY ("standard_id") REFERENCES "public"."governance_standards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_gap_snapshots" ADD CONSTRAINT "governance_gap_snapshots_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_clause_drafts_open_key" ON "governance_clause_drafts" USING btree ("clause_id") WHERE "governance_clause_drafts"."state" = 'open' and "governance_clause_drafts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "governance_clause_drafts_standard_idx" ON "governance_clause_drafts" USING btree ("standard_id","state");--> statement-breakpoint
CREATE INDEX "governance_gap_snapshots_standard_idx" ON "governance_gap_snapshots" USING btree ("standard_id","created_at");