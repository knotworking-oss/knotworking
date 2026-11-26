import { moduleIds } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

const nutrition = (over: Record<string, unknown> = {}) => ({
  energyKj: 1450,
  energyKcal: 342,
  fat: 1.2,
  saturates: 0.2,
  carbohydrate: 70,
  sugars: 1.5,
  fibre: 3.1,
  protein: 11,
  salt: 0.01,
  ...over,
});

describe("labels module", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const makeItem = async (body: Record<string, unknown>) =>
    (await ok(await as(ada).send("POST", "/items", body), 201)) as { id: string };
  const approveRecipe = async (id: string) => ok(await as(ada).send("POST", `/recipes/${id}/draft/approve`));

  let flour: string;
  let butter: string;
  let sugar: string;
  let film: string;
  let pastry: string;
  let tart: string;
  let pastryRecipe: string;
  let tartRecipe: string;
  let tartV1: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    adaId = (await (await ctx.req("/v1/me", { cookie: ada })).json()).user.id;
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

    flour = (
      await makeItem({
        code: "FLR",
        name: "Flour T55",
        type: "ingredient",
        unit: "kg",
        allergens: ["cereals_gluten"],
      })
    ).id;
    butter = (
      await makeItem({ code: "BUT", name: "Butter", type: "ingredient", unit: "kg", allergens: ["milk"] })
    ).id;
    sugar = (await makeItem({ code: "SUG", name: "Caster sugar", type: "ingredient", unit: "kg" })).id;
    film = (await makeItem({ code: "FILM", name: "Lid film", type: "packaging", unit: "each" })).id;
    pastry = (await makeItem({ code: "PST", name: "Sweet pastry", type: "wip", unit: "kg" })).id;
    tart = (
      await makeItem({
        code: "TART",
        name: "Bakewell tart",
        type: "finished",
        unit: "each",
        unitWeightG: 400,
        storage: "ambient",
        shelfLifeDays: 10,
        allergens: ["cereals_gluten", "milk"],
        mayContain: ["nuts"],
      })
    ).id;

    pastryRecipe = (
      await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-PST",
          name: "Sweet pastry",
          outputItemId: pastry,
          draft: {
            yieldQuantity: 1,
            yieldUnit: "kg",
            lines: [
              { itemId: flour, quantity: 600, unit: "g" },
              { itemId: butter, quantity: 300, unit: "g" },
              { itemId: sugar, quantity: 100, unit: "g" },
            ],
          },
        }),
        201,
      )
    ).id;
    await approveRecipe(pastryRecipe);
    const created = await ok(
      await as(ada).send("POST", "/recipes", {
        code: "R-TART",
        name: "Bakewell tart",
        outputItemId: tart,
        draft: {
          // 2 kg of pastry and 0.4 kg of sugar make 5 tarts of 400 g (2 kg): moisture lost.
          yieldQuantity: 5,
          yieldUnit: "each",
          lines: [
            { itemId: pastry, quantity: 2, unit: "kg" },
            { itemId: sugar, quantity: 400, unit: "g" },
            { itemId: film, quantity: 5, unit: "each" },
          ],
        },
      }),
      201,
    );
    tartRecipe = created.id;
    tartV1 = created.currentVersion.id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in and needs recipes: read can't write", async () => {
      expect((await as(marcus.cookie).get("/labelling/labels")).status).toBe(403);
      await grant("labels", "write");
      // Labels alone is not enough while recipes (and items) are closed.
      expect((await as(marcus.cookie).get("/labelling/labels")).status).toBe(403);
      await grant("items", "read");
      await grant("recipes", "read");
      expect((await as(marcus.cookie).get("/labelling/labels")).status).toBe(403);
      await grant("food_items", "read");
      await grant("labels", "read");
      expect((await as(marcus.cookie).get("/labelling/labels")).status).toBe(200);
      const write = await as(marcus.cookie).send("PUT", `/labelling/items/${flour}`, {});
      expect(write.status).toBe(403);
      await grant("labels", "write");
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", "items", "recipes"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/labelling/items`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      // Task labels still live at /labels, owned by the tasks module.
      const taskLabel = await off.req(`${WS}/labels`, { cookie, method: "POST", json: { name: "Urgent" } });
      expect(taskLabel.status).toBe(201);
      await off.handle.close();
    }, 60_000);
  });

  describe("items' labelling data", () => {
    it("enters nutrition from a specification, through the API with a token too", async () => {
      const res = await viaToken("PUT", `/labelling/items/${flour}`, {
        declarationName: "Wheat flour",
        components: "wheat flour, calcium carbonate, iron, niacin, thiamin",
        nutrition: nutrition(),
        nutritionSource: "Spec v3",
      });
      const body = await ok(res);
      expect(body).toMatchObject({
        code: "FLR",
        declarationName: "Wheat flour",
        nutrition: { basis: "100g", fat: 1.2, salt: 0.01 },
        effective: { source: "entered" },
      });
    });

    it("refuses packaging and impossible values", async () => {
      expect(
        (await as(ada).send("PUT", `/labelling/items/${film}`, { declarationName: "Film" })).status,
      ).toBe(400);
      const bad = await as(ada).send("PUT", `/labelling/items/${butter}`, {
        nutrition: nutrition({ fat: 1, saturates: 2 }),
      });
      expect(bad.status).toBe(400);
    });

    it("lists food items with where their nutrition comes from", async () => {
      const page = await ok(await as(marcus.cookie).get("/labelling/items?nutrition=missing"));
      const codes = page.items.map((i: { code: string }) => i.code);
      // Pastry is made in house: its nutrition is computed, and missing while butter and sugar are.
      expect(codes).toEqual(expect.arrayContaining(["BUT", "SUG", "PST", "TART"]));
      expect(codes).not.toContain("FLR");
      expect(codes).not.toContain("FILM");
      const pst = page.items.find((i: { code: string }) => i.code === "PST");
      expect(pst.madeBy).toMatchObject({ recipeCode: "R-PST", versionNumber: 1 });
      expect(pst.effective.missing.map((m: { code: string }) => m.code).sort()).toEqual(["BUT", "SUG"]);
    });
  });

  describe("computed declaration and nutrition", () => {
    it("reports missing nutrition, and declares compound ingredients in weight order", async () => {
      const facts = await ok(
        await as(marcus.cookie).get(`/labelling/recipes/${tartRecipe}/versions/${tartV1}`),
      );
      expect(facts.nutrition.complete).toBe(false);
      expect(facts.nutrition.panel).toBeNull();
      expect(facts.nutrition.missing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "BUT", reason: "no_nutrition", path: ["PST"] }),
        ]),
      );
      // Packaging is not an ingredient.
      expect(facts.declarationMarkup).toBe(
        "Sweet pastry (**Wheat** flour (**wheat** flour, calcium carbonate, iron, niacin, thiamin), **Butter**, Caster sugar), Caster sugar",
      );
      expect(facts.allergens.contains).toEqual(["cereals_gluten", "milk"]);
      expect(facts.mayContain).toEqual(["nuts"]);
    });

    it("rolls nutrition up once every ingredient has it", async () => {
      await ok(
        await as(ada).send("PUT", `/labelling/items/${butter}`, {
          nutrition: nutrition({
            energyKj: 3041,
            energyKcal: 740,
            fat: 82,
            saturates: 52,
            carbohydrate: 0.6,
            sugars: 0.6,
            protein: 0.6,
            salt: 1.2,
            fibre: null,
          }),
        }),
      );
      await ok(
        await as(ada).send("PUT", `/labelling/items/${sugar}`, {
          nutrition: nutrition({
            energyKj: 1700,
            energyKcal: 400,
            fat: 0,
            saturates: 0,
            carbohydrate: 100,
            sugars: 100,
            protein: 0,
            salt: 0,
            fibre: 0,
          }),
        }),
      );
      const facts = await ok(
        await as(ada).get(`/labelling/recipes/${tartRecipe}/versions/${tartV1}?quid=${butter}`),
      );
      expect(facts.nutrition.complete).toBe(true);
      expect(facts.nutrition.basis).toBe("100g");
      // Pastry: 600 g flour, 300 g butter, 100 g sugar → 1000 g. Fat per 100 g of pastry:
      // (6 × 1.2 + 3 × 82) / 10 = 25.32. Tart: 2000 g pastry + 400 g sugar baked to 2000 g.
      expect(facts.nutrition.per100.fat).toBeCloseTo(25.32, 4);
      expect(facts.nutrition.panel.declared.fat.display).toBe("25 g");
      // Butter carries no fibre figure: fibre is left off rather than understated.
      expect(facts.nutrition.per100.fibre).toBeNull();
      expect(facts.nutrition.fibreMissing).toEqual(["BUT"]);
      // QUID: 600 g butter (via the pastry) in 2000 g of tart.
      expect(facts.declarationText).toContain("Butter (30%)");
    });
  });

  describe("product labels", () => {
    let labelId: string;

    it("needs an approved recipe version", async () => {
      const res = await as(ada).send("POST", "/labelling/labels", { recipeId: tartRecipe });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("no_approved_version");
      await approveRecipe(tartRecipe);
    });

    it("drafts a label from the computed data", async () => {
      const label = await ok(
        await viaToken("POST", "/labelling/labels", { recipeId: tartRecipe, quidItemIds: [butter] }),
        201,
      );
      labelId = label.id;
      expect(label).toMatchObject({
        versionNumber: 1,
        status: "draft",
        productName: "Bakewell tart",
        recipeVersion: { id: tartV1, versionNumber: 1 },
        allergens: { contains: ["cereals_gluten", "milk"], mayContain: ["nuts"] },
        allergenStatement: "Allergy advice: for allergens, see ingredients in bold. May contain tree nuts.",
        storageInstructions: "Store in a cool, dry place.",
        dateGuidance: "Best before: see date on pack. Shelf life 10 days from production.",
        netQuantity: "400 g",
        includeNutrition: true,
        stale: false,
      });
      expect(label.ingredientsText).toContain("Butter (30%)");
      expect(label.ingredients.some((s: { emphasis?: boolean }) => s.emphasis)).toBe(true);
      expect(label.nutrition.declared.salt.display).toMatch(/ g$/);
      expect(label.panelSource).toBe("computed");
      expect(label).not.toHaveProperty("sourceSnapshot");

      const again = await as(ada).send("POST", "/labelling/labels", { recipeId: tartRecipe });
      expect(again.status).toBe(409);
      const err = (await again.json()).error;
      expect(err.code).toBe("label_draft_exists");
      expect(err.details.id).toBe(labelId);
    });

    it("edits a draft's text; ingredients are written with ** around allergens", async () => {
      const label = await ok(
        await as(marcus.cookie).send("PATCH", `/labelling/labels/${labelId}`, {
          productName: "Bakewell Tart",
          ingredients: "**Wheat** flour, sugar, **butter** (30%)",
          netQuantity: "400g",
        }),
      );
      expect(label.ingredients).toEqual([
        { text: "Wheat", emphasis: true },
        { text: " flour, sugar, " },
        { text: "butter", emphasis: true },
        { text: " (30%)" },
      ]);
      expect(label.ingredientsMarkup).toBe("**Wheat** flour, sugar, **butter** (30%)");
      expect(label.productName).toBe("Bakewell Tart");
    });

    it("approval is a person with manage, never a token", async () => {
      const asWriter = await as(marcus.cookie).send("POST", `/labelling/labels/${labelId}/approve`);
      expect(asWriter.status).toBe(403);
      expect((await asWriter.json()).error.code).toBe("module_forbidden");
      const token403 = await viaToken("POST", `/labelling/labels/${labelId}/approve`);
      expect(token403.status).toBe(403);
      expect((await token403.json()).error.code).toBe("token_not_allowed");
    });

    it("refuses a draft that is out of date with the data until it is refreshed", async () => {
      await ok(
        await as(ada).send("PUT", `/labelling/items/${sugar}`, {
          declarationName: "Sugar",
          nutrition: nutrition({
            energyKj: 1700,
            energyKcal: 400,
            fat: 0,
            saturates: 0,
            carbohydrate: 100,
            sugars: 100,
            protein: 0,
            salt: 0,
            fibre: 0,
          }),
        }),
      );
      const stale = await ok(await as(ada).get(`/labelling/labels/${labelId}`));
      expect(stale.stale).toBe(true);
      expect(stale.staleReasons).toEqual([{ kind: "declaration_changed", itemCodes: ["SUG"] }]);
      const refused = await as(ada).send("POST", `/labelling/labels/${labelId}/approve`);
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe("label_out_of_date");

      const refreshed = await ok(
        await as(marcus.cookie).send("POST", `/labelling/labels/${labelId}/refresh`, {}),
      );
      expect(refreshed.stale).toBe(false);
      // The computed parts are redrafted; the text typed in is kept.
      expect(refreshed.ingredientsText).toContain("Sugar");
      expect(refreshed.productName).toBe("Bakewell Tart");
      expect(refreshed.netQuantity).toBe("400g");
    });

    it("approves, recording who and when; approved labels never change", async () => {
      const approved = await ok(await as(ada).send("POST", `/labelling/labels/${labelId}/approve`));
      expect(approved).toMatchObject({ status: "approved", approvedBy: adaId, stale: false });
      expect(approved.approvedAt).toBeTruthy();
      for (const [method, path, body] of [
        ["PATCH", `/labelling/labels/${labelId}`, { productName: "X" }],
        ["POST", `/labelling/labels/${labelId}/refresh`, {}],
        ["DELETE", `/labelling/labels/${labelId}`, undefined],
      ] as const) {
        const res = await as(ada).send(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(409);
        expect((await res.json()).error.code).toBe("label_not_draft");
      }
    });

    it("flags the approved label for review when an ingredient's nutrition or allergens change", async () => {
      await ok(
        await as(ada).send("PUT", `/labelling/items/${butter}`, {
          nutrition: nutrition({
            energyKj: 3041,
            energyKcal: 740,
            fat: 81,
            saturates: 52,
            carbohydrate: 0.6,
            sugars: 0.6,
            protein: 0.6,
            salt: 1.2,
            fibre: null,
          }),
        }),
      );
      await ok(await as(ada).send("PATCH", `/items/${flour}`, { mayContain: ["sesame"] }));
      const label = await ok(await as(ada).get(`/labelling/labels/${labelId}`));
      expect(label.status).toBe("approved");
      expect(label.stale).toBe(true);
      expect(label.staleReasons).toEqual([
        { kind: "allergens_changed", itemCodes: ["FLR"] },
        { kind: "nutrition_changed", itemCodes: ["BUT"] },
      ]);
      // Its approved text is untouched.
      expect(label.productName).toBe("Bakewell Tart");
      const staleList = await ok(await as(ada).get("/labelling/labels?stale=true"));
      expect(staleList.labels.map((l: { id: string }) => l.id)).toEqual([labelId]);
      expect((await ok(await as(ada).get("/labelling/labels?stale=false"))).total).toBe(0);
    });

    it("notifies label managers once about the stale approved label", async () => {
      const workspaceId = (await ok(await ctx.req(`${WS}/bootstrap`, { cookie: ada }))).workspace.id;
      const sweep = () => sweepDueNotifications(ctx.handle.db, { activeModules: moduleIds, workspaceId });
      const first = (await sweep()).created.filter((n) => n.type === "label_stale");
      expect(first.map((n) => [n.userId, n.data.subjectId])).toEqual([[adaId, labelId]]);
      expect((await sweep()).created.filter((n) => n.type === "label_stale")).toEqual([]);
    });

    it("flags it when the recipe version is superseded; a new draft corrects it", async () => {
      await ok(
        await as(ada).send("PUT", `/recipes/${tartRecipe}/draft`, {
          yieldQuantity: 5,
          yieldUnit: "each",
          lines: [
            { itemId: pastry, quantity: 2, unit: "kg" },
            { itemId: sugar, quantity: 300, unit: "g" },
          ],
        }),
      );
      await approveRecipe(tartRecipe);
      const old = await ok(await as(ada).get(`/labelling/labels/${labelId}`));
      expect(old.staleReasons[0]).toEqual({ kind: "recipe_version_superseded", itemCodes: [] });

      const draft = await ok(await as(ada).send("POST", "/labelling/labels", { recipeId: tartRecipe }), 201);
      expect(draft).toMatchObject({
        versionNumber: 2,
        status: "draft",
        recipeVersion: { versionNumber: 2 },
        // Text the computation can't give comes from the approved label.
        productName: "Bakewell Tart",
        netQuantity: "400g",
        quidItemIds: [butter],
      });
      expect(
        draft.history.map((h: { versionNumber: number; status: string }) => [h.versionNumber, h.status]),
      ).toEqual([
        [2, "draft"],
        [1, "approved"],
      ]);
      await ok(await as(ada).send("POST", `/labelling/labels/${draft.id}/approve`));
      const superseded = await ok(await as(ada).get(`/labelling/labels/${labelId}`));
      expect(superseded).toMatchObject({ status: "superseded", stale: false, staleReasons: [] });
      const list = await ok(await as(ada).get(`/labelling/labels?recipeId=${tartRecipe}&status=all`));
      expect(
        list.labels.map((l: { versionNumber: number; status: string }) => [l.versionNumber, l.status]),
      ).toEqual([
        [2, "approved"],
        [1, "superseded"],
      ]);
      // Search finds labels by product name and by the recipe's code or name.
      expect((await ok(await as(ada).get("/labelling/labels?q=bakewell&status=all"))).total).toBe(2);
      expect((await ok(await as(ada).get("/labelling/labels?q=r-tart"))).total).toBe(1);
      expect((await ok(await as(ada).get("/labelling/labels?q=nothing"))).total).toBe(0);
    });

    it("refuses approval without a complete nutrition panel unless none is declared", async () => {
      const salt = (await makeItem({ code: "SALT", name: "Salt", type: "ingredient", unit: "kg" })).id;
      const draft = await ok(
        await as(ada).send("PUT", `/recipes/${tartRecipe}/draft`, {
          yieldQuantity: 5,
          yieldUnit: "each",
          lines: [
            { itemId: pastry, quantity: 2, unit: "kg" },
            { itemId: salt, quantity: 10, unit: "g" },
          ],
        }),
      );
      expect(draft.status).toBe("draft");
      await approveRecipe(tartRecipe);
      const label = await ok(await as(ada).send("POST", "/labelling/labels", { recipeId: tartRecipe }), 201);
      expect(label.nutrition).toBeNull();
      expect(label.facts.nutrition.missing.map((m: { code: string }) => m.code)).toEqual(["SALT"]);
      const refused = await as(ada).send("POST", `/labelling/labels/${label.id}/approve`);
      expect(refused.status).toBe(409);
      const err = (await refused.json()).error;
      expect(err.code).toBe("nutrition_incomplete");
      expect(err.message).toMatch(/SALT/);

      // The partial values of the incomplete roll-up (salt counted as zero) are not a panel.
      const partial = label.facts.nutrition.per100;
      const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
      const copied = await as(ada).send("PATCH", `/labelling/labels/${label.id}`, {
        nutrition: {
          basis: label.facts.nutrition.basis,
          ...Object.fromEntries(Object.entries(partial).map(([k, v]) => [k, round3(v as number | null)])),
        },
      });
      expect(copied.status).toBe(409);
      const copiedErr = (await copied.json()).error;
      expect(copiedErr.code).toBe("nutrition_incomplete");
      expect(copiedErr.message).toMatch(/SALT/);
      expect((await ok(await as(ada).get(`/labelling/labels/${label.id}`))).nutrition).toBeNull();

      // Typing a panel in (from a lab analysis) is allowed; it is rounded like a computed one and
      // recorded as entered, not computed.
      const typed = await ok(
        await as(ada).send("PATCH", `/labelling/labels/${label.id}`, {
          nutrition: nutrition({ fat: 24.56, saturates: 14.04, salt: 0.384 }),
        }),
      );
      expect(typed.nutrition.declared.fat.display).toBe("25 g");
      expect(typed.nutrition.declared.salt.display).toBe("0.38 g");
      expect(typed.nutrition.raw.fat).toBe(24.56);
      expect(typed.panelSource).toBe("entered");
      // Or the product declares none; nutrition changes then never make it stale.
      const none = await ok(
        await as(ada).send("PATCH", `/labelling/labels/${label.id}`, { nutrition: null }),
      );
      expect(none).toMatchObject({ includeNutrition: false, nutrition: null, panelSource: null });
      await ok(await as(ada).send("POST", `/labelling/labels/${label.id}/approve`));

      // A changed unit weight changes the weights the label was drafted from: review it, even
      // without nutrition (it moves the order and QUID too).
      await ok(await as(ada).send("PATCH", `/items/${tart}`, { unitWeightG: 450 }));
      const reweighed = await ok(await as(ada).get(`/labelling/labels/${label.id}`));
      expect(reweighed.staleReasons).toEqual([{ kind: "conversion_changed", itemCodes: ["TART"] }]);
    });

    it("deletes a draft only", async () => {
      const draft = await ok(
        await as(ada).send("POST", "/labelling/labels", { recipeId: pastryRecipe }),
        201,
      );
      expect(draft.productName).toBe("Sweet pastry");
      const res = await as(marcus.cookie).send("DELETE", `/labelling/labels/${draft.id}`);
      expect(res.status).toBe(204);
      expect((await as(ada).get(`/labelling/labels/${draft.id}`)).status).toBe(404);
    });
  });

  describe("variants, options, previews and four-eyes", () => {
    it("keeps several labels per recipe, each numbered and approved on its own", async () => {
      const standard = await ok(
        await as(ada).send("POST", "/labelling/labels", { recipeId: pastryRecipe }),
        201,
      );
      expect(standard).toMatchObject({ variant: "Standard", versionNumber: 1 });
      const own = await ok(
        await as(ada).send("POST", "/labelling/labels", {
          recipeId: pastryRecipe,
          variant: "Shop own label",
          portionSize: 50,
          portionLabel: "1 slice",
          negligibleAsZero: true,
        }),
        201,
      );
      expect(own).toMatchObject({ variant: "Shop own label", versionNumber: 1, status: "draft" });
      // The same variant (in any case) has one draft only.
      const again = await as(ada).send("POST", "/labelling/labels", {
        recipeId: pastryRecipe,
        variant: "shop OWN label",
      });
      expect(again.status).toBe(409);
      expect((await again.json()).error.code).toBe("label_draft_exists");
      // Approving one leaves the other a draft, and only supersedes its own variant.
      await ok(await as(ada).send("POST", `/labelling/labels/${standard.id}/approve`));
      expect((await ok(await as(ada).get(`/labelling/labels/${own.id}`))).status).toBe("draft");
      const next = await ok(await as(ada).send("POST", "/labelling/labels", { recipeId: pastryRecipe }), 201);
      expect(next).toMatchObject({ variant: "Standard", versionNumber: 2 });
      expect(next.otherLabels.map((l: { variant: string }) => l.variant)).toEqual(["Shop own label"]);
      await ok(await as(ada).send("POST", `/labelling/labels/${next.id}/approve`));
      const all = await ok(await as(ada).get(`/labelling/labels?recipeId=${pastryRecipe}&status=all`));
      expect(
        all.labels.map((l: { variant: string; versionNumber: number; status: string }) => [
          l.variant,
          l.versionNumber,
          l.status,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["Standard", 1, "superseded"],
          ["Standard", 2, "approved"],
          ["Shop own label", 1, "draft"],
        ]),
      );
      const found = await ok(await as(ada).get(`/labelling/labels?q=shop%20own`));
      expect(found.total).toBe(1);
    });

    it("gives per-portion values with %RI, and re-rounds a draft when the portion or zero rule changes", async () => {
      const draft = (await ok(await as(ada).get(`/labelling/labels?recipeId=${pastryRecipe}&q=shop%20own`)))
        .labels[0];
      const label = await ok(await as(ada).get(`/labelling/labels/${draft.id}`));
      expect(label.nutrition.portion).toMatchObject({ size: 50, label: "1 slice" });
      const { raw } = label.nutrition;
      expect(label.nutrition.portion.raw.fat).toBeCloseTo(raw.fat / 2, 4);
      expect(label.nutrition.portion.ri.fat).toBe(Math.round((raw.fat / 2 / 70) * 100));
      expect(label.nutrition.portion.ri.energy).toBe(Math.round((raw.energyKcal / 2 / 2000) * 100));
      const changed = await ok(
        await as(ada).send("PATCH", `/labelling/labels/${draft.id}`, {
          portionSize: 100,
          negligibleAsZero: false,
        }),
      );
      expect(changed.nutrition.portion.size).toBe(100);
      expect(changed.nutrition.raw).toEqual(raw);
      const none = await ok(
        await as(ada).send("PATCH", `/labelling/labels/${draft.id}`, { portionSize: null }),
      );
      expect(none.nutrition.portion).toBeNull();
      // Traffic lights come with the label: the pastry is high in fat per 100 g.
      expect(label.trafficLights.find((t: { nutrient: string }) => t.nutrient === "fat").level).toBe("red");
    });

    it("calculates energy from the macronutrients when asked", async () => {
      const declared = await ok(await as(ada).get(`/labelling/recipes/${tartRecipe}/versions/${tartV1}`));
      const calculated = await ok(
        await as(ada).get(`/labelling/recipes/${tartRecipe}/versions/${tartV1}?energyMethod=calculated`),
      );
      const p = calculated.nutrition.panel;
      expect(p.energyMethod).toBe("calculated");
      expect(p.raw.energyKcal).toBeCloseTo(p.raw.fat * 9 + p.raw.carbohydrate * 4 + p.raw.protein * 4, 2);
      expect(p.raw.energyKj).not.toBeCloseTo(declared.nutrition.panel.raw.energyKj, 3);
    });

    it("orders added water by its weight in the finished product", async () => {
      const water = (await makeItem({ code: "WTR", name: "Water", type: "ingredient", unit: "kg" })).id;
      const dough = (await makeItem({ code: "DOUGH", name: "Dough", type: "finished", unit: "kg" })).id;
      const recipe = await ok(
        await as(ada).send("POST", "/recipes", {
          code: "R-DOUGH",
          name: "Dough",
          outputItemId: dough,
          draft: {
            // 1300 g in the bowl, 850 g out: 450 g of water evaporates.
            yieldQuantity: 850,
            yieldUnit: "g",
            lines: [
              { itemId: water, quantity: 600, unit: "g" },
              { itemId: flour, quantity: 500, unit: "g" },
              { itemId: sugar, quantity: 200, unit: "g" },
            ],
          },
        }),
        201,
      );
      const version = await approveRecipe(recipe.id);
      const names = (facts: { ingredients: { code: string }[] }) => facts.ingredients.map((i) => i.code);
      const bowl = await ok(await as(ada).get(`/labelling/recipes/${recipe.id}/versions/${version.id}`));
      expect(names(bowl)).toEqual(["WTR", "FLR", "SUG"]);
      const finished = await ok(
        await as(ada).get(`/labelling/recipes/${recipe.id}/versions/${version.id}?volatile=${water}`),
      );
      expect(names(finished)).toEqual(["FLR", "SUG", "WTR"]);
      expect(finished.ingredients[2].weightG).toBe(600);
      expect(finished.ingredients[2].finishedG).toBeCloseTo(150, 6);
      // Stored as a label option and carried to the next draft.
      const label = await ok(
        await as(ada).send("POST", "/labelling/labels", { recipeId: recipe.id, volatileItemIds: [water] }),
        201,
      );
      expect(label.volatileItemIds).toEqual([water]);
      expect(label.ingredientsText.endsWith("Water")).toBe(true);
    });

    it("previews a draft recipe version marked DRAFT, and never approves it", async () => {
      const recipe = await ok(await as(ada).get(`/recipes/${pastryRecipe}`));
      await ok(
        await as(ada).send("PUT", `/recipes/${pastryRecipe}/draft`, {
          yieldQuantity: 1,
          yieldUnit: "kg",
          lines: recipe.currentVersion.lines.map((l: { itemId: string; quantity: number; unit: string }) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unit: l.unit,
          })),
        }),
      );
      const draftVersion = (await ok(await as(ada).get(`/recipes/${pastryRecipe}`))).draftVersion;
      const preview = await ok(
        await as(ada).get(`/labelling/recipes/${pastryRecipe}/versions/${draftVersion.id}`),
      );
      expect(preview.preview).toMatchObject({ previewOnly: true, watermark: "DRAFT" });
      expect(preview.preview.ingredients.length).toBeGreaterThan(0);
      const approvedPreview = await ok(
        await as(ada).get(`/labelling/recipes/${pastryRecipe}/versions/${recipe.currentVersion.id}`),
      );
      expect(approvedPreview.preview.watermark).toBeNull();
      // Nothing was stored, and a label is only drafted from the approved version.
      const labels = await ok(await as(ada).get(`/labelling/labels?recipeId=${pastryRecipe}&status=all`));
      expect(
        labels.labels.every((l: { recipeVersion: { id: string } }) => l.recipeVersion.id !== draftVersion.id),
      ).toBe(true);
    });

    it("needs someone other than the last editor to approve, unless they are the only manager", async () => {
      const draft = await ok(
        await as(ada).send("POST", "/labelling/labels", { recipeId: pastryRecipe, variant: "Four eyes" }),
        201,
      );
      // Ada is the only manager: she may approve her own.
      await grant("labels", "write");
      const sole = await ok(
        await as(ada).send("POST", "/labelling/labels", { recipeId: pastryRecipe, variant: "Sole" }),
        201,
      );
      await ok(await as(ada).send("POST", `/labelling/labels/${sole.id}/approve`));
      // With a second manager, the last editor can't.
      await grant("labels", "manage");
      const refused = await as(ada).send("POST", `/labelling/labels/${draft.id}/approve`);
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe("four_eyes");
      // Marcus edits it, so now Ada may approve and Marcus may not.
      await ok(await as(marcus.cookie).send("PATCH", `/labelling/labels/${draft.id}`, { notes: "Checked" }));
      const marcusRefused = await as(marcus.cookie).send("POST", `/labelling/labels/${draft.id}/approve`);
      expect(marcusRefused.status).toBe(403);
      const approved = await ok(await as(ada).send("POST", `/labelling/labels/${draft.id}/approve`));
      expect(approved).toMatchObject({ status: "approved", lastEditedByName: "Marcus Chen" });
      await grant("labels", "write");
    });
  });

  describe("sync log", () => {
    it("records labelling data and labels, hidden from members without the module", async () => {
      const entities = async (cookie: string) => {
        const seen = new Map<string, Record<string, unknown>>();
        for (let after = "0", more = true; more;) {
          const page = await ok(await as(cookie).get(`/sync?after=${after}&limit=1000`));
          for (const c of page.changes) if (c.action === "upsert") seen.set(c.entity, c.data);
          ({ cursor: after, hasMore: more } = page);
        }
        return seen;
      };
      const forAda = await entities(ada);
      expect(forAda.has("item_label_data")).toBe(true);
      expect(forAda.has("product_label")).toBe(true);
      expect(forAda.get("product_label")).not.toHaveProperty("sourceSnapshot");
      await grant("labels", null);
      const forMarcus = await entities(marcus.cookie);
      expect(forMarcus.has("product_label")).toBe(false);
      expect(forMarcus.has("item_label_data")).toBe(false);
      expect(forMarcus.has("recipe")).toBe(true);
      await grant("labels", "write");
    });
  });
});
