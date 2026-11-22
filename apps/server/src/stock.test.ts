import { addDays, DEFAULT_TIME_ZONE, parseActiveModules, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

describe("stock module", () => {
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
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const created = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 201) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const balance = async (lotId: string) =>
    Object.fromEntries(
      (await (await as(ada).get(`/stock/lots/${lotId}`)).json()).balances.map(
        (b: { locationId: string; amount: { base: number } }) => [b.locationId, b.amount.base],
      ),
    ) as Record<string, number>;

  const itemFor = async (code: string, type = "ingredient") =>
    (await created(await as(ada).send("POST", "/items", { code, name: code, type, unit: "kg" })))
      .id as string;

  // Fixtures.
  let flour: string; // ingredient, kg, shelf life 270 days
  let milk: string; // ingredient, l, density 1.03
  let cake: string; // finished good
  let approved: string;
  let pending: string;
  let suspended: string;
  let store: string;
  let chiller: string;

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

    const item = async (body: object) => (await created(await as(ada).send("POST", "/items", body))).id;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg", shelfLifeDays: 270 });
    milk = await item({ code: "MLK", name: "Milk", type: "ingredient", unit: "l", densityGPerMl: 1.03 });
    cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each" });
    const supplier = async (name: string, status?: string) => {
      const id = (await created(await as(ada).send("POST", "/suppliers", { name }))).id;
      if (status) await created(await as(ada).send("POST", `/suppliers/${id}/approval`, { status }), 200);
      return id;
    };
    approved = await supplier("Mill", "approved");
    pending = await supplier("New Dairy");
    suspended = await supplier("Bad Farm", "suspended");
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in, and needs the items module too", async () => {
      expect((await as(marcus.cookie).get("/stock/levels")).status).toBe(403);
      await grant("stock", "read");
      // stock depends on items: without items it is still closed.
      expect((await as(marcus.cookie).get("/stock/levels")).status).toBe(403);
      await grant("items", "write");
      expect((await as(marcus.cookie).get("/stock/levels")).status).toBe(200);
      const write = await as(marcus.cookie).send("POST", "/stock/locations", { name: "Shed" });
      expect(write.status).toBe(403);
      await grant("stock", "write");
    });

    it("is switched off with the module, and can't be on without items", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", "items"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/stock/levels`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
      expect(() => parseActiveModules("tasks,stock")).toThrow(/needs "items"/);
    }, 60_000);
  });

  describe("locations", () => {
    it("creates, lists and updates locations; codes are unique", async () => {
      store = (
        await created(
          await as(marcus.cookie).send("POST", "/stock/locations", { name: "Dry store", code: "DS" }),
        )
      ).id;
      chiller = (
        await created(
          await as(ada).send("POST", "/stock/locations", {
            name: "Chiller 1",
            code: "CH1",
            storage: "chilled",
          }),
        )
      ).id;
      const dupe = await as(ada).send("POST", "/stock/locations", { name: "Other", code: "ds" });
      expect(dupe.status).toBe(409);
      const { locations } = await (await as(ada).get("/stock/locations")).json();
      expect(locations.map((l: { name: string }) => l.name)).toEqual(["Chiller 1", "Dry store"]);
      expect(locations[0]).toMatchObject({ storage: "chilled", status: "active", lotCount: 0 });
      expect(locations[0].workspaceId).toBeUndefined();
    });
  });

  describe("goods-in", () => {
    it("converts the quantity to the base unit and defaults the expiry from shelf life", async () => {
      const lot = await created(
        await as(marcus.cookie).send("POST", "/stock/receipts", {
          itemId: flour,
          quantity: 25,
          unit: "kg",
          locationId: store,
          receivedOn: today,
          supplierId: approved,
          supplierLotCode: "M-778",
          reference: "DN-1001",
        }),
      );
      expect(lot).toMatchObject({
        lotCode: `L${today.slice(2, 4)}${today.slice(5, 7)}${today.slice(8, 10)}-001`,
        status: "available",
        expiresOn: addDays(today, 270),
        expiryType: "best_before",
        supplierLotCode: "M-778",
        supplier: { id: approved, name: "Mill", approvalStatus: "approved" },
        onHand: { base: 25000, baseUnit: "g", display: 25, displayUnit: "kg" },
      });
      expect(lot.movements).toMatchObject([
        { type: "receipt", quantity: 25000, reference: "DN-1001", actorId: marcus.userId },
      ]);
    });

    it("crosses dimensions with the item's density, and refuses units it can't convert", async () => {
      const lot = await created(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: milk,
          quantity: 10.3,
          unit: "kg",
          locationId: chiller,
          receivedOn: today,
          expiresOn: addDays(today, 5),
          expiryType: "use_by",
          lotCode: "MILK-A",
        }),
      );
      expect(lot.onHand).toEqual({ base: 10000, baseUnit: "ml", display: 10, displayUnit: "l" });
      expect(lot).toMatchObject({ expiryType: "use_by", lotCode: "MILK-A" });
      const bad = await as(ada).send("POST", "/stock/receipts", {
        itemId: flour,
        quantity: 1,
        unit: "l",
        locationId: store,
        receivedOn: today,
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe("unit_not_convertible");
      // Lot codes are unique per item, case-insensitively.
      const dupe = await as(ada).send("POST", "/stock/receipts", {
        itemId: milk,
        quantity: 1,
        unit: "l",
        locationId: chiller,
        receivedOn: today,
        lotCode: "milk-a",
      });
      expect(dupe.status).toBe(409);
      expect((await dupe.json()).error.code).toBe("lot_code_taken");
    });

    it("applies supplier approval: suspended refused, pending only into quarantine", async () => {
      const base = { itemId: flour, quantity: 5, unit: "kg", locationId: store, receivedOn: today };
      const refused = await as(ada).send("POST", "/stock/receipts", { ...base, supplierId: suspended });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe("supplier_not_approved");
      const notYet = await as(ada).send("POST", "/stock/receipts", { ...base, supplierId: pending });
      expect(notYet.status).toBe(409);
      const held = await created(
        await as(ada).send("POST", "/stock/receipts", { ...base, supplierId: pending, status: "quarantine" }),
      );
      expect(held).toMatchObject({ status: "quarantine", statusChangedBy: adaId });
    });

    it("receives only ingredients and packaging, unless manage gives a reason (opening balance)", async () => {
      const base = { itemId: cake, quantity: 10, unit: "each", locationId: store, receivedOn: today };
      const writer = await as(marcus.cookie).send("POST", "/stock/receipts", { ...base, reason: "Opening" });
      expect(writer.status).toBe(403);
      expect((await writer.json()).error.code).toBe("item_not_receivable");
      expect((await as(ada).send("POST", "/stock/receipts", base)).status).toBe(400);
      const opening = await created(
        await as(ada).send("POST", "/stock/receipts", { ...base, reason: "Opening balance" }),
      );
      expect(opening.movements[0]).toMatchObject({
        type: "receipt",
        reason: "Opening balance",
        quantity: 10,
      });
    });
  });

  describe("movements", () => {
    let lot: string;

    beforeAll(async () => {
      lot = (
        await created(
          await as(ada).send("POST", "/stock/receipts", {
            itemId: flour,
            quantity: 10,
            unit: "kg",
            locationId: store,
            receivedOn: today,
            lotCode: "FLR-MOVE",
          }),
        )
      ).id;
    });

    it("transfers between locations as a pair sharing a transfer id", async () => {
      const res = await created(
        await as(marcus.cookie).send("POST", "/stock/transfers", {
          lotId: lot,
          fromLocationId: store,
          toLocationId: chiller,
          quantity: 2500,
          unit: "g",
        }),
      );
      expect(res.movements.map((m: { type: string; quantity: number }) => [m.type, m.quantity])).toEqual([
        ["transfer_out", -2500],
        ["transfer_in", 2500],
      ]);
      expect(new Set(res.movements.map((m: { transferId: string }) => m.transferId))).toEqual(
        new Set([res.transferId]),
      );
      expect(await balance(lot)).toEqual({ [store]: 7500, [chiller]: 2500 });
    });

    it("refuses to take more than is there, saying what is available", async () => {
      const res = await as(marcus.cookie).send("POST", "/stock/transfers", {
        lotId: lot,
        fromLocationId: chiller,
        toLocationId: store,
        quantity: 3,
        unit: "kg",
      });
      expect(res.status).toBe(409);
      const { error } = await res.json();
      expect(error.code).toBe("insufficient_stock");
      expect(error.details.available).toEqual({ base: 2500, baseUnit: "g", display: 2.5, displayUnit: "kg" });
    });

    it("lets only one of two concurrent withdrawals spend the same stock", async () => {
      const take = () =>
        as(marcus.cookie).send("POST", "/stock/waste", {
          lotId: lot,
          locationId: chiller,
          quantity: 2,
          unit: "kg",
          reason: "Dropped",
        });
      const results = await Promise.all([take(), take()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect((await balance(lot))[chiller]).toBe(500);
    });

    it("waste needs write and a person; adjustments need manage and a person", async () => {
      const waste = { lotId: lot, locationId: store, quantity: 100, unit: "g", reason: "Spill" };
      expect((await viaToken("POST", "/stock/waste", waste)).status).toBe(403);
      expect((await as(ada).send("POST", "/stock/waste", { ...waste, reason: "" })).status).toBe(400);
      const wasted = await created(await as(marcus.cookie).send("POST", "/stock/waste", waste));
      expect(wasted).toMatchObject({ type: "waste", quantity: -100, reason: "Spill" });

      const adjustment = { lotId: lot, locationId: store, quantity: -0.4, unit: "kg", reason: "Recount" };
      const writer = await as(marcus.cookie).send("POST", "/stock/adjustments", adjustment);
      expect(writer.status).toBe(403);
      expect((await writer.json()).error.code).toBe("module_forbidden");
      const tokenRes = await viaToken("POST", "/stock/adjustments", adjustment);
      expect((await tokenRes.json()).error.code).toBe("token_not_allowed");
      expect((await created(await as(ada).send("POST", "/stock/adjustments", adjustment))).quantity).toBe(
        -400,
      );
      const overdraw = await as(ada).send("POST", "/stock/adjustments", { ...adjustment, quantity: -100 });
      expect((await overdraw.json()).error.code).toBe("insufficient_stock");
      expect(await balance(lot)).toEqual({ [store]: 7000, [chiller]: 500 });
    });

    it("stocktakes post the differences (manage and a person) and return variances", async () => {
      const body = {
        reference: "ST-NOV",
        counts: [
          { lotId: lot, locationId: store, countedQuantity: 6.8, unit: "kg" },
          { lotId: lot, locationId: chiller, countedQuantity: 500, unit: "g" },
        ],
      };
      expect((await as(marcus.cookie).send("POST", "/stock/stocktakes", body)).status).toBe(403);
      expect((await viaToken("POST", "/stock/stocktakes", body)).status).toBe(403);
      const result = await created(await as(ada).send("POST", "/stock/stocktakes", body));
      expect(result.posted).toBe(1);
      expect(result.variances.map((v: { variance: { base: number } }) => v.variance.base)).toEqual([-200, 0]);
      const { movements } = await (await as(ada).get(`/stock/movements?lotId=${lot}&type=stocktake`)).json();
      expect(movements).toMatchObject([{ quantity: -200, reference: "ST-NOV" }]);
      expect((await balance(lot))[store]).toBe(6800);
    });

    it("reverses a movement once, never into a negative balance", async () => {
      const { movements } = await (await as(ada).get(`/stock/movements?lotId=${lot}&type=waste`)).json();
      const spill = movements.find((m: { reason: string }) => m.reason === "Spill");
      const reverse = (id: string, cookie = ada) =>
        as(cookie).send("POST", `/stock/movements/${id}/reverse`, { reason: "Posted in error" });
      expect((await reverse(spill.id, marcus.cookie)).status).toBe(403);
      expect((await viaToken("POST", `/stock/movements/${spill.id}/reverse`, { reason: "x" })).status).toBe(
        403,
      );
      const res = await created(await reverse(spill.id));
      expect(res.movements).toMatchObject([{ type: "waste", quantity: 100, reversesMovementId: spill.id }]);
      expect((await balance(lot))[store]).toBe(6900);
      const again = await reverse(spill.id);
      expect(again.status).toBe(409);
      expect((await again.json()).error.code).toBe("already_reversed");
      expect((await reverse(res.movements[0].id)).status).toBe(409);

      // Reversing the transfer pair would take 2.5 kg out of the chiller, which holds 0.5 kg.
      const transfers = await (await as(ada).get(`/stock/movements?lotId=${lot}&type=transfer_in`)).json();
      const blocked = await reverse(transfers.movements[0].id);
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error.code).toBe("insufficient_stock");
    });

    it("reverses both rows of a transfer together", async () => {
      const { movements } = await created(
        await as(ada).send("POST", "/stock/transfers", {
          lotId: lot,
          fromLocationId: store,
          toLocationId: chiller,
          quantity: 1,
          unit: "kg",
        }),
      );
      const before = await balance(lot);
      const res = await created(
        await as(ada).send("POST", `/stock/movements/${movements[0].id}/reverse`, { reason: "Wrong lot" }),
      );
      expect(res.movements.map((m: { type: string; quantity: number }) => [m.type, m.quantity])).toEqual([
        ["transfer_out", 1000],
        ["transfer_in", -1000],
      ]);
      const after = await balance(lot);
      expect(after[store]).toBe(before[store]! + 1000);
      expect(after[chiller]).toBe(before[chiller]! - 1000);
    });

    it("has no route that updates or deletes a movement", async () => {
      const { movements } = await (await as(ada).get(`/stock/movements?lotId=${lot}`)).json();
      const id = movements[0].id;
      for (const method of ["PATCH", "PUT", "DELETE"]) {
        expect((await as(ada).send(method, `/stock/movements/${id}`, { quantity: 1 })).status).toBe(404);
      }
      const registered = ctx.app.routes.filter((r) => r.path.includes("/stock/movements"));
      expect(registered.every((r) => r.method === "GET" || r.path.endsWith("/reverse"))).toBe(true);
    });
  });

  describe("lot status and picking", () => {
    let early: string;
    let late: string;
    let expired: string;

    beforeAll(async () => {
      const receive = async (lotCode: string, expiresOn: string, expiryType: string, quantity: number) =>
        (
          await created(
            await as(ada).send("POST", "/stock/receipts", {
              itemId: milk,
              quantity,
              unit: "l",
              locationId: chiller,
              receivedOn: addDays(today, -10),
              lotCode,
              expiresOn,
              expiryType,
            }),
          )
        ).id;
      expired = await receive("MILK-OLD", addDays(today, -1), "use_by", 50);
      late = await receive("MILK-LATE", addDays(today, 20), "use_by", 4);
      early = await receive("MILK-EARLY", addDays(today, 2), "use_by", 3);
    });

    it("changes status with manage and a person, recording who and when", async () => {
      const body = { status: "quarantine", note: "Temperature excursion" };
      expect((await as(marcus.cookie).send("POST", `/stock/lots/${early}/status`, body)).status).toBe(403);
      expect((await viaToken("POST", `/stock/lots/${early}/status`, body)).status).toBe(403);
      expect(
        (await as(ada).send("POST", `/stock/lots/${early}/status`, { status: "quarantine" })).status,
      ).toBe(400);
      const lot = await created(await as(ada).send("POST", `/stock/lots/${early}/status`, body), 200);
      expect(lot).toMatchObject({
        status: "quarantine",
        statusChangedBy: adaId,
        statusNote: "Temperature excursion",
      });
      expect(lot.statusChangedAt).toBeTruthy();
      // Transfers are allowed whatever the status.
      expect(
        (
          await as(marcus.cookie).send("POST", "/stock/transfers", {
            lotId: early,
            fromLocationId: chiller,
            toLocationId: store,
            quantity: 1,
            unit: "l",
          })
        ).status,
      ).toBe(201);
    });

    it("suggests a FEFO pick from available, unexpired lots only", async () => {
      // Available milk: MILK-A (10 l, use by +5), MILK-LATE (4 l, +20). MILK-EARLY is quarantined,
      // MILK-OLD is past its use-by date.
      const pick = await created(
        await as(marcus.cookie).get(`/stock/items/${milk}/pick?quantity=12&unit=l`),
        200,
      );
      expect(
        pick.allocations.map((a: { lotCode: string; amount: { base: number } }) => [
          a.lotCode,
          a.amount.base,
        ]),
      ).toEqual([
        ["MILK-A", 10000],
        ["MILK-LATE", 2000],
      ]);
      expect(pick.shortfall.base).toBe(0);
      const short = await (await as(ada).get(`/stock/items/${milk}/pick?quantity=20&unit=l`)).json();
      expect(short.shortfall).toMatchObject({ base: 6000, display: 6, displayUnit: "l" });
      expect((await as(ada).get(`/stock/items/${milk}/pick?quantity=1&unit=each`)).status).toBe(400);
      // Releasing the lot makes it the first choice.
      await created(
        await as(ada).send("POST", `/stock/lots/${early}/status`, { status: "available", note: "OK" }),
        200,
      );
      const released = await (await as(ada).get(`/stock/items/${milk}/pick?quantity=1&unit=l`)).json();
      expect(released.allocations[0]).toMatchObject({ lotCode: "MILK-EARLY" });
      void expired;
    });

    it("lists lots in FEFO order with balances and filters", async () => {
      const list = async (qs: string) =>
        (await (await as(ada).get(`/stock/lots?${qs}`)).json()) as { lots: any[]; total: number };
      const milkLots = await list(`itemId=${milk}`);
      expect(milkLots.lots.map((l) => l.lotCode)).toEqual(["MILK-OLD", "MILK-EARLY", "MILK-A", "MILK-LATE"]);
      expect(milkLots.lots[0]).toMatchObject({ expiryState: "expired", onHand: { base: 50000 } });
      const early = milkLots.lots[1];
      expect(early.balances.map((b: { locationName: string }) => b.locationName)).toEqual([
        "Chiller 1",
        "Dry store",
      ]);
      expect((await list(`itemId=${milk}&expiringWithinDays=7`)).lots.map((l) => l.lotCode)).toEqual([
        "MILK-OLD",
        "MILK-EARLY",
        "MILK-A",
      ]);
      expect((await list("q=m-778")).lots.map((l) => l.supplierLotCode)).toEqual(["M-778"]);
      expect((await list(`itemId=${milk}&locationId=${store}`)).lots.map((l) => l.lotCode)).toEqual([
        "MILK-EARLY",
      ]);
      expect((await list("status=quarantine")).total).toBe(1);
      // Pickers of past lots (a complaint, a recall test) want the latest received first.
      const newest = (await list(`itemId=${milk}&order=newest&includeEmpty=true`)).lots;
      const received = newest.map((l) => l.receivedOn as string);
      expect(received).toEqual([...received].sort().reverse());
      expect(newest).toHaveLength(milkLots.lots.length);
    });

    it("shows a lot's traceability: supplier, balances and every movement", async () => {
      const { lots } = await (await as(ada).get("/stock/lots?q=M-778")).json();
      const lot = await (await as(ada).get(`/stock/lots/${lots[0].id}`)).json();
      expect(lot).toMatchObject({
        supplier: { name: "Mill" },
        supplierLotCode: "M-778",
        item: { code: "FLR", unit: "kg" },
      });
      expect(lot.movements[0]).toMatchObject({
        type: "receipt",
        reference: "DN-1001",
        locationName: "Dry store",
      });
      expect(lot.movements[0].actorName).toBeTruthy();
      expect((await as(ada).get("/stock/lots/00000000-0000-7000-8000-000000000000")).status).toBe(404);
    });
  });

  describe("levels and locations", () => {
    it("lists one row per item with the status split, lots and earliest expiry", async () => {
      const list = async (qs: string) =>
        (await (await as(ada).get(`/stock/levels?${qs}`)).json()) as { levels: any[]; total: number };
      const all = await list("");
      expect(all.levels.map((l) => l.item.code)).toEqual(["CAKE", "FLR", "MLK"]);
      const flourRow = all.levels.find((l) => l.item.code === "FLR");
      expect(flourRow.quarantine).toMatchObject({ base: 5000, display: 5 });
      expect(flourRow.onHand.base).toBe(flourRow.available.base + 5000);
      expect(flourRow.lotCount).toBe(3);
      const milkRow = all.levels.find((l) => l.item.code === "MLK");
      expect(milkRow).toMatchObject({ earliestExpiry: addDays(today, -1), expiryState: "expired" });
      expect((await list("itemType=finished")).levels.map((l) => l.item.code)).toEqual(["CAKE"]);
      expect((await list("q=mil")).total).toBe(1);
      expect((await list("expiringWithinDays=30")).levels.map((l) => l.item.code)).toEqual(["MLK"]);
      expect((await list(`locationId=${store}`)).levels.map((l) => l.item.code)).toEqual([
        "CAKE",
        "FLR",
        "MLK",
      ]);
      await created(
        await as(ada).send("POST", "/items", { code: "SALT", name: "Salt", type: "ingredient", unit: "kg" }),
      );
      expect((await list("")).total).toBe(3);
      expect((await list("includeZero=true")).total).toBe(4);
      const page = await list("limit=1&offset=1");
      expect(page.levels.map((l) => l.item.code)).toEqual(["FLR"]);
      expect(page.total).toBe(3);
    });

    it("archives a location only when it is empty, and puts nothing into an archived one", async () => {
      const empty = await created(
        await as(ada).send("POST", "/stock/locations", { name: "Freezer", storage: "frozen" }),
      );
      const full = await as(ada).send("PATCH", `/stock/locations/${store}`, { status: "archived" });
      expect(full.status).toBe(409);
      expect((await full.json()).error.code).toBe("location_not_empty");
      const archived = await created(
        await as(ada).send("PATCH", `/stock/locations/${empty.id}`, { status: "archived" }),
        200,
      );
      expect(archived.status).toBe("archived");
      const into = await as(ada).send("POST", "/stock/receipts", {
        itemId: flour,
        quantity: 1,
        unit: "kg",
        locationId: empty.id,
        receivedOn: today,
      });
      expect((await into.json()).error.code).toBe("location_archived");
      expect((await (await as(ada).get("/stock/locations?status=all")).json()).locations).toHaveLength(3);
      expect((await (await as(ada).get("/stock/locations")).json()).locations).toHaveLength(2);
    });

    it("lets tokens read, receive and transfer", async () => {
      expect((await viaToken("GET", "/stock/levels")).status).toBe(200);
      const lot = await created(
        await viaToken("POST", "/stock/receipts", {
          itemId: flour,
          quantity: 1,
          unit: "kg",
          locationId: store,
          receivedOn: today,
        }),
      );
      expect(
        (
          await viaToken("POST", "/stock/transfers", {
            lotId: lot.id,
            fromLocationId: store,
            toLocationId: chiller,
            quantity: 1,
            unit: "kg",
          })
        ).status,
      ).toBe(201);
    });
  });

  it("writes the sync log, hidden from members without the module", async () => {
    const sync = async (cookie: string) =>
      (await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie })).json()).changes.map(
        (c: { entity: string }) => c.entity,
      ) as string[];
    const entities = ["stock_location", "stock_lot", "stock_movement"];
    const seen = await sync(ada);
    for (const entity of entities) expect(seen).toContain(entity);
    expect(await sync(marcus.cookie)).toContain("stock_movement");
    await grant("stock", "none");
    const hidden = await sync(marcus.cookie);
    for (const entity of entities) expect(hidden).not.toContain(entity);
    expect(hidden).toContain("item");
    // Stock is not in the bootstrap.
    const bootstrap = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    expect(Object.keys(bootstrap).some((k) => k.toLowerCase().includes("stock"))).toBe(false);
    await grant("stock", "write");
  });

  describe("deleting used records", () => {
    it("refuses to delete an item that has stock, and keeps it listed", async () => {
      const id = await itemFor("DEL-LOT");
      await created(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: id,
          quantity: 2,
          unit: "kg",
          locationId: store,
          receivedOn: today,
        }),
      );
      const res = await as(ada).send("DELETE", `/items/${id}`);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("item_in_use");
      const { items } = await (await as(ada).get("/items?q=DEL-LOT")).json();
      expect(items.map((i: { id: string }) => i.id)).toEqual([id]);
    });

    it("refuses to delete an item used on a recipe, as ingredient or output", async () => {
      const ingredient = await itemFor("DEL-ING");
      const output = await itemFor("DEL-OUT", "wip");
      const recipe = await created(
        await as(ada).send("POST", "/recipes", { code: "DEL-R", name: "Del", outputItemId: output }),
      );
      // Output item of a live recipe.
      expect((await as(ada).send("DELETE", `/items/${output}`)).status).toBe(409);
      // Ingredient on a draft line.
      await created(
        await as(ada).send("PUT", `/recipes/${recipe.id}/draft`, {
          yieldQuantity: 10,
          yieldUnit: "kg",
          lines: [{ itemId: ingredient, quantity: 1, unit: "kg" }],
        }),
        200,
      );
      const res = await as(ada).send("DELETE", `/items/${ingredient}`);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("item_in_use");
    });

    it("still deletes an unused item", async () => {
      const id = await itemFor("DEL-FREE");
      expect((await as(ada).send("DELETE", `/items/${id}`)).status).toBe(204);
      expect((await as(ada).get(`/items/${id}`)).status).toBe(404);
    });

    it("refuses to delete a supplier named on a lot, but deletes an unused one", async () => {
      const id = (await created(await as(ada).send("POST", "/suppliers", { name: "Del Mill" }))).id;
      await created(await as(ada).send("POST", `/suppliers/${id}/approval`, { status: "approved" }), 200);
      await created(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: flour,
          quantity: 1,
          unit: "kg",
          locationId: store,
          receivedOn: today,
          supplierId: id,
        }),
      );
      const res = await as(ada).send("DELETE", `/suppliers/${id}`);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("supplier_in_use");
      expect((await as(ada).get(`/suppliers/${id}`)).status).toBe(200);

      const free = (await created(await as(ada).send("POST", "/suppliers", { name: "Del Free" }))).id;
      expect((await as(ada).send("DELETE", `/suppliers/${free}`)).status).toBe(204);
    });
  });
});
