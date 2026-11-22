CREATE TABLE "authenticity_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"item_id" uuid NOT NULL,
	"supplier_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version_id" uuid,
	"draft_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text
);
--> statement-breakpoint
CREATE TABLE "authenticity_triggers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"resolved_by_version_id" uuid
);
--> statement-breakpoint
CREATE TABLE "authenticity_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"control_id" uuid NOT NULL,
	"verified_on" date NOT NULL,
	"outcome" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"evidence_valid_until" date,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "authenticity_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text NOT NULL,
	"body" jsonb NOT NULL,
	"subject" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"approval_note" text
);
--> statement-breakpoint
ALTER TABLE "authenticity_assessments" ADD CONSTRAINT "authenticity_assessments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_assessments" ADD CONSTRAINT "authenticity_assessments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_assessments" ADD CONSTRAINT "authenticity_assessments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_assessments" ADD CONSTRAINT "authenticity_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_assessments" ADD CONSTRAINT "authenticity_assessments_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_triggers" ADD CONSTRAINT "authenticity_triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_triggers" ADD CONSTRAINT "authenticity_triggers_assessment_id_authenticity_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."authenticity_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_triggers" ADD CONSTRAINT "authenticity_triggers_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_triggers" ADD CONSTRAINT "authenticity_triggers_resolved_by_version_id_authenticity_versions_id_fk" FOREIGN KEY ("resolved_by_version_id") REFERENCES "public"."authenticity_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_verifications" ADD CONSTRAINT "authenticity_verifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_verifications" ADD CONSTRAINT "authenticity_verifications_assessment_id_authenticity_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."authenticity_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_verifications" ADD CONSTRAINT "authenticity_verifications_version_id_authenticity_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."authenticity_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_verifications" ADD CONSTRAINT "authenticity_verifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_verifications" ADD CONSTRAINT "authenticity_verifications_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_versions" ADD CONSTRAINT "authenticity_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_versions" ADD CONSTRAINT "authenticity_versions_assessment_id_authenticity_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."authenticity_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_versions" ADD CONSTRAINT "authenticity_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_versions" ADD CONSTRAINT "authenticity_versions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_versions" ADD CONSTRAINT "authenticity_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authenticity_assessments_reference_key" ON "authenticity_assessments" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "authenticity_assessments_active_subject_key" ON "authenticity_assessments" USING btree ("workspace_id","item_id",coalesce("supplier_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "authenticity_assessments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "authenticity_assessments_workspace_idx" ON "authenticity_assessments" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "authenticity_triggers_assessment_idx" ON "authenticity_triggers" USING btree ("workspace_id","assessment_id");--> statement-breakpoint
CREATE INDEX "authenticity_verifications_version_idx" ON "authenticity_verifications" USING btree ("workspace_id","version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "authenticity_versions_number_key" ON "authenticity_versions" USING btree ("assessment_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "authenticity_versions_draft_key" ON "authenticity_versions" USING btree ("assessment_id") WHERE "authenticity_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "authenticity_versions_approved_key" ON "authenticity_versions" USING btree ("assessment_id") WHERE "authenticity_versions"."status" = 'approved';