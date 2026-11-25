import { newId } from "@knotworking/core";
import { eq, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder } from "./migrate";
import { foodItems, items, memberModuleAccess, recipeVersions, users, workspaces } from "./schema";

it("moves legacy food declarations in place and preserves their recipe versions and access", async () => {
  const handle = createDb("memory://");
  try {
    const { db } = handle;
    const migrations = readMigrationFiles({ migrationsFolder });
    const migration = migrations.find((entry) =>
      entry.sql.some((s) => s.includes('CREATE TABLE "food_items"')),
    )!;
    const apply = (statements: string[]) =>
      db.transaction(async (tx) => {
        for (const statement of statements) await tx.execute(sql.raw(statement));
      });
    for (const earlier of migrations.slice(0, migrations.indexOf(migration))) await apply(earlier.sql);

    const [workspace] = await db
      .insert(workspaces)
      .values({
        slug: "synthetic-food",
        name: "Synthetic food",
        enabledModules: ["items", "recipes", "stock", "production"],
      })
      .returning();
    const [member] = await db
      .insert(users)
      .values({
        name: "Catalogue writer",
        email: "catalogue-writer@example.test",
      })
      .returning();
    await db.insert(memberModuleAccess).values({
      workspaceId: workspace!.id,
      userId: member!.id,
      moduleId: "items",
      level: "write",
    });

    const ingredientId = newId();
    const productId = newId();
    const archivedId = newId();
    const recipeId = newId();
    const versionId = newId();
    await db.execute(sql`
      insert into items (id, workspace_id, code, name, type, unit, allergens, may_contain, storage, shelf_life_days, deleted_at)
      values
        (${ingredientId}, ${workspace!.id}, 'DAIRY', 'Synthetic dairy', 'ingredient', 'l', '["milk"]', '["eggs"]', 'chilled', 4, null),
        (${productId}, ${workspace!.id}, 'PRODUCT', 'Synthetic product', 'finished', 'each', '["milk"]', '["eggs"]', 'chilled', 2, null),
        (${archivedId}, ${workspace!.id}, 'ARCHIVED', 'Old sample', 'ingredient', 'kg', '["soybeans"]', '[]', 'frozen', 200, now())
    `);
    await db.execute(sql`
      insert into recipes (id, workspace_id, code, name, output_item_id)
      values (${recipeId}, ${workspace!.id}, 'FORMULA', 'Synthetic formula', ${productId})
    `);
    await db.execute(sql`
      insert into recipe_versions (id, workspace_id, recipe_id, version_number, status, yield_quantity, yield_unit, approved_allergens)
      values (${versionId}, ${workspace!.id}, ${recipeId}, 1, 'approved', 1, 'each', '{"contains":["milk"],"mayContain":["eggs"]}')
    `);

    await apply(migration.sql);

    const declarations = await db.select().from(foodItems);
    expect(declarations).toHaveLength(3);
    expect(declarations).toEqual(
      expect.arrayContaining([
        {
          itemId: ingredientId,
          workspaceId: workspace!.id,
          allergens: ["milk"],
          mayContain: ["eggs"],
          storage: "chilled",
          shelfLifeDays: 4,
        },
        {
          itemId: productId,
          workspaceId: workspace!.id,
          allergens: ["milk"],
          mayContain: ["eggs"],
          storage: "chilled",
          shelfLifeDays: 2,
        },
        {
          itemId: archivedId,
          workspaceId: workspace!.id,
          allergens: ["soybeans"],
          mayContain: [],
          storage: "frozen",
          shelfLifeDays: 200,
        },
      ]),
    );
    expect((await db.select().from(items).where(eq(items.id, archivedId)))[0]?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect((await db.select().from(recipeVersions).where(eq(recipeVersions.id, versionId)))[0]).toMatchObject(
      {
        recipeId,
        approvedAllergens: { contains: ["milk"], mayContain: ["eggs"] },
      },
    );
    expect(
      (await db.select().from(workspaces).where(eq(workspaces.id, workspace!.id)))[0]?.enabledModules,
    ).toContain("food_items");
    expect(
      (await db.select().from(memberModuleAccess).where(eq(memberModuleAccess.moduleId, "food_items")))[0],
    ).toMatchObject({
      workspaceId: workspace!.id,
      userId: member!.id,
      level: "write",
    });
  } finally {
    await handle.close();
  }
}, 60_000);
