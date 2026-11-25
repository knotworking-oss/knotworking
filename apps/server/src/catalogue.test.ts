import { addDays, DEFAULT_TIME_ZONE, todayInZone, type ModuleId } from "@knotworking/core";
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
});
