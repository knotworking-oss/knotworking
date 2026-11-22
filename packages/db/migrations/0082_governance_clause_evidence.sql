CREATE TABLE "governance_clause_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"clause_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "governance_clause_evidence" ADD CONSTRAINT "governance_clause_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_evidence" ADD CONSTRAINT "governance_clause_evidence_clause_id_governance_standard_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."governance_standard_clauses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_clause_evidence" ADD CONSTRAINT "governance_clause_evidence_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_clause_evidence_key" ON "governance_clause_evidence" USING btree ("clause_id","check_id") WHERE "governance_clause_evidence"."deleted_at" is null;