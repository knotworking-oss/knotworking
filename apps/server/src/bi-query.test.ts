import {
  addDays,
  biDataset,
  convertQuantity,
  itemBaseUnit,
  moduleIds,
  newId,
  roundQuantity,
  todayInZone,
  toBaseQuantity,
  type UnitCode,
} from "@knotworking/core";
import {
  customers,
  items,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  suppliers,
  users,
  workspaces,
} from "@knotworking/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { visibleDataset } from "./services/bi/access";
import { rowsOf } from "./services/bi/guard";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("BI query engine", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let workspaceId: string;
  let otherWorkspaceId: string;
  const ids = {
    flour: newId(),
    sugar: newId(),
    millers: newId(),
    sweetCo: newId(),
    customer: newId(),
  };
  let orderFixture: (
    supplierId: string,
    orderedOn: string,
    lines: Array<[string, number, number | null, UnitCode?]>,
    extra?: Partial<typeof purchaseOrders.$inferInsert>,
  ) => Promise<string>;
  /** A line's value as the purchasing service computes it (core `convertQuantity`), from its stored base quantity. */
  let lineValue: (itemId: string, base: number, unit: UnitCode, price: number) => number | null;
  const today = todayInZone("Europe/London");
  const daysAgo = (n: number) => addDays(today, -n);

  const query = (spec: unknown, auth: { cookie?: string; token?: string } = { cookie: ada }) =>
    ctx.req(`${WS}/bi/query?spec=${encodeURIComponent(JSON.stringify(spec))}`, {
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.token ? { headers: { authorization: `Bearer ${auth.token}`, origin: "" } } : {}),
    });
  const ok = async (res: Response | { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const sqlRows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await ctx.handle.db.execute(q));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: moduleIds });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    workspaceId = (await ok(await ctx.req(`${WS}/bootstrap`, { cookie: ada }))).workspace.id;
    const db = ctx.handle.db;

    // Purchasing: two suppliers, two items, three live orders and one deleted. Line quantities are
    // stored as the purchasing service stores them: in the item's base unit (grams here).
    await db.insert(items).values([
      {
        id: ids.flour,
        workspaceId,
        code: "FLR",
        name: "Flour",
        type: "ingredient",
        unit: "kg",
        unitWeightG: 16000,
      },
      { id: ids.sugar, workspaceId, code: "SUG", name: "Sugar", type: "ingredient", unit: "kg" },
    ]);
    await db.insert(suppliers).values([
      { id: ids.millers, workspaceId, name: "Millers Ltd" },
      { id: ids.sweetCo, workspaceId, name: "Sweet Co" },
    ]);
    const itemUnits: Record<string, { unit: UnitCode; unitWeightG?: number | null }> = {
      [ids.flour]: { unit: "kg", unitWeightG: 16000 },
      [ids.sugar]: { unit: "kg" },
    };
    orderFixture = order;
    lineValue = (itemId, base, unit, price) => {
      const item = itemUnits[itemId]!;
      const inUnit = convertQuantity(base, itemBaseUnit(item), unit, item);
      return inUnit === null ? null : roundQuantity(inUnit) * price;
    };
    async function order(
      supplierId: string,
      orderedOn: string,
      /** Item, quantity in the line's unit, price per that unit, the unit (default kg). */
      lines: Array<[string, number, number | null, UnitCode?]>,
      extra: Partial<typeof purchaseOrders.$inferInsert> = {},
    ) {
      const id = newId();
      await db.insert(purchaseOrders).values({
        id,
        workspaceId,
        reference: `PO-${id.slice(-6)}`,
        supplierId,
        status: "sent",
        orderedOn,
        ...extra,
      });
      await db.insert(purchaseOrderLines).values(
        lines.map(([itemId, quantity, unitPrice, unit = "kg"], i) => ({
          workspaceId,
          purchaseOrderId: id,
          lineNo: i + 1,
          itemId,
          quantity: toBaseQuantity(quantity, unit, itemUnits[itemId]!)!,
          unit,
          unitPrice,
        })),
      );
      return id;
    }
    await order(ids.millers, daysAgo(10), [
      [ids.flour, 100, 0.5],
      [ids.sugar, 20, 1.25],
    ]);
    await order(ids.millers, daysAgo(40), [[ids.flour, 200, 0.55]]);
    await order(ids.sweetCo, daysAgo(5), [
      [ids.sugar, 50, 1.2],
      [ids.sugar, 10, null],
    ]);
    // Deleted, and far in the past: never counted.
    await order(ids.sweetCo, daysAgo(3), [[ids.sugar, 1000, 9]], { deletedAt: new Date() });
    await order(ids.sweetCo, daysAgo(800), [[ids.sugar, 7, 1]]);

    // Another workspace whose rows must never appear, including one pointing at Acme's item.
    otherWorkspaceId = newId();
    await db
      .insert(workspaces)
      .values({ id: otherWorkspaceId, slug: `other-${otherWorkspaceId.slice(-6)}`, name: "Other" });
    const otherSupplier = newId();
    await db
      .insert(suppliers)
      .values({ id: otherSupplier, workspaceId: otherWorkspaceId, name: "Elsewhere" });
    const otherOrder = newId();
    await db.insert(purchaseOrders).values({
      id: otherOrder,
      workspaceId: otherWorkspaceId,
      reference: "PO-X",
      supplierId: otherSupplier,
      status: "sent",
      orderedOn: daysAgo(2),
    });
    await db.insert(purchaseOrderLines).values({
      workspaceId: otherWorkspaceId,
      purchaseOrderId: otherOrder,
      lineNo: 1,
      itemId: ids.flour,
      quantity: 5_000_000,
      unit: "kg" as const,
      unitPrice: 10,
    });

    // Sales in two currencies.
    await db
      .insert(customers)
      .values({ id: ids.customer, workspaceId, code: "C1", name: "Corner Shop", address: "1 High St" });
    for (const [currency, price] of [
      ["GBP", 2],
      ["EUR", 3],
    ] as const) {
      const orderId = newId();
      await db.insert(salesOrders).values({
        id: orderId,
        workspaceId,
        reference: `SO-${currency}`,
        kind: "order",
        status: "confirmed",
        customerId: ids.customer,
        recipient: {},
        currency,
      } as typeof salesOrders.$inferInsert);
      await db.insert(salesOrderLines).values({
        workspaceId,
        orderId,
        position: 1,
        itemId: ids.flour,
        itemCode: "FLR",
        itemName: "Flour",
        unit: "kg" as const,
        baseUnit: "g" as const,
        quantity: 10,
        baseQuantity: 10_000,
        unitPrice: price,
        dueOn: today,
        note: "",
      });
    }
  }, 120_000);
  afterAll(() => ctx.handle.close());

  describe("the catalogue", () => {
    it("lists every dataset to an owner, without table or column names", async () => {
      const body = await ok(await ctx.req(`${WS}/bi/datasets`, { cookie: ada }));
      expect(body.datasets.map((d: { id: string }) => d.id)).toContain("purchase_orders");
      const po = body.datasets.find((d: { id: string }) => d.id === "purchase_orders");
      expect(po.dimensions.map((d: { id: string }) => d.id)).toContain("supplier");
      expect(JSON.stringify(body)).not.toContain("purchase_order_lines");
      expect(JSON.stringify(body)).not.toContain("unit_price");
    });

    it("shows a member only the datasets of modules they can read", async () => {
      const body = await ok(await ctx.req(`${WS}/bi/datasets`, { cookie: marcus.cookie }));
      const listed = body.datasets.map((d: { id: string }) => d.id);
      expect(listed).toEqual(expect.arrayContaining(["tasks", "time_entries"]));
      expect(listed).not.toContain("purchase_orders");
      expect(listed).not.toContain("training_records");
    });
  });

  describe("results", () => {
    it("sums purchasing spend by supplier, matching hand-written SQL", async () => {
      const body = await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["order_value", "order_count"],
          groupBy: [{ dim: "supplier" }],
          period: { preset: "last_12_months" },
        }),
      );
      expect(body.currency).toBe("GBP");
      expect(body.rows).toEqual([
        { supplier: "Millers Ltd", supplier__id: ids.millers, order_value: 185, order_count: 2 },
        { supplier: "Sweet Co", supplier__id: ids.sweetCo, order_value: 60, order_count: 1 },
      ]);
      // The raw lines, priced in TypeScript the way the purchasing service prices them.
      const lines = await sqlRows<{
        supplier_id: string;
        item_id: string;
        quantity: string;
        unit: UnitCode;
        unit_price: string | null;
      }>(sql`
        select o.supplier_id, l.item_id, l.quantity, l.unit, l.unit_price
        from purchase_order_lines l join purchase_orders o on o.id = l.purchase_order_id
        where l.workspace_id = ${workspaceId} and o.deleted_at is null and l.deleted_at is null
          and o.status in ('sent', 'closed')
          and o.ordered_on >= ${body.period.from}::date and o.ordered_on < ${body.period.to}::date`);
      const expected = new Map<string, number>();
      for (const l of lines) {
        const value =
          l.unit_price === null
            ? null
            : lineValue(l.item_id, Number(l.quantity), l.unit, Number(l.unit_price));
        expected.set(l.supplier_id, (expected.get(l.supplier_id) ?? 0) + (value ?? 0));
      }
      expect(expected.size).toBe(2);
      for (const [supplierId, value] of expected) {
        expect(
          body.rows.find((r: { supplier__id: string }) => r.supplier__id === supplierId).order_value,
        ).toBeCloseTo(value, 6);
      }
    });

    it("excludes soft-deleted rows and other workspaces' rows, even ones pointing at this workspace's items", async () => {
      const body = await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["order_value", "line_count"],
          groupBy: [{ dim: "item" }],
        }),
      );
      const flour = body.rows.find((r: { item__id: string }) => r.item__id === ids.flour);
      expect(flour).toMatchObject({ item: "Flour", order_value: 160, line_count: 2 });
      const total = await ok(await query({ dataset: "purchase_orders", measures: ["order_value"] }));
      // 185 + 60 + the old 7: never the deleted 9,000 nor the other workspace's 50,000.
      expect(total.rows).toEqual([{ order_value: 252 }]);
    });

    it("prices each line in its own unit, as the purchasing service does, and counts only sent and closed orders", async () => {
      const bagsCo = newId();
      await ctx.handle.db.insert(suppliers).values({ id: bagsCo, workspaceId, name: "Bags Co" });
      const placed = [
        // 3 bags of flour (16 kg each) at 12 per bag: stored as 48,000 g, worth 36.
        await orderFixture(bagsCo, daysAgo(1), [
          [ids.flour, 3, 12, "each"],
          [ids.flour, 500, 0.002, "g"],
        ]),
        await orderFixture(bagsCo, daysAgo(1), [[ids.flour, 10, 1]], { status: "closed" }),
        // Never committed spend.
        await orderFixture(bagsCo, daysAgo(1), [[ids.flour, 10, 100]], { status: "draft" }),
        await orderFixture(bagsCo, daysAgo(1), [[ids.flour, 10, 100]], { status: "cancelled" }),
      ];
      // Sugar has no unit weight, so a line in bags can't be converted: left out, never guessed.
      await ctx.handle.db.insert(purchaseOrderLines).values({
        workspaceId,
        purchaseOrderId: placed[0]!,
        lineNo: 9,
        itemId: ids.sugar,
        quantity: 1000,
        unit: "each" as const,
        unitPrice: 5,
      });
      try {
        const body = await ok(
          await query({
            dataset: "purchase_orders",
            measures: ["order_value", "ordered_quantity"],
            filters: [
              { dim: "supplier", op: "eq", value: bagsCo },
              { dim: "item", op: "eq", value: ids.flour },
            ],
          }),
        );
        const expected =
          lineValue(ids.flour, 48_000, "each", 12)! +
          lineValue(ids.flour, 500, "g", 0.002)! +
          lineValue(ids.flour, 10_000, "kg", 1)!;
        expect(expected).toBeCloseTo(36 + 1 + 10, 6);
        expect(body.rows[0].order_value).toBeCloseTo(expected, 6);
        // Quantities are in the item's base unit (grams), over the same committed orders as the
        // value: the draft and the cancelled order are left out.
        expect(body.rows[0].ordered_quantity).toBe(48_000 + 500 + 10_000);
        const counted = await ok(
          await query({
            dataset: "purchase_orders",
            measures: ["order_count", "line_count"],
            filters: [{ dim: "supplier", op: "eq", value: bagsCo }],
          }),
        );
        // Two committed orders (the sent one with three lines, the closed one with one).
        expect(counted.rows[0]).toMatchObject({ order_count: 2, line_count: 4 });
        expect(lineValue(ids.sugar, 1000, "each", 5)).toBeNull();
        const sugar = await ok(
          await query({
            dataset: "purchase_orders",
            measures: ["order_value"],
            filters: [
              { dim: "supplier", op: "eq", value: bagsCo },
              { dim: "item", op: "eq", value: ids.sugar },
            ],
          }),
        );
        expect(sugar.rows).toEqual([{ order_value: 0 }]);
        const units = await ok(
          await query({
            dataset: "purchase_orders",
            measures: ["ordered_quantity"],
            groupBy: [{ dim: "base_unit" }],
          }),
        );
        expect(units.rows.map((r: { base_unit: string }) => r.base_unit)).toEqual(["g"]);
      } finally {
        await ctx.handle.db
          .update(purchaseOrders)
          .set({ deletedAt: new Date() })
          .where(sql`${purchaseOrders.supplierId} = ${bagsCo}`);
      }
    });

    it("buckets dates by month and financial year, as a forward trend", async () => {
      const body = await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["order_value"],
          groupBy: [{ dim: "ordered_on", grain: "month" }],
        }),
      );
      const months = body.rows.map((r: { ordered_on: string }) => r.ordered_on);
      expect(months).toEqual([...months].sort());
      for (const m of months) expect(m).toMatch(/^\d{4}-\d{2}-01$/);
      expect(body.rows.reduce((s: number, r: { order_value: number }) => s + r.order_value, 0)).toBe(252);

      await ok(
        await ctx.req(`${WS}/settings`, {
          method: "PATCH",
          cookie: ada,
          json: { financialYearStartMonth: 4 },
        }),
      );
      const fy = await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["order_value"],
          groupBy: [{ dim: "ordered_on", grain: "financial_year" }],
        }),
      );
      for (const r of fy.rows) expect(r.ordered_on).toMatch(/^\d{4}-04-01$/);
      await ok(
        await ctx.req(`${WS}/settings`, {
          method: "PATCH",
          cookie: ada,
          json: { financialYearStartMonth: 1 },
        }),
      );
    });

    it("filters, sorts and limits, and says when rows were cut", async () => {
      const body = await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["order_value"],
          groupBy: [{ dim: "supplier" }],
          filters: [{ dim: "item", op: "eq", value: ids.sugar }],
          sort: [{ by: "order_value", dir: "asc" }],
          limit: 1,
        }),
      );
      expect(body.rows).toEqual([{ supplier: "Millers Ltd", supplier__id: ids.millers, order_value: 25 }]);
      expect(body.truncated).toBe(true);
    });

    it("compares with the previous period", async () => {
      const body = await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["order_value"],
          period: { preset: "last_30_days" },
          compare: "previous_period",
        }),
      );
      // 75 + 60 in the last 30 days; 110 in the 30 before.
      expect(body.rows).toEqual([{ order_value: 135, order_value__compare: 110 }]);
      expect(body.comparePeriod).toEqual({ from: addDays(body.period.from, -30), to: body.period.from });
      expect(body.columns.find((c: { key: string }) => c.key === "order_value").compareKey).toBe(
        "order_value__compare",
      );
    });

    it("matches hand-written SQL on the seeded tasks", async () => {
      const body = await ok(
        await query({ dataset: "tasks", measures: ["task_count"], groupBy: [{ dim: "state_type" }] }),
      );
      const expected = await sqlRows<{ type: string; n: number }>(sql`
        select s.type, count(*)::int as n from tasks t left join workflow_states s on s.id = t.state_id
        where t.workspace_id = ${workspaceId} and t.deleted_at is null group by s.type`);
      expect(body.rows.length).toBe(expected.length);
      for (const row of expected) {
        expect(body.rows.find((r: { state_type: string }) => r.state_type === row.type)?.task_count).toBe(
          Number(row.n),
        );
      }
    });
  });

  describe("review regressions", () => {
    it("refuses malformed ids and impossible dates with a path, never a 500", async () => {
      for (const spec of [
        {
          dataset: "tasks",
          measures: ["task_count"],
          filters: [{ dim: "assignee", op: "eq", value: "abc" }],
        },
        {
          dataset: "tasks",
          measures: ["task_count"],
          filters: [{ dim: "due_on", op: "eq", value: "2026-02-30" }],
        },
        { dataset: "tasks", measures: ["task_count"], period: { from: "2026-13-01" } },
      ]) {
        const body = await ok(await query(spec), 400);
        expect(body.error.code).toBe("invalid_query");
        expect(body.error.details.issues[0].path).toMatch(/filters\[0\]\.value|period/);
      }
    });

    it("keeps rows with no value in not_in, as neq does", async () => {
      const total = (await ok(await query({ dataset: "tasks", measures: ["task_count"] }))).rows[0]
        .task_count;
      const projects = await ok(
        await query({
          dataset: "tasks",
          measures: ["task_count"],
          groupBy: [{ dim: "project" }],
          filters: [{ dim: "project", op: "not_null" }],
          limit: 1,
        }),
      );
      const top = projects.rows[0].project__id;
      const unassigned = await ok(
        await query({
          dataset: "tasks",
          measures: ["task_count"],
          filters: [{ dim: "project", op: "is_null" }],
        }),
      );
      // The seed has tasks with no project, so the difference between not_in and `not in` shows.
      expect(unassigned.rows[0].task_count).toBeGreaterThan(0);
      const notIn = await ok(
        await query({
          dataset: "tasks",
          measures: ["task_count"],
          filters: [{ dim: "project", op: "not_in", value: [top] }],
        }),
      );
      const neq = await ok(
        await query({
          dataset: "tasks",
          measures: ["task_count"],
          filters: [{ dim: "project", op: "neq", value: top }],
        }),
      );
      expect(notIn.rows[0].task_count).toBe(neq.rows[0].task_count);
      expect(notIn.rows[0].task_count).toBe(total - projects.rows[0].task_count);
    });

    it("takes the top N by a comparison column across every group, not just the current top N", async () => {
      // Millers: 75 now, 110 before. Sweet Co: 60 now, nothing before.
      const body = await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["order_value"],
          groupBy: [{ dim: "supplier" }],
          period: { preset: "last_30_days" },
          compare: "previous_period",
          sort: [{ by: "order_value__compare", dir: "asc" }],
          limit: 1,
        }),
      );
      // Ascending puts the group with no earlier value last, as SQL's nulls last would.
      expect(body.rows).toEqual([
        { supplier: "Millers Ltd", supplier__id: ids.millers, order_value: 75, order_value__compare: 110 },
      ]);
      expect(body.truncated).toBe(true);
      expect(body.compareTruncated).toBe(false);
    });
  });

  describe("currency and units", () => {
    it("refuses to add up money in different currencies, and splits it when asked", async () => {
      const refused = await ok(await query({ dataset: "sales_orders", measures: ["sales_value"] }), 400);
      expect(refused.error.code).toBe("invalid_query");
      expect(refused.error.details.issues[0]).toMatchObject({ path: "measures[0]", suggestion: "currency" });
      const split = await ok(
        await query({ dataset: "sales_orders", measures: ["sales_value"], groupBy: [{ dim: "currency" }] }),
      );
      expect(split.currency).toBeNull();
      expect(split.rows).toEqual(
        expect.arrayContaining([
          { currency: "EUR", sales_value: 30 },
          { currency: "GBP", sales_value: 20 },
        ]),
      );
      const pinned = await ok(
        await query({
          dataset: "sales_orders",
          measures: ["sales_value"],
          filters: [{ dim: "currency", op: "eq", value: "GBP" }],
        }),
      );
      expect(pinned.rows).toEqual([{ sales_value: 20 }]);
      // A filter that pins the currency names it, so the figure is labelled correctly.
      expect(pinned.currency).toBe("GBP");
    });

    it("refuses to add up quantities of different items", async () => {
      const refused = await ok(
        await query({ dataset: "purchase_orders", measures: ["ordered_quantity"] }),
        400,
      );
      expect(refused.error.message).toContain("different units");
      await ok(
        await query({
          dataset: "purchase_orders",
          measures: ["ordered_quantity"],
          groupBy: [{ dim: "item" }],
        }),
      );
    });
  });

  describe("invalid specs", () => {
    it("names the path, the reason and the nearest valid field", async () => {
      const body = await ok(
        await query({ dataset: "purchase_orders", measures: ["order_value"], groupBy: [{ dim: "suplier" }] }),
        400,
      );
      expect(body.error.details.issues[0]).toMatchObject({ path: "groupBy[0].dim", suggestion: "supplier" });
      expect(body.error.message).toContain("did you mean 'supplier'");
      const dataset = await ok(await query({ dataset: "purchase_order", measures: ["order_value"] }), 400);
      expect(dataset.error.details.issues[0]).toMatchObject({
        path: "dataset",
        suggestion: "purchase_orders",
      });
      const structural = await ok(await query({ dataset: "tasks", measures: [] }), 400);
      expect(structural.error.details.issues[0].path).toBe("measures");
      expect((await ok(await ctx.req(`${WS}/bi/query?spec=nope`, { cookie: ada }), 400)).error.code).toBe(
        "invalid_query",
      );
      const value = await ok(
        await query({
          dataset: "tasks",
          measures: ["task_count"],
          filters: [{ dim: "state_type", op: "eq", value: "done" }],
        }),
        400,
      );
      expect(value.error.details.issues[0].path).toBe("filters[0].value");
    });
  });

  describe("access", () => {
    it("refuses a member a dataset of a module they can't read, and opens it with a grant", async () => {
      const spec = { dataset: "purchase_orders", measures: ["order_value"] };
      expect((await ok(await query(spec, marcus), 403)).error.code).toBe("module_forbidden");
      for (const moduleId of ["items", "stock", "purchasing"]) {
        await ok(
          await ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
            method: "PUT",
            cookie: ada,
            json: { level: "read" },
          }),
        );
      }
      expect((await ok(await query(spec, marcus))).rows).toEqual([{ order_value: 252 }]);
      for (const moduleId of ["items", "stock", "purchasing"]) {
        await ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
          method: "PUT",
          cookie: ada,
          json: { level: null },
        });
      }
    });

    it("refuses a token outside its module allowlist the same way, and lets a read token query", async () => {
      const token = async (body: object) =>
        (
          await ok(
            await ctx.req("/v1/me/api-tokens", {
              method: "POST",
              cookie: ada,
              json: { name: "bi", ...body },
            }),
            201,
          )
        ).token as string;
      const narrow = await token({ scope: "read", modules: ["bi", "tasks"] });
      expect(
        (
          await ok(
            await query({ dataset: "purchase_orders", measures: ["order_value"] }, { token: narrow }),
            403,
          )
        ).error.code,
      ).toBe("module_forbidden");
      await ok(await query({ dataset: "tasks", measures: ["task_count"] }, { token: narrow }));
      const catalogue = await ok(
        await ctx.req(`${WS}/bi/datasets`, { headers: { authorization: `Bearer ${narrow}`, origin: "" } }),
      );
      expect(catalogue.datasets.map((d: { id: string }) => d.id)).toEqual(["tasks"]);
      const withoutBi = await token({ scope: "read", modules: ["tasks"] });
      expect(
        (await ok(await query({ dataset: "tasks", measures: ["task_count"] }, { token: withoutBi }), 403))
          .error.code,
      ).toBe("module_forbidden");
    });

    it("hides fields reached through modules the viewer can't read, and guest-hidden fields from guests", () => {
      const training = biDataset("training_records")!;
      const full = { training: "read", people: "read" } as const;
      expect(
        visibleDataset(training, { modules: full, role: "member" })!.dimensions.map((d) => d.id),
      ).toContain("person");
      expect(
        visibleDataset(training, { modules: full, role: "guest" })!.dimensions.map((d) => d.id),
      ).not.toContain("person");
      expect(
        visibleDataset(training, { modules: { training: "read" }, role: "member" })!.dimensions.map(
          (d) => d.id,
        ),
      ).not.toContain("person");
      expect(visibleDataset(training, { modules: { people: "read" }, role: "member" })).toBeNull();
      // A scope through a parent the viewer can read keeps the dataset; one they can't hides it.
      const invoices = biDataset("purchase_invoices")!;
      expect(visibleDataset(invoices, { modules: { purchasing: "read" }, role: "member" })).not.toBeNull();
    });

    it("answers 404 when the module is switched off", async () => {
      const off = await makeApp({ seed: true, activeModules: moduleIds.filter((m) => m !== "bi") });
      try {
        const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
        const res = await off.req(`${WS}/bi/datasets`, { cookie });
        expect(res.status).toBe(404);
        expect((await res.json()).error.code).toBe("module_inactive");
      } finally {
        await off.handle.close();
      }
      // A second seeded app: slow under a full parallel run.
    }, 30_000);
  });

  it("is never written by a query (users table untouched as a sanity check)", async () => {
    const [before] = await sqlRows<{ n: number }>(sql`select count(*)::int as n from ${users}`);
    await ok(await query({ dataset: "tasks", measures: ["task_count"], groupBy: [{ dim: "assignee" }] }));
    const [after] = await sqlRows<{ n: number }>(sql`select count(*)::int as n from ${users}`);
    expect(after!.n).toBe(before!.n);
  });
});
