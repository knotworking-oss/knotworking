import { addDaysIso, DEFAULT_TIME_ZONE, isoWeekdayOf, todayInZone } from "@knotworking/core";
import { qualityNonconformances } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("quality: four-eyes, due sweep, trends, supplier standing, prefill, programme", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  const today = todayInZone(DEFAULT_TIME_ZONE);
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const grant = async (moduleId: string, level: string | null) =>
    ok(
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
        method: "PUT",
        cookie: ada,
        json: { level },
      }),
    );
  let cake: string;
  let cakeLot: string;
  let supplier: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    marcus = {
      userId: members.find((x: { email: string }) => x.email === "marcus@knotworking.dev").userId,
      cookie: (await signIn(ctx, "marcus@knotworking.dev")).cookie,
    };
    await grant("items", "read");
    await grant("stock", "read");
    await grant("quality", "write");
    cake = (
      await ok(
        await as(ada).send("POST", "/items", { code: "CAKE", name: "Cake", type: "finished", unit: "each" }),
        201,
      )
    ).id;
    const store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Store" }), 201)).id;
    cakeLot = (
      await ok(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: cake,
          quantity: 480,
          unit: "each",
          locationId: store,
          receivedOn: today,
          reason: "Opening balance",
        }),
        201,
      )
    ).id;
    supplier = (await ok(await as(ada).send("POST", "/suppliers", { name: "Mill Co" }), 201)).id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  const raise = async (body: object) =>
    (
      await ok(
        await as(ada).send("POST", "/quality/nonconformances", {
          raisedOn: today,
          source: "process",
          title: "Thing",
          description: "It broke",
          ...body,
        }),
        201,
      )
    ).id as string;

  it("refuses verification by whoever took the action, unless they are the only manager", async () => {
    const id = await raise({ rootCause: "Worn seal", correctiveAction: "Replaced" });
    await ok(await as(ada).send("PATCH", `/quality/nonconformances/${id}`, { status: "action_taken" }));
    await grant("quality", "manage");
    const res = await as(ada).send("POST", `/quality/nonconformances/${id}/close`, {
      verificationNote: "ok",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("four_eyes");
    await ok(
      await as(marcus.cookie).send("POST", `/quality/nonconformances/${id}/close`, {
        verificationNote: "ok",
      }),
    );
    // Marcus took this action himself: Ada verifies.
    const second = await raise({ rootCause: "x", correctiveAction: "y" });
    await ok(
      await as(marcus.cookie).send("PATCH", `/quality/nonconformances/${second}`, { status: "action_taken" }),
    );
    expect(
      (
        await as(marcus.cookie).send("POST", `/quality/nonconformances/${second}/close`, {
          verificationNote: "n",
        })
      ).status,
    ).toBe(403);
    await ok(
      await as(ada).send("POST", `/quality/nonconformances/${second}/close`, { verificationNote: "n" }),
    );
    await grant("quality", "write");
  });

  it("notifies the owner and managers once when a non-conformance falls due", async () => {
    const id = await raise({ ownerUserId: marcus.userId, dueOn: today, title: "Due today" });
    await raise({ dueOn: addDaysIso(today, 5), title: "Not yet" });
    const sweep = async () =>
      (await ok(await as(ada).send("POST", "/notifications/sweep"))).created as number;
    expect(await sweep()).toBeGreaterThan(0);
    const inbox = async (cookie: string) =>
      (await ok(await as(cookie).get("/notifications"))).notifications.filter(
        (n: { type: string }) => n.type === "nonconformance_due",
      );
    expect((await inbox(marcus.cookie)).map((n: any) => n.data.subjectId)).toEqual([id]);
    expect((await inbox(ada)).map((n: any) => n.data.title)).toEqual([expect.stringContaining("Due today")]);
    expect(await sweep()).toBe(0);
    // A non-conformance deleted since hides its notification.
    await ctx.handle.db
      .update(qualityNonconformances)
      .set({ deletedAt: new Date() })
      .where(eq(qualityNonconformances.id, id));
    expect(await inbox(marcus.cookie)).toEqual([]);
  });

  it("works out complaints per million units from entered volumes", async () => {
    await ok(
      await as(marcus.cookie).send("PUT", "/quality/sales-volumes", {
        itemId: cake,
        period: today,
        units: 50_000,
      }),
    );
    for (let i = 0; i < 2; i++)
      await ok(
        await as(marcus.cookie).send("POST", "/quality/complaints", {
          receivedOn: today,
          source: "consumer",
          category: "quality",
          itemId: cake,
          description: "Dry",
        }),
        201,
      );
    const t = await ok(await as(marcus.cookie).get("/quality/trends?months=3"));
    expect(t.periods).toHaveLength(3);
    expect(t.overall.months.at(-1)).toMatchObject({ complaints: 2, units: 50_000, perMillion: 40 });
    expect(t.overall.months[0].perMillion).toBeNull();
    expect(t.products[0]).toMatchObject({ item: { code: "CAKE" }, total: { complaints: 2, perMillion: 40 } });
    expect(t.categories[0]).toMatchObject({ category: "quality", total: { perMillion: 40 } });
  });

  it("shows a supplier's open non-conformances, suggests suspension and records the review", async () => {
    const major = await raise({
      source: "supplier",
      severity: "major",
      supplierId: supplier,
      title: "Short weight",
    });
    const standing = await ok(await as(marcus.cookie).get(`/quality/suppliers/${supplier}`));
    expect(standing.open.map((n: any) => n.id)).toEqual([major]);
    expect(standing.advice.suggest).toBe(true);
    // Nothing recorded until the approval has been decided (by a person, in items).
    expect(
      (await as(ada).send("POST", `/quality/suppliers/${supplier}/review`, { nonconformanceIds: [major] }))
        .status,
    ).toBe(409);
    await ok(
      await as(ada).send("POST", `/suppliers/${supplier}/approval`, {
        status: "suspended",
        note: "Short weight",
      }),
    );
    await ok(
      await as(ada).send("POST", `/quality/suppliers/${supplier}/review`, { nonconformanceIds: [major] }),
    );
    const nc = await ok(await as(ada).get(`/quality/nonconformances/${major}`));
    expect(nc).toMatchObject({ supplierReviewStatus: "suspended" });
    const after = await ok(await as(ada).get(`/quality/suppliers/${supplier}`));
    expect(after.advice.suggest).toBe(false);
  });

  it("prefills a recall test from the lot's mass balance", async () => {
    const p = await ok(await as(ada).get(`/quality/recall-tests/prefill?lotId=${cakeLot}`));
    expect(p).toMatchObject({ lotId: cakeLot, unit: "each", quantityExpected: 480, quantityTraced: 480 });
    expect(p.notes).toContain("Mass balance");
  });

  it("plans a recurring programme's audits ahead and the sweep adds the next one once", async () => {
    const start = addDaysIso(today, 10);
    const prog = await ok(
      await as(marcus.cookie).send("POST", "/quality/audit-programmes", {
        title: "GMP walk",
        scope: "BRCGS 4.11",
        intervalMonths: 1,
        nextPlannedOn: start,
        auditorUserId: marcus.userId,
      }),
      201,
    );
    const audits = async () =>
      (await ok(await as(ada).get("/quality/audits"))).audits.filter((a: any) => a.title === "GMP walk");
    // The first, and the second a month later (within 60 days).
    expect((await audits()).map((a: any) => a.plannedOn).sort()[0]).toBe(start);
    const planned = (await audits()).length;
    expect(planned).toBeGreaterThanOrEqual(1);
    await as(ada).send("POST", "/notifications/sweep");
    expect((await audits()).length).toBe(planned);
    expect(prog.id).toBeTruthy();
  });

  it("pins a programme's audits to a weekday, without drifting the schedule", async () => {
    const start = addDaysIso(today, 12);
    const wanted = (isoWeekdayOf(start) % 7) + 1;
    const prog = await ok(
      await as(marcus.cookie).send("POST", "/quality/audit-programmes", {
        title: "Weekday walk",
        intervalMonths: 1,
        nextPlannedOn: start,
        weekday: wanted,
      }),
      201,
    );
    // The start date is one day before the wanted weekday: the audit is planned a day later.
    expect(prog.weekday).toBe(wanted);
    expect(prog.nextAuditOn >= start).toBe(true);
    expect(isoWeekdayOf(prog.nextAuditOn)).toBe(wanted);
    const audits = (await ok(await as(ada).get("/quality/audits"))).audits.filter(
      (a: any) => a.title === "Weekday walk",
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    for (const a of audits) expect(isoWeekdayOf(a.plannedOn)).toBe(wanted);
    expect(audits.map((a: any) => a.plannedOn).sort()[0]).toBe(addDaysIso(start, 1));

    // Weekday out of range is refused; clearing it is allowed.
    expect(
      (await as(marcus.cookie).send("PATCH", `/quality/audit-programmes/${prog.id}`, { weekday: 8 })).status,
    ).toBe(400);
    const cleared = await ok(
      await as(marcus.cookie).send("PATCH", `/quality/audit-programmes/${prog.id}`, { weekday: null }),
    );
    expect(cleared.weekday).toBeNull();
    expect(cleared.nextAuditOn).toBe(cleared.nextPlannedOn);
  });
});
