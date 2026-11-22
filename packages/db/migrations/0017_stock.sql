CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"storage" text DEFAULT 'ambient' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"supplier_id" uuid,
	"supplier_lot_code" text,
	"received_on" date NOT NULL,
	"expires_on" date,
	"expiry_type" text,
	"status" text DEFAULT 'available' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"status_changed_by" uuid,
	"status_note" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"reference" text,
	"transfer_id" uuid,
	"reverses_movement_id" uuid,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reverses_movement_id_stock_movements_id_fk" FOREIGN KEY ("reverses_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_locations_workspace_idx" ON "stock_locations" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_locations_workspace_code_key" ON "stock_locations" USING btree ("workspace_id",lower("code")) WHERE "stock_locations"."deleted_at" is null and "stock_locations"."code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_lots_item_code_key" ON "stock_lots" USING btree ("item_id",lower("lot_code")) WHERE "stock_lots"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "stock_lots_workspace_item_idx" ON "stock_lots" USING btree ("workspace_id","item_id");--> statement-breakpoint
CREATE INDEX "stock_lots_workspace_expiry_idx" ON "stock_lots" USING btree ("workspace_id","expires_on");--> statement-breakpoint
CREATE INDEX "stock_movements_workspace_item_idx" ON "stock_movements" USING btree ("workspace_id","item_id");--> statement-breakpoint
CREATE INDEX "stock_movements_lot_location_idx" ON "stock_movements" USING btree ("lot_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_movements_workspace_occurred_idx" ON "stock_movements" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_reverses_key" ON "stock_movements" USING btree ("reverses_movement_id") WHERE "stock_movements"."reverses_movement_id" is not null;