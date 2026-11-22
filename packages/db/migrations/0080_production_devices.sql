CREATE TABLE "production_device_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"reading_id" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value" numeric(18, 6) NOT NULL,
	"sent_value" numeric(18, 6) NOT NULL,
	"sent_unit" text NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"calibration_state" text NOT NULL,
	"applied_check_id" uuid,
	"recorded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "production_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"unit" text,
	"line_id" uuid,
	"haccp_asset_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "production_device_readings" ADD CONSTRAINT "production_device_readings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_device_readings" ADD CONSTRAINT "production_device_readings_device_id_production_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."production_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_device_readings" ADD CONSTRAINT "production_device_readings_applied_check_id_production_packing_checks_id_fk" FOREIGN KEY ("applied_check_id") REFERENCES "public"."production_packing_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_device_readings" ADD CONSTRAINT "production_device_readings_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_devices" ADD CONSTRAINT "production_devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_devices" ADD CONSTRAINT "production_devices_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_devices" ADD CONSTRAINT "production_devices_haccp_asset_id_haccp_assets_id_fk" FOREIGN KEY ("haccp_asset_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_devices" ADD CONSTRAINT "production_devices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_device_readings_key" ON "production_device_readings" USING btree ("device_id","reading_id");--> statement-breakpoint
CREATE INDEX "production_device_readings_taken_idx" ON "production_device_readings" USING btree ("device_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "production_devices_code_key" ON "production_devices" USING btree ("workspace_id",lower("code")) WHERE "production_devices"."deleted_at" is null;