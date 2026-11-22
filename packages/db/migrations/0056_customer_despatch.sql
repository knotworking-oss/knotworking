CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
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
CREATE TABLE "despatch_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"despatch_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"item_name" text NOT NULL,
	"lot_code" text NOT NULL,
	"location_name" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"item_unit" text NOT NULL,
	"expires_on" date,
	"movement_id" uuid,
	"reversal_movement_id" uuid
);
--> statement-breakpoint
CREATE TABLE "despatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_code" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_address" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"delivery_address" text NOT NULL,
	"despatched_on" date NOT NULL,
	"external_reference" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_lines" ADD CONSTRAINT "despatch_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_lines" ADD CONSTRAINT "despatch_lines_despatch_id_despatches_id_fk" FOREIGN KEY ("despatch_id") REFERENCES "public"."despatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_lines" ADD CONSTRAINT "despatch_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_lines" ADD CONSTRAINT "despatch_lines_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_lines" ADD CONSTRAINT "despatch_lines_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_lines" ADD CONSTRAINT "despatch_lines_movement_id_stock_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatch_lines" ADD CONSTRAINT "despatch_lines_reversal_movement_id_stock_movements_id_fk" FOREIGN KEY ("reversal_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "despatches" ADD CONSTRAINT "despatches_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_workspace_code_key" ON "customers" USING btree ("workspace_id",lower("code"));--> statement-breakpoint
CREATE INDEX "customers_workspace_name_idx" ON "customers" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "despatch_lines_workspace_lot_idx" ON "despatch_lines" USING btree ("workspace_id","lot_id");--> statement-breakpoint
CREATE INDEX "despatch_lines_despatch_idx" ON "despatch_lines" USING btree ("despatch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "despatch_lines_movement_key" ON "despatch_lines" USING btree ("movement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "despatches_workspace_reference_key" ON "despatches" USING btree ("workspace_id","reference");--> statement-breakpoint
CREATE INDEX "despatches_workspace_date_idx" ON "despatches" USING btree ("workspace_id","despatched_on");--> statement-breakpoint
CREATE INDEX "despatches_customer_idx" ON "despatches" USING btree ("customer_id");