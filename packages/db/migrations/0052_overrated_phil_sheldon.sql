CREATE TABLE "site_work_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"task_id" uuid,
	"area_id" uuid,
	"kind" text DEFAULT 'breakdown' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"stops_production" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"requested_by" uuid,
	"assigned_to" uuid,
	"contractor" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"done_by" uuid,
	"work_done" text,
	"downtime_minutes" integer,
	"spares_used" text,
	"parts_cost" numeric(12, 2),
	"labour_cost" numeric(12, 2),
	"contractor_cost" numeric(12, 2),
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "calibration_instrument_id" uuid;--> statement-breakpoint
ALTER TABLE "site_storage_units" ADD COLUMN "measure" text DEFAULT 'temperature' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_asset_id_site_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."site_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_task_id_site_maintenance_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."site_maintenance_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_area_id_haccp_assets_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_work_orders" ADD CONSTRAINT "site_work_orders_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_work_orders_workspace_idx" ON "site_work_orders" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "site_work_orders_asset_idx" ON "site_work_orders" USING btree ("asset_id");--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_calibration_instrument_id_haccp_assets_id_fk" FOREIGN KEY ("calibration_instrument_id") REFERENCES "public"."haccp_assets"("id") ON DELETE no action ON UPDATE no action;