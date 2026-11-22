CREATE TABLE "accounting_configuration_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_connections" (
	"id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"company_id" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_connections_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "accounting_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"local_reference" text NOT NULL,
	"external_reference" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_configuration_events" ADD CONSTRAINT "accounting_configuration_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_configuration_events" ADD CONSTRAINT "accounting_configuration_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_configuration_events" ADD CONSTRAINT "accounting_configuration_events_workspace_id_connection_id_accounting_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."accounting_connections"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_mappings" ADD CONSTRAINT "accounting_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_mappings" ADD CONSTRAINT "accounting_mappings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_mappings" ADD CONSTRAINT "accounting_mappings_workspace_id_connection_id_accounting_connections_workspace_id_id_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."accounting_connections"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_configuration_events_history_idx" ON "accounting_configuration_events" USING btree ("workspace_id","connection_id","revision");--> statement-breakpoint
CREATE INDEX "accounting_connections_destination_idx" ON "accounting_connections" USING btree ("workspace_id","provider","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_mappings_local_key" ON "accounting_mappings" USING btree ("workspace_id","connection_id","kind","local_reference");
--> statement-breakpoint
-- Retain destinations prepared by the earlier internal outbox foundation. No person is
-- invented as the author of this migrated configuration; admins can review it in settings.
INSERT INTO accounting_connections (id, workspace_id, name, provider, company_id, disabled, revision, created_at, updated_at)
SELECT DISTINCT ON (workspace_id, connection_id)
  connection_id, workspace_id, 'Imported accounting setup', provider, company_id, false, 1, created_at, created_at
FROM accounting_postings
ORDER BY workspace_id, connection_id, created_at, id;
