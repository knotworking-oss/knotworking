CREATE TABLE "hse_incident_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"description" text NOT NULL,
	"owner_user_id" uuid,
	"due_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"completion_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hse_incident_injuries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"staff_id" uuid,
	"person_name" text NOT NULL,
	"person_type" text NOT NULL,
	"nature" text NOT NULL,
	"body_part" text,
	"treatment" text NOT NULL,
	"days_absent" integer,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hse_incident_actions" ADD CONSTRAINT "hse_incident_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_actions" ADD CONSTRAINT "hse_incident_actions_incident_id_hse_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."hse_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_actions" ADD CONSTRAINT "hse_incident_actions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_actions" ADD CONSTRAINT "hse_incident_actions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_actions" ADD CONSTRAINT "hse_incident_actions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_injuries" ADD CONSTRAINT "hse_incident_injuries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_injuries" ADD CONSTRAINT "hse_incident_injuries_incident_id_hse_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."hse_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_injuries" ADD CONSTRAINT "hse_incident_injuries_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hse_incident_injuries" ADD CONSTRAINT "hse_incident_injuries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hse_incident_actions_incident_idx" ON "hse_incident_actions" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "hse_incident_actions_due_idx" ON "hse_incident_actions" USING btree ("workspace_id","status","due_on");--> statement-breakpoint
CREATE INDEX "hse_incident_injuries_incident_idx" ON "hse_incident_injuries" USING btree ("incident_id");