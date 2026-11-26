import { addDays, DEFAULT_TIME_ZONE, newId, todayInZone, type ModuleId } from "@knotworking/core";
import { prepareDespatch } from "./despatch-test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const ws = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const genericModules: ModuleId[] = ["items", "recipes", "stock", "production", "purchasing", "costing"];

describe("catalogue and bills of materials", () => {
  let ctx: TestCtx;
  let cookie: string;
  const request = (method: string, path: string, json?: unknown) =>
    ctx.req(ws + path, { method, cookie, json });
  const ok = async (method: string, path: string, json?: unknown, status = 200) => {
    const response = await request(method, path, json);
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  const item = (code: string, type: string, unit: string, rest: object = {}) =>
    ok("POST", "/items", { code, name: code, type, unit, ...rest }, 201);
  const bom = (path: string, outputItemId: string, itemId: string, quantity: number, unit: string) =>
    ok(
      "POST",
      path,
      {
        code: "ASSEMBLY",
        name: "Synthetic assembly",
        outputItemId,
        draft: { yieldQuantity: 2, yieldUnit: "each", lines: [{ itemId, quantity, unit }] },
      },
      201,
    );
  async function assemble(
    recipeId: string,
    lotId: string,
    locationId: string,
    quantity: number,
    unit: string,
  ) {
    const batch = await ok(
      "POST",
      "/production/batches",
      {
        recipeId,
        plannedOn: today,
        batches: 1,
        outputLocationId: locationId,
      },
      201,
    );
    const path = `/production/batches/${batch.id}`;
    await ok("POST", `${path}/start`);
    await ok("POST", `${path}/consumption`, { lines: [{ lotId, locationId, quantity, unit }] }, 201);
    const result = await ok("POST", `${path}/output`, { quantity: 2, unit: "each" }, 201);
    await ok("POST", `${path}/complete`, {});
    return { batchId: batch.id, lotId: result.outputs[0].lotId };
  }

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    cookie = (await signIn(ctx, "ada@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(async () => ctx?.handle.close());

  it("purchases, receives and assembles stock in different units with Food items disabled", async () => {
    await ok("PATCH", "/module-settings", { modules: genericModules });
    const supplier = await ok("POST", "/suppliers", { name: "Synthetic metals" }, 201);
    await ok("POST", `/suppliers/${supplier.id}/approval`, { status: "approved" });
    const store = await ok("POST", "/stock/locations", { name: "Workshop" }, 201);
    const bar = await item("BAR", "raw_material", "m", { standardCost: 20 });
    const plate = await item("PLATE", "consumable", "m2", { standardCost: 50 });
    const service = await item("POLISH", "service", "h");
    const bracket = await item("BRACKET", "component", "each");
    expect(bar).not.toHaveProperty("allergens");
    expect(await ok("GET", "/items?allergen=milk", undefined, 404)).toMatchObject({
      error: { code: "module_inactive" },
    });
    await ok("PATCH", `/items/${bar.id}`, { shelfLifeDays: 2 }, 404);

    const order = await ok(
      "POST",
      "/purchasing/orders",
      {
        supplierId: supplier.id,
        expectedOn: today,
        lines: [
          { itemId: bar.id, quantity: 4, unit: "m", unitPrice: 18 },
          { itemId: plate.id, quantity: 2, unit: "m2", unitPrice: 40 },
          {
            kind: "non_stock",
            itemId: service.id,
            description: "Polishing",
            quantity: 2,
            unit: "h",
            unitPrice: 15,
          },
        ],
      },
      201,
    );
    await ok("POST", `/purchasing/orders/${order.id}/send`, {});
    const received = await ok(
      "POST",
      `/purchasing/orders/${order.id}/receipts`,
      {
        receivedOn: today,
        lines: [
          { lineId: order.lines[0].id, outcome: "accepted", quantity: 400, unit: "cm", locationId: store.id },
          {
            lineId: order.lines[1].id,
            outcome: "accepted",
            quantity: 20_000,
            unit: "cm2",
            locationId: store.id,
          },
          { lineId: order.lines[2].id, outcome: "accepted", quantity: 2 },
        ],
      },
      201,
    );
    const barLot = received.receipts.find((r: { lineId: string }) => r.lineId === order.lines[0].id).lotId;
    const areaLot = received.receipts.find((r: { lineId: string }) => r.lineId === order.lines[1].id).lotId;
    expect(
      received.receipts.find((r: { lineId: string }) => r.lineId === order.lines[2].id).lotId,
    ).toBeNull();
    expect(await ok("GET", `/stock/lots/${areaLot}`)).toMatchObject({
      onHand: { display: 2, displayUnit: "m2" },
    });

    const recipe = await bom("/boms", bracket.id, bar.id, 125, "cm");
    const version = await ok("POST", `/boms/${recipe.id}/draft/approve`);
    expect(version).toMatchObject({
      approvedAllergens: null,
      rollup: { cost: { batchCost: 25, costPerOutputUnit: 12.5 } },
    });
    expect((await ok("GET", `/recipes/${recipe.id}`)).currentVersion.id).toBe(version.id);
    const made = await assemble(recipe.id, barLot, store.id, 1250, "mm");
    expect(await ok("GET", `/stock/lots/${barLot}`)).toMatchObject({
      expiresOn: null,
      onHand: { base: 2750, display: 2.75, displayUnit: "m" },
    });
    expect(await ok("GET", `/costing/batches/${made.batchId}`)).toMatchObject({
      actualCost: 22.5,
      costPerUnit: 11.25,
    });
  });

  it("keeps length and area quantities consistent across BOMs, purchasing, stock and costing", async () => {
    await ok("PATCH", "/module-settings", { modules: genericModules });
    const supplier = await ok("POST", "/suppliers", { name: "Synthetic sheet goods" }, 201);
    await ok("POST", `/suppliers/${supplier.id}/approval`, { status: "approved" });
    const store = await ok("POST", "/stock/locations", { name: "Panel store" }, 201);
    const sheet = await item("SHEET", "raw_material", "m2", { standardCost: 30 });
    const trim = await item("TRIM", "raw_material", "m", { standardCost: 2 });
    const panel = await item("PANEL", "component", "each");

    // Units that cannot be converted are refused rather than guessed.
    const badLine = await request("POST", "/boms", {
      code: "PANEL-BAD",
      name: "Unconvertible panel",
      outputItemId: panel.id,
      draft: { yieldQuantity: 4, yieldUnit: "each", lines: [{ itemId: sheet.id, quantity: 1, unit: "m" }] },
    });
    expect(badLine.status).toBe(400);
    const badOrder = await request("POST", "/purchasing/orders", {
      supplierId: supplier.id,
      expectedOn: today,
      lines: [{ itemId: trim.id, quantity: 1, unit: "m2", unitPrice: 1 }],
    });
    expect(badOrder.status).toBe(400);

    // Bought in a unit other than the item's own, priced per that unit.
    const order = await ok(
      "POST",
      "/purchasing/orders",
      {
        supplierId: supplier.id,
        expectedOn: today,
        lines: [
          { itemId: sheet.id, quantity: 1, unit: "m2", unitPrice: 36 },
          { itemId: trim.id, quantity: 200, unit: "cm", unitPrice: 0.03 },
        ],
      },
      201,
    );
    expect(order.lines.map((line: { lineValue: number }) => line.lineValue)).toEqual([36, 6]);
    expect(order.lines[1].ordered).toMatchObject({ inLineUnit: 200 });
    await ok("POST", `/purchasing/orders/${order.id}/send`, {});
    const received = await ok(
      "POST",
      `/purchasing/orders/${order.id}/receipts`,
      {
        receivedOn: today,
        lines: [
          {
            lineId: order.lines[0].id,
            outcome: "accepted",
            quantity: 10_000,
            unit: "cm2",
            locationId: store.id,
          },
          { lineId: order.lines[1].id, outcome: "accepted", quantity: 2, unit: "m", locationId: store.id },
        ],
      },
      201,
    );
    const lotOf = (line: { id: string }) =>
      received.receipts.find((r: { lineId: string }) => r.lineId === line.id).lotId;
    const sheetLot = lotOf(order.lines[0]);
    const trimLot = lotOf(order.lines[1]);
    expect(await ok("GET", `/stock/lots/${sheetLot}`)).toMatchObject({
      onHand: { base: 1_000_000, display: 1, displayUnit: "m2" },
    });
    expect(await ok("GET", `/stock/lots/${trimLot}`)).toMatchObject({
      onHand: { base: 2000, display: 2, displayUnit: "m" },
    });

    // Four panels take half a square metre of sheet and 1.2 m of trim.
    const recipe = await ok(
      "POST",
      "/boms",
      {
        code: "PANEL-BOM",
        name: "Synthetic panel",
        outputItemId: panel.id,
        draft: {
          yieldQuantity: 4,
          yieldUnit: "each",
          lines: [
            { itemId: sheet.id, quantity: 5000, unit: "cm2" },
            { itemId: trim.id, quantity: 1200, unit: "mm" },
          ],
        },
      },
      201,
    );
    const version = await ok("POST", `/boms/${recipe.id}/draft/approve`);
    expect(version.rollup.cost.batchCost).toBeCloseTo(17.4);
    expect(version.rollup.cost.costPerOutputUnit).toBeCloseTo(4.35);
    const scaled = await ok(
      "GET",
      `/boms/${recipe.id}/versions/${version.id}?outputQuantity=8&outputUnit=each`,
    );
    expect(scaled.scale).toMatchObject({ factor: 2 });

    const batch = await ok(
      "POST",
      "/production/batches",
      { recipeId: recipe.id, plannedOn: today, batches: 2, outputLocationId: store.id },
      201,
    );
    const needs = await ok("GET", `/production/requirements?from=${today}&to=${today}`);
    const need = (itemId: string) =>
      needs.requirements.find((r: { item: { id: string } }) => r.item.id === itemId);
    expect(need(sheet.id)).toMatchObject({
      required: { base: 1_000_000, display: 1, displayUnit: "m2" },
      shortfall: { base: 0 },
    });
    expect(need(trim.id)).toMatchObject({
      required: { base: 2400, display: 2.4, displayUnit: "m" },
      shortfall: { base: 400, display: 0.4, displayUnit: "m" },
    });

    const path = `/production/batches/${batch.id}`;
    await ok("POST", `${path}/start`);
    await ok(
      "POST",
      `${path}/consumption`,
      {
        lines: [
          { lotId: sheetLot, locationId: store.id, quantity: 1, unit: "m2" },
          { lotId: trimLot, locationId: store.id, quantity: 200, unit: "cm" },
        ],
      },
      201,
    );
    await ok("POST", `${path}/output`, { quantity: 8, unit: "each" }, 201);
    await ok("POST", `${path}/complete`, {});
    const costed = await ok("GET", `/costing/batches/${batch.id}`);
    expect(costed.actualCost).toBeCloseTo(42);
    expect(costed.costPerUnit).toBeCloseTo(5.25);
  });

  it("values a large area lot at the entered price, rounding only the money", async () => {
    await ok("PATCH", "/module-settings", { modules: genericModules });
    const supplier = await ok("POST", "/suppliers", { name: "Synthetic flooring" }, 201);
    await ok("POST", `/suppliers/${supplier.id}/approval`, { status: "approved" });
    const store = await ok("POST", "/stock/locations", { name: "Flooring store" }, 201);
    const vinyl = await item("VINYL", "raw_material", "m2");
    const order = await ok(
      "POST",
      "/purchasing/orders",
      {
        supplierId: supplier.id,
        expectedOn: today,
        lines: [{ itemId: vinyl.id, quantity: 500, unit: "m2", unitPrice: 2.994 }],
      },
      201,
    );
    expect(order.lines[0].lineValue).toBe(1497);
    await ok("POST", `/purchasing/orders/${order.id}/send`, {});
    const received = await ok(
      "POST",
      `/purchasing/orders/${order.id}/receipts`,
      {
        receivedOn: today,
        lines: [
          { lineId: order.lines[0].id, outcome: "accepted", quantity: 500, unit: "m2", locationId: store.id },
        ],
      },
      201,
    );
    const lotId = received.receipts[0].lotId;
    // £2.994/m² is £0.000002994/mm²: held to 8 places it would value the lot at £1,495.
    expect(received.receipts[0].unitPrice).toBe(0.000002994);
    const cost = await ok("GET", `/costing/lots/${lotId}`);
    expect(cost).toMatchObject({ unitCost: 2.994, receipts: [{ unitPrice: 2.994 }] });
    const valuation = await ok("GET", "/costing/valuation?q=VINYL");
    expect(valuation.lots).toHaveLength(1);
    expect(valuation.lots[0].value).toBe(1497);
  });

  it("buys merchandise, sells it and despatches it from stock with Food items disabled", async () => {
    await ok("PATCH", "/module-settings", {
      modules: [...genericModules, "customers", "despatch", "sales"],
    });
    const store = await ok("POST", "/stock/locations", { name: "Shop store" }, 201);
    const mug = await item("MUG", "merchandise", "each", { standardCost: 3 });
    const supplier = await ok("POST", "/suppliers", { name: "Synthetic pottery" }, 201);
    await ok("POST", `/suppliers/${supplier.id}/approval`, { status: "approved" });
    const purchase = await ok(
      "POST",
      "/purchasing/orders",
      {
        supplierId: supplier.id,
        expectedOn: today,
        lines: [{ itemId: mug.id, quantity: 12, unit: "each", unitPrice: 2.5 }],
      },
      201,
    );
    await ok("POST", `/purchasing/orders/${purchase.id}/send`, {});
    const received = await ok(
      "POST",
      `/purchasing/orders/${purchase.id}/receipts`,
      {
        receivedOn: today,
        lines: [
          {
            lineId: purchase.lines[0].id,
            outcome: "accepted",
            quantity: 12,
            unit: "each",
            locationId: store.id,
          },
        ],
      },
      201,
    );
    const lotId = received.receipts[0].lotId as string;
    expect(await ok("GET", `/stock/lots/${lotId}`)).toMatchObject({ onHand: { base: 12 } });
    const customer = await ok(
      "POST",
      "/customers",
      { code: "retail", name: "Synthetic retailer", address: "1 Example Street" },
      201,
    );
    const created = await ok(
      "POST",
      "/sales/orders",
      {
        commandId: newId(),
        kind: "order",
        document: {
          customerId: customer.id,
          currency: "GBP",
          lines: [{ itemId: mug.id, quantity: 5, unit: "each", dueOn: today, unitPrice: 6 }],
        },
      },
      201,
    );
    const sale = await ok("POST", `/sales/orders/${created.id}/confirm`, {
      commandId: newId(),
      expectedRevision: created.revision,
      reason: "Confirmed by phone",
    });
    const despatch = await ok(
      "POST",
      "/despatch",
      {
        customerId: customer.id,
        despatchedOn: today,
        lines: [{ lotId, locationId: store.id, quantity: 5, unit: "each" }],
      },
      201,
    );
    expect(despatch.lines).toHaveLength(1);
    const prepared = await prepareDespatch(request, despatch.id);
    expect(prepared.error).toBeUndefined();
    await ok("POST", `/despatch/${despatch.id}/confirm`, {
      commandId: newId(),
      expectedUpdatedAt: prepared.stamp,
    });
    // Confirming the despatch takes the mugs out of stock.
    expect(await ok("GET", `/stock/lots/${lotId}`)).toMatchObject({ onHand: { base: 7 } });
    await ok("POST", `/sales/orders/${sale.id}/fulfilments`, {
      commandId: newId(),
      expectedRevision: sale.revision,
      orderLineId: sale.lines[0].id,
      despatchLineId: despatch.lines[0].id,
      reason: "Fulfilled customer order",
    });
    expect((await ok("GET", `/sales/orders/${sale.id}/fulfilments`)).lines[0]).toMatchObject({
      shipped: 5,
      outstanding: 0,
    });
    const raw = await item("STEEL", "raw_material", "kg");
    const rawLot = await ok(
      "POST",
      "/stock/receipts",
      { itemId: raw.id, quantity: 1, unit: "kg", locationId: store.id, receivedOn: today },
      201,
    );
    const refused = await request("POST", "/despatch", {
      customerId: customer.id,
      despatchedOn: today,
      lines: [{ lotId: rawLot.id, locationId: store.id, quantity: 1, unit: "kg" }],
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("item_not_despatchable");
  });

  it("retains allergen snapshots, expiry defaults and lot traceability in a food workspace", async () => {
    await ok("PATCH", "/module-settings", { modules: null });
    const flour = await item("FLOUR", "ingredient", "kg", {
      allergens: ["cereals_gluten"],
      mayContain: ["milk"],
    });
    const bread = await item("BREAD", "finished", "each", {
      allergens: ["cereals_gluten"],
      shelfLifeDays: 3,
    });
    const store = await ok("POST", "/stock/locations", { name: "Kitchen" }, 201);
    const lot = await ok(
      "POST",
      "/stock/receipts",
      { itemId: flour.id, quantity: 2, unit: "kg", locationId: store.id, receivedOn: today },
      201,
    );
    const recipe = await ok(
      "POST",
      "/recipes",
      {
        code: "BREAD-RECIPE",
        name: "Synthetic bread",
        outputItemId: bread.id,
        draft: {
          yieldQuantity: 2,
          yieldUnit: "each",
          lines: [{ itemId: flour.id, quantity: 1000, unit: "g" }],
        },
      },
      201,
    );
    expect(await ok("POST", `/recipes/${recipe.id}/draft/approve`)).toMatchObject({
      approvedAllergens: { contains: ["cereals_gluten"], mayContain: ["milk"] },
    });
    const made = await assemble(recipe.id, lot.id, store.id, 1, "kg");
    expect(await ok("GET", `/stock/lots/${made.lotId}`)).toMatchObject({ expiresOn: addDays(today, 3) });
    expect(await ok("GET", `/production/lots/${made.lotId}/trace`)).toMatchObject({
      backward: [{ batch: { id: made.batchId }, inputs: [{ lot: { id: lot.id }, amount: { base: 1000 } }] }],
    });

    await ok("PATCH", "/module-settings", { modules: genericModules });
    expect(await ok("GET", `/items/${flour.id}`)).not.toHaveProperty("allergens");
    expect((await ok("GET", `/boms/${recipe.id}`)).currentVersion.approvedAllergens).toBeNull();
    const sync = await ok("GET", "/sync?after=0&limit=500");
    expect(sync.changes.some((change: { entity: string }) => change.entity === "food_item")).toBe(false);
    expect(
      sync.changes.some(
        (change: { data: object | null }) =>
          change.data && ("allergens" in change.data || "approvedAllergens" in change.data),
      ),
    ).toBe(false);
    await ok("PATCH", "/module-settings", { modules: null });
    expect(await ok("GET", `/items/${flour.id}`)).toMatchObject({
      allergens: ["cereals_gluten"],
      mayContain: ["milk"],
    });
  });

  it("redacts food data from sync for a member and a token without Food items while it is active", async () => {
    await ok("PATCH", "/module-settings", { modules: null });
    const nuts = await item("NUTMIX", "ingredient", "kg", { allergens: ["nuts"], shelfLifeDays: 30 });
    const snack = await item("SNACK", "finished", "each", { allergens: ["nuts"] });
    const recipe = await ok(
      "POST",
      "/recipes",
      {
        code: "SNACK-RECIPE",
        name: "Synthetic snack",
        outputItemId: snack.id,
        draft: {
          yieldQuantity: 2,
          yieldUnit: "each",
          lines: [{ itemId: nuts.id, quantity: 100, unit: "g" }],
        },
      },
      201,
    );
    await ok("POST", `/recipes/${recipe.id}/draft/approve`);

    const { members } = await ok("GET", "/members");
    const marcus = members.find((m: { email: string }) => m.email === "marcus@knotworking.dev");
    for (const module of ["items", "recipes"])
      await ok("PUT", `/members/${marcus.userId}/module-access/${module}`, { level: "read" });
    await ok("PUT", `/members/${marcus.userId}/module-access/food_items`, { level: "none" });
    const marcusCookie = (await signIn(ctx, marcus.email)).cookie;
    const created = await ctx.req("/v1/me/api-tokens", {
      method: "POST",
      cookie,
      json: { name: "Catalogue sync", scope: "read", modules: ["items", "recipes"] },
    });
    expect(created.status).toBe(201);
    const restrictedToken = (await created.json()).token as string;

    type Change = { entity: string; entityId: string; data: Record<string, unknown> | null };
    const pull = async (auth: { cookie: string } | { headers: Record<string, string> }) => {
      const all: Change[] = [];
      let after = "0";
      for (;;) {
        const res = await ctx.req(`${ws}/sync?after=${after}&limit=1000`, { method: "GET", ...auth });
        const page = await res.json();
        expect(res.status, JSON.stringify(page)).toBe(200);
        all.push(...page.changes);
        if (!page.hasMore) return all;
        after = page.cursor;
      }
    };
    const leaks = (changes: Change[]) =>
      changes.filter(
        (c) =>
          c.entity === "food_item" ||
          (c.data !== null && ("allergens" in c.data || "approvedAllergens" in c.data)),
      );
    // The owner sees the food data; it is there to leak.
    const owner = await pull({ cookie });
    expect(leaks(owner).some((c) => c.entityId === nuts.id)).toBe(true);
    expect(owner.some((c) => c.entity === "recipe_version" && c.data?.approvedAllergens)).toBe(true);

    for (const auth of [
      { cookie: marcusCookie },
      { headers: { authorization: `Bearer ${restrictedToken}`, origin: "" } },
    ]) {
      const changes = await pull(auth);
      // The items and versions still sync, without their food fields.
      expect(changes.some((c) => c.entity === "item" && c.entityId === nuts.id)).toBe(true);
      expect(changes.some((c) => c.entity === "recipe_version" && c.data?.recipeId === recipe.id)).toBe(true);
      expect(leaks(changes)).toEqual([]);
    }
  });

  it("records the allergen baseline of a version approved while Food items is off", async () => {
    await ok("PATCH", "/module-settings", { modules: null });
    const oats = await item("OATS", "ingredient", "kg", { allergens: ["cereals_gluten"] });
    const bar = await item("OATBAR", "finished", "each", { allergens: ["cereals_gluten"] });
    await ok("PATCH", "/module-settings", { modules: genericModules });
    const recipe = await ok(
      "POST",
      "/boms",
      {
        code: "OATBAR-BOM",
        name: "Synthetic oat bar",
        outputItemId: bar.id,
        draft: {
          yieldQuantity: 2,
          yieldUnit: "each",
          lines: [{ itemId: oats.id, quantity: 100, unit: "g" }],
        },
      },
      201,
    );
    // Hidden from the response while Food items is off, but recorded on the version.
    expect(await ok("POST", `/boms/${recipe.id}/draft/approve`)).toMatchObject({ approvedAllergens: null });

    await ok("PATCH", "/module-settings", { modules: null });
    const current = (await ok("GET", `/recipes/${recipe.id}`)).currentVersion;
    expect(current).toMatchObject({
      approvedAllergens: { contains: ["cereals_gluten"], mayContain: [] },
      allergenDrift: null,
    });
    // An ingredient's declaration changes after Food items is back: the version is flagged.
    await ok("PATCH", `/items/${oats.id}`, { mayContain: ["milk"] });
    expect((await ok("GET", `/recipes/${recipe.id}`)).currentVersion.allergenDrift).toMatchObject({
      mayContain: { added: ["milk"], removed: [] },
    });
    const flagged = await ok("GET", "/recipes?allergenDrift=true&limit=100");
    expect(flagged.recipes.map((r: { id: string }) => r.id)).toContain(recipe.id);
  });
});
