ALTER TABLE "workspaces" ADD COLUMN "time_zone" text DEFAULT 'Europe/London' NOT NULL;--> statement-breakpoint
-- The attendance settings' zone becomes the workspace's: carry over a zone a workspace saved there when the
-- new validator would accept it (UTC, or a region name such as America/New_York, in its canonical spelling).
-- Anything else (GMT, EST, CET, +01:00, …) would pin the workspace to a fixed offset: it keeps Europe/London.
UPDATE "workspaces" SET "time_zone" = "carried"."zone" FROM (
	SELECT "attendance_settings"."workspace_id", CASE
		WHEN lower(trim("attendance_settings"."time_zone")) IN ('utc', 'etc/utc', 'uct', 'etc/uct', 'universal', 'etc/universal', 'zulu', 'etc/zulu') THEN 'UTC'
		ELSE (
			SELECT min("pg_timezone_names"."name") FROM "pg_timezone_names"
			WHERE lower("pg_timezone_names"."name") = lower(trim("attendance_settings"."time_zone"))
				AND "pg_timezone_names"."name" ~ '^[A-Za-z]+/[A-Za-z0-9_/+-]+$'
				AND "pg_timezone_names"."name" !~ '^(Etc|posix|right|SystemV)/'
		)
	END AS "zone"
	FROM "attendance_settings"
) AS "carried"
WHERE "carried"."workspace_id" = "workspaces"."id" AND "carried"."zone" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" DROP COLUMN "time_zone";
