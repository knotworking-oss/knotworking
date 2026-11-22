-- Data migration: reserves `kiosk` (the tablet attendance kiosk, a top-level web route) and
-- renames any existing workspace using it, with the same rule and sync-log entry as
-- 0007_reserved_workspace_slugs. Slugs reserved earlier are already gone, so they are no-ops here.
--
-- The list below must equal `RESERVED_WORKSPACE_SLUGS` (packages/core/src/workspace-slugs.ts):
-- `reserved-workspace-slugs-migration.test.ts` checks the latest reserved-slug migration against it.
-- Do not edit it in place for a later change: add a new migration with the new list instead.
DO $$
DECLARE
  reserved text[] := ARRAY[
    -- reserved-slugs:begin
      'api',
      'mcp',
      'v1',
      'health',
      'healthz',
      'login',
      'logout',
      'setup',
      'invite',
      'forgot-password',
      'reset-password',
      'design',
      'settings',
      'not-found',
      'error',
      '_next',
      'static',
      'public',
      'assets',
      'favicon.ico',
      'robots.txt',
      'sitemap.xml',
      'admin',
      'auth',
      'oauth',
      'new',
      'workspaces',
      'kiosk'
    -- reserved-slugs:end
  ];
  ws record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR ws IN
    SELECT "id" FROM "workspaces"
    WHERE lower(btrim("slug")) = ANY (reserved)
    ORDER BY "created_at", "id"
  LOOP
    -- Same per-workspace lock `recordChanges` takes, so the log keeps its commit order.
    PERFORM pg_advisory_xact_lock(hashtextextended(ws."id"::text, 0));

    SELECT lower(btrim("slug")) || '-workspace' INTO base FROM "workspaces" WHERE "id" = ws."id";
    candidate := base;
    n := 2;
    WHILE EXISTS (SELECT 1 FROM "workspaces" WHERE "slug" = candidate AND "id" <> ws."id") LOOP
      candidate := base || '-' || n;
      n := n + 1;
    END LOOP;

    UPDATE "workspaces" SET "slug" = candidate, "updated_at" = now() WHERE "id" = ws."id";

    INSERT INTO "sync_changes" ("workspace_id", "entity", "entity_id", "action", "data")
    SELECT w."id", 'workspace', w."id", 'upsert', jsonb_build_object(
      'id', w."id",
      'slug', w."slug",
      'name', w."name",
      'icon', w."icon",
      'createdAt', to_char(w."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(w."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'deletedAt', NULL
    )
    FROM "workspaces" w
    WHERE w."id" = ws."id" AND w."deleted_at" IS NULL;
  END LOOP;
END $$;
