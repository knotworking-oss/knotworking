import { addDays, DEFAULT_TIME_ZONE, isoWeekdayOf, todayInZone } from "@knotworking/core";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
/** The next Monday after today. */
const monday = addDays(today, 8 - isoWeekdayOf(today));
type Res = Awaited<ReturnType<TestCtx["req"]>>;

describe("factory performance (3.5.2)", () => {
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
  let otherLine: string;
  let recipe: string;
  let batch: string;
  let planned: string;
  let store: string;
  const perf = async (cookie = ada) =>
    ok(
      await call(
        "GET",
        `/production/performance?from=${monday}&to=${monday}&lineId=${line}`,
        undefined,
        cookie,
      ),
    );

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    for (const module of ["recipes", "stock", "demand", "items"])
      await ok(await call("PUT", `/members/${m.userId}/module-access/${module}`, { level: "read" }));
    await ok(await call("PUT", `/members/${m.userId}/module-access/production`, { level: "write" }));
    await ok(await call("PUT", `/members/${m.userId}/module-access/costing`, { level: "none" }));

    const item = async (body: object) => (await ok(await call("POST", "/items", body), 201)).id as string;
    const flour = await item({ code: "PF-FLR", name: "Flour", type: "ingredient", unit: "kg" });
    const loaf = await item({ code: "PF-LOAF", name: "Loaf", type: "finished", unit: "each" });
    recipe = (
      await ok(
        await call("POST", "/recipes", {
          code: "R-PF-LOAF",
          name: "Loaf",
          outputItemId: loaf,
          draft: {
            yieldQuantity: 10,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 3, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
    await ok(await call("POST", `/recipes/${recipe}/draft/approve`));
    store = (await ok(await call("POST", "/stock/locations", { name: "PF finished" }), 201)).id;
    line = (await ok(await call("POST", "/production/lines", { name: "Pack 1", hoursPerDay: 8 }), 201)).id;
    otherLine = (await ok(await call("POST", "/production/lines", { name: "Pack 2", hoursPerDay: 8 }), 201))
      .id;
    await ok(
      await call("PUT", `/production/lines/${line}/shifts`, {
        shifts: [{ name: "Day", weekdays: [1, 2, 3, 4, 5], start: "06:00", end: "14:00" }],
      }),
    );
    await ok(
      await call("PUT", `/production/lines/${line}/recipes/${recipe}`, {
        rate: 10,
        unit: "each",
        crewSize: 2,
      }),
    );
    const plan = async (code: string) =>
      (
        await ok(
          await call("POST", "/production/batches", {
            recipeId: recipe,
            plannedOn: monday,
            batches: 4,
            batchCode: code,
            lineId: line,
            outputLocationId: store,
          }),
          201,
        )
      ).id as string;
    batch = await plan("PF-1");
    planned = await plan("PF-2");
    await ok(await call("POST", `/production/batches/${batch}/start`));
    await ok(await call("POST", `/production/batches/${batch}/output`, { quantity: 30, unit: "each" }), 201);
  });

  it("records rejects, labour and downtime, and voids mistakes with a reason", async () => {
    const setup = await ok(
      await call(
        "POST",
        `/production/batches/${batch}/rejects`,
        { quantity: 6, unit: "each", reason: "setup_waste" },
        marcus.cookie,
      ),
      201,
    );
    expect(setup.quantity.base).toBe(6);
    const wrong = await ok(
      await call("POST", `/production/batches/${batch}/rejects`, {
        quantity: 2,
        unit: "each",
        reason: "underweight",
      }),
      201,
    );
    await ok(await call("POST", `/production/rejects/${wrong.id}/void`, { reason: "Entered twice" }));
    expect(
      await code(await call("POST", `/production/rejects/${wrong.id}/void`, { reason: "again" }), 409),
    ).toBe("already_voided");
    await ok(await call("POST", `/production/batches/${batch}/labour`, { people: 3, minutes: 120 }), 201);
    const extra = await ok(
      await call("POST", `/production/batches/${batch}/labour`, { people: 1, minutes: 60 }),
      201,
    );
    await ok(await call("POST", `/production/labour/${extra.id}/void`, { reason: "Wrong batch" }));

    await ok(
      await call("POST", "/production/downtime", {
        lineId: line,
        date: monday,
        minutes: 30,
        reason: "cleaning",
      }),
      201,
    );
    // A request retried with the same command id records once.
    const commandId = randomUUID();
    const breakdown = {
      commandId,
      lineId: line,
      date: monday,
      minutes: 60,
      reason: "breakdown",
      batchId: batch,
      note: "Sealer jam",
    };
    const first = await ok(await call("POST", "/production/downtime", breakdown), 201);
    const again = await ok(await call("POST", "/production/downtime", breakdown), 201);
    expect(again.id).toBe(first.id);
    const mistake = await ok(
      await call("POST", "/production/downtime", {
        lineId: line,
        date: monday,
        minutes: 15,
        reason: "minor_stops",
      }),
      201,
    );
    await ok(await call("POST", `/production/downtime/${mistake.id}/void`, { reason: "Not a stop" }));

    // A batch on another line, or a planned batch, is refused.
    expect(
      await code(
        await call("POST", "/production/downtime", {
          lineId: otherLine,
          date: monday,
          minutes: 5,
          reason: "breakdown",
          batchId: batch,
        }),
        400,
      ),
    ).toBeTruthy();
    expect(
      await code(
        await call("POST", `/production/batches/${planned}/rejects`, {
          quantity: 1,
          unit: "each",
          reason: "other",
        }),
        409,
      ),
    ).toBe("batch_not_running");
    // Voiding is a correction: write access is enough to record, the void is a person's act.
    const list = await ok(
      await call("GET", `/production/downtime?from=${monday}&to=${monday}&lineId=${line}`),
    );
    expect(list.downtime).toHaveLength(3);
    expect(list.downtime.filter((d: { voidedAt: string | null }) => d.voidedAt)).toHaveLength(1);
  });

  it("works out OEE by the written definitions", async () => {
    const report = await perf();
    expect(report.definitions.version).toBe("oee-v1");
    const day = report.lines[0].days[0];
    // 480 min of shift, 30 planned down → 450 planned; 60 unplanned → 390 run.
    expect(day).toMatchObject({
      capacityMinutes: 480,
      plannedDowntimeMinutes: 30,
      unplannedDowntimeMinutes: 60,
      plannedProductionMinutes: 450,
      runMinutes: 390,
      // 30 good + 6 rejects at 10 an hour: 216 ideal minutes, 180 of them good.
      idealMinutesTotal: 216,
      idealMinutesGood: 180,
      availability: 0.8667,
      performance: 0.5538,
      quality: 0.8333,
      oee: 0.4,
    });
    // Standard labour: both batches, 4 h each at a crew of 2. Actual: 3 people for 2 h.
    expect(day.labour).toEqual({ standardPersonHours: 16, standardUnknown: 0, actualPersonHours: 6 });
    expect(report.lines[0].downtimeByReason.map((d: { reason: string }) => d.reason)).toEqual([
      "breakdown",
      "cleaning",
    ]);
    expect(report.lines[0].rejectsByReason).toEqual([
      { reason: "setup_waste", label: "Start-up or set-up waste", records: 1, idealMinutes: 36, unrated: 0 },
    ]);

    // A day with nothing planned on the line isn't scheduled: it adds no planned production time.
    const tuesday = addDays(monday, 1);
    // Downtime logged on an idle day is listed apart and never counts against the scheduled days.
    await ok(
      await call("POST", "/production/downtime", {
        lineId: line,
        date: tuesday,
        minutes: 480,
        reason: "no_orders",
      }),
      201,
    );
    const twoDays = await ok(
      await call("GET", `/production/performance?from=${monday}&to=${tuesday}&lineId=${line}`),
    );
    expect(twoDays.lines[0].days[1]).toMatchObject({
      scheduled: false,
      lineCapacityMinutes: 480,
      plannedProductionMinutes: 0,
      plannedDowntimeMinutes: 0,
      unscheduledDowntimeMinutes: 480,
      oee: null,
      warnings: [],
    });
    expect(twoDays.lines[0].totals).toMatchObject({ plannedProductionMinutes: 450, oee: 0.4 });

    const detail = await ok(await call("GET", `/production/batches/${batch}/performance`));
    expect(detail).toMatchObject({
      firstPassYield: 0.8333,
      standardHours: 4,
      standardPersonHours: 8,
      actualPersonHours: 6,
    });
    expect(detail.good.base).toBe(30);
    expect(detail.rejected.base).toBe(6);
    expect(detail.unplannedDowntimeMinutes).toBe(60);
    expect(detail.rejects).toHaveLength(2);
  });

  it("costs line hours at absorption rates only for costing readers, and locks signed-off batches", async () => {
    await ok(
      await call("PUT", "/costing/rates", {
        lineId: null,
        effectiveFrom: addDays(monday, -30),
        labourPerHour: 20,
        overheadPerHour: 5,
      }),
    );
    await ok(await call("POST", `/production/batches/${batch}/complete`, { note: "Done" }));
    const report = await perf();
    // The completed batch: 4 standard hours at 25 an hour; it ran (almost) no time in the test.
    expect(report.lines[0].cost).toMatchObject({
      standardHours: 4,
      standardCost: 100,
      batchesCosted: 1,
      batchesLeftOut: 1,
    });
    expect(report.costBasis).toContain("absorption");
    const limited = await perf(marcus.cookie);
    expect(limited.lines[0].cost).toBeNull();
    expect(limited.costBasis).toBeNull();

    // After sign-off only manage adds or voids rejects and labour.
    expect(
      await code(
        await call(
          "POST",
          `/production/batches/${batch}/rejects`,
          { quantity: 1, unit: "each", reason: "damaged" },
          marcus.cookie,
        ),
        403,
      ),
    ).toBe("batch_completed");
    await ok(
      await call("POST", `/production/batches/${batch}/rejects`, {
        quantity: 1,
        unit: "each",
        reason: "damaged",
      }),
      201,
    );

    // Downtime against a batch counts on the batch's planned day, even when logged the day after.
    // On a signed-off batch it needs manage too.
    const late = {
      lineId: line,
      date: addDays(monday, 1),
      minutes: 30,
      reason: "breakdown",
      batchId: batch,
    };
    expect(await code(await call("POST", "/production/downtime", late, marcus.cookie), 403)).toBe(
      "batch_completed",
    );
    await ok(await call("POST", "/production/downtime", late), 201);
    const after = await ok(
      await call("GET", `/production/performance?from=${monday}&to=${addDays(monday, 1)}&lineId=${line}`),
    );
    expect(after.lines[0].days[0].unplannedDowntimeMinutes).toBe(90);
    expect(after.lines[0].days[1].unplannedDowntimeMinutes).toBe(0);

    // Records on a cancelled batch can still be voided, by manage only.
    const doomed = (
      await ok(
        await call("POST", "/production/batches", {
          recipeId: recipe,
          plannedOn: monday,
          batches: 1,
          batchCode: "PF-3",
          lineId: line,
        }),
        201,
      )
    ).id;
    await ok(await call("POST", `/production/batches/${doomed}/start`));
    const hours = await ok(
      await call("POST", `/production/batches/${doomed}/labour`, { people: 2, minutes: 30 }),
      201,
    );
    await ok(await call("POST", `/production/batches/${doomed}/cancel`, { reason: "Wrong recipe" }));
    expect(
      await code(
        await call("POST", `/production/labour/${hours.id}/void`, { reason: "Cancelled" }, marcus.cookie),
        403,
      ),
    ).toBe("batch_completed");
    await ok(await call("POST", `/production/labour/${hours.id}/void`, { reason: "Cancelled" }));
  });
});
