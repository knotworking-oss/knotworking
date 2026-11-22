ALTER TABLE "recipe_versions" ADD COLUMN "approved_allergens" jsonb;
--> statement-breakpoint
-- Backfill: record the roll-up the approved versions' ingredients declare now.
UPDATE "recipe_versions" rv SET "approved_allergens" = jsonb_build_object(
  'contains', coalesce((
    SELECT jsonb_agg(DISTINCT a.code) FROM "recipe_lines" rl
    JOIN "items" i ON i.id = rl.item_id
    CROSS JOIN LATERAL jsonb_array_elements_text(i.allergens) AS a(code)
    WHERE rl.version_id = rv.id AND rl.deleted_at is null), '[]'::jsonb),
  'mayContain', coalesce((
    SELECT jsonb_agg(DISTINCT m.code) FROM "recipe_lines" rl
    JOIN "items" i ON i.id = rl.item_id
    CROSS JOIN LATERAL jsonb_array_elements_text(i.may_contain) AS m(code)
    WHERE rl.version_id = rv.id AND rl.deleted_at is null
      AND m.code NOT IN (
        SELECT a2.code FROM "recipe_lines" rl2
        JOIN "items" i2 ON i2.id = rl2.item_id
        CROSS JOIN LATERAL jsonb_array_elements_text(i2.allergens) AS a2(code)
        WHERE rl2.version_id = rv.id AND rl2.deleted_at is null)), '[]'::jsonb))
WHERE rv."status" in ('approved', 'superseded') AND rv."deleted_at" is null;
