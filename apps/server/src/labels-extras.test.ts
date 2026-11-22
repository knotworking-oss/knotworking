import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/**
 * Labels module: energy extras and retention on items, the 5% water rule, the GTIN on a product
 * label and the nutrition CSV import.
 */
describe("labels: extras, water rule, GTIN and nutrition import", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const makeItem = async (body: Record<string, unknown>) =>
    (await ok(await as(ada).send("POST", "/items", body), 201)) as { id: string };
  const importCsv = (csv: string, dryRun = false, cookie = ada) =>
    as(cookie).send("POST", "/labelling/items/import", { csv, dryRun, fileName: "spec.csv" });
  const item = async (id: string) => ok(await as(ada).get(`/labelling/items/${id}`));
  const syncEntities = async () =>
    (await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada })).json()).changes.map(
      (c: { entity: string }) => c.entity,
    ) as string[];

  const base = {
    energyKj: 1000,
    energyKcal: 239,
    fat: 0,
    saturates: 0,
    carbohydrate: 80,
    sugars: 40,
    fibre: null,
    protein: 0,
    salt: 0,
  };

  let syrup: string;
  let spinach: string;
  let water: string;
  let flour: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;
    syrup = (await makeItem({ code: "SYR", name: "Maltitol syrup", type: "ingredient", unit: "kg" })).id;
    spinach = (await makeItem({ code: "SPN", name: "Spinach", type: "ingredient", unit: "kg" })).id;
    water = (await makeItem({ code: "WTR", name: "Water", type: "ingredient", unit: "kg" })).id;
    flour = (await makeItem({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" })).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("energy extras, vitamins and retention on an item", () => {
    it("stores polyols, organic acids, alcohol, vitamins and retention, and returns them", async () => {
      const saved = await ok(
        await as(ada).send("PUT", `/labelling/items/${syrup}`, {
          nutrition: { ...base, polyols: 60, organicAcids: 1.5, alcohol: 0 },
          micronutrients: { vitaminC: 12 },
          retention: { vitaminC: 0.5 },
        }),
      );
      expect(saved.nutrition).toMatchObject({
        polyols: 60,
        organicAcids: 1.5,
        alcohol: null,
        erythritol: null,
      });
      expect(saved.micronutrients).toEqual({ vitaminC: 12 });
      expect(saved.retention).toEqual({ vitaminC: 0.5 });
    });

    it("refuses polyols above the carbohydrate, retention above 1 and unknown vitamins", async () => {
      const over = await as(ada).send("PUT", `/labelling/items/${syrup}`, {
        nutrition: { ...base, polyols: 70, erythritol: 20 },
      });
      expect(over.status).toBe(400);
      expect(
        (
          await as(ada).send("PUT", `/labelling/items/${syrup}`, {
            nutrition: base,
            retention: { vitaminC: 1.2 },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(ada).send("PUT", `/labelling/items/${syrup}`, {
            nutrition: base,
            micronutrients: { caffeine: 1 },
          })
        ).status,
      ).toBe(400);
    });

    it("calculates energy from the extras for a recipe, and shows vitamins beside the panel", async () => {
      await ok(
        await as(ada).send("PUT", `/labelling/items/${syrup}`, {
          nutrition: { ...base, polyols: 60, organicAcids: 1.5 },
          micronutrients: { vitaminC: 12 },
          retention: { vitaminC: 0.5 },
        }),
      );
      const sweet = (await makeItem({ code: "SWEET", name: "Sweet", type: "finished", unit: "kg" })).id;
      const recipe = await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-SWEET",
          name: "Sweet",
          outputItemId: sweet,
          draft: { yieldQuantity: 1, yieldUnit: "kg", lines: [{ itemId: syrup, quantity: 1, unit: "kg" }] },
        }),
        201,
      );
      const version = await ok(await as(ada).send("POST", `/recipes/${recipe.id}/draft/approve`));
      const facts = await ok(
        await as(ada).get(`/labelling/recipes/${recipe.id}/versions/${version.id}?energyMethod=calculated`),
      );
      // carbohydrate 80 (polyols 60): 20 × 17 + 60 × 10 + 1.5 × 13 = 959.5 kJ; 20 × 4 + 60 × 2.4 + 1.5 × 3 = 228.5 kcal.
      expect(facts.nutrition.panel.raw).toMatchObject({ energyKj: 959.5, energyKcal: 228.5, polyols: 60 });
      expect(facts.nutrition.panel.declared.energyKj.display).toBe("960 kJ");
      // Never declared:
      expect(Object.keys(facts.nutrition.panel.declared)).not.toContain("polyols");
      // 12 mg per 100 g of vitamin C, half of it kept.
      expect(facts.nutrition.micronutrients).toEqual({ vitaminC: 6 });
      expect(facts.nutrition.micronutrientRows[0]).toMatchObject({
        key: "vitaminC",
        value: 6,
        nrvPercent: 8,
      });
    });
  });

  describe("the 5% rule for added water", () => {
    it("leaves added water out of the drafted label when it is under 5% of the product", async () => {
      await ok(await as(ada).send("PUT", `/labelling/items/${flour}`, { nutrition: base }));
      await ok(
        await as(ada).send("PUT", `/labelling/items/${water}`, {
          nutrition: { ...base, energyKj: 0, energyKcal: 0, carbohydrate: 0, sugars: 0 },
        }),
      );
      const bread = (await makeItem({ code: "BRD", name: "Bread", type: "finished", unit: "kg" })).id;
      const recipe = await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-BRD",
          name: "Bread",
          outputItemId: bread,
          draft: {
            yieldQuantity: 1000,
            yieldUnit: "g",
            lines: [
              { itemId: flour, quantity: 960, unit: "g" },
              { itemId: water, quantity: 40, unit: "g" },
            ],
          },
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/recipes/${recipe.id}/draft/approve`));
      const label = await ok(await as(ada).send("POST", "/labelling/labels", { recipeId: recipe.id }), 201);
      expect(label.ingredientsText).toBe("Flour");
    });
  });

  describe("GTIN on a product label", () => {
    let recipeId: string;
    let labelId: string;

    it("is checked, stored without spaces, printed from and carried to the next draft", async () => {
      const recipe = (await ok(await as(ada).get("/recipes?q=R-SWEET"))).recipes[0];
      recipeId = recipe.id;
      labelId = (await ok(await as(ada).send("POST", "/labelling/labels", { recipeId }), 201)).id;
      expect((await ok(await as(ada).get(`/labelling/labels/${labelId}`))).gtin).toBeNull();
      const bad = await as(ada).send("PATCH", `/labelling/labels/${labelId}`, { gtin: "5901234123450" });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(await bad.json())).toContain("check digit");
      const saved = await ok(
        await as(ada).send("PATCH", `/labelling/labels/${labelId}`, { gtin: "5 901234 123457" }),
      );
      expect(saved.gtin).toBe("5901234123457");
      // Cleared with an empty value, and set again.
      expect(
        (await ok(await as(ada).send("PATCH", `/labelling/labels/${labelId}`, { gtin: "" }))).gtin,
      ).toBeNull();
      await ok(await as(ada).send("PATCH", `/labelling/labels/${labelId}`, { gtin: "5901234123457" }));
      // A 12-digit UPC-A is stored as 13.
      expect(
        (await ok(await as(ada).send("PATCH", `/labelling/labels/${labelId}`, { gtin: "036000291452" })))
          .gtin,
      ).toBe("0036000291452");
      await ok(await as(ada).send("PATCH", `/labelling/labels/${labelId}`, { gtin: "5901234123457" }));
      // Approve (another manager is needed unless one is alone: ada is the only manager) and redraft.
      await ok(await as(ada).send("POST", `/labelling/labels/${labelId}/approve`));
      const next = await ok(await as(ada).send("POST", "/labelling/labels", { recipeId }), 201);
      expect(next.gtin).toBe("5901234123457");
    });
  });

  describe("nutrition CSV import", () => {
    const csv = [
      "code,basis,energy kj,energy kcal,fat,saturates,carbohydrate,sugars,fibre,protein,salt,polyols,vitamin c,source",
      "SPN,100g,100,24,0.5,0.1,2,1,2,2.9,0.2,,28,CoFID",
      "SYR,100g,1000,239,0,0,80,40,,0,0,60,,Spec v9",
    ].join("\n");

    it("previews without writing, then applies, and writes the sync log", async () => {
      const before = (await syncEntities()).filter((e) => e === "item_label_data").length;
      const preview = await ok(await importCsv(csv, true));
      expect(preview).toMatchObject({ dryRun: true, rowCount: 2, created: 1, updated: 1, errors: [] });
      expect(preview.changes.map((c: { key: string; action: string }) => [c.key, c.action])).toEqual([
        ["SPN", "create"],
        ["SYR", "update"],
      ]);
      expect(preview.changes[1].fields).toEqual(["organicAcids", "micronutrients", "nutritionSource"]);
      expect((await item(spinach)).nutrition).toBeNull();

      const done = await ok(await importCsv(csv), 201);
      expect(done).toMatchObject({ dryRun: false, created: 1, updated: 1 });
      expect(await item(spinach)).toMatchObject({
        nutrition: { basis: "100g", energyKj: 100, fibre: 2, protein: 2.9, salt: 0.2 },
        micronutrients: { vitaminC: 28 },
        nutritionSource: "CoFID",
      });
      // Retention is the kitchen's own figure: an import keeps it. The file's empty vitamin C cell cleared the syrup's.
      const syr = await item(syrup);
      expect(syr.nutrition).toMatchObject({ polyols: 60, fibre: null });
      expect(syr.retention).toEqual({ vitaminC: 0.5 });
      expect(syr.micronutrients).toBeNull();
      expect(syr.nutritionSource).toBe("Spec v9");
      expect((await syncEntities()).filter((e) => e === "item_label_data").length).toBe(before + 2);
    });

    it("reports a file imported again as unchanged", async () => {
      const again = await ok(await importCsv(csv, true));
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2, changes: [] });
    });

    it("finds items by name, and works out salt from sodium", async () => {
      const r = await ok(
        await importCsv(
          [
            "Food Name,Energy (kcal) (kcal),Energy (kJ) (kJ),Protein (g),Fat (g),Carbohydrate (g),Total sugars (g),Satd FA /100g fd (g),Sodium (mg)",
            "Flour,342,1450,11,1.2,70,1.5,0.2,4",
          ].join("\n"),
        ),
        201,
      );
      expect(r.updated).toBe(1);
      expect((await item(flour)).nutrition).toMatchObject({ salt: 0.01, carbohydrate: 70 });
    });

    it("writes nothing when any row is wrong, listing every problem", async () => {
      const bad = await importCsv(
        [
          "code,energy kj,energy kcal,fat,saturates,carbohydrate,sugars,protein,salt",
          "SPN,100,24,5,0.1,2,1,2.9,0.2",
          "NOPE,100,24,5,0.1,2,1,2.9,0.2",
          "SYR,100,24,5,9,2,1,2.9,0.2",
        ].join("\n"),
      );
      expect(bad.status).toBe(400);
      const body = await bad.json();
      expect(body.error.code).toBe("invalid_rows");
      expect(
        body.error.details.errors.map((e: { row: number; column: string }) => [e.row, e.column]),
      ).toEqual([
        [3, "code"],
        [4, "saturates"],
      ]);
      expect((await item(spinach)).nutrition.fat).toBe(0.5);
    });

    it("refuses packaging and names the basis from the item's unit", async () => {
      await makeItem({ code: "BOX", name: "Box", type: "packaging", unit: "each" });
      const pack = await importCsv(
        "code,kj,kcal,fat,saturates,carbohydrate,sugars,protein,salt\nBOX,1,0,0,0,0,0,0,0",
        true,
      );
      expect((await pack.json()).errors[0]).toMatchObject({ row: 2, column: "code" });
      const juice = (await makeItem({ code: "JUI", name: "Juice", type: "ingredient", unit: "l" })).id;
      await ok(
        await importCsv(
          "code,kj,kcal,fat,saturates,carbohydrate,sugars,protein,salt\nJUI,180,43,0,0,10,10,0.5,0",
          false,
        ),
        201,
      );
      expect((await item(juice)).nutrition.basis).toBe("100ml");
    });

    it("needs write on labels, and a token may import", async () => {
      expect((await importCsv(csv, true, marcus.cookie)).status).toBe(403);
      const res = await ctx.req(`${WS}/labelling/items/import`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: { csv, dryRun: true },
      });
      expect(res.status).toBe(200);
    });
  });
});
