CREATE TABLE "governance_clause_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"clause_id" uuid NOT NULL,
	"standard_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"owner_user_id" uuid,
	"due_on" date,
	"assessed_by" uuid,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_clause_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"clause_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_standard_clauses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"standard_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"text" text,
	"section" text NOT NULL,
	"section_title" text,
	"fundamental" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "governance_standards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"issue" text NOT NULL,
	"publisher" text,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "governance_clause_assessments" ADD CONSTRAINT "governance_clause_assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_assessments" ADD CONSTRAINT "governance_clause_assessments_clause_id_governance_standard_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."governance_standard_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_assessments" ADD CONSTRAINT "governance_clause_assessments_standard_id_governance_standards_id_fk" FOREIGN KEY ("standard_id") REFERENCES "public"."governance_standards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_assessments" ADD CONSTRAINT "governance_clause_assessments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_assessments" ADD CONSTRAINT "governance_clause_assessments_assessed_by_users_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_tasks" ADD CONSTRAINT "governance_clause_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_tasks" ADD CONSTRAINT "governance_clause_tasks_clause_id_governance_standard_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."governance_standard_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_tasks" ADD CONSTRAINT "governance_clause_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_standard_clauses" ADD CONSTRAINT "governance_standard_clauses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_standard_clauses" ADD CONSTRAINT "governance_standard_clauses_standard_id_governance_standards_id_fk" FOREIGN KEY ("standard_id") REFERENCES "public"."governance_standards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_standards" ADD CONSTRAINT "governance_standards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_standards" ADD CONSTRAINT "governance_standards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "governance_clause_assessments_clause_idx" ON "governance_clause_assessments" USING btree ("clause_id","assessed_at");--> statement-breakpoint
CREATE INDEX "governance_clause_tasks_clause_idx" ON "governance_clause_tasks" USING btree ("clause_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_standard_clauses_ref_key" ON "governance_standard_clauses" USING btree ("standard_id",lower("ref")) WHERE "governance_standard_clauses"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_standards_code_issue_key" ON "governance_standards" USING btree ("workspace_id",lower("code"),lower("issue")) WHERE "governance_standards"."deleted_at" is null;