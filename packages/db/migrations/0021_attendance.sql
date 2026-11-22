CREATE TABLE "attendance_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"token_hash" text,
	"paired_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"device_id" uuid,
	"recorded_by" uuid,
	"reason" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_roll_call_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"roll_call_id" uuid NOT NULL,
	"staff_id" uuid,
	"visit_id" uuid,
	"name" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'unaccounted' NOT NULL,
	"marked_at" timestamp with time zone,
	"marked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_roll_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"time_zone" text NOT NULL,
	"rounding_minutes" integer NOT NULL,
	"break_after_hours" numeric(5, 2),
	"break_minutes" integer NOT NULL,
	"max_shift_hours" integer NOT NULL,
	"overtime_after_weekly_hours" numeric(6, 2),
	"payroll_format" text NOT NULL,
	"sage_basic_payment_ref" text,
	"sage_overtime_payment_ref" text,
	"visitor_retention_months" integer NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_visits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"signed_in_at" timestamp with time zone NOT NULL,
	"signed_out_at" timestamp with time zone,
	"signed_out_how" text,
	"signed_out_by" uuid,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_device_id_attendance_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."attendance_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_call_entries" ADD CONSTRAINT "attendance_roll_call_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_call_entries" ADD CONSTRAINT "attendance_roll_call_entries_roll_call_id_attendance_roll_calls_id_fk" FOREIGN KEY ("roll_call_id") REFERENCES "public"."attendance_roll_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_call_entries" ADD CONSTRAINT "attendance_roll_call_entries_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_call_entries" ADD CONSTRAINT "attendance_roll_call_entries_visit_id_attendance_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."attendance_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_call_entries" ADD CONSTRAINT "attendance_roll_call_entries_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_calls" ADD CONSTRAINT "attendance_roll_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_calls" ADD CONSTRAINT "attendance_roll_calls_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_roll_calls" ADD CONSTRAINT "attendance_roll_calls_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD CONSTRAINT "attendance_visits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD CONSTRAINT "attendance_visits_signed_out_by_users_id_fk" FOREIGN KEY ("signed_out_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD CONSTRAINT "attendance_visits_device_id_attendance_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."attendance_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_devices_token_key" ON "attendance_devices" USING btree ("token_hash") WHERE "attendance_devices"."token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_devices_pairing_key" ON "attendance_devices" USING btree ("pairing_code_hash") WHERE "attendance_devices"."pairing_code_hash" is not null;--> statement-breakpoint
CREATE INDEX "attendance_devices_workspace_idx" ON "attendance_devices" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "attendance_events_staff_idx" ON "attendance_events" USING btree ("workspace_id","staff_id","at");--> statement-breakpoint
CREATE INDEX "attendance_events_at_idx" ON "attendance_events" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "attendance_roll_call_entries_call_idx" ON "attendance_roll_call_entries" USING btree ("roll_call_id");--> statement-breakpoint
CREATE INDEX "attendance_roll_calls_workspace_idx" ON "attendance_roll_calls" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "attendance_visits_open_idx" ON "attendance_visits" USING btree ("workspace_id","signed_out_at");--> statement-breakpoint
CREATE INDEX "attendance_visits_in_idx" ON "attendance_visits" USING btree ("workspace_id","signed_in_at");