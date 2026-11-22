import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("recipes module", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let marcus: { cookie: string; userId: string };
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const makeItem = async (body: Record<string, unknown>) => {
    const res = await as(ada).send("POST", "/items", body);
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };

  let flour: string;
  let milk: string;
  let sugar: string;
  let nuts: string;
  let cake: string;
  let dough: string;
  let rawMaterial: string;
  let archived: string;

  const draftBody = (overrides: Record<string, unknown> = {}) => ({
    yieldQuantity: 10,
    yieldUnit: "kg",
    method: "Mix. Bake.",
    changeNote: "First version",
    lines: [
      { itemId: flour, quantity: 5, unit: "kg" },
      { itemId: milk, quantity: 2, unit: "l" },
      { itemId: sugar, quantity: 500, unit: "g", note: "caster" },
    ],
    ...overrides,
  });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const session = await signIn(ctx, "ada@knotworking.dev");
    ada = session.cookie;
    adaId = (await (await ctx.req("/v1/me", { cookie: ada })).json()).user.id;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };

    flour = (
      await makeItem({
        code: "FLR",
        name: "Flour",
        type: "ingredient",
        unit: "kg",
        standardCost: 1.2,
        allergens: ["cereals_gluten"],
      })
    ).id;
    milk = (
      await makeItem({
        code: "MLK",
        name: "Milk",
        type: "ingredient",
        unit: "l",
        densityGPerMl: 1.03,
        standardCost: 0.8,
        allergens: ["milk"],
      })
    ).id;
    sugar = (await makeItem({ code: "SUG", name: "Sugar", type: "ingredient", unit: "kg" })).id;
    nuts = (
      await makeItem({
        code: "CHOC",
        name: "Chocolate chips",
        type: "ingredient",
        unit: "kg",
        standardCost: 6,
        mayContain: ["nuts", "milk"],
      })
    ).id;
    cake = (
      await makeItem({
        code: "CAKE",
        name: "Sponge cake",
        type: "finished",
        unit: "kg",
        allergens: ["cereals_gluten", "eggs"],
        mayContain: ["milk"],
      })
    ).id;
    dough = (await makeItem({ code: "DOUGH", name: "Dough", type: "wip", unit: "kg" })).id;
    rawMaterial = (await makeItem({ code: "RAW2", name: "Other", type: "ingredient", unit: "kg" })).id;
    archived = (await makeItem({ code: "OLD", name: "Old", type: "ingredient", unit: "kg" })).id;
    await as(ada).send("PATCH", `/items/${archived}`, { status: "archived" });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in and needs items: read can't write", async () => {
      expect((await as(marcus.cookie).get("/recipes")).status).toBe(403);
      // recipes alone is not enough while items is closed.
      await grant("recipes", "write");
      expect((await as(marcus.cookie).get("/recipes")).status).toBe(403);
      await grant("items", "read");
      await grant("recipes", "read");
      expect((await as(marcus.cookie).get("/recipes")).status).toBe(200);
      const write = await as(marcus.cookie).send("POST", "/recipes", {
        code: "X",
        name: "X",
        outputItemId: cake,
      });
      expect(write.status).toBe(403);
      await grant("recipes", "write");
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", "items"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/recipes`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);
  });

  describe("creating", () => {
    it("creates a recipe with a first draft; codes are unique case-insensitively", async () => {
      const res = await as(marcus.cookie).send("POST", "/recipes", {
        code: "SPONGE",
        name: "Sponge",
        outputItemId: cake,
        draft: draftBody(),
      });
      expect(res.status).toBe(201);
      const recipe = await res.json();
      expect(recipe).toMatchObject({ code: "SPONGE", status: "active", outputItem: { code: "CAKE" } });
      expect(recipe.workspaceId).toBeUndefined();
      expect(recipe.versions).toHaveLength(1);
      expect(recipe.versions[0]).toMatchObject({ versionNumber: 1, status: "draft" });
      expect(recipe.currentVersion.lines.map((l: { item: { code: string } }) => l.item.code)).toEqual([
        "FLR",
        "MLK",
        "SUG",
      ]);

      const dupe = await as(ada).send("POST", "/recipes", {
        code: "sponge",
        name: "Other",
        outputItemId: cake,
      });
      expect(dupe.status).toBe(409);
      expect((await dupe.json()).error.code).toBe("code_taken");
    });

    it("only makes work-in-progress or finished items, and not archived or unknown ones", async () => {
      const bad = await as(ada).send("POST", "/recipes", { code: "B1", name: "B", outputItemId: flour });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.message).toMatch(/work-in-progress or finished/);
      const unknown = await as(ada).send("POST", "/recipes", {
        code: "B2",
        name: "B",
        outputItemId: crypto.randomUUID(),
      });
      expect(unknown.status).toBe(400);
    });
  });

  describe("draft validation", () => {
    let id: string;
    beforeAll(async () => {
      const res = await as(ada).send("POST", "/recipes", {
        code: "VAL",
        name: "Validation",
        outputItemId: dough,
      });
      id = (await res.json()).id;
    });
    const put = (body: unknown) => as(ada).send("PUT", `/recipes/${id}/draft`, body);
    const message = async (res: Response) =>
      ((await res.json()) as { error: { message: string } }).error.message;

    it("refuses the recipe's own output item as an ingredient", async () => {
      const res = await put(draftBody({ lines: [{ itemId: dough, quantity: 1, unit: "kg" }] }));
      expect(res.status).toBe(400);
      expect(await message(res)).toMatch(/itself/);
    });

    it("refuses units that can't be converted, with a clear message", async () => {
      // Sugar has no density: litres of sugar can't be turned into kilograms.
      const res = await put(draftBody({ lines: [{ itemId: sugar, quantity: 1, unit: "l" }] }));
      expect(res.status).toBe(400);
      expect(await message(res)).toMatch(/SUG.*density or unit weight/);
      // Milk has a density, so kilograms of milk are fine.
      expect((await put(draftBody({ lines: [{ itemId: milk, quantity: 1, unit: "kg" }] }))).status).toBe(200);
    });

    it("refuses archived, unknown and malformed lines, and a yield in the wrong dimension", async () => {
      expect((await put(draftBody({ lines: [{ itemId: archived, quantity: 1, unit: "kg" }] }))).status).toBe(
        400,
      );
      expect(
        (await put(draftBody({ lines: [{ itemId: crypto.randomUUID(), quantity: 1, unit: "kg" }] }))).status,
      ).toBe(400);
      expect((await put(draftBody({ lines: [{ itemId: flour, quantity: 0, unit: "kg" }] }))).status).toBe(
        400,
      );
      expect((await put(draftBody({ lines: [{ itemId: flour, quantity: 1, unit: "stone" }] }))).status).toBe(
        400,
      );
      const wrongYield = await put(draftBody({ yieldUnit: "l" }));
      expect(wrongYield.status).toBe(400);
      expect(await message(wrongYield)).toMatch(/yield/);
    });

    it("leaves the previous draft untouched when a save is refused", async () => {
      await put(draftBody({ lines: [{ itemId: flour, quantity: 3, unit: "kg" }] }));
      await put(draftBody({ lines: [{ itemId: archived, quantity: 1, unit: "kg" }] }));
      const recipe = await (await as(ada).get(`/recipes/${id}`)).json();
      expect(recipe.currentVersion.lines).toHaveLength(1);
      expect(recipe.currentVersion.lines[0].quantity).toBe(3);
    });
  });

  describe("lifecycle", () => {
    let id: string;
    let v1: string;
    let v2: string;

    beforeAll(async () => {
      const res = await as(ada).send("POST", "/recipes", {
        code: "LIFE",
        name: "Lifecycle",
        outputItemId: cake,
      });
      id = (await res.json()).id;
    });

    it("an empty draft or one with no yield can't be approved", async () => {
      const none = await as(ada).send("POST", `/recipes/${id}/draft/approve`);
      expect(none.status).toBe(409);
      expect((await none.json()).error.code).toBe("no_draft");
      await as(ada).send("PUT", `/recipes/${id}/draft`, draftBody({ lines: [] }));
      const empty = await as(ada).send("POST", `/recipes/${id}/draft/approve`);
      expect(empty.status).toBe(400);
      expect((await empty.json()).error.message).toMatch(/no ingredients/);
      await as(ada).send("PUT", `/recipes/${id}/draft`, draftBody({ yieldQuantity: 0 }));
      const noYield = await as(ada).send("POST", `/recipes/${id}/draft/approve`);
      expect(noYield.status).toBe(400);
      expect((await noYield.json()).error.message).toMatch(/yield/);
    });

    it("approval needs manage and a signed-in person, and records who and when", async () => {
      await as(ada).send("PUT", `/recipes/${id}/draft`, draftBody());
      const asWriter = await as(marcus.cookie).send("POST", `/recipes/${id}/draft/approve`);
      expect(asWriter.status).toBe(403);
      expect((await asWriter.json()).error.code).toBe("module_forbidden");

      const { token } = await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json();
      const viaToken = await ctx.req(`${WS}/recipes/${id}/draft/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: "" },
      });
      expect(viaToken.status).toBe(403);
      expect((await viaToken.json()).error.code).toBe("token_not_allowed");
      // …but a token may draft.
      const draftViaToken = await ctx.req(`${WS}/recipes/${id}/draft`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: draftBody(),
      });
      expect(draftViaToken.status).toBe(200);

      const ok = await as(ada).send("POST", `/recipes/${id}/draft/approve`);
      expect(ok.status).toBe(200);
      const approved = await ok.json();
      v1 = approved.id;
      expect(approved).toMatchObject({ versionNumber: 1, status: "approved", approvedBy: adaId });
      expect(approved.approvedAt).toBeTruthy();
    });

    it("approved versions are immutable: edits go to a new draft", async () => {
      const res = await as(marcus.cookie).send(
        "PUT",
        `/recipes/${id}/draft`,
        draftBody({ yieldQuantity: 12 }),
      );
      expect(res.status).toBe(200);
      const draft = await res.json();
      v2 = draft.id;
      expect(draft).toMatchObject({ versionNumber: 2, status: "draft", yieldQuantity: 12 });
      const old = await (await as(ada).get(`/recipes/${id}/versions/${v1}`)).json();
      expect(old).toMatchObject({ status: "approved", yieldQuantity: 10 });
      // Saving again edits the same draft instead of making a third version.
      const again = await (
        await as(marcus.cookie).send("PUT", `/recipes/${id}/draft`, draftBody({ yieldQuantity: 11 }))
      ).json();
      expect(again).toMatchObject({ id: v2, versionNumber: 2, yieldQuantity: 11 });
      const recipe = await (await as(ada).get(`/recipes/${id}`)).json();
      expect(recipe.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
      // The current version stays the approved one; the draft is offered beside it.
      expect(recipe.currentVersion.id).toBe(v1);
      expect(recipe.draftVersion.id).toBe(v2);
    });

    it("approving the next draft supersedes the previous version, which is kept", async () => {
      const ok = await as(ada).send("POST", `/recipes/${id}/draft/approve`);
      expect(ok.status).toBe(200);
      const recipe = await (await as(ada).get(`/recipes/${id}`)).json();
      expect(
        recipe.versions.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status]),
      ).toEqual([
        [2, "approved"],
        [1, "superseded"],
      ]);
      expect(recipe.currentVersion.id).toBe(v2);
      expect(recipe.draftVersion).toBeNull();
      const old = await (await as(ada).get(`/recipes/${id}/versions/${v1}`)).json();
      expect(old.status).toBe("superseded");
      expect(old.lines).toHaveLength(3);
      // Nothing left to approve.
      expect((await as(ada).send("POST", `/recipes/${id}/draft/approve`)).status).toBe(409);
    });

    it("a draft can be discarded; the approved version stays", async () => {
      expect((await as(ada).send("DELETE", `/recipes/${id}/draft`)).status).toBe(409);
      await as(ada).send("PUT", `/recipes/${id}/draft`, draftBody());
      expect((await as(ada).send("DELETE", `/recipes/${id}/draft`)).status).toBe(204);
      const recipe = await (await as(ada).get(`/recipes/${id}`)).json();
      expect(recipe.versions).toHaveLength(2);
    });

    it("refuses delete once approved; archive instead, and archived recipes can't be edited", async () => {
      const del = await as(ada).send("DELETE", `/recipes/${id}`);
      expect(del.status).toBe(409);
      expect((await del.json()).error.code).toBe("recipe_approved");
      const patched = await as(marcus.cookie).send("PATCH", `/recipes/${id}`, {
        status: "archived",
        name: "Lifecycle cake",
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ status: "archived", name: "Lifecycle cake" });
      const edit = await as(ada).send("PUT", `/recipes/${id}/draft`, draftBody());
      expect(edit.status).toBe(409);
      expect((await edit.json()).error.code).toBe("recipe_archived");
      await as(ada).send("PATCH", `/recipes/${id}`, { status: "active" });
    });

    it("deletes a recipe that was never approved", async () => {
      const created = await as(ada).send("POST", "/recipes", {
        code: "TEMP",
        name: "Temp",
        outputItemId: cake,
        draft: draftBody(),
      });
      const tempId = (await created.json()).id;
      expect((await as(ada).send("DELETE", `/recipes/${tempId}`)).status).toBe(204);
      expect((await as(ada).get(`/recipes/${tempId}`)).status).toBe(404);
      // The code is free again.
      expect(
        (await as(ada).send("POST", "/recipes", { code: "temp", name: "Temp", outputItemId: cake })).status,
      ).toBe(201);
    });
  });

  describe("roll-ups and scaling", () => {
    let id: string;
    let versionId: string;

    beforeAll(async () => {
      const res = await as(ada).send("POST", "/recipes", {
        code: "ROLL",
        name: "Roll-up",
        outputItemId: cake,
        draft: draftBody({
          lines: [
            { itemId: flour, quantity: 5000, unit: "g" },
            { itemId: milk, quantity: 2, unit: "l" },
            { itemId: nuts, quantity: 1, unit: "kg" },
          ],
        }),
      });
      const recipe = await res.json();
      id = recipe.id;
      versionId = recipe.currentVersion.id;
    });

    it("rolls up allergens, mismatches and cost", async () => {
      const { rollup } = await (await as(ada).get(`/recipes/${id}/versions/${versionId}`)).json();
      expect(rollup.allergens).toEqual({ contains: ["cereals_gluten", "milk"], mayContain: ["nuts"] });
      // The cake declares gluten, eggs and may-contain milk: milk is brought in but not declared
      // as contained, nuts are not mentioned at all, and no ingredient explains eggs.
      expect(rollup.allergenMismatch).toEqual({ undeclared: ["milk", "nuts"], unexplained: ["eggs"] });
      // 5 kg × 1.2 + 2 l × 0.8 + 1 kg × 6
      expect(rollup.cost.batchCost).toBeCloseTo(13.6, 6);
      expect(rollup.cost).toMatchObject({ costComplete: true, missingCostCodes: [], outputUnit: "kg" });
      expect(rollup.cost.costPerOutputUnit).toBeCloseTo(1.36, 6);
    });

    it("reports a partial cost when an ingredient has none", async () => {
      await as(ada).send("PUT", `/recipes/${id}/draft`, draftBody());
      const recipe = await (await as(ada).get(`/recipes/${id}`)).json();
      const { rollup } = recipe.currentVersion;
      // Sugar has no cost: 5 × 1.2 + 2 × 0.8 only.
      expect(rollup.cost).toMatchObject({ costComplete: false, missingCostCodes: ["SUG"] });
      expect(rollup.cost.batchCost).toBeCloseTo(7.6, 6);
      // Back to the original content for the tests below.
      await as(ada).send(
        "PUT",
        `/recipes/${id}/draft`,
        draftBody({
          lines: [
            { itemId: flour, quantity: 5000, unit: "g" },
            { itemId: milk, quantity: 2, unit: "l" },
            { itemId: nuts, quantity: 1, unit: "kg" },
          ],
        }),
      );
    });

    it("scales by batches or by a target output, without rounding silently", async () => {
      const byBatches = await (await as(ada).get(`/recipes/${id}/versions/${versionId}?batches=1.5`)).json();
      expect(byBatches.scale).toEqual({ factor: 1.5, outputQuantity: 15, outputUnit: "kg" });
      expect(byBatches.lines.map((l: { scaledQuantity: number }) => l.scaledQuantity)).toEqual([
        7500, 3, 1.5,
      ]);

      const byOutput = await (
        await as(ada).get(`/recipes/${id}/versions/${versionId}?outputQuantity=3&outputUnit=kg`)
      ).json();
      expect(byOutput.scale.factor).toBeCloseTo(0.3, 10);
      expect(byOutput.lines[0].scaledQuantity).toBeCloseTo(1500, 6);
      // A different unit of the same dimension converts.
      const inGrams = await (
        await as(ada).get(`/recipes/${id}/versions/${versionId}?outputQuantity=500&outputUnit=g`)
      ).json();
      expect(inGrams.scale.factor).toBeCloseTo(0.05, 10);
      // A third of a batch is not rounded in the data, only for display.
      const third = await (
        await as(ada).get(`/recipes/${id}/versions/${versionId}?outputQuantity=10&outputUnit=kg`)
      ).json();
      expect(third.scale.factor).toBe(1);
      const odd = await (await as(ada).get(`/recipes/${id}/versions/${versionId}?batches=0.3333333`)).json();
      expect(odd.lines[2].scaledQuantity).toBeCloseTo(0.3333333, 10);
      expect(odd.lines[2].scaledQuantityRounded).toBe(0.3333);
    });

    it("refuses an impossible scale", async () => {
      const both = await as(ada).get(
        `/recipes/${id}/versions/${versionId}?batches=2&outputQuantity=1&outputUnit=kg`,
      );
      expect(both.status).toBe(400);
      const half = await as(ada).get(`/recipes/${id}/versions/${versionId}?outputQuantity=1`);
      expect(half.status).toBe(400);
      // Litres can't become kilograms: the output item (cake) has no density.
      const wrong = await as(ada).get(`/recipes/${id}/versions/${versionId}?outputQuantity=1&outputUnit=l`);
      expect(wrong.status).toBe(400);
    });
  });

  describe("listing", () => {
    it("filters by text, status, output item and ingredient, with draft flags and allergens", async () => {
      const all = await (await as(ada).get("/recipes")).json();
      expect(all.total).toBe(all.recipes.length);
      const life = all.recipes.find((r: { code: string }) => r.code === "LIFE");
      expect(life).toMatchObject({ approvedVersionNumber: 2, hasDraft: false });
      const roll = all.recipes.find((r: { code: string }) => r.code === "ROLL");
      expect(roll).toMatchObject({ approvedVersionNumber: null, hasDraft: true });
      expect(roll.allergens.contains).toEqual(["cereals_gluten", "milk"]);

      const byText = await (await as(ada).get("/recipes?q=roll-")).json();
      expect(byText.recipes.map((r: { code: string }) => r.code)).toEqual(["ROLL"]);
      const byItem = await (await as(ada).get(`/recipes?itemId=${nuts}`)).json();
      expect(byItem.recipes.map((r: { code: string }) => r.code)).toEqual(["ROLL"]);
      const byOutput = await (await as(ada).get(`/recipes?outputItemId=${dough}`)).json();
      expect(byOutput.recipes.map((r: { code: string }) => r.code)).toEqual(["VAL"]);
      const page = await (await as(ada).get("/recipes?limit=1&offset=1")).json();
      expect(page.recipes).toHaveLength(1);
      expect(page.total).toBe(all.total);

      await as(ada).send("PATCH", `/recipes/${roll.id}`, { status: "archived" });
      expect(
        (await (await as(ada).get("/recipes")).json()).recipes.some(
          (r: { code: string }) => r.code === "ROLL",
        ),
      ).toBe(false);
      const archivedList = await (await as(ada).get("/recipes?status=archived")).json();
      expect(archivedList.recipes.map((r: { code: string }) => r.code)).toEqual(["ROLL"]);
      await as(ada).send("PATCH", `/recipes/${roll.id}`, { status: "active" });
    });

    it("returns 404 for another recipe's version and for unknown ids", async () => {
      const all = await (await as(ada).get("/recipes")).json();
      const [a, b] = all.recipes as { id: string }[];
      const detail = await (await as(ada).get(`/recipes/${b!.id}`)).json();
      const other = detail.versions[0]?.id ?? crypto.randomUUID();
      expect((await as(ada).get(`/recipes/${a!.id}/versions/${other}`)).status).toBe(404);
      expect((await as(ada).get(`/recipes/${crypto.randomUUID()}`)).status).toBe(404);
    });
  });

  describe("allergen re-check and starting from an older version", () => {
    let id: string;
    let butter: string;
    let v1: string;

    it("records the allergen roll-up at approval and says nothing while it still matches", async () => {
      butter = (
        await makeItem({ code: "BTR", name: "Butter", type: "ingredient", unit: "kg", allergens: ["milk"] })
      ).id;
      const created = await (
        await as(ada).send("POST", "/recipes", {
          code: "RECHECK",
          name: "Re-check",
          outputItemId: cake,
          draft: draftBody({ lines: [{ itemId: butter, quantity: 1, unit: "kg" }] }),
        })
      ).json();
      id = created.id;
      // A draft is never checked: nothing was recorded yet.
      expect(created.currentVersion.allergenDrift).toBeNull();
      v1 = (await (await as(ada).send("POST", `/recipes/${id}/draft/approve`)).json()).id;
      const version = await (await as(ada).get(`/recipes/${id}/versions/${v1}`)).json();
      expect(version.approvedAllergens).toEqual({ contains: ["milk"], mayContain: [] });
      expect(version.allergenDrift).toBeNull();
      const row = (await (await as(ada).get("/recipes?q=RECHECK")).json()).recipes[0];
      expect(row.allergenDrift).toBe(false);
    });

    it("flags the approved version when an ingredient's declaration changes", async () => {
      const patch = await as(ada).send("PATCH", `/items/${butter}`, {
        allergens: ["milk", "soybeans"],
        mayContain: ["nuts"],
      });
      expect(patch.status).toBe(200);
      const recipe = await (await as(ada).get(`/recipes/${id}`)).json();
      expect(recipe.currentVersion.allergenDrift).toEqual({
        contains: { added: ["soybeans"], removed: [] },
        mayContain: { added: ["nuts"], removed: [] },
      });
      const row = (await (await as(ada).get("/recipes?q=RECHECK")).json()).recipes[0];
      expect(row.allergenDrift).toBe(true);
      // Superseded and draft versions carry no flag.
      await as(ada).send(
        "PUT",
        `/recipes/${id}/draft`,
        draftBody({ lines: [{ itemId: butter, quantity: 1, unit: "kg" }] }),
      );
      const draft = (await (await as(ada).get(`/recipes/${id}`)).json()).draftVersion;
      expect(draft.allergenDrift).toBeNull();
    });

    it("filters the list to flagged recipes in the query, so paging and the total are right", async () => {
      const all = (await (await as(ada).get("/recipes?limit=200")).json()) as { total: number };
      expect(all.total).toBeGreaterThan(2);
      const flagged = await (await as(ada).get("/recipes?allergenDrift=true&limit=1&offset=0")).json();
      expect(flagged.total).toBe(1);
      expect(flagged.recipes.map((r: { code: string }) => r.code)).toEqual(["RECHECK"]);
      const beyond = await (await as(ada).get("/recipes?allergenDrift=true&limit=1&offset=1")).json();
      expect(beyond.recipes).toEqual([]);
      expect(beyond.total).toBe(1);
      const clean = await (await as(ada).get("/recipes?allergenDrift=false&limit=200")).json();
      expect(clean.total).toBe(all.total - 1);
      expect(clean.recipes.map((r: { code: string }) => r.code)).not.toContain("RECHECK");
    });

    it("notifies recipe managers once per version and drift", async () => {
      const inbox = async () =>
        (
          (await (await as(ada).get("/notifications?limit=100")).json()) as {
            notifications: { type: string; data: { subjectId?: string; snippet?: string } }[];
          }
        ).notifications.filter((n) => n.type === "recipe_allergen_drift");
      expect(await inbox()).toHaveLength(0);
      expect((await as(ada).send("POST", "/notifications/sweep")).status).toBe(200);
      const first = await inbox();
      expect(first).toHaveLength(1);
      expect(first[0]!.data).toMatchObject({
        subjectId: id,
        snippet: "contains +soybeans; may contain +nuts",
      });
      await as(ada).send("POST", "/notifications/sweep");
      expect(await inbox()).toHaveLength(1);
      // The same drift again (the sweep runs often) is silent; a different one notifies again.
      await as(ada).send("PATCH", `/items/${butter}`, { allergens: ["milk", "soybeans", "eggs"] });
      await as(ada).send("POST", "/notifications/sweep");
      expect(await inbox()).toHaveLength(2);
      await as(ada).send("PATCH", `/items/${butter}`, { allergens: ["milk", "soybeans"] });
    });

    it("a new approval records the current declaration and clears the flag", async () => {
      await as(ada).send("POST", `/recipes/${id}/draft/approve`);
      const recipe = await (await as(ada).get(`/recipes/${id}`)).json();
      expect(recipe.currentVersion.allergenDrift).toBeNull();
      expect(recipe.currentVersion.approvedAllergens).toEqual({
        contains: ["milk", "soybeans"],
        mayContain: ["nuts"],
      });
    });

    it("starts a new draft from a superseded version by saving its content", async () => {
      const old = await (await as(ada).get(`/recipes/${id}/versions/${v1}`)).json();
      expect(old.status).toBe("superseded");
      const res = await as(ada).send("PUT", `/recipes/${id}/draft`, {
        yieldQuantity: old.yieldQuantity,
        yieldUnit: old.yieldUnit,
        method: old.method,
        changeNote: "Back to v1",
        lines: old.lines.map(
          (l: { itemId: string; quantity: number; unit: string; note: string | null }) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unit: l.unit,
            note: l.note,
          }),
        ),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ versionNumber: 3, status: "draft", changeNote: "Back to v1" });
    });
  });

  describe("sync log", () => {
    it("records recipe changes, hidden from members without the module", async () => {
      const entities = async (cookie: string) => {
        const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie })).json();
        return new Set(page.changes.map((c: { entity: string }) => c.entity));
      };
      const seen = await entities(ada);
      expect(seen).toContain("recipe");
      expect(seen).toContain("recipe_version");
      expect(seen).toContain("recipe_line");
      expect(await entities(marcus.cookie)).toContain("recipe_version");
      await grant("recipes", "none");
      const hidden = await entities(marcus.cookie);
      expect(hidden).not.toContain("recipe");
      expect(hidden).not.toContain("recipe_version");
      expect(hidden).not.toContain("recipe_line");
      expect(hidden).toContain("item");
      await grant("recipes", "write");
    });
  });
});
