CREATE TABLE "food_items" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"allergens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"may_contain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"storage" text DEFAULT 'ambient' NOT NULL,
	"shelf_life_days" integer
);
--> statement-breakpoint
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Copy every existing declaration, including archived and soft-deleted catalogue rows.
INSERT INTO "food_items" ("item_id", "workspace_id", "allergens", "may_contain", "storage", "shelf_life_days")
SELECT "id", "workspace_id", "allergens", "may_contain", "storage", "shelf_life_days" FROM "items";
--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "allergens";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "may_contain";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "storage";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "shelf_life_days";
--> statement-breakpoint
-- Existing Items users and integrations already held this access. Keep their scope on upgrade.
INSERT INTO "member_module_access" ("id", "workspace_id", "user_id", "module_id", "level")
SELECT gen_random_uuid(), "workspace_id", "user_id", 'food_items', "level"
FROM "member_module_access"
WHERE "module_id" = 'items' AND "deleted_at" IS NULL
ON CONFLICT ("workspace_id", "user_id", "module_id") DO NOTHING;
--> statement-breakpoint
UPDATE "workspaces" SET "enabled_modules" = array_append("enabled_modules", 'food_items')
WHERE 'items' = ANY("enabled_modules") AND NOT ('food_items' = ANY("enabled_modules"));
--> statement-breakpoint
UPDATE "api_tokens" SET "modules" = "modules" || '["food_items"]'::jsonb
WHERE jsonb_typeof("modules") = 'array' AND "modules" ? 'items' AND NOT ("modules" ? 'food_items');
--> statement-breakpoint
UPDATE "assistant_settings" SET "modules" = "modules" || '["food_items"]'::jsonb
WHERE jsonb_typeof("modules") = 'array' AND "modules" ? 'items' AND NOT ("modules" ? 'food_items');
