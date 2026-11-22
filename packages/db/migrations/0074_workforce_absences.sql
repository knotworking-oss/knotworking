CREATE TABLE "workforce_absence_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"absence_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_absences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"start_on" date NOT NULL,
	"end_on" date,
	"staff_note" text DEFAULT '' NOT NULL,
	"hr_note" text DEFAULT '' NOT NULL,
	"requested_by" uuid,
	"created_by" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workforce_absence_events" ADD CONSTRAINT "workforce_absence_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_absence_events" ADD CONSTRAINT "workforce_absence_events_absence_id_workforce_absences_id_fk" FOREIGN KEY ("absence_id") REFERENCES "public"."workforce_absences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_absence_events" ADD CONSTRAINT "workforce_absence_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_absences" ADD CONSTRAINT "workforce_absences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_absences" ADD CONSTRAINT "workforce_absences_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_absences" ADD CONSTRAINT "workforce_absences_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_absences" ADD CONSTRAINT "workforce_absences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workforce_absence_events_history_idx" ON "workforce_absence_events" USING btree ("workspace_id","absence_id","revision");--> statement-breakpoint
CREATE INDEX "workforce_absences_staff_dates_idx" ON "workforce_absences" USING btree ("workspace_id","staff_id","start_on");--> statement-breakpoint
CREATE INDEX "workforce_absences_state_idx" ON "workforce_absences" USING btree ("workspace_id","state","created_at");