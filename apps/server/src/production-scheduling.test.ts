import { addDays, DEFAULT_TIME_ZONE, isoWeekdayOf, todayInZone } from "@knotworking/core";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
/** The next Monday after today. */
const monday = addDays(today, 8 - isoWeekdayOf(today));
type Res = Awaited<ReturnType<TestCtx["req"]>>;

describe("detailed scheduling (3.5.1)", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Res, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const code = async (res: Res, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };

  let line: string;
  const recipe: Record<string, string> = {};
  const product: Record<string, string> = {};
  const batch: Record<string, string> = {};
  const plan = async (date = monday) =>
    ok(await call("GET", `/production/schedule/day?lineId=${line}&date=${date}`));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    const item = async (body: object) => (await ok(await call("POST", "/items", body), 201)).id as string;
    const flour = await item({
      code: "SCH-FLR",
      name: "Flour",
      type: "ingredient",
      unit: "kg",
      allergens: ["cereals_gluten"],
    });
    const milk = await item({
      code: "SCH-MLK",
      name: "Milk",
      type: "ingredient",
      unit: "kg",
      allergens: ["milk"],
    });
    const rice = await item({ code: "SCH-RCE", name: "Rice flour", type: "ingredient", unit: "kg" });
    const make = async (key: string, name: string, allergens: string[], lines: [string, number][]) => {
      product[key] = await item({ code: `SCH-${key}`, name, type: "finished", unit: "each", allergens });
      recipe[key] = (
        await ok(
          await call("POST", "/recipes", {
            code: `R-SCH-${key}`,
            name,
            outputItemId: product[key],
            draft: {
              yieldQuantity: 10,
              yieldUnit: "each",
              lines: lines.map(([itemId, quantity]) => ({ itemId, quantity, unit: "kg" })),
            },
          }),
          201,
        )
      ).id;
      await ok(await call("POST", `/recipes/${recipe[key]}/draft/approve`));
    };
    await make("A", "Plain loaf", ["cereals_gluten"], [[flour, 3]]);
    await make(
      "B",
      "Milk loaf",
      ["cereals_gluten", "milk"],
      [
        [flour, 3],
        [milk, 1],
      ],
    );
    await make("C", "Rice cracker", [], [[rice, 2]]);
    line = (await ok(await call("POST", "/production/lines", { name: "Oven 1", hoursPerDay: 8 }), 201)).id;
    for (const key of ["A", "B", "C"])
      await ok(
        await call("PUT", `/production/lines/${line}/recipes/${recipe[key]}`, {
          rate: 10,
          unit: "each",
          ...(key === "B" ? { crewSize: 3 } : {}),
        }),
      );
    for (const key of ["A", "B", "C"])
      batch[key] = (
        await ok(
          await call("POST", "/production/batches", {
            recipeId: recipe[key],
            plannedOn: monday,
            batches: 1,
            batchCode: `SCH-${key}`,
            lineId: line,
          }),
          201,
        )
      ).id;
  });

  it("sets shifts, changeovers and crew on a line, and shifts set its capacity", async () => {
    const shifted = await ok(
      await call("PUT", `/production/lines/${line}/shifts`, {
        shifts: [
          { name: "Early", weekdays: [1, 2, 3, 4, 5], start: "06:00", end: "14:00" },
          { name: "Late", weekdays: [1, 2, 3, 4, 5], start: "14:00", end: "18:00" },
        ],
      }),
    );
    expect(shifted.shifts.map((s: { start: string; end: string }) => `${s.start}-${s.end}`)).toEqual([
      "06:00-14:00",
      "14:00-18:00",
    ]);
    await ok(
      await call("PATCH", `/production/lines/${line}`, {
        changeoverMinutes: 15,
        allergenCleanMinutes: 45,
        crewAvailable: 2,
      }),
    );
    const withRules = await ok(
      await call("PUT", `/production/lines/${line}/changeovers`, {
        rules: [{ fromRecipeId: recipe.A, toRecipeId: recipe.B, minutes: 5, note: "Same dough base" }],
      }),
    );
    expect(withRules.changeovers).toHaveLength(1);
    expect(withRules.recipes.find((r: { recipeId: string }) => r.recipeId === recipe.B).crewSize).toBe(3);

    // A rule needs at least one named recipe; another workspace's or unknown recipes are refused.
    expect(
      await code(
        await call("PUT", `/production/lines/${line}/changeovers`, {
          rules: [{ fromRecipeId: null, toRecipeId: null, minutes: 5 }],
        }),
        400,
      ),
    ).toBeTruthy();
    expect(
      await code(
        await call("PUT", `/production/lines/${line}/changeovers`, {
          rules: [{ fromRecipeId: randomUUID(), toRecipeId: recipe.B, minutes: 5 }],
        }),
        404,
      ),
    ).toBe("not_found");
    // Shift and changeover setup is line configuration: manage only.
    expect(
      await code(await call("PUT", `/production/lines/${line}/shifts`, { shifts: [] }, marcus.cookie), 403),
    ).toBeTruthy();

    const week = await ok(await call("GET", `/production/schedule?from=${monday}&to=${addDays(monday, 6)}`));
    const days = week.lines.find((l: { id: string }) => l.id === line).days;
    expect(days[0].capacityHours).toBe(12); // 06:00–18:00
    expect(days[5].capacityHours).toBe(0); // no Saturday shift
  });

  it("times the day with changeovers and an allergen clean-down, and explains a better order", async () => {
    const day = await plan();
    expect(day.timing).toBe("shifts");
    expect(day.steps.map((s: { batchCode: string }) => s.batchCode)).toEqual(["SCH-A", "SCH-B", "SCH-C"]);
    const [a, b, c] = day.steps;
    expect([a.startClock, a.endClock]).toEqual(["06:00", "07:00"]);
    expect(b.changeover).toMatchObject({ minutes: 5, source: "rule", allergenClean: [] });
    expect([b.startClock, b.endClock]).toEqual(["07:05", "08:05"]);
    // The milk loaf leaves gluten and milk behind; the cracker contains neither.
    expect(c.changeover.allergenClean).toEqual(["cereals_gluten", "milk"]);
    expect(c.changeover.minutes).toBe(45);
    expect(c.changeover.reason).toContain("contains Cereals containing gluten, Milk and SCH-C doesn't");
    expect([c.startClock, c.endClock]).toEqual(["08:50", "09:50"]);
    expect(day).toMatchObject({ changeoverMinutes: 50, cleanDowns: 1, overrunMinutes: 0, labourHours: 3 });
    expect(b.warnings).toContain("Needs 3 people; Oven 1 has 2");

    expect(day.proposal.order.map((s: { batchCode: string }) => s.batchCode)).toEqual([
      "SCH-C",
      "SCH-A",
      "SCH-B",
    ]);
    expect(day.proposal.order[0].reason).toBe("Starts the day: contains no allergens");
    expect(day.proposal.proposed).toMatchObject({ cleanDowns: 0, changeoverMinutes: 20 });
    expect(day.proposal).toMatchObject({ changed: true, improves: true });
  });

  it("applies an order only against the current set of batches", async () => {
    // Applying an order is planning: `write` is enough.
    for (const module of ["recipes", "stock", "demand", "items"])
      await ok(await call("PUT", `/members/${marcus.userId}/module-access/${module}`, { level: "read" }));
    await ok(await call("PUT", `/members/${marcus.userId}/module-access/production`, { level: "write" }));
    expect(
      await code(
        await call("PUT", "/production/schedule/sequence", {
          lineId: line,
          date: monday,
          batchIds: [batch.C, batch.A],
        }),
        409,
      ),
    ).toBe("sequence_stale");
    const applied = await ok(
      await call(
        "PUT",
        "/production/schedule/sequence",
        { lineId: line, date: monday, batchIds: [batch.C, batch.A, batch.B] },
        marcus.cookie,
      ),
    );
    expect(
      applied.steps.map((s: { batchCode: string; sequence: number }) => [s.batchCode, s.sequence]),
    ).toEqual([
      ["SCH-C", 1],
      ["SCH-A", 2],
      ["SCH-B", 3],
    ]);
    expect(applied).toMatchObject({ cleanDowns: 0, changeoverMinutes: 20 });
    expect(applied.proposal.changed).toBe(false);

    // The line schedule lists the day in the applied order too.
    const week = await ok(await call("GET", `/production/schedule?from=${monday}&to=${monday}`));
    expect(
      week.lines
        .find((l: { id: string }) => l.id === line)
        .days[0].batches.map((b: { batchCode: string }) => b.batchCode),
    ).toEqual(["SCH-C", "SCH-A", "SCH-B"]);
    // An order made against a view someone else has since reordered is refused.
    expect(
      await code(
        await call("PUT", "/production/schedule/sequence", {
          lineId: line,
          date: monday,
          batchIds: [batch.A, batch.B, batch.C],
          expectedBatchIds: [batch.A, batch.B, batch.C],
        }),
        409,
      ),
    ).toBe("sequence_stale");
    await ok(
      await call("PUT", "/production/schedule/sequence", {
        lineId: line,
        date: monday,
        batchIds: [batch.C, batch.A, batch.B],
        expectedBatchIds: [batch.C, batch.A, batch.B],
      }),
    );

    // Moving a batch to another day drops its place in this day's order.
    const moved = await ok(
      await call("PATCH", `/production/batches/${batch.A}`, { plannedOn: addDays(monday, 1) }),
    );
    expect(moved.sequence ?? null).toBeNull();
    expect((await plan()).steps.map((s: { batchCode: string }) => s.batchCode)).toEqual(["SCH-C", "SCH-B"]);
  });

  it("warns when a day runs past the last shift or the line has no shift that day", async () => {
    const saturday = addDays(monday, 5);
    await ok(await call("PATCH", `/production/batches/${batch.C}`, { plannedOn: saturday }));
    const sat = await plan(saturday);
    expect(sat.windows).toEqual([]);
    expect(sat.warnings).toContain("Oven 1 has no shift on this weekday");
    expect(sat.steps[0].overrun).toBe(true);
    const detail = await ok(await call("GET", `/production/batches/${batch.C}`));
    expect(JSON.stringify(detail)).toContain(`Oven 1 has no shift on ${saturday}`);
  });

  it("shows confirmed commitments, planned output and projected stock per day, apart from weekly demand", async () => {
    const customer = (
      await ok(
        await call("POST", "/customers", { code: "SCH-SHOP", name: "Shop", address: "1 High St" }),
        201,
      )
    ).id;
    const order = await ok(
      await call("POST", "/sales/orders", {
        commandId: randomUUID(),
        kind: "order",
        document: {
          customerId: customer,
          currency: "GBP",
          terms: "Net 30",
          lines: [{ itemId: product.B, quantity: 30, unit: "each", dueOn: today, unitPrice: 2 }],
        },
      }),
      201,
    );
    await ok(
      await call("POST", `/sales/orders/${order.id}/confirm`, {
        commandId: randomUUID(),
        expectedRevision: order.revision,
        reason: "Confirmed by phone",
      }),
    );
    const daily = await ok(await call("GET", `/production/daily-demand?days=14&itemId=${product.B}`));
    expect(daily.basis).toMatchObject({ salesCommitments: true, stock: true, weeklyDemandCombined: false });
    const row = daily.items[0];
    expect(row.item.code).toBe("SCH-B");
    expect(row.days[0]).toMatchObject({ date: today, committed: 30, short: true, projected: -30 });
    const mon = row.days.find((d: { date: string }) => d.date === monday);
    expect(mon.planned).toBe(10);
    expect(mon.projected).toBe(-20);
    expect(row.firstShortDate).toBe(today);
    // Weekly demand never feeds the daily projection.
    expect(row.days.reduce((t: number, d: { committed: number }) => t + d.committed, 0)).toBe(30);

    // Without Sales access the commitments are left out and said to be.
    for (const module of ["recipes", "stock", "demand", "items"])
      await ok(await call("PUT", `/members/${marcus.userId}/module-access/${module}`, { level: "read" }));
    await ok(await call("PUT", `/members/${marcus.userId}/module-access/sales`, { level: "none" }));
    const limited = await ok(
      await call("GET", `/production/daily-demand?itemId=${product.B}`, undefined, marcus.cookie),
    );
    expect(limited.basis.salesCommitments).toBe(false);
    expect(limited.items[0].days.every((d: { committed: number }) => d.committed === 0)).toBe(true);
  });
});
