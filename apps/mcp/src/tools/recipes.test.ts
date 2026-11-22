import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("recipe tools", () => {
  it("lists recipes with their approved version, draft flag and allergens", async () => {
    const { call } = await session();
    const page = await call("list_recipes", { workspace: "acme" });
    expect(page.data).toMatchObject({ total: 1, returned: 1, hasMore: false });
    expect(page.data.recipes[0]).toMatchObject({
      code: "SPONGE",
      approvedVersion: 1,
      hasDraft: false,
      allergens: { contains: ["cereals_gluten", "milk"], mayContain: [] },
    });
    const byIngredient = await call("list_recipes", { workspace: "acme", ingredient: "mlk-001" });
    expect(byIngredient.data.total).toBe(1);
    const none = await call("list_recipes", { workspace: "acme", ingredient: "BOX-12" });
    expect(none.data.total).toBe(0);
    expect((await call("list_recipes", { workspace: "acme", query: "nothing" })).data.total).toBe(0);
  });

  it("gets a recipe by code with lines, roll-ups and optional scaling", async () => {
    const { call } = await session();
    const got = await call("get_recipe", { workspace: "acme", recipe: "sponge" });
    expect(got.data).toMatchObject({
      code: "SPONGE",
      versions: [{ versionNumber: 1, status: "approved" }],
      currentVersion: {
        yield: { quantity: 10, unit: "kg" },
        lines: [
          { item: "FLR-001", quantity: 4 },
          { item: "MLK-001", quantity: 2 },
        ],
        cost: { costComplete: false, missingCostCodes: ["FLR-001", "MLK-001"] },
      },
      draft: null,
    });
    expect(got.data.approvalNote).toMatch(/person/);
    const scaled = await call("get_recipe", { workspace: "acme", recipe: "SPONGE", batches: 2.5 });
    expect(scaled.data.scale).toMatchObject({ factor: 2.5, outputQuantity: 25 });
    expect(scaled.data.currentVersion.lines.map((l: { scaledQuantity: number }) => l.scaledQuantity)).toEqual(
      [10, 5],
    );
    const both = await call("get_recipe", {
      workspace: "acme",
      recipe: "SPONGE",
      batches: 1,
      output_quantity: 1,
      output_unit: "kg",
    });
    expect(both.isError).toBe(true);
    const missing = await call("get_recipe", { workspace: "acme", recipe: "NOPE" });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.code).toBe("not_found");
  });

  it("creates a recipe with a first draft, resolving items by code", async () => {
    const { call, fake } = await session();
    const created = await call("create_recipe", {
      workspace: "acme",
      code: "LOAF",
      name: "White loaf",
      output_item: "BOX-12",
      yield_quantity: 20,
      yield_unit: "kg",
      lines: [{ item: "FLR-001", quantity: 12, unit: "kg", note: "sifted" }],
    });
    expect(created.isError).toBeFalsy();
    expect(created.data).toMatchObject({
      code: "LOAF",
      versions: [{ versionNumber: 1, status: "draft" }],
      currentVersion: { lines: [{ item: "FLR-001", quantity: 12, note: "sifted" }] },
    });
    expect(fake.recipesModule.recipes).toHaveLength(2);
    const dupe = await call("create_recipe", {
      workspace: "acme",
      code: "loaf",
      name: "X",
      output_item: "BOX-12",
    });
    expect(dupe.isError).toBe(true);
    expect(dupe.data.error.code).toBe("code_taken");
    const partial = await call("create_recipe", {
      workspace: "acme",
      code: "P",
      name: "P",
      output_item: "BOX-12",
      yield_quantity: 1,
    });
    expect(partial.isError).toBe(true);
    expect(partial.data.error.code).toBe("invalid_input");
  });

  it("saves a draft beside the approved version, and refuses unknown items", async () => {
    const { call, fake } = await session();
    const saved = await call("save_recipe_draft", {
      workspace: "acme",
      recipe: "SPONGE",
      yield_quantity: 12,
      yield_unit: "kg",
      change_note: "More flour",
      lines: [{ item: "FLR-001", quantity: 5, unit: "kg" }],
    });
    expect(saved.data).toMatchObject({ versionNumber: 2, status: "draft", changeNote: "More flour" });
    const versions = fake.recipesModule.recipes[0]!.versions;
    expect(versions.map((v: { status: string }) => v.status)).toEqual(["approved", "draft"]);
    const got = await call("get_recipe", { workspace: "acme", recipe: "SPONGE" });
    expect(got.data.currentVersion.versionNumber).toBe(1);
    expect(got.data.draft.versionNumber).toBe(2);
    const bad = await call("save_recipe_draft", {
      workspace: "acme",
      recipe: "SPONGE",
      yield_quantity: 12,
      yield_unit: "kg",
      lines: [{ item: "NOPE", quantity: 1, unit: "kg" }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.code).toBe("not_found");
  });

  it("updates and archives a recipe, and has no approve or delete tool", async () => {
    const { call, client } = await session();
    const updated = await call("update_recipe", {
      workspace: "acme",
      recipe: "SPONGE",
      status: "archived",
      name: "Sponge cake",
    });
    expect(updated.data).toMatchObject({ name: "Sponge cake", status: "archived" });
    expect((await call("update_recipe", { workspace: "acme", recipe: "SPONGE" })).isError).toBe(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /recipe/.test(n)).sort()).toEqual([
      "create_recipe",
      "get_recipe",
      "list_recipes",
      "save_recipe_draft",
      "update_recipe",
    ]);
    expect(names.join(" ")).not.toMatch(/approve|delete_recipe/);
  });
});
