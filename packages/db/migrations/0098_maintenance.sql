-- The existing maintenance tables and sync entity IDs stay in place. Transfer module access
-- so users of Site keep their Maintenance access after the two modules become independent.
INSERT INTO "member_module_access" ("id", "workspace_id", "user_id", "module_id", "level")
SELECT gen_random_uuid(), "workspace_id", "user_id", 'maintenance', "level"
FROM "member_module_access"
WHERE "module_id" = 'site' AND "deleted_at" IS NULL
ON CONFLICT ("workspace_id", "user_id", "module_id") DO NOTHING;
--> statement-breakpoint
UPDATE "workspaces" SET "enabled_modules" = array_append("enabled_modules", 'maintenance')
WHERE 'site' = ANY("enabled_modules") AND NOT ('maintenance' = ANY("enabled_modules"));
--> statement-breakpoint
UPDATE "api_tokens" SET "modules" = "modules" || '["maintenance"]'::jsonb
WHERE jsonb_typeof("modules") = 'array' AND "modules" ? 'site' AND NOT ("modules" ? 'maintenance');
--> statement-breakpoint
UPDATE "assistant_settings" SET "modules" = "modules" || '["maintenance"]'::jsonb
WHERE jsonb_typeof("modules") = 'array' AND "modules" ? 'site' AND NOT ("modules" ? 'maintenance');
--> statement-breakpoint
UPDATE "notifications" SET "module" = 'maintenance'
WHERE "type" = 'maintenance_due' AND "module" = 'site';
--> statement-breakpoint
INSERT INTO "notification_sweeps" ("workspace_id", "module", "first_swept_at")
SELECT "workspace_id", 'maintenance', "first_swept_at" FROM "notification_sweeps" WHERE "module" = 'site'
ON CONFLICT ("workspace_id", "module") DO NOTHING;
