CREATE TABLE "quality_incident_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "quality_incident_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_note" text
);
--> statement-breakpoint
CREATE TABLE "quality_incident_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "quality_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"assessment" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closure" jsonb
);
--> statement-breakpoint
ALTER TABLE "quality_incident_events" ADD CONSTRAINT "quality_incident_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_events" ADD CONSTRAINT "quality_incident_events_incident_id_quality_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."quality_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_events" ADD CONSTRAINT "quality_incident_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_holds" ADD CONSTRAINT "quality_incident_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_holds" ADD CONSTRAINT "quality_incident_holds_incident_id_quality_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."quality_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_holds" ADD CONSTRAINT "quality_incident_holds_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_holds" ADD CONSTRAINT "quality_incident_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_snapshots" ADD CONSTRAINT "quality_incident_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_snapshots" ADD CONSTRAINT "quality_incident_snapshots_incident_id_quality_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."quality_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incident_snapshots" ADD CONSTRAINT "quality_incident_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incidents" ADD CONSTRAINT "quality_incidents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incidents" ADD CONSTRAINT "quality_incidents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incidents" ADD CONSTRAINT "quality_incidents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_incidents" ADD CONSTRAINT "quality_incidents_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quality_incident_events_case_idx" ON "quality_incident_events" USING btree ("workspace_id","incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_incident_holds_case_lot_key" ON "quality_incident_holds" USING btree ("incident_id","lot_id");--> statement-breakpoint
CREATE INDEX "quality_incident_holds_lot_idx" ON "quality_incident_holds" USING btree ("workspace_id","lot_id");--> statement-breakpoint
CREATE INDEX "quality_incident_snapshots_case_idx" ON "quality_incident_snapshots" USING btree ("workspace_id","incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_incidents_reference_key" ON "quality_incidents" USING btree ("workspace_id","reference");