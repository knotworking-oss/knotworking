CREATE TABLE "hse_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"performed_on" date NOT NULL,
	"outcome" text NOT NULL,
	"findings" text NOT NULL,
	"actions" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"next_due_on" date,
	"period_from" date,
	"quantity" numeric(18, 4),
	"unit" text,
	"resolves_entry_id" uuid,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "hse_incident_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hse_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"body" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hse_permit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"permit_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hse_permits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"asset_id" uuid NOT NULL,
	"isolation_required" boolean NOT NULL,
	"body" jsonb NOT NULL,
	"evidence_snapshot" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hse_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hse_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"reason" text NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hse_entries" ADD CONSTRAINT "hse_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_entries" ADD CONSTRAINT "hse_entries_record_id_hse_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."hse_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_entries" ADD CONSTRAINT "hse_entries_version_id_hse_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."hse_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_entries" ADD CONSTRAINT "hse_entries_resolves_entry_id_hse_entries_id_fk" FOREIGN KEY ("resolves_entry_id") REFERENCES "public"."hse_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_entries" ADD CONSTRAINT "hse_entries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_entries" ADD CONSTRAINT "hse_entries_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_events" ADD CONSTRAINT "hse_incident_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_events" ADD CONSTRAINT "hse_incident_events_incident_id_hse_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."hse_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_events" ADD CONSTRAINT "hse_incident_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incidents" ADD CONSTRAINT "hse_incidents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incidents" ADD CONSTRAINT "hse_incidents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_permit_events" ADD CONSTRAINT "hse_permit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_permit_events" ADD CONSTRAINT "hse_permit_events_permit_id_hse_permits_id_fk" FOREIGN KEY ("permit_id") REFERENCES "public"."hse_permits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_permit_events" ADD CONSTRAINT "hse_permit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_permits" ADD CONSTRAINT "hse_permits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_permits" ADD CONSTRAINT "hse_permits_asset_id_site_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."site_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_permits" ADD CONSTRAINT "hse_permits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_records" ADD CONSTRAINT "hse_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_records" ADD CONSTRAINT "hse_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_versions" ADD CONSTRAINT "hse_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_versions" ADD CONSTRAINT "hse_versions_record_id_hse_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."hse_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_versions" ADD CONSTRAINT "hse_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_versions" ADD CONSTRAINT "hse_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hse_entries_record_idx" ON "hse_entries" USING btree ("workspace_id","record_id","performed_on");--> statement-breakpoint
CREATE UNIQUE INDEX "hse_entries_resolution_key" ON "hse_entries" USING btree ("workspace_id","resolves_entry_id") WHERE "hse_entries"."voided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "hse_incident_events_revision_key" ON "hse_incident_events" USING btree ("workspace_id","incident_id","revision");--> statement-breakpoint
CREATE INDEX "hse_incidents_scope_idx" ON "hse_incidents" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hse_permit_events_revision_key" ON "hse_permit_events" USING btree ("workspace_id","permit_id","revision");--> statement-breakpoint
CREATE INDEX "hse_permits_asset_idx" ON "hse_permits" USING btree ("workspace_id","asset_id","status");--> statement-breakpoint
CREATE INDEX "hse_records_scope_idx" ON "hse_records" USING btree ("workspace_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hse_versions_number_key" ON "hse_versions" USING btree ("workspace_id","record_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "hse_versions_draft_key" ON "hse_versions" USING btree ("workspace_id","record_id") WHERE "hse_versions"."status"='draft';--> statement-breakpoint
CREATE UNIQUE INDEX "hse_versions_approved_key" ON "hse_versions" USING btree ("workspace_id","record_id") WHERE "hse_versions"."status"='approved';