CREATE TABLE "production_line_recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"rate_per_hour" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "production_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hours_per_day" numeric(5, 2) DEFAULT 8 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "production_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"fulfilled_quantity" numeric(18, 4) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by" uuid,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	"release_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "line_id" uuid;--> statement-breakpoint
ALTER TABLE "production_line_recipes" ADD CONSTRAINT "production_line_recipes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_line_recipes" ADD CONSTRAINT "production_line_recipes_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_line_recipes" ADD CONSTRAINT "production_line_recipes_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_lines" ADD CONSTRAINT "production_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_batch_id_production_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."production_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_line_recipes_line_recipe_key" ON "production_line_recipes" USING btree ("line_id","recipe_id") WHERE "production_line_recipes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "production_line_recipes_recipe_idx" ON "production_line_recipes" USING btree ("recipe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_lines_workspace_name_key" ON "production_lines" USING btree ("workspace_id",lower("name")) WHERE "production_lines"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "production_reservations_batch_idx" ON "production_reservations" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "production_reservations_lot_idx" ON "production_reservations" USING btree ("lot_id","status");--> statement-breakpoint
CREATE INDEX "production_reservations_workspace_idx" ON "production_reservations" USING btree ("workspace_id","status","item_id");--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "production_batches_line_idx" ON "production_batches" USING btree ("line_id","planned_on");