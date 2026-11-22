CREATE TABLE "demand_pack_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size" numeric(18, 4) NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "demand_history" ADD COLUMN "entered_quantity" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "demand_history" ADD COLUMN "entered_unit" text;--> statement-breakpoint
ALTER TABLE "demand_lines" ADD COLUMN "entered_quantity" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "demand_lines" ADD COLUMN "entered_unit" text;--> statement-breakpoint
ALTER TABLE "demand_pack_units" ADD CONSTRAINT "demand_pack_units_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_pack_units" ADD CONSTRAINT "demand_pack_units_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_pack_units" ADD CONSTRAINT "demand_pack_units_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_pack_units" ADD CONSTRAINT "demand_pack_units_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_pack_units_key" ON "demand_pack_units" USING btree ("workspace_id","item_id",lower("name")) WHERE "demand_pack_units"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "demand_pack_units_item_idx" ON "demand_pack_units" USING btree ("item_id");