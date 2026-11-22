CREATE TABLE "item_label_data" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"declaration_name" text,
	"components" text,
	"nutrition_basis" text DEFAULT '100g' NOT NULL,
	"energy_kj" numeric(10, 3),
	"energy_kcal" numeric(10, 3),
	"fat" numeric(10, 3),
	"saturates" numeric(10, 3),
	"carbohydrate" numeric(10, 3),
	"sugars" numeric(10, 3),
	"fibre" numeric(10, 3),
	"protein" numeric(10, 3),
	"salt" numeric(10, 3),
	"nutrition_source" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_labels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"recipe_version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"product_name" text NOT NULL,
	"ingredients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allergen_statement" text,
	"allergens" jsonb DEFAULT '{"contains":[],"mayContain":[]}'::jsonb NOT NULL,
	"include_nutrition" boolean DEFAULT true NOT NULL,
	"nutrition" jsonb,
	"panel_source" text,
	"storage_instructions" text,
	"date_guidance" text,
	"net_quantity" text,
	"notes" text,
	"compound_style" text DEFAULT 'bracketed' NOT NULL,
	"quid_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "item_label_data" ADD CONSTRAINT "item_label_data_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_label_data" ADD CONSTRAINT "item_label_data_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_label_data" ADD CONSTRAINT "item_label_data_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_recipe_version_id_recipe_versions_id_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "public"."recipe_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_label_data_item_key" ON "item_label_data" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_number_key" ON "product_labels" USING btree ("recipe_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_one_draft_key" ON "product_labels" USING btree ("recipe_id") WHERE "product_labels"."status" = 'draft' and "product_labels"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_one_approved_key" ON "product_labels" USING btree ("recipe_id") WHERE "product_labels"."status" = 'approved' and "product_labels"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "product_labels_workspace_status_idx" ON "product_labels" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "product_labels_recipe_version_idx" ON "product_labels" USING btree ("recipe_version_id");