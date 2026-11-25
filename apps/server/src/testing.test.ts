import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const year = today.slice(0, 4);

describe("testing module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const ok = async (res: Response, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const fails = async (res: Response, status: number, code?: string): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    if (code) expect(body.error?.code).toBe(code);
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

  let flour: string;
  let store: string;
  let lot: string;
  let lab: string;
  let swabPoint: string;
  let spec: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
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
    flour = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "FLR",
          name: "Flour",
          type: "ingredient",
          unit: "kg",
          allergens: ["cereals_gluten"],
        }),
        201,
      )
    ).id;
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Dry store" }), 201)).id;
    lot = (
      await ok(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: flour,
          quantity: 25,
          unit: "kg",
          locationId: store,
          receivedOn: today,
        }),
        201,
      )
    ).id;
  });

  afterAll(() => ctx.handle.close());

  it("is opt-in and needs Items and Stock", async () => {
    expect((await as(marcus.cookie).get("/testing/samples")).status).toBe(403);
    await grant("testing", "write");
    await grant("items", "read");
    expect((await as(marcus.cookie).get("/testing/samples")).status).toBe(403);
    await grant("stock", "read");
    await ok(await as(marcus.cookie).get("/testing/samples"));
  });

  it("keeps laboratories, sampling points and plans", async () => {
    lab = (
      await ok(
        await as(ada).send("POST", "/testing/laboratories", {
          name: "Micro Labs",
          accreditation: "UKAS 0001",
        }),
        201,
      )
    ).id;
    swabPoint = (
      await ok(
        await as(ada).send("POST", "/testing/points", {
          code: "HC-Z1-01",
          name: "Slicer blade",
          kind: "environmental",
          zone: "High care zone 1",
        }),
        201,
      )
    ).id;
    await fails(
      await as(ada).send("POST", "/testing/points", { code: "hc-z1-01", name: "Dup", kind: "water" }),
      409,
      "code_taken",
    );
    // A point plan must say what it tests for; a lot plan names an item.
    await fails(
      await as(ada).send("POST", "/testing/plans", {
        name: "Swab",
        subject: "point",
        samplingPointId: swabPoint,
        frequencyDays: 7,
      }),
      400,
    );
    await fails(
      await as(ada).send("POST", "/testing/plans", {
        name: "x",
        subject: "lot",
        samplingPointId: swabPoint,
        frequencyDays: 7,
      }),
      400,
    );
    const plan = await ok(
      await as(ada).send("POST", "/testing/plans", {
        name: "Weekly Listeria swab",
        subject: "point",
        samplingPointId: swabPoint,
        frequencyDays: 7,
        rationale: "High care zone 1 food contact surface, per the EMP risk assessment",
        laboratoryId: lab,
        analytes: [{ category: "microbiological", name: "Listeria spp.", limitText: "Not detected" }],
      }),
      201,
    );
    const { plans } = await ok(await as(ada).get("/testing/plans"));
    expect(plans.find((p: { id: string }) => p.id === plan.id)).toMatchObject({
      nextDueOn: today,
      state: "due",
      lastSampledOn: null,
      samplingPoint: { code: "HC-Z1-01", zone: "High care zone 1" },
    });
  });

  it("logs a lot sample with limits from the item's approved specification", async () => {
    await grant("food_items", "read");
    await grant("specifications", "manage");
    const created = await ok(
      await as(ada).send("POST", "/specifications", {
        code: "SPEC-FLR",
        title: "Flour",
        itemId: flour,
        draft: {
          storage: "ambient",
          shelfLifeDays: 270,
          allergens: ["cereals_gluten"],
          reviewDueOn: "2099-01-01",
          parameters: [
            { category: "chemical", name: "Moisture", unit: "%", max: 15.5 },
            { category: "microbiological", name: "Salmonella", limitText: "Absent in 25 g" },
            { category: "sensory", name: "Colour", target: 3 },
          ],
        },
      }),
      201,
    );
    spec = created.id;
    await ok(await as(marcus.cookie).send("POST", `/specifications/${spec}/draft/approve`));

    const sample = await ok(
      await as(ada).send("POST", "/testing/samples", {
        subject: "lot",
        lotId: lot,
        laboratoryId: lab,
        sampledOn: today,
      }),
      201,
    );
    expect(sample).toMatchObject({
      reference: `S-${year}-0001`,
      status: "awaiting_results",
      outcome: "pending",
      lot: { id: lot, status: "available" },
      item: { code: "FLR" },
      specification: { code: "SPEC-FLR", versionNumber: 1 },
      laboratory: { name: "Micro Labs" },
    });
    // A target alone has nothing to fail, so Colour isn't tested.
    expect(sample.results.map((r: { name: string }) => r.name)).toEqual(["Moisture", "Salmonella"]);
    await fails(
      await as(ada).send("POST", "/testing/samples", { subject: "lot", lotId: lot, sampledOn: "2099-01-01" }),
      400,
    );
  });

  it("passes a lot within its limits", async () => {
    const { samples } = await ok(await as(ada).get(`/testing/samples?lotId=${lot}`));
    const sample = await ok(await as(ada).get(`/testing/samples/${samples[0].id}`));
    const [moisture, salmonella] = sample.results;
    // A written limit needs a person's verdict; a numeric one needs the value.
    await fails(
      await as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        results: [{ resultId: salmonella.id, valueText: "Not detected" }],
      }),
      400,
    );
    await fails(
      await as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        results: [{ resultId: moisture.id, outcome: "pass" }],
      }),
      400,
    );
    const partial = await ok(
      await as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        reportReference: "ML-1",
        results: [{ resultId: moisture.id, value: 14.2 }],
      }),
    );
    expect(partial).toMatchObject({ status: "awaiting_results", outcome: "pending" });
    const done = await ok(
      await as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        results: [{ resultId: salmonella.id, valueText: "Not detected", outcome: "pass" }],
      }),
    );
    expect(done).toMatchObject({
      status: "complete",
      outcome: "pass",
      investigationStatus: null,
      lot: { status: "available" },
    });
  });

  it("fails a lot: opens an investigation and holds the lot, even when an API token records it", async () => {
    const sample = await ok(
      await viaToken("POST", "/testing/samples", { subject: "lot", lotId: lot, sampledOn: today }),
      201,
    );
    expect(sample.reference).toBe(`S-${year}-0002`);
    const moisture = sample.results.find((r: { name: string }) => r.name === "Moisture");
    const failed = await ok(
      await viaToken("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        results: [{ resultId: moisture.id, value: 16.1 }],
      }),
    );
    expect(failed).toMatchObject({
      outcome: "fail",
      status: "awaiting_results",
      investigationStatus: "open",
      lotHeld: true,
      lot: { status: "quarantine" },
    });
    const lotRow = await ok(await as(ada).get(`/stock/lots/${lot}`));
    expect(lotRow.statusNote).toContain(sample.reference);
    expect(lotRow.statusNote).toContain("Moisture");

    // Correcting a recorded result needs a reason and keeps the old value.
    await fails(
      await as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        results: [{ resultId: moisture.id, value: 15.1 }],
      }),
      400,
    );
    const corrected = await ok(
      await as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
        reportedOn: today,
        results: [{ resultId: moisture.id, value: 15.1, correctionReason: "Transcription error" }],
      }),
    );
    const fixed = corrected.results.find((r: { name: string }) => r.name === "Moisture");
    expect(fixed).toMatchObject({ value: 15.1, outcome: "pass" });
    expect(fixed.history).toEqual([
      expect.objectContaining({ value: 16.1, outcome: "fail", reason: "Transcription error" }),
    ]);
    // The investigation stays open for a person to close, and the lot stays held.
    expect(corrected).toMatchObject({ investigationStatus: "open", lot: { status: "quarantine" } });
    const open = await ok(await as(ada).get("/testing/samples?investigation=open"));
    expect(open.samples.map((s: { id: string }) => s.id)).toEqual([sample.id]);
  });

  it("closes an investigation only by a person with manage, once every result is in", async () => {
    const { samples } = await ok(await as(ada).get("/testing/samples?investigation=open"));
    const id = samples[0].id;
    const close = { findings: "Moisture meter misread", actionTaken: "Retested; lot released by QA" };
    await fails(
      await as(ada).send("POST", `/testing/samples/${id}/investigation/close`, close),
      409,
      "results_pending",
    );
    const sample = await ok(await as(ada).get(`/testing/samples/${id}`));
    const salmonella = sample.results.find((r: { name: string }) => r.name === "Salmonella");
    await ok(
      await as(ada).send("POST", `/testing/samples/${id}/results`, {
        reportedOn: today,
        results: [{ resultId: salmonella.id, outcome: "pass" }],
      }),
    );
    expect((await viaToken("POST", `/testing/samples/${id}/investigation/close`, close)).status).toBe(403);
    expect(
      (await as(marcus.cookie).send("POST", `/testing/samples/${id}/investigation/close`, close)).status,
    ).toBe(403);
    await fails(
      await as(ada).send("POST", `/testing/samples/${id}/investigation/close`, { findings: "x" }),
      400,
    );
    const closed = await ok(await as(ada).send("POST", `/testing/samples/${id}/investigation/close`, close));
    expect(closed).toMatchObject({
      investigationStatus: "closed",
      findings: "Moisture meter misread",
      status: "complete",
    });
    expect(closed.investigationClosedByName).toBeTruthy();
    // Closing doesn't release the lot: that is stock's QA decision.
    expect(closed.lot.status).toBe("quarantine");
  });

  it("samples a point under its plan, moves the plan's due date and cancels a lost sample", async () => {
    const { plans } = await ok(await as(ada).get("/testing/plans"));
    const plan = plans[0];
    const swab = await ok(
      await as(marcus.cookie).send("POST", "/testing/samples", {
        subject: "point",
        samplingPointId: swabPoint,
        planId: plan.id,
        sampledOn: today,
        sampledBy: "M. Hygiene",
      }),
      201,
    );
    expect(swab).toMatchObject({ laboratory: { id: lab }, samplingPoint: { code: "HC-Z1-01" }, lot: null });
    expect(swab.results).toEqual([
      expect.objectContaining({ name: "Listeria spp.", limitText: "Not detected" }),
    ]);
    // A point plan can't be used for a lot.
    await fails(
      await as(ada).send("POST", "/testing/samples", {
        subject: "lot",
        lotId: lot,
        planId: plan.id,
        sampledOn: today,
      }),
      400,
    );
    const after = (await ok(await as(ada).get("/testing/plans"))).plans[0];
    expect(after).toMatchObject({ lastSampledOn: today, state: "due_soon" });

    const lost = await ok(
      await as(ada).send("POST", "/testing/samples", {
        subject: "point",
        samplingPointId: swabPoint,
        sampledOn: today,
        analytes: [{ category: "microbiological", name: "Listeria spp.", limitText: "Not detected" }],
      }),
      201,
    );
    const cancelled = await ok(
      await as(ada).send("POST", `/testing/samples/${lost.id}/cancel`, { reason: "Lost in transit" }),
    );
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Lost in transit" });
    await fails(
      await as(ada).send("POST", `/testing/samples/${lost.id}/results`, {
        reportedOn: today,
        results: [{ resultId: lost.results[0].id, outcome: "pass" }],
      }),
      409,
      "sample_cancelled",
    );
    // A swab failing at a point opens an investigation but holds no lot.
    const swabFail = await ok(
      await as(ada).send("POST", `/testing/samples/${swab.id}/results`, {
        reportedOn: today,
        results: [{ resultId: swab.results[0].id, valueText: "Detected", outcome: "fail" }],
      }),
    );
    expect(swabFail).toMatchObject({
      outcome: "fail",
      investigationStatus: "open",
      lotHeld: false,
      status: "complete",
    });
  });

  it("trends an analyte with totals, leaving cancelled samples out", async () => {
    const moisture = await ok(await as(ada).get(`/testing/trends?analyte=moisture&itemId=${flour}`));
    expect(moisture.points.map((p: { value: number; outcome: string }) => [p.value, p.outcome])).toEqual([
      [14.2, "pass"],
      [15.1, "pass"],
    ]);
    expect(moisture.summary).toMatchObject({ results: 2, fails: 0, mean: 14.65, max: 15.1 });
    const listeria = await ok(
      await as(ada).get(`/testing/trends?analyte=Listeria%20spp.&zone=high%20care%20zone%201`),
    );
    expect(listeria.summary).toMatchObject({ results: 1, fails: 1, failRate: 1 });
    await fails(await as(ada).get(`/testing/trends?analyte=x&itemId=${flour}&zone=z`), 400);
    const { analytes } = await ok(await as(ada).get("/testing/analytes"));
    expect(analytes).toEqual(expect.arrayContaining(["Moisture", "Salmonella", "Listeria spp."]));
  });

  it("puts metadata, never results or findings, in the sync log", async () => {
    const page = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: ada })).json();
    const samples = page.changes.filter((c: { entity: string }) => c.entity === "testing_sample");
    expect(samples.length).toBeGreaterThan(0);
    for (const change of samples) {
      expect(change.data).not.toHaveProperty("findings");
      expect(change.data).not.toHaveProperty("results");
      expect(change.data).toHaveProperty("outcome");
    }
    await grant("testing", null);
    const theirs = await (await ctx.req(`${WS}/sync?after=0&limit=1000`, { cookie: marcus.cookie })).json();
    expect(theirs.changes.some((c: { entity: string }) => c.entity.startsWith("testing_"))).toBe(false);
  });
});
