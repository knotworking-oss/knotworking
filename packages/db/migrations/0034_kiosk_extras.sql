CREATE TABLE "attendance_badges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"hint" text NOT NULL,
	"issued_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_kiosk_rejections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid,
	"client_id" uuid NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"staff_id" uuid,
	"detail" text,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sop_acknowledgements" ADD COLUMN "source" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD COLUMN "offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD COLUMN "badge_requires_pin" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD COLUMN "offline_replay_hours" integer DEFAULT 72 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD COLUMN "visitor_site_rules" text;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "host_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "host_user_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "host_name" text;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "site_rules" text;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "site_rules_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "sign_out_client_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD COLUMN "signed_out_offline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_badges" ADD CONSTRAINT "attendance_badges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_badges" ADD CONSTRAINT "attendance_badges_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_badges" ADD CONSTRAINT "attendance_badges_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_badges" ADD CONSTRAINT "attendance_badges_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_kiosk_rejections" ADD CONSTRAINT "attendance_kiosk_rejections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_kiosk_rejections" ADD CONSTRAINT "attendance_kiosk_rejections_device_id_attendance_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."attendance_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_kiosk_rejections" ADD CONSTRAINT "attendance_kiosk_rejections_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_kiosk_rejections" ADD CONSTRAINT "attendance_kiosk_rejections_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_badges_code_key" ON "attendance_badges" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_badges_live_key" ON "attendance_badges" USING btree ("staff_id") WHERE "attendance_badges"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "attendance_badges_workspace_idx" ON "attendance_badges" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_kiosk_rejections_client_key" ON "attendance_kiosk_rejections" USING btree ("workspace_id","client_id");--> statement-breakpoint
CREATE INDEX "attendance_kiosk_rejections_open_idx" ON "attendance_kiosk_rejections" USING btree ("workspace_id","dismissed_at");--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD CONSTRAINT "attendance_visits_host_staff_id_staff_id_fk" FOREIGN KEY ("host_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_visits" ADD CONSTRAINT "attendance_visits_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_events_client_key" ON "attendance_events" USING btree ("workspace_id","client_id") WHERE "attendance_events"."client_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_visits_client_key" ON "attendance_visits" USING btree ("workspace_id","client_id") WHERE "attendance_visits"."client_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_visits_sign_out_client_key" ON "attendance_visits" USING btree ("workspace_id","sign_out_client_id") WHERE "attendance_visits"."sign_out_client_id" is not null;