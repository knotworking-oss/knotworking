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

describe("stock tools", () => {
  it("offers six tools by default, none for waste, adjustments, lot status, stocktakes or reversals", async () => {
    const { client } = await session();
    const { tools } = await client.listTools();
    const stock = tools.filter((t) => /stock/.test(t.name)).map((t) => t.name);
    expect(stock.sort()).toEqual(
      [
        "get_stock_levels",
        "list_stock_lots",
        "get_stock_lot",
        "suggest_stock_pick",
        "receive_stock",
        "transfer_stock",
      ].sort(),
    );
    expect(tools.map((t) => t.name).join(" ")).not.toMatch(
      /waste|adjust|stocktake|reverse|quarantine|release/,
    );
    const receive = tools.find((t) => t.name === "receive_stock")!;
    expect(receive.description).toMatch(/done by a person in the app/);
    expect(receive.description).toMatch(/unless an owner or admin allows them under Settings → API access/);
  });

  describe("waste, adjustments and stocktakes (API access)", () => {
    const stockActions = ["stock.waste", "stock.adjust", "stock.stocktake"] as const;

    async function withFlour(options: Parameters<typeof connect>[0] = {}) {
      const s = await session(options);
      await s.call("receive_stock", {
        workspace: "acme",
        item: "FLR-001",
        quantity: 10,
        unit: "kg",
        location: "DS",
        received_on: "2026-11-11",
        lot_code: "F-1",
      });
      return s;
    }

    it("appear only for the actions that are enabled", async () => {
      const none = await session();
      expect((await none.client.listTools()).tools.map((t) => t.name)).not.toContain("record_stock_waste");

      const some = await session({ enable: ["stock.adjust"] });
      const names = (await some.client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("adjust_stock");
      expect(names).not.toContain("record_stock_waste");
      expect(names).not.toContain("post_stocktake");

      const all = await session({ enable: [...stockActions] });
      const tools = (await all.client.listTools()).tools;
      for (const name of ["record_stock_waste", "adjust_stock", "post_stocktake"]) {
        const t = tools.find((x) => x.name === name)!;
        expect(t.description, name).toMatch(
          /owner or admin allowed API tokens .* under Settings → API access/,
        );
      }
      expect(tools.find((t) => t.name === "record_stock_waste")!.description).toMatch(/write access/);
      expect(tools.find((t) => t.name === "adjust_stock")!.description).toMatch(/manage access/);
      expect(tools.find((t) => t.name === "post_stocktake")!.description).toMatch(/manage access/);
      for (const name of ["record_stock_waste", "adjust_stock", "post_stocktake"]) {
        expect(tools.find((x) => x.name === name)!.annotations?.destructiveHint, name).toBe(true);
      }
    });

    it("records waste against a lot code and location name, refusing more than is there", async () => {
      const { call, fake } = await withFlour({ enable: ["stock.waste"] });
      const res = await call("record_stock_waste", {
        workspace: "acme",
        lot: "f-1",
        location: "dry store",
        quantity: 500,
        unit: "g",
        reason: "Split bag",
        reference: "W-1",
      });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({ type: "waste", reason: "Split bag", reference: "W-1" });
      expect(fake.stockModule.movements.at(-1)).toMatchObject({
        type: "waste",
        quantity: -500,
        reason: "Split bag",
        reference: "W-1",
      });
      expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/workspaces/acme/stock/waste" });

      const tooMuch = await call("record_stock_waste", {
        workspace: "acme",
        lot: "F-1",
        location: "DS",
        quantity: 50,
        unit: "kg",
        reason: "Flood",
      });
      expect(tooMuch.data.error.code).toBe("insufficient_stock");
    });

    it("posts a signed adjustment: positive adds, negative removes", async () => {
      const { call, fake } = await withFlour({ enable: ["stock.adjust"] });
      const up = await call("adjust_stock", {
        workspace: "acme",
        lot: "F-1",
        location: "DS",
        quantity: 2,
        unit: "kg",
        reason: "Found on shelf",
      });
      expect(up.data).toMatchObject({ type: "adjustment", reason: "Found on shelf" });
      expect(fake.stockModule.movements.at(-1)).toMatchObject({ type: "adjustment", quantity: 2000 });
      await call("adjust_stock", {
        workspace: "acme",
        lot: "F-1",
        location: "DS",
        quantity: -500,
        unit: "g",
        reason: "Dust",
      });
      expect(fake.stockModule.movements.at(-1)).toMatchObject({ type: "adjustment", quantity: -500 });
      expect(fake.requests.at(-1)!.path).toBe("/v1/workspaces/acme/stock/adjustments");

      const zero = await call("adjust_stock", {
        workspace: "acme",
        lot: "F-1",
        location: "DS",
        quantity: 0,
        unit: "kg",
        reason: "Nothing",
      });
      expect(zero.isError).toBe(true);
    });

    it("posts a stocktake and reports the variances, naming the count that can't be resolved", async () => {
      const { call, fake } = await withFlour({ enable: ["stock.stocktake"] });
      const res = await call("post_stocktake", {
        workspace: "acme",
        counts: [{ lot: "F-1", location: "DS", counted_quantity: 9.5, unit: "kg" }],
        reference: "ST-1",
        reason: "Monthly count",
      });
      expect(res.isError).toBe(false);
      expect(res.data).toMatchObject({
        reference: "ST-1",
        posted: 1,
        variances: [
          {
            lotCode: "F-1",
            item: "FLR-001",
            location: "Dry store",
            expected: { base: 10000 },
            counted: { base: 9500 },
            variance: { base: -500 },
          },
        ],
      });
      expect(fake.stockModule.movements.at(-1)).toMatchObject({
        type: "stocktake",
        quantity: -500,
        reference: "ST-1",
        reason: "Monthly count",
      });
      expect(fake.requests.at(-1)!.path).toBe("/v1/workspaces/acme/stock/stocktakes");

      const same = await call("post_stocktake", {
        workspace: "acme",
        counts: [{ lot: "F-1", location: "DS", counted_quantity: 9.5, unit: "kg" }],
      });
      expect(same.data.posted).toBe(0);

      const before = fake.stockModule.movements.length;
      const bad = await call("post_stocktake", {
        workspace: "acme",
        counts: [
          { lot: "F-1", location: "DS", counted_quantity: 1, unit: "kg" },
          { lot: "NOPE", location: "DS", counted_quantity: 1, unit: "kg" },
        ],
      });
      expect(bad.data.error.code).toBe("not_found");
      expect(bad.data.error.message).toMatch(/^counts\[1\]:/);
      expect(fake.stockModule.movements).toHaveLength(before);
    });

    it("looks up each location list, lot and item once however many counts repeat them", async () => {
      const { call, fake } = await withFlour({ enable: ["stock.stocktake"] });
      await call("receive_stock", {
        workspace: "acme",
        item: "FLR-001",
        quantity: 2,
        unit: "kg",
        location: "CH1",
        received_on: "2026-11-11",
        lot_code: "F-2",
      });
      const before = {
        locations: fake.hits("/stock/locations"),
        lots: fake.hits("/stock/lots"),
        items: fake.hits("/items"),
      };
      const counts = Array.from({ length: 120 }, (_, i) => ({
        lot: i % 2 ? "F-1" : "f-2",
        item: "FLR-001",
        location: i % 2 ? "DS" : "Chiller 1",
        counted_quantity: 1,
        unit: "kg" as const,
      }));
      const res = await call("post_stocktake", { workspace: "acme", counts });
      // The API refuses a lot counted twice at one location; only the lookups before that matter here.
      expect(res.data.error.code).toBe("invalid_input");
      expect(fake.hits("/stock/locations") - before.locations).toBe(1);
      expect(fake.hits("/stock/lots") - before.lots).toBe(2);
      expect(fake.hits("/items") - before.items).toBe(1);
    });

    it("surfaces a token_not_allowed refusal readably", async () => {
      const { call, fake } = await withFlour({ enable: [...stockActions] });
      fake.tokenActions.delete("stock.waste");
      const res = await call("record_stock_waste", {
        workspace: "acme",
        lot: "F-1",
        location: "DS",
        quantity: 1,
        unit: "kg",
        reason: "x",
      });
      expect(res.isError).toBe(true);
      expect(res.data.error.code).toBe("token_not_allowed");
      expect(res.data.error.message).toMatch(/Settings → API access/);
    });
  });

  it("receives stock by item code, location name and supplier name, converting units", async () => {
    const { call, fake } = await session();
    const res = await call("receive_stock", {
      workspace: "acme",
      item: "flr-001",
      quantity: 2500,
      unit: "g",
      location: "dry store",
      received_on: "2026-11-11",
      supplier: "Shipton Mill",
      supplier_lot_code: "SM-42",
      expires_on: "2027-05-01",
      expiry_type: "best_before",
      reference: "DN-7",
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({
      item: { code: "FLR-001" },
      supplier: { name: "Shipton Mill" },
      supplierLotCode: "SM-42",
      onHand: { base: 2500, baseUnit: "g", display: 2.5, displayUnit: "kg" },
    });
    expect(fake.stockModule.movements.at(-1)).toMatchObject({
      type: "receipt",
      quantity: 2500,
      reference: "DN-7",
    });

    const pending = await call("receive_stock", {
      workspace: "acme",
      item: "MLK-001",
      quantity: 10,
      unit: "l",
      location: "CH1",
      received_on: "2026-11-11",
      supplier: "Dairy Co",
    });
    expect(pending.isError).toBe(true);
    expect(pending.data.error.code).toBe("supplier_not_approved");
    const held = await call("receive_stock", {
      workspace: "acme",
      item: "MLK-001",
      quantity: 10,
      unit: "l",
      location: "CH1",
      received_on: "2026-11-11",
      supplier: "Dairy Co",
      quarantine: true,
    });
    expect(held.data.status).toBe("quarantine");

    const nowhere = await call("receive_stock", {
      workspace: "acme",
      item: "FLR-001",
      quantity: 1,
      unit: "kg",
      location: "Loft",
      received_on: "2026-11-11",
    });
    expect(nowhere.data.error.code).toBe("not_found");
    expect(nowhere.data.error.message).toMatch(/Dry store \(DS\)/);
  });

  it("transfers by lot code and reports insufficient stock", async () => {
    const { call } = await session();
    await call("receive_stock", {
      workspace: "acme",
      item: "FLR-001",
      quantity: 5,
      unit: "kg",
      location: "DS",
      received_on: "2026-11-11",
      lot_code: "F-1",
    });
    const moved = await call("transfer_stock", {
      workspace: "acme",
      lot: "f-1",
      from_location: "Dry store",
      to_location: "CH1",
      quantity: 2,
      unit: "kg",
    });
    expect(moved.isError).toBe(false);
    expect(moved.data.movements.map((m: { type: string }) => m.type)).toEqual([
      "transfer_out",
      "transfer_in",
    ]);
    const tooMuch = await call("transfer_stock", {
      workspace: "acme",
      lot: "F-1",
      from_location: "DS",
      to_location: "CH1",
      quantity: 4,
      unit: "kg",
    });
    expect(tooMuch.isError).toBe(true);
    expect(tooMuch.data.error.code).toBe("insufficient_stock");

    const lot = await call("get_stock_lot", { workspace: "acme", lot: "F-1" });
    expect(
      lot.data.balances.map((b: { location: string; amount: { base: number } }) => [
        b.location,
        b.amount.base,
      ]),
    ).toEqual([
      ["Dry store", 3000],
      ["Chiller 1", 2000],
    ]);
    expect(lot.data.movements.map((m: { type: string }) => m.type)).toEqual([
      "receipt",
      "transfer_out",
      "transfer_in",
    ]);
    expect((await call("get_stock_lot", { workspace: "acme", lot: "NOPE" })).data.error.code).toBe(
      "not_found",
    );
  });

  it("lists levels and lots, and suggests a FEFO pick", async () => {
    const { call } = await session();
    const receive = (lot_code: string, quantity: number, expires_on: string, quarantine = false) =>
      call("receive_stock", {
        workspace: "acme",
        item: "MLK-001",
        quantity,
        unit: "l",
        location: "CH1",
        received_on: "2026-11-01",
        lot_code,
        expires_on,
        expiry_type: "use_by",
        quarantine,
      });
    await receive("M-LATE", 6, "2026-11-30");
    await receive("M-SOON", 3, "2026-11-14");
    await receive("M-HELD", 9, "2026-11-12", true);

    const levels = await call("get_stock_levels", { workspace: "acme" });
    expect(levels.data.levels).toMatchObject([
      {
        item: { code: "MLK-001" },
        onHand: { display: 18 },
        available: { display: 9 },
        quarantine: { display: 9 },
        lotCount: 3,
        earliestExpiry: "2026-11-12",
      },
    ]);
    const soon = await call("list_stock_lots", {
      workspace: "acme",
      item: "MLK-001",
      expiring_within_days: 7,
    });
    expect(soon.data.lots.map((l: { lotCode: string }) => l.lotCode)).toEqual(["M-HELD", "M-SOON"]);
    expect(soon.data).toMatchObject({ total: 2, hasMore: false });

    const pick = await call("suggest_stock_pick", {
      workspace: "acme",
      item: "MLK-001",
      quantity: 5000,
      unit: "ml",
    });
    expect(
      pick.data.allocations.map((a: { lotCode: string; amount: { display: number } }) => [
        a.lotCode,
        a.amount.display,
      ]),
    ).toEqual([
      ["M-SOON", 3],
      ["M-LATE", 2],
    ]);
    expect(pick.data.shortfall.base).toBe(0);
    const short = await call("suggest_stock_pick", {
      workspace: "acme",
      item: "MLK-001",
      quantity: 20,
      unit: "l",
    });
    expect(short.data.shortfall).toMatchObject({ display: 11, displayUnit: "l" });
  });

  it("reads a lot's release check, with no tool to release", async () => {
    const { call, fake, client } = await session();
    const flour = fake.itemsModule.items.find((i) => i.code === "FLR-001")!;
    fake.stockModule.lots.push({
      id: crypto.randomUUID(),
      itemId: flour.id,
      lotCode: "L-REL",
      status: "quarantine",
      supplierLotCode: null,
    });
    const check = await call("get_lot_qa_evidence", { workspace: "acme", lot: "L-REL" });
    expect(check.data).toMatchObject({ blocked: true, status: "quarantine" });
    expect(check.data.checks[0]).toMatchObject({ status: "block", refs: ["S-2026-0001"] });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => /release_lot|set_lot_status/.test(n))).toBe(false);
  });
});
