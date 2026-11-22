import { newId } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeApi, READ_TOKEN, WRITE_TOKEN } from "../testing/fake-api";
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

/** The fake's sponge recipe, made to output a finished cake sold by count, with milk weighable. */
function cakeFake() {
  const fake = createFakeApi();
  const items = fake.itemsModule.items;
  const cake = {
    ...items.find((i) => i.code === "FLR-001")!,
    id: newId(),
    code: "CAKE-1",
    name: "Victoria sponge",
    type: "finished",
    unit: "each",
    unitWeightG: 500,
    allergens: ["cereals_gluten", "milk"],
    mayContain: ["nuts"],
    storage: "ambient",
    shelfLifeDays: 5,
  };
  items.push(cake);
  items.find((i) => i.code === "MLK-001")!.densityGPerMl = 1;
  const sponge = fake.recipesModule.recipes.find((r) => r.code === "SPONGE")!;
  sponge.outputItemId = cake.id;
  // 4 kg flour + 2 l milk make 12 cakes of 500 g: 6 kg from 6 kg.
  sponge.versions[0]!.yieldQuantity = 12;
  sponge.versions[0]!.yieldUnit = "each";
  return fake;
}

const flourSpec = {
  energy_kj: 1450,
  energy_kcal: 342,
  fat: 1.2,
  saturates: 0.2,
  carbohydrate: 70,
  sugars: 1.5,
  fibre: 3.1,
  protein: 11,
  salt: 0.01,
};
const milkSpec = {
  basis: "100ml",
  energy_kj: 268,
  energy_kcal: 64,
  fat: 3.6,
  saturates: 2.3,
  carbohydrate: 4.7,
  sugars: 4.7,
  protein: 3.4,
  salt: 0.11,
};

