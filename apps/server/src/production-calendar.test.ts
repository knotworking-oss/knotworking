import { addDays, DEFAULT_TIME_ZONE, todayInZone, weekStart } from "@knotworking/core";
import { productionReservations } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDueNotifications } from "./services/notification-sweep";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const tomorrow = addDays(today, 1);
const yesterday = addDays(today, -1);
const MODULES = ["items", "recipes", "stock", "demand", "production"] as const;

type Res = Awaited<ReturnType<TestCtx["req"]>>;

describe("production: reservations by location, expiry, alerts, calendar and capacity", () => {
  let ctx: TestCtx;
  let ada: { cookie: string };
  const A = () => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie: ada.cookie }),
    send: (method: string, path: string, json?: unknown) =>
      ctx.req(`${WS}${path}`, { method, cookie: ada.cookie, json }),
  });
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

  let flour: string;
  let cake: string;
  let recipe: string;
  let store: string;
  let chiller: string;
  let lot: string; // 6 kg at the store, 2 kg moved to the chiller later
  let line: string;

  const plan = async (body: object = {}) =>
    ok(
      await A().send("POST", "/production/batches", {
        recipeId: recipe,
        plannedOn: today,
        ...("outputQuantity" in body ? {} : { batches: 1 }),
        ...body,
      }),
      201,
    );
  const reserve = (batchId: string, body: object) =>
    A().send("POST", `/production/batches/${batchId}/reservations`, body);
  type Held = { item: { id: string }; status: string; locationId: string | null; held: { base: number } };
  const flourOf = (detail: { reservations: Held[] }) =>
    detail.reservations.filter((r) => r.item.id === flour);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = await signIn(ctx, "ada@knotworking.dev");
    const item = async (body: object) => (await ok(await A().send("POST", "/items", body), 201)).id as string;
    flour = await item({ code: "FLR", name: "Flour", type: "ingredient", unit: "kg" });
    cake = await item({ code: "CAKE", name: "Cake", type: "finished", unit: "each", unitWeightG: 450 });
    recipe = (
      await ok(
        await A().send("POST", "/recipes", {
          code: "R-CAKE",
          name: "Cake",
          outputItemId: cake,
          draft: {
            yieldQuantity: 12,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 3, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
    await ok(await A().send("POST", `/recipes/${recipe}/draft/approve`));
    store = (await ok(await A().send("POST", "/stock/locations", { name: "Dry store" }), 201)).id;
    chiller = (await ok(await A().send("POST", "/stock/locations", { name: "Chiller" }), 201)).id;
    lot = (
      await ok(
        await A().send("POST", "/stock/receipts", {
          itemId: flour,
          locationId: store,
          receivedOn: today,
          quantity: 6,
          unit: "kg",
          lotCode: "FL-1",
        }),
        201,
      )
    ).id;
    await ok(
      await A().send("POST", "/stock/transfers", {
        lotId: lot,
        fromLocationId: store,
        toLocationId: chiller,
        quantity: 2,
        unit: "kg",
      }),
      201,
    );
    line = (await ok(await A().send("POST", "/production/lines", { name: "Line 1", hoursPerDay: 8 }), 201))
      .id;
    // 12 cakes (5400 g... base unit each): 6 each per hour.
    await ok(await A().send("PUT", `/production/lines/${line}/recipes/${recipe}`, { rate: 6, unit: "each" }));
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("reserving at a location", () => {
    it("reserves a lot's balance at one location and keeps it apart from the other", async () => {
      const batch = await plan();
      const res = await ok(
        await reserve(batch.id, {
          lines: [{ lotId: lot, locationId: chiller, quantity: 2, unit: "kg" }],
        }),
        201,
      );
      expect(res.reservations[0]).toMatchObject({ locationId: chiller, locationName: "Chiller" });
      // The chiller holds nothing more for anyone else, though the lot has 4 kg left elsewhere.
      const other = await plan();
      expect(
        await code(
          await reserve(other.id, {
            lines: [{ lotId: lot, locationId: chiller, quantity: 0.5, unit: "kg" }],
          }),
          409,
        ),
      ).toBe("insufficient_unreserved_stock");
      // Stock at the store is free.
      await ok(
        await reserve(other.id, { lines: [{ lotId: lot, locationId: store, quantity: 1, unit: "kg" }] }),
        201,
      );
      // A pick for the other batch skips the chiller's reserved 2 kg: it comes from the store only.
      const pick = await ok(await A().get(`/production/batches/${other.id}/pick`));
      const allocations = pick.materials[0].allocations as { locationName: string }[];
      expect(allocations.every((a) => a.locationName === "Dry store")).toBe(true);
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
      await A().send("POST", `/production/batches/${other.id}/cancel`, { reason: "test" });
    });

    it("cannot reserve more than is at the location, or at an unknown one", async () => {
      const batch = await plan();
      expect(
        await code(
          await reserve(batch.id, {
            lines: [{ lotId: lot, locationId: chiller, quantity: 2.5, unit: "kg" }],
          }),
          409,
        ),
      ).toBe("insufficient_unreserved_stock");
      expect(
        await code(
          await reserve(batch.id, {
            lines: [
              { lotId: lot, locationId: "019a0000-0000-7000-8000-000000000000", quantity: 1, unit: "kg" },
            ],
          }),
          404,
        ),
      ).toBeTruthy();
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });

    it("an item line with a location picks only from there, and consumption uses that hold first", async () => {
      const batch = await plan();
      const res = await ok(await reserve(batch.id, { lines: [{ itemId: flour, locationId: chiller }] }), 201);
      const rows = flourOf(res);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ locationId: chiller });
      expect(rows[0]!.held.base).toBe(2000); // only 2 kg there, the batch needs 3
      expect(res.shortfalls).toHaveLength(1);
      // Reserve 1 kg of the lot as a whole as well, then consume 2 kg from the store: the whole-lot hold is used.
      await ok(await reserve(batch.id, { lines: [{ lotId: lot, quantity: 1, unit: "kg" }] }), 201);
      await ok(await A().send("POST", `/production/batches/${batch.id}/start`));
      const after = await ok(
        await A().send("POST", `/production/batches/${batch.id}/consumption`, {
          lines: [{ lotId: lot, locationId: store, quantity: 1, unit: "kg" }],
        }),
        201,
      );
      const held = flourOf(after).filter((r) => r.status === "active");
      expect(held).toHaveLength(1);
      expect(held[0]!.locationId).toBe(chiller);
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });
  });

  describe("expiry", () => {
    it("holds through its last day, then counts for nothing and is released by the sweep", async () => {
      const batch = await plan({ batches: 3 });
      expect(
        await code(
          await reserve(batch.id, { expiresOn: yesterday, lines: [{ lotId: lot, quantity: 1, unit: "kg" }] }),
          400,
        ),
      ).toBe("invalid_expiry");
      const free = async () =>
        (await ok(await A().get(`/production/availability?itemIds=${flour}`))).items[0].available
          .base as number;
      const before = await free();
      const res = await ok(
        await reserve(batch.id, { expiresOn: tomorrow, lines: [{ lotId: lot, quantity: 4, unit: "kg" }] }),
        201,
      );
      const id = res.reservations[0].id as string;
      expect(res.reservations[0]).toMatchObject({ reservationExpiresOn: tomorrow, expired: false });
      expect(await free()).toBe(before - 4000);
      // The expiry can be moved and removed.
      const moved = await ok(await A().send("PATCH", `/production/reservations/${id}`, { expiresOn: today }));
      expect(moved.reservations[0].reservationExpiresOn).toBe(today);
      expect(
        await code(await A().send("PATCH", `/production/reservations/${id}`, { expiresOn: yesterday }), 400),
      ).toBe("invalid_expiry");
      // Pretend its last day was yesterday: reads ignore it at once.
      await ctx.handle.db
        .update(productionReservations)
        .set({ expiresOn: yesterday })
        .where(eq(productionReservations.id, id));
      expect(await free()).toBe(before);
      const detail = await ok(await A().get(`/production/batches/${batch.id}`));
      expect(detail.reservations[0]).toMatchObject({ status: "active", expired: true });
      expect(detail.reservations[0].held.base).toBe(0);
      // The sweep releases it (reason expired) and says so in the sync log.
      await sweepDueNotifications(ctx.handle.db, { activeModules: MODULES });
      const after = await ok(await A().get(`/production/batches/${batch.id}`));
      expect(after.reservations[0]).toMatchObject({ status: "released", releaseReason: "expired" });
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });

    it("a reservation write releases expired holds first, so their stock is free", async () => {
      const first = await plan({ batches: 3 });
      const res = await ok(
        await reserve(first.id, { expiresOn: tomorrow, lines: [{ lotId: lot, quantity: 5, unit: "kg" }] }),
        201,
      );
      await ctx.handle.db
        .update(productionReservations)
        .set({ expiresOn: yesterday })
        .where(eq(productionReservations.id, res.reservations[0].id));
      const second = await plan({ batches: 3 });
      await ok(await reserve(second.id, { lines: [{ lotId: lot, quantity: 5, unit: "kg" }] }), 201);
      const old = await ok(await A().get(`/production/batches/${first.id}`));
      expect(old.reservations[0]).toMatchObject({ status: "released", releaseReason: "expired" });
      await A().send("POST", `/production/batches/${first.id}/cancel`, { reason: "test" });
      await A().send("POST", `/production/batches/${second.id}/cancel`, { reason: "test" });
    });
  });

  describe("alerts when a reserved lot is at risk", () => {
    const alerts = async () =>
      (await ok(await A().get("/notifications?limit=100"))).notifications.filter(
        (n: { type: string }) => n.type === "reserved_lot_problem",
      ) as { data: { reservationProblem: string; title: string; subjectId: string }; module: string }[];

    it("tells the planner when the lot goes into quarantine, and again for nothing on a repeat", async () => {
      const marker = (await alerts()).length;
      const batch = await plan({ plannedOn: tomorrow });
      await ok(await reserve(batch.id, { lines: [{ lotId: lot, quantity: 1, unit: "kg" }] }), 201);
      // Ada is the only person, and made the change: nobody else is told, nobody is told twice.
      await ok(
        await A().send("POST", `/stock/lots/${lot}/status`, { status: "quarantine", note: "Metal check" }),
      );
      const mine = await alerts();
      // Ada caused it herself; the planner and manager are the same person.
      expect(mine.length).toBe(marker);
      // The sweep tells her (nobody acted): once.
      await sweepDueNotifications(ctx.handle.db, { activeModules: MODULES });
      const afterSweep = await alerts();
      expect(afterSweep.length).toBe(marker + 1);
      expect(afterSweep[0]!.data).toMatchObject({ reservationProblem: "quarantine", subjectId: batch.id });
      expect(afterSweep[0]!.module).toBe("production");
      await sweepDueNotifications(ctx.handle.db, { activeModules: MODULES });
      expect((await alerts()).length).toBe(marker + 1);
      await ok(await A().send("POST", `/stock/lots/${lot}/status`, { status: "available", note: "Cleared" }));
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });

    it("the sweep notices a lot that has run short", async () => {
      const marker = (await alerts()).length;
      const batch = await plan({ plannedOn: tomorrow, batches: 3 });
      await ok(await reserve(batch.id, { lines: [{ lotId: lot, quantity: 4, unit: "kg" }] }), 201);
      await ok(
        await A().send("POST", "/stock/waste", {
          lotId: lot,
          locationId: store,
          quantity: 2.5,
          unit: "kg",
          reason: "Spilt",
        }),
        201,
      );
      const detail = await ok(await A().get(`/production/batches/${batch.id}`));
      expect(detail.reservations[0].short).toBe(true);
      await sweepDueNotifications(ctx.handle.db, { activeModules: MODULES });
      const list = await alerts();
      expect(list.length).toBe(marker + 1);
      expect(list[0]!.data.reservationProblem).toBe("short");
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });
  });

  describe("working-day calendar", () => {
    const monday = weekStart(addDays(today, 14));
    const saturday = addDays(monday, 5);

    it("marks days off for the workspace and a line, repeatably", async () => {
      const bank = await ok(
        await A().send("POST", "/production/calendar", { from: monday, reason: "Bank holiday" }),
        201,
      );
      expect(bank).toMatchObject({ created: 1, existing: 0 });
      const weekend = await ok(
        await A().send("POST", "/production/calendar", {
          from: monday,
          to: addDays(monday, 6),
          weekdays: [6, 7],
          reason: "Weekend",
        }),
        201,
      );
      expect(weekend.created).toBe(2);
      const again = await ok(
        await A().send("POST", "/production/calendar", {
          from: monday,
          to: addDays(monday, 6),
          weekdays: [6, 7],
        }),
        201,
      );
      expect(again).toMatchObject({ created: 0, existing: 2 });
      const refit = await ok(
        await A().send("POST", "/production/calendar", {
          from: addDays(monday, 2),
          lineId: line,
          reason: "Refit",
        }),
        201,
      );
      expect(refit.created).toBe(1);
      const list = await ok(await A().get(`/production/calendar?from=${monday}&to=${addDays(monday, 6)}`));
      expect(list.days.map((d: { date: string }) => d.date)).toEqual([
        monday,
        addDays(monday, 2),
        saturday,
        addDays(monday, 6),
      ]);
      expect(list.days.find((d: { lineName: string | null }) => d.lineName)).toMatchObject({
        lineName: "Line 1",
      });
      expect(
        await code(
          await A().send("POST", "/production/calendar", { from: today, lineId: crypto.randomUUID() }),
          404,
        ),
      ).toBeTruthy();
      expect(
        await code(
          await A().send("POST", "/production/calendar", { from: today, to: addDays(today, 400) }),
          400,
        ),
      ).toBeTruthy();
    });

    it("warns about a batch planned on a day off, but plans it", async () => {
      const batch = await plan({ plannedOn: monday });
      expect(batch.calendarWarning).toMatchObject({
        date: monday,
        scope: "workspace",
        reason: "Bank holiday",
      });
      const onLine = await plan({ plannedOn: addDays(monday, 2), lineId: line });
      expect(onLine.calendarWarning).toMatchObject({ scope: "line", reason: "Refit" });
      expect(onLine.lineCheck.warnings.join(" ")).toContain("non-working day");
      const fine = await plan({ plannedOn: addDays(monday, 1), lineId: line });
      expect(fine.calendarWarning).toBeNull();
      for (const b of [batch, onLine, fine]) {
        await A().send("POST", `/production/batches/${b.id}/cancel`, { reason: "test" });
      }
    });

    it("the schedule has no capacity on a day off, and flags what is planned on it", async () => {
      const batch = await plan({ plannedOn: monday, lineId: line });
      const schedule = await ok(
        await A().get(`/production/schedule?from=${monday}&to=${addDays(monday, 6)}`),
      );
      expect(schedule.daysOff.map((d: { date: string }) => d.date)).toEqual([
        monday,
        saturday,
        addDays(monday, 6),
      ]);
      const days = schedule.lines[0].days as {
        date: string;
        capacityHours: number;
        overloaded: boolean;
        dayOff: { scope: string } | null;
      }[];
      const mon = days.find((d) => d.date === monday)!;
      expect(mon).toMatchObject({ capacityHours: 0, overloaded: true, dayOff: { scope: "workspace" } });
      const tue = days.find((d) => d.date === addDays(monday, 1))!;
      expect(tue).toMatchObject({ capacityHours: 8, overloaded: false, dayOff: null });
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });

    it("removes a day off", async () => {
      const list = await ok(await A().get(`/production/calendar?from=${saturday}&to=${saturday}`));
      const id = list.days[0].id as string;
      expect((await A().send("DELETE", `/production/calendar/${id}`)).status).toBe(204);
      expect((await A().send("DELETE", `/production/calendar/${id}`)).status).toBe(404);
      const after = await ok(await A().get(`/production/calendar?from=${saturday}&to=${saturday}`));
      expect(after.days).toEqual([]);
    });
  });

  describe("demand against line capacity", () => {
    it("compares the uncovered demand and planned batches with each week's capacity", async () => {
      const thisWeek = weekStart(today);
      const nextWeek = addDays(thisWeek, 7);
      // 120 cakes next week; no stock, no batches. 6 an hour on Line 1: 20 hours.
      await ok(
        await A().send("PUT", "/demand/lines", {
          lines: [{ itemId: cake, period: nextWeek, quantity: 120, unit: "each" }],
        }),
      );
      const cap = await ok(await A().get(`/demand/capacity?from=${thisWeek}&to=${addDays(nextWeek, 7)}`));
      expect(cap).toMatchObject({ available: true, lineCount: 1 });
      const week = cap.weeks.find((w: { periodStart: string }) => w.periodStart === nextWeek);
      // The week's capacity: 8 h on each working day (every day unless marked off).
      expect(week.capacityHours).toBe(8 * week.lines[0].workingDays);
      expect(week.neededHours).toBe(20);
      expect(week.bookedHours).toBe(0);
      expect(cap.needs[0]).toMatchObject({ item: { id: cake }, rate: { lineName: "Line 1" } });
      // A planned batch covers part of the demand and takes booked hours instead.
      const batch = await plan({
        plannedOn: addDays(nextWeek, 1),
        lineId: line,
        outputQuantity: 60,
        outputUnit: "each",
      });
      const cap2 = await ok(await A().get(`/demand/capacity?from=${thisWeek}&to=${addDays(nextWeek, 7)}`));
      const week2 = cap2.weeks.find((w: { periodStart: string }) => w.periodStart === nextWeek);
      expect(week2.bookedHours).toBe(10);
      expect(week2.neededHours).toBe(10);
      expect(week2.loadPercent).toBeGreaterThan(0);
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
      // Marking the week's days off leaves no capacity: the week is over.
      await ok(
        await A().send("POST", "/production/calendar", {
          from: nextWeek,
          to: addDays(nextWeek, 6),
          reason: "Shutdown",
        }),
        201,
      );
      const cap3 = await ok(await A().get(`/demand/capacity?from=${thisWeek}&to=${nextWeek}`));
      const week3 = cap3.weeks.find((w: { periodStart: string }) => w.periodStart === nextWeek);
      expect(week3).toMatchObject({ capacityHours: 0, status: "over" });
      expect(week3.daysOff).toHaveLength(7);
      expect(cap3.overWeeks).toContain(nextWeek);
    });
  });

  describe("scanning a GS1-128 lot label", () => {
    it("finds the lot by the lot number in a scanned element string", async () => {
      const batch = await plan({ plannedOn: tomorrow });
      for (const scanned of ["(10)FL-1", "]C110FL-1", "1726123110FL-1", "fl-1"]) {
        const res = await ok(
          await A().get(`/production/batches/${batch.id}/scan?code=${encodeURIComponent(scanned)}`),
        );
        expect(res.matches[0]?.lotCode, scanned).toBe("FL-1");
      }
      await A().send("POST", `/production/batches/${batch.id}/cancel`, { reason: "test" });
    });
  });
});
