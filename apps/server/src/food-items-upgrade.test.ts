import { addDays, DEFAULT_TIME_ZONE, newId, todayInZone } from "@knotworking/core";
import { createDb, migrationsFolder, seed, workspaces } from "@knotworking/db";
import { eq, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/**
 * An existing food workspace upgraded through 0105: food declarations written in the old
 * shape (on `items`) still drive allergen roll-ups, drift, label declarations, expiry
 * defaults and lot traceability once they live in the Food items extension.
 */
const ws = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

describe("food workspace upgraded to the Food items extension", () => {
  let ctx: TestCtx;
  let cookie: string;
  const ids = { flour: newId(), butter: newId(), biscuit: newId(), recipe: newId(), version: newId() };
  const ok = async (method: string, path: string, json?: unknown, status = 200) => {
    const response = await ctx.req(ws + path, { method, cookie, json });
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };

  beforeAll(async () => {
    const handle = createDb("memory://");
    const { db } = handle;
    const migrations = readMigrationFiles({ migrationsFolder });
    const from = migrations.findIndex((m) => m.sql.some((s) => s.includes('CREATE TABLE "food_items"')));
    expect(from).toBeGreaterThan(0);
    const apply = (statements: string[]) =>
      db.transaction(async (tx) => {
        for (const statement of statements) await tx.execute(sql.raw(statement));
      });
    for (const migration of migrations.slice(0, from)) await apply(migration.sql);
    await seed(db);

    // Old-shape catalogue and an approved recipe version with its allergen snapshot.
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
    const w = workspace!.id;
    await db.execute(sql`
      insert into items (id, workspace_id, code, name, type, unit, allergens, may_contain, storage, shelf_life_days, standard_cost)
      values
        (${ids.flour}, ${w}, 'UPG-FLOUR', 'Synthetic flour', 'ingredient', 'kg', '["cereals_gluten"]', '["milk"]', 'ambient', 180, 1),
        (${ids.butter}, ${w}, 'UPG-BUTTER', 'Synthetic butter', 'ingredient', 'kg', '["milk"]', '[]', 'chilled', 20, 8),
        (${ids.biscuit}, ${w}, 'UPG-BISCUIT', 'Synthetic biscuit', 'finished', 'each', '[]', '["sesame"]', 'ambient', 30, null)
    `);
    await db.execute(sql`
      insert into recipes (id, workspace_id, code, name, output_item_id)
      values (${ids.recipe}, ${w}, 'UPG-BISCUITS', 'Synthetic biscuits', ${ids.biscuit})
    `);
    await db.execute(sql`
      insert into recipe_versions (id, workspace_id, recipe_id, version_number, status, yield_quantity, yield_unit, approved_allergens, approved_at)
      values (${ids.version}, ${w}, ${ids.recipe}, 1, 'approved', 10, 'each',
        '{"contains":["cereals_gluten","milk"],"mayContain":[]}', now())
    `);
    await db.execute(sql`
      insert into recipe_lines (id, workspace_id, version_id, item_id, quantity, unit, sort_order)
      values
        (${newId()}, ${w}, ${ids.version}, ${ids.flour}, 500, 'g', 0),
        (${newId()}, ${w}, ${ids.version}, ${ids.butter}, 0.25, 'kg', 1)
    `);

    for (const migration of migrations.slice(from)) await apply(migration.sql);
    ctx = await makeApp({ seed: false, handle });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 120_000);
  afterAll(async () => ctx?.handle.close());

  it("keeps declarations, allergen snapshots and label allergens", async () => {
    expect(await ok("GET", `/items/${ids.flour}`)).toMatchObject({
      allergens: ["cereals_gluten"],
      mayContain: ["milk"],
      storage: "ambient",
      shelfLifeDays: 180,
    });
    expect(await ok("GET", `/items/${ids.butter}`)).toMatchObject({
      allergens: ["milk"],
      storage: "chilled",
      shelfLifeDays: 20,
    });
    expect(
      (await ok("GET", "/items?allergen=milk")).items.map((i: { code: string }) => i.code).sort(),
    ).toEqual(["UPG-BUTTER", "UPG-FLOUR"]);

    const recipe = await ok("GET", `/recipes/${ids.recipe}`);
    expect(recipe.currentVersion).toMatchObject({
      id: ids.version,
      approvedAllergens: { contains: ["cereals_gluten", "milk"], mayContain: [] },
      rollup: { allergens: { contains: ["cereals_gluten", "milk"], mayContain: [] } },
      allergenDrift: null,
    });
    expect((await ok("GET", "/recipes?allergenDrift=true")).total).toBe(0);

    const facts = await ok("GET", `/labelling/recipes/${ids.recipe}/versions/${ids.version}`);
    expect(facts.allergens.contains).toEqual(["cereals_gluten", "milk"]);
    expect(facts.declarationMarkup).toContain("**");

    // A declaration changed after the upgrade is still caught against the approved snapshot.
    await ok("PATCH", `/items/${ids.butter}`, { allergens: ["milk", "eggs"] });
    expect((await ok("GET", "/recipes?allergenDrift=true")).recipes).toMatchObject([
      { id: ids.recipe, allergenDrift: true },
    ]);
    await ok("PATCH", `/items/${ids.butter}`, { allergens: ["milk"] });
  });

  it("dates lots from migrated shelf lives and traces a batch both ways", async () => {
    const store = await ok("POST", "/stock/locations", { name: "Upgrade store" }, 201);
    const receive = (itemId: string, quantity: number) =>
      ok(
        "POST",
        "/stock/receipts",
        { itemId, quantity, unit: "kg", locationId: store.id, receivedOn: today },
        201,
      );
    const flourLot = await receive(ids.flour, 5);
    const butterLot = await receive(ids.butter, 1);
    expect(flourLot).toMatchObject({ expiresOn: addDays(today, 180), expiryType: "best_before" });
    expect(butterLot).toMatchObject({ expiresOn: addDays(today, 20) });

    const batch = await ok(
      "POST",
      "/production/batches",
      { recipeId: ids.recipe, plannedOn: today, batches: 1, outputLocationId: store.id },
      201,
    );
    const path = `/production/batches/${batch.id}`;
    await ok("POST", `${path}/start`);
    await ok(
      "POST",
      `${path}/consumption`,
      {
        lines: [
          { lotId: flourLot.id, locationId: store.id, quantity: 500, unit: "g" },
          { lotId: butterLot.id, locationId: store.id, quantity: 250, unit: "g" },
        ],
      },
      201,
    );
    const output = await ok("POST", `${path}/output`, { quantity: 10, unit: "each" }, 201);
    await ok("POST", `${path}/complete`, {});
    const outputLot = output.outputs[0].lotId;

    expect(await ok("GET", `/stock/lots/${outputLot}`)).toMatchObject({ expiresOn: addDays(today, 30) });
    const back = await ok("GET", `/production/lots/${outputLot}/trace`);
    expect(back.backward).toHaveLength(1);
    expect(back.backward[0].inputs.map((i: { lot: { id: string } }) => i.lot.id).sort()).toEqual(
      [flourLot.id, butterLot.id].sort(),
    );
    const forward = await ok("GET", `/production/lots/${flourLot.id}/trace`);
    expect(forward.forward).toMatchObject([
      { batch: { id: batch.id }, consumed: { amount: { base: 500 } }, outputs: [{ lot: { id: outputLot } }] },
    ]);
  });
});