describe("label tools", () => {
  it("offers reading, nutrition entry and drafting, but no approval", async () => {
    const { client } = await session();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_item_nutrition",
        "set_item_nutrition",
        "get_label_facts",
        "list_product_labels",
        "get_product_label",
        "draft_product_label",
      ]),
    );
    expect(names.some((n) => /approve/.test(n) && /label/.test(n))).toBe(false);
    expect(tools.find((t) => t.name === "draft_product_label")!.description).toMatch(/person/);
  });

  it("enters nutrition by item code, keeping fields it isn't given", async () => {
    const { call } = await session();
    const first = await call("set_item_nutrition", {
      workspace: "acme",
      item: "flr-001",
      declaration_name: "Wheat flour",
      nutrition: flourSpec,
      source: "Spec v3",
    });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({
      item: "FLR-001",
      declarationName: "Wheat flour",
      nutrition: { basis: "100g", fat: 1.2 },
      nutritionSource: "Spec v3",
    });
    const second = await call("set_item_nutrition", {
      workspace: "acme",
      item: "FLR-001",
      components: "wheat flour, calcium carbonate",
    });
    expect(second.data).toMatchObject({
      declarationName: "Wheat flour",
      components: "wheat flour, calcium carbonate",
      nutrition: { fat: 1.2 },
    });

    const packaging = await call("set_item_nutrition", {
      workspace: "acme",
      item: "BOX-12",
      nutrition: flourSpec,
    });
    expect(packaging.isError).toBe(true);
    const impossible = await call("set_item_nutrition", {
      workspace: "acme",
      item: "MLK-001",
      nutrition: { ...milkSpec, saturates: 9 },
    });
    expect(impossible.isError).toBe(true);
  });

  it("lists items still missing nutrition", async () => {
    const { call } = await session({ fake: cakeFake() });
    await call("set_item_nutrition", { workspace: "acme", item: "FLR-001", nutrition: flourSpec });
    const missing = await call("list_item_nutrition", { workspace: "acme", nutrition: "missing" });
    const codes = missing.data.items.map((i: { code: string }) => i.code);
    expect(codes).toContain("MLK-001");
    expect(codes).toContain("CAKE-1");
    expect(codes).not.toContain("FLR-001");
    expect(codes).not.toContain("BOX-12");
    const cake = missing.data.items.find((i: { code: string }) => i.code === "CAKE-1");
    expect(cake.madeBy).toBe("SPONGE v1");
    expect(cake.missing).toEqual([expect.objectContaining({ item: "MLK-001" })]);
  });

  it("computes a recipe's label facts, saying what is missing", async () => {
    const { call } = await session({ fake: cakeFake() });
    await call("set_item_nutrition", {
      workspace: "acme",
      item: "FLR-001",
      declaration_name: "Wheat flour",
      nutrition: flourSpec,
    });
    const partial = await call("get_label_facts", { workspace: "acme", recipe: "sponge" });
    expect(partial.data.nutrition.complete).toBe(false);
    expect(partial.data.missingNutrition).toEqual([
      expect.objectContaining({ item: "MLK-001", reason: "No nutrition entered" }),
    ]);
    expect(partial.data.ingredients).toBe("**Wheat** flour, Whole **milk**");
    expect(partial.data.allergens).toMatchObject({
      contains: ["Cereals containing gluten", "Milk"],
      mayContain: ["Tree nuts"],
    });

    await call("set_item_nutrition", { workspace: "acme", item: "MLK-001", nutrition: milkSpec });
    const facts = await call("get_label_facts", { workspace: "acme", recipe: "SPONGE", quid: ["mlk-001"] });
    expect(facts.data.nutrition.complete).toBe(true);
    expect(facts.data.nutrition.basis).toBe("100g");
    // 4 kg × 1.2 + 2000 ml × 3.6 / 100 g fat in 6 kg of cake.
    expect(facts.data.nutrition.per100Raw.fat).toBeCloseTo((48 + 72) / 60, 6);
    expect(facts.data.nutrition.declared.rows[0].label).toBe("Energy");
    expect(facts.data.ingredients).toBe("**Wheat** flour, Whole **milk** (33%)");
    expect(facts.data.markupNote).toMatch(/bold/);
  });

  it("drafts, edits and refreshes a label; approval is left to a person", async () => {
    const fake = cakeFake();
    const { call } = await session({ fake });
    const created = await call("draft_product_label", { workspace: "acme", recipe: "SPONGE" });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({
      action: "created",
      status: "draft",
      productName: "Victoria sponge",
      netQuantity: "500 g",
      nutrition: "Incomplete: see missingNutrition",
      storageInstructions: "Store in a cool, dry place.",
    });
    expect(created.data.missingNutrition.map((m: { item: string }) => m.item).sort()).toEqual([
      "FLR-001",
      "MLK-001",
    ]);
    expect(created.data.approvalNote).toMatch(/person/);

    const edited = await call("draft_product_label", {
      workspace: "acme",
      recipe: "sponge",
      product_name: "Classic Victoria sponge",
      net_quantity: "500g",
    });
    expect(edited.data).toMatchObject({ action: "updated", productName: "Classic Victoria sponge" });

    await call("set_item_nutrition", { workspace: "acme", item: "FLR-001", nutrition: flourSpec });
    await call("set_item_nutrition", { workspace: "acme", item: "MLK-001", nutrition: milkSpec });
    const stale = await call("list_product_labels", { workspace: "acme", stale: true });
    expect(stale.data.labels).toEqual([
      expect.objectContaining({
        recipe: "SPONGE",
        status: "draft",
        staleReasons: [expect.objectContaining({ kind: "nutrition_changed", items: ["FLR-001", "MLK-001"] })],
      }),
    ]);

    const refreshed = await call("draft_product_label", {
      workspace: "acme",
      recipe: "SPONGE",
      refresh: true,
    });
    expect(refreshed.data).toMatchObject({
      action: "refreshed",
      stale: false,
      productName: "Classic Victoria sponge",
      netQuantity: "500g",
    });
    expect(refreshed.data.nutrition.rows.map((r: { label: string }) => r.label)).toContain("of which sugars");

    const got = await call("get_product_label", { workspace: "acme", recipe: "SPONGE", draft: true });
    expect(got.data.id).toBe(refreshed.data.id);
    const none = await call("get_product_label", { workspace: "acme", recipe: "nope" });
    expect(none.isError).toBe(true);

    // The fake API, like the real one, refuses approval to tokens.
    const res = await fake.fetch(
      new Request(`http://api.test/v1/workspaces/acme/labelling/labels/${got.data.id}/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${WRITE_TOKEN}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("token_not_allowed");
  });

  it("enters energy extras, vitamins and retention without losing what it isn't given", async () => {
    const { call } = await session({ fake: cakeFake() });
    const saved = await call("set_item_nutrition", {
      workspace: "acme",
      item: "FLR-001",
      nutrition: { ...flourSpec, polyols: 5, alcohol: 1 },
      vitamins_and_minerals: { thiamin: 0.3, iron: 1.5 },
      retention_after_cooking: { thiamin: 0.8 },
    });
    expect(saved.isError).toBe(false);
    expect(saved.data.nutrition).toMatchObject({ polyols: 5, alcohol: 1 });
    // A later call about something else keeps the vitamins and the retention.
    await call("set_item_nutrition", { workspace: "acme", item: "FLR-001", source: "Spec v4" });
    const listed = await call("list_item_nutrition", { workspace: "acme", query: "FLR-001" });
    expect(listed.data.items[0]).toMatchObject({
      vitaminsAndMinerals: { thiamin: 0.3, iron: 1.5 },
      retentionAfterCooking: { thiamin: 0.8 },
    });
    const bad = await call("set_item_nutrition", {
      workspace: "acme",
      item: "FLR-001",
      retention_after_cooking: { thiamin: 1.5 },
    });
    expect(bad.isError).toBe(true);
  });

  it("imports nutrition from CSV, checking first", async () => {
    const { call, fake } = await session({ fake: cakeFake() });
    const csv = [
      "code,basis,energy kj,energy kcal,fat,saturates,carbohydrate,sugars,fibre,protein,salt,thiamin",
      "FLR-001,100g,1450,342,1.2,0.2,70,1.5,3.1,11,0.01,0.3",
    ].join("\n");
    const dry = await call("import_item_nutrition_csv", { workspace: "acme", csv, dry_run: true });
    expect(dry.data).toMatchObject({ dryRun: true, rows: 1, errors: [] });
    expect(
      (await call("list_item_nutrition", { workspace: "acme", query: "FLR-001" })).data.items[0].source,
    ).toBe("missing");
    const bad = await call("import_item_nutrition_csv", { workspace: "acme", csv: "code,fat\nFLR-001,1" });
    expect(bad.isError).toBe(true);
    expect(bad.data.error.code).toBe("invalid_rows");
    const done = await call("import_item_nutrition_csv", { workspace: "acme", csv, file_name: "spec.csv" });
    expect(done.isError).toBeFalsy();
    expect(fake.requests.some((r) => r.path.endsWith("/labelling/items/import"))).toBe(true);
    const listed = await call("list_item_nutrition", { workspace: "acme", query: "FLR-001" });
    expect(listed.data.items[0]).toMatchObject({ source: "entered", per100: { fat: 1.2 } });
  });

  it("is refused to a read-only token", async () => {
    const { call } = await session({ token: READ_TOKEN });
    const res = await call("import_item_nutrition_csv", { workspace: "acme", csv: "code\nA", dry_run: true });
    expect(res.data.error.code).toBe("token_read_only");
  });
});
