CREATE TABLE "customer_delivery_sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "despatch_handling_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"despatch_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"sscc" text,
	"contents" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "despatch_operation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"despatch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "despatch_proofs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"despatch_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "despatch_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"despatch_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"original_lot_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"item_unit" text NOT NULL,
	"movement_id" uuid NOT NULL,
	"reversal_movement_id" uuid,
	"received_on" date NOT NULL,
	"reason" text NOT NULL,
	"condition" text NOT NULL,
	"incident_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "delivery_site_id" uuid;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "delivery_site_code" text;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "delivery_site_name" text;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "allocated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "allocated_by" uuid;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "packed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "packed_by" uuid;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "load_check" jsonb;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "load_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "despatches" ADD COLUMN "load_checked_by" uuid;--> statement-breakpoint
ALTER TABLE "customer_delivery_sites" ADD CONSTRAINT "customer_delivery_sites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_delivery_sites" ADD CONSTRAINT "customer_delivery_sites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_handling_units" ADD CONSTRAINT "despatch_handling_units_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_handling_units" ADD CONSTRAINT "despatch_handling_units_despatch_id_despatches_id_fk" FOREIGN KEY ("despatch_id") REFERENCES "public"."despatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_handling_units" ADD CONSTRAINT "despatch_handling_units_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_operation_events" ADD CONSTRAINT "despatch_operation_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_operation_events" ADD CONSTRAINT "despatch_operation_events_despatch_id_despatches_id_fk" FOREIGN KEY ("despatch_id") REFERENCES "public"."despatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_operation_events" ADD CONSTRAINT "despatch_operation_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_proofs" ADD CONSTRAINT "despatch_proofs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_proofs" ADD CONSTRAINT "despatch_proofs_despatch_id_despatches_id_fk" FOREIGN KEY ("despatch_id") REFERENCES "public"."despatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_proofs" ADD CONSTRAINT "despatch_proofs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_despatch_id_despatches_id_fk" FOREIGN KEY ("despatch_id") REFERENCES "public"."despatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_line_id_despatch_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."despatch_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_original_lot_id_stock_lots_id_fk" FOREIGN KEY ("original_lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_movement_id_stock_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_reversal_movement_id_stock_movements_id_fk" FOREIGN KEY ("reversal_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_incident_id_quality_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."quality_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_returns" ADD CONSTRAINT "despatch_returns_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_delivery_sites_code_key" ON "customer_delivery_sites" USING btree ("customer_id",lower("code"));--> statement-breakpoint
CREATE INDEX "customer_delivery_sites_workspace_idx" ON "customer_delivery_sites" USING btree ("workspace_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "despatch_handling_units_sscc_key" ON "despatch_handling_units" USING btree ("workspace_id","sscc");--> statement-breakpoint
CREATE INDEX "despatch_handling_units_despatch_idx" ON "despatch_handling_units" USING btree ("workspace_id","despatch_id");--> statement-breakpoint
CREATE INDEX "despatch_operation_events_despatch_idx" ON "despatch_operation_events" USING btree ("workspace_id","despatch_id");--> statement-breakpoint
CREATE INDEX "despatch_proofs_despatch_idx" ON "despatch_proofs" USING btree ("workspace_id","despatch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "despatch_returns_movement_key" ON "despatch_returns" USING btree ("movement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "despatch_returns_lot_key" ON "despatch_returns" USING btree ("workspace_id","lot_id");--> statement-breakpoint
CREATE INDEX "despatch_returns_despatch_idx" ON "despatch_returns" USING btree ("workspace_id","despatch_id");--> statement-breakpoint
CREATE INDEX "despatch_returns_original_lot_idx" ON "despatch_returns" USING btree ("workspace_id","original_lot_id");--> statement-breakpoint
CREATE INDEX "despatch_returns_case_idx" ON "despatch_returns" USING btree ("workspace_id","incident_id");--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_delivery_site_id_customer_delivery_sites_id_fk" FOREIGN KEY ("delivery_site_id") REFERENCES "public"."customer_delivery_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_allocated_by_users_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_packed_by_users_id_fk" FOREIGN KEY ("packed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_load_checked_by_users_id_fk" FOREIGN KEY ("load_checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;