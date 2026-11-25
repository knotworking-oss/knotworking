CREATE TABLE "checklist_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_actions" ADD CONSTRAINT "checklist_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_actions" ADD CONSTRAINT "checklist_actions_check_id_site_checklist_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."site_checklist_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_actions" ADD CONSTRAINT "checklist_actions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_actions_check_key" ON "checklist_actions" USING btree ("check_id");--> statement-breakpoint
CREATE INDEX "checklist_actions_workspace_idx" ON "checklist_actions" USING btree ("workspace_id","status","created_at");
--> statement-breakpoint
-- Existing food workflows now use Checklists as well as Site. Keep scope and levels on upgrade.
INSERT INTO "member_module_access" ("id", "workspace_id", "user_id", "module_id", "level")
SELECT gen_random_uuid(), "workspace_id", "user_id", 'checklists', "level"
FROM "member_module_access"
WHERE "module_id" = 'site' AND "deleted_at" IS NULL
ON CONFLICT ("workspace_id", "user_id", "module_id") DO NOTHING;
--> statement-breakpoint
UPDATE "workspaces" SET "enabled_modules" = array_append("enabled_modules", 'checklists')
WHERE 'site' = ANY("enabled_modules") AND NOT ('checklists' = ANY("enabled_modules"));
--> statement-breakpoint
UPDATE "api_tokens" SET "modules" = "modules" || '["checklists"]'::jsonb
WHERE jsonb_typeof("modules") = 'array' AND "modules" ? 'site' AND NOT ("modules" ? 'checklists');
--> statement-breakpoint
UPDATE "assistant_settings" SET "modules" = "modules" || '["checklists"]'::jsonb
WHERE jsonb_typeof("modules") = 'array' AND "modules" ? 'site' AND NOT ("modules" ? 'checklists');
