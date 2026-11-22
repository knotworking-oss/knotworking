import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

/**
 * Section 3.2 acceptance exercise (docs/phase-3.md), end to end through the API:
 *
 * - a lot awaiting a required result remains on hold;
 * - a failed result raises an investigation and contains the lot;
 * - an authorised release records the evidence and the rule version used, both a normal release
 *   once the evidence is in and a two-person release exception;
 * - a specification change identifies the affected recipes, labels and open production.
 */
describe("Section 3.2 acceptance exercise", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
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
  const grant = async (moduleId: string, level: string) =>
    ok(
      await ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
        method: "PUT",
        cookie: ada,
        json: { level },
      }),
    );
  const blocking = (checks: { kind: string; status: string }[]) =>
    checks.filter((c) => c.status === "block").map((c) => c.kind);

  const specDraft = (over: Record<string, unknown> = {}) => ({
    description: "Wheat flour, type 55",
    storage: "ambient",
    shelfLifeDays: 270,
    minimumLifeOnReceiptDays: 120,
    allergens: ["cereals_gluten"],
    mayContain: [],
    countryOfOrigin: "United Kingdom",
    claims: [],
    parameters: [
      { category: "chemical", name: "Moisture", unit: "%", max: 15.5 },
      { category: "microbiological", name: "Salmonella", limitText: "Absent in 25 g" },
    ],
    reviewDueOn: "2099-01-01",
    agreedBy: "J. Miller, Technical Manager",
    agreedOn: today,
    agreementReference: "MILL-SPEC-12",
    changeNote: "First issue",
    ...over,
  });

  let mill: string;
  let flour: string;
  let bread: string;
  let store: string;
  let recipe: string;
  let spec: string;
  let label: string;
  let batch: string;

  const receiveHeld = async (code: string) => {
    const lot = (
      await ok(
        await as(ada).send("POST", "/stock/receipts", {
          itemId: flour,
          supplierId: mill,
          quantity: 100,
          unit: "kg",
          locationId: store,
          receivedOn: today,
          lotCode: code,
        }),
        201,
      )
    ).id as string;
    await ok(
      await as(ada).send("POST", `/stock/lots/${lot}/status`, {
        status: "quarantine",
        note: "Goods-in hold",
      }),
    );
    return lot;
  };
  const sampleLot = async (lot: string) =>
    ok(await as(ada).send("POST", "/testing/samples", { subject: "lot", lotId: lot, sampledOn: today }), 201);
  const report = (sample: any, values: Record<string, Record<string, unknown>>) =>
    as(ada).send("POST", `/testing/samples/${sample.id}/results`, {
      reportedOn: today,
      results: sample.results
        .filter((r: { name: string }) => values[r.name])
        .map((r: { id: string; name: string }) => ({ resultId: r.id, ...values[r.name] })),
    });
  const check = async (lot: string) => ok(await as(ada).get(`/stock/lots/${lot}/release-check`));
  const lotStatus = async (lot: string) => (await ok(await as(ada).get(`/stock/lots/${lot}`))).status;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    // Marcus is the second manager: specifications (four eyes) and stock (release exceptions).
    await grant("items", "read");
    await grant("specifications", "manage");
    await grant("stock", "manage");

    mill = (await ok(await as(ada).send("POST", "/suppliers", { name: "Exercise Mill" }), 201)).id;
    await ok(
      await as(ada).send("POST", `/suppliers/${mill}/approval`, {
        status: "approved",
        reviewDueOn: "2099-01-01",
      }),
    );
    flour = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "X32-FLR",
          name: "Exercise flour",
          type: "ingredient",
          unit: "kg",
          allergens: ["cereals_gluten"],
          suppliers: [{ supplierId: mill }],
        }),
        201,
      )
    ).id;
    bread = (
      await ok(
        await as(ada).send("POST", "/items", {
          code: "X32-BRD",
          name: "Exercise loaf",
          type: "finished",
          unit: "each",
          unitWeightG: 800,
          allergens: ["cereals_gluten"],
          shelfLifeDays: 5,
        }),
        201,
      )
    ).id;
    store = (await ok(await as(ada).send("POST", "/stock/locations", { name: "Exercise store" }), 201)).id;
    recipe = (
      await ok(
        await as(ada).send("POST", "/recipes", {
          code: "X32-R-BRD",
          name: "Exercise loaf",
          outputItemId: bread,
          draft: {
            yieldQuantity: 10,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 5, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
    await ok(await as(ada).send("POST", `/recipes/${recipe}/draft/approve`));
    label = (await ok(await as(ada).send("POST", "/labelling/labels", { recipeId: recipe }), 201)).id;
    batch = (
      await ok(
        await as(ada).send("POST", "/production/batches", {
          recipeId: recipe,
          plannedOn: "2099-02-01",
          batches: 1,
        }),
        201,
      )
    ).id;
  });

  afterAll(() => ctx.handle.close());

  it("approves the supplier's specification and sets the item's release rule", async () => {
    spec = (
      await ok(
        await as(ada).send("POST", "/specifications", {
          code: "X32-SPEC-FLR",
          title: "Exercise flour (Exercise Mill)",
          itemId: flour,
          supplierId: mill,
          draft: specDraft(),
        }),
        201,
      )
    ).id;
    // Four eyes: Ada drafted it, Marcus approves.
    await fails(await as(ada).send("POST", `/specifications/${spec}/draft/approve`), 403, "four_eyes");
    await ok(await as(marcus.cookie).send("POST", `/specifications/${spec}/draft/approve`));
    const rule = await ok(
      await as(ada).send("PUT", `/stock/release-rules/${flour}`, {
        requirePassingTest: true,
        requiredAnalytes: ["Salmonella"],
        requireApprovedSpecification: true,
        note: "Raw flour: positive release on Salmonella",
      }),
    );
    expect(rule.version).toBe(1);
  });

  it("keeps a lot awaiting its required result on hold", async () => {
    const lot = await receiveHeld("X32-LOT-1");
    await sampleLot(lot);
    const now = await check(lot);
    expect(now.ruleVersion).toBe(1);
    expect(blocking(now.checks)).toEqual(expect.arrayContaining(["tests_pending", "required_test"]));
    // The approved specification is met.
    expect(now.checks.find((c: { kind: string }) => c.kind === "specification").status).toBe("pass");
    await fails(
      await as(ada).send("POST", `/stock/lots/${lot}/status`, { status: "available", note: "Release" }),
      409,
      "release_blocked",
    );
    expect(await lotStatus(lot)).toBe("quarantine");
  });

  it("raises an investigation and contains the lot on a failed result, then releases on the evidence", async () => {
    const lot = await receiveHeld("X32-LOT-2");
    // Before any sample the required test is unmet, so it can't be released.
    await fails(
      await as(ada).send("POST", `/stock/lots/${lot}/status`, { status: "available", note: "x" }),
      409,
      "release_blocked",
    );
    const first = await sampleLot(lot);
    const failed = await ok(
      await report(first, { Moisture: { value: 14 }, Salmonella: { outcome: "fail" } }),
    );
    expect(failed).toMatchObject({
      outcome: "fail",
      investigationStatus: "open",
      lot: { status: "quarantine" },
    });
    expect(blocking((await check(lot)).checks)).toEqual(
      // While investigated the failure blocks as an open investigation (and the required test is unmet).
      expect.arrayContaining(["investigation_open", "required_test"]),
    );
    // Close the investigation and retest: only then is the failure resolved.
    await ok(
      await as(ada).send("POST", `/testing/samples/${first.id}/investigation/close`, {
        findings: "Swab contamination at sampling",
        actionTaken: "Resampled under aseptic technique",
      }),
    );
    expect(blocking((await check(lot)).checks)).toContain("test_failed");
    const retest = await sampleLot(lot);
    await ok(await report(retest, { Moisture: { value: 14 }, Salmonella: { outcome: "pass" } }));
    const ready = await check(lot);
    expect(ready.blocked).toBe(false);

    // The authorised release records the evidence and the rule version it was made under.
    await ok(
      await as(ada).send("POST", `/stock/lots/${lot}/status`, {
        status: "available",
        note: "Retest clear; released",
      }),
    );
    const { releases } = await ok(await as(ada).get(`/stock/lots/${lot}/releases`));
    expect(releases[0]).toMatchObject({
      fromStatus: "quarantine",
      ruleVersion: 1,
      rule: { version: 1, requiredAnalytes: ["Salmonella"] },
      exception: false,
    });
    const recorded = Object.fromEntries(
      releases[0].checks.map((c: { kind: string; status: string }) => [c.kind, c.status]),
    );
    expect(recorded).toMatchObject({ required_test: "pass", specification: "pass", test_failed: "pass" });
    expect(
      releases[0].checks
        .find((c: { kind: string }) => c.kind === "required_test")
        .refs.map((r: any) => r.label),
    ).toContain(retest.reference);
  });

  it("releases by exception only when a second manager approves, recording both and the rule version", async () => {
    const lot = await receiveHeld("X32-LOT-3");
    await sampleLot(lot);
    const path = `/stock/lots/${lot}/release-exceptions`;
    const { requests } = await ok(
      await as(ada).send("POST", path, {
        note: "Positive release agreed",
        reason: "Customer accepted positive release pending Salmonella",
        evidence: "Customer email ref CX-88; supplier CoA clear",
      }),
      201,
    );
    await fails(await as(ada).send("POST", `${path}/${requests[0].id}/approve`, {}), 403, "four_eyes");
    expect(await lotStatus(lot)).toBe("quarantine");
    await ok(await as(marcus.cookie).send("POST", `${path}/${requests[0].id}/approve`, {}));
    expect(await lotStatus(lot)).toBe("available");
    const { releases } = await ok(await as(ada).get(`/stock/lots/${lot}/releases`));
    expect(releases[0]).toMatchObject({
      exception: true,
      ruleVersion: 1,
      exceptionReason: "Customer accepted positive release pending Salmonella",
      exceptionEvidence: "Customer email ref CX-88; supplier CoA clear",
      exceptionSelfApproved: false,
    });
    expect(releases[0].exceptionRequestedByName).toBeTruthy();
    expect(releases[0].releasedByName).not.toBe(releases[0].exceptionRequestedByName);
    expect(blocking(releases[0].checks)).toEqual(expect.arrayContaining(["tests_pending", "required_test"]));
  });

  it("shows which recipes, labels and open production a specification change affects", async () => {
    const revised = await ok(
      await as(ada).send(
        "PUT",
        `/specifications/${spec}/draft`,
        specDraft({ mayContain: ["sesame"], changeNote: "Mill now handles sesame on the same line" }),
      ),
    );
    expect(revised.draftChanges).toMatchObject({ addedAllergens: ["sesame"], impacting: true });
    const impact = await ok(await as(ada).get(`/specifications/${spec}/impact`));
    expect(impact.recipes.map((r: { id: string; relation: string }) => [r.id, r.relation])).toEqual([
      [recipe, "ingredient"],
    ]);
    expect(impact.labels.map((l: { id: string }) => l.id)).toEqual([label]);
    expect(impact.batches.map((b: { id: string }) => b.id)).toEqual([batch]);
    expect(impact.hidden).toEqual([]);
    expect(impact.changes.addedAllergens).toEqual(["sesame"]);
  });
});
