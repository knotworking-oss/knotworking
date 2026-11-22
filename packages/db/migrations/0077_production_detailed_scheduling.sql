CREATE TABLE "production_changeovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"from_recipe_id" uuid,
	"to_recipe_id" uuid,
	"minutes" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "production_line_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"name" text NOT NULL,
	"weekdays" jsonb NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "production_line_recipes" ADD COLUMN "crew_size" integer;--> statement-breakpoint
ALTER TABLE "production_lines" ADD COLUMN "changeover_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "production_lines" ADD COLUMN "allergen_clean_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "production_lines" ADD COLUMN "crew_available" integer;--> statement-breakpoint
ALTER TABLE "production_changeovers" ADD CONSTRAINT "production_changeovers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_changeovers" ADD CONSTRAINT "production_changeovers_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_changeovers" ADD CONSTRAINT "production_changeovers_from_recipe_id_recipes_id_fk" FOREIGN KEY ("from_recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_changeovers" ADD CONSTRAINT "production_changeovers_to_recipe_id_recipes_id_fk" FOREIGN KEY ("to_recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_line_shifts" ADD CONSTRAINT "production_line_shifts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_line_shifts" ADD CONSTRAINT "production_line_shifts_line_id_production_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."production_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_changeovers_pair_key" ON "production_changeovers" USING btree ("line_id",coalesce("from_recipe_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("to_recipe_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "production_changeovers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "production_line_shifts_line_idx" ON "production_line_shifts" USING btree ("line_id");