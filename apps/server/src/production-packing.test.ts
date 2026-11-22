import { DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
type Res = Awaited<ReturnType<TestCtx["req"]>>;

describe("packing checks (3.5.3)", () => {
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

  let recipe: string;
  let batch: string;
  let label: string;
  let draftLabel: string;
  let store: string;
  let runId: string;
  const check = (json: object, status = 201, cookie = ada) =>
    call("POST", `/production/packing/${runId}/checks`, json, cookie).then((r) => ok(r, status));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    for (const module of ["recipes", "stock", "demand", "items"])
      await ok(await call("PUT", `/members/${m.userId}/module-access/${module}`, { level: "read" }));
    await ok(await call("PUT", `/members/${m.userId}/module-access/production`, { level: "write" }));
    await ok(await call("PUT", `/members/${m.userId}/module-access/labels`, { level: "write" }));

    const item = async (body: object) => (await ok(await call("POST", "/items", body), 201)).id as string;
    const flour = await item({ code: "PK-FLR", name: "Flour", type: "ingredient", unit: "kg" });
    const biscuit = await item({ code: "PK-BIS", name: "Biscuits 250 g", type: "finished", unit: "each" });
    recipe = (
      await ok(
        await call("POST", "/recipes", {
          code: "R-PK-BIS",
          name: "Biscuits",
          outputItemId: biscuit,
          draft: {
            yieldQuantity: 10,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 2.5, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
    await ok(await call("POST", `/recipes/${recipe}/draft/approve`));
    // Drafted by one person, approved by another (four-eyes).
    label = (
      await ok(
        await call("POST", "/labelling/labels", { recipeId: recipe, includeNutrition: false }, marcus.cookie),
        201,
      )
    ).id;
    await ok(await call("POST", `/labelling/labels/${label}/approve`));
    draftLabel = (
      await ok(
        await call(
          "POST",
          "/labelling/labels",
          { recipeId: recipe, variant: "Retail", includeNutrition: false },
          marcus.cookie,
        ),
        201,
      )
    ).id;
    store = (await ok(await call("POST", "/stock/locations", { name: "PK finished" }), 201)).id;
    batch = (
      await ok(
        await call("POST", "/production/batches", {
          recipeId: recipe,
          plannedOn: today,
          batches: 2,
          batchCode: "PK-1",
          outputLocationId: store,
        }),
        201,
      )
    ).id;
  });

  it("opens a run only on a started batch, with the batch version's approved label", async () => {
    const open = { labelId: label, nominalQuantity: 250, expectedDateCode: "BB 24 NOV 2026" };
    expect(await code(await call("POST", `/production/batches/${batch}/packing`, open), 409)).toBe(
      "batch_not_running",
    );
    await ok(await call("POST", `/production/batches/${batch}/start`));
    const before = await ok(await call("GET", `/production/batches/${batch}/packing`));
    expect(before.candidates.labels.map((l: { id: string }) => l.id)).toEqual([label]);
    expect(before.candidates.defaultLotCode).toBe("PK-1");
    // The label must be approved.
    expect(
      await code(
        await call("POST", `/production/batches/${batch}/packing`, { ...open, labelId: draftLabel }),
        409,
      ),
    ).toBe("label_not_approved");
    // A packer without Labels access sees no label records, only that one approved label exists,
    // and opening without a label pins that one.
    await ok(await call("PUT", `/members/${marcus.userId}/module-access/labels`, { level: "none" }));
    const hidden = await ok(
      await call("GET", `/production/batches/${batch}/packing`, undefined, marcus.cookie),
    );
    expect(hidden.candidates).toMatchObject({ labels: [], labelsVisible: false, labelCount: 1 });
    const opened = await ok(
      await call("POST", `/production/batches/${batch}/packing`, { ...open, labelId: null }, marcus.cookie),
      201,
    );
    expect(opened.candidates.labels).toEqual([]);
    runId = opened.open.id;
    expect(opened.open).toMatchObject({
      expectedLotCode: "PK-1",
      labelSummary: { variant: "Standard", versionNumber: 1 },
      gaps: [
        "No line clearance recorded",
        "No first-off label and code check recorded",
        "No metal detector challenge recorded",
        "No weight sample recorded",
      ],
    });
    expect(await code(await call("POST", `/production/batches/${batch}/packing`, open), 409)).toBe(
      "packing_run_open",
    );
  });

  it("evaluates checks, requires an action on a failure, and keeps a failure open until a pass", async () => {
    await check({
      kind: "line_clearance",
      items: {
        previous_product_removed: true,
        previous_packaging_and_labels_removed: true,
        coders_and_printers_cleared: true,
        line_clean_and_ready: true,
      },
    });
    // A missing clearance item counts as not done: a failure, not a validation error.
    const partial = await check({
      kind: "line_clearance",
      items: { previous_product_removed: true },
      failureAction: "Line re-cleared",
    });
    expect(partial.open.checks.at(-1)).toMatchObject({ kind: "line_clearance", passed: false });
    expect(partial.open.checks.at(-1).reasons).toHaveLength(3);
    const cleared = await check({
      kind: "line_clearance",
      items: {
        previous_product_removed: true,
        previous_packaging_and_labels_removed: true,
        coders_and_printers_cleared: true,
        line_clean_and_ready: true,
      },
    });
    expect(cleared.open.gaps).not.toContain("The last line clearance failed and no passing one has followed");
    // A challenge must use every test piece.
    expect(
      await code(
        await call("POST", `/production/packing/${runId}/checks`, {
          kind: "detector_challenge",
          detector: "MD-1",
          pieces: [{ piece: "ferrous", sizeMm: 2, rejected: true }],
        }),
        400,
      ),
    ).toBeTruthy();
    const wrongCode = {
      kind: "first_off",
      labelCorrect: true,
      dateCodeSeen: "BB 23 NOV 2026",
      lotCodeSeen: "PK-1",
      legible: true,
    };
    expect(await code(await call("POST", `/production/packing/${runId}/checks`, wrongCode), 400)).toBe(
      "failure_action_required",
    );
    const failed = await check({ ...wrongCode, failureAction: "Coder reset; 40 packs held and relabelled" });
    const firstOff = failed.open.checks.at(-1);
    expect(firstOff).toMatchObject({
      passed: false,
      reasons: ['Date code reads "BB 23 NOV 2026", expected "BB 24 NOV 2026"'],
    });
    expect(failed.open.gaps).toContain(
      "The last first-off label and code check failed and no passing one has followed",
    );
    // Codes compare without case or spacing differences.
    await check({ ...wrongCode, dateCodeSeen: "bb 24nov 2026" }, 201, marcus.cookie);

    const missed = await check({
      kind: "detector_challenge",
      detector: "MD-1",
      pieces: [
        { piece: "ferrous", sizeMm: 2, rejected: true },
        { piece: "non_ferrous", sizeMm: 2.5, rejected: true },
        { piece: "stainless_steel", sizeMm: 3, rejected: false },
      ],
      failureAction: "Detector recalibrated; product since the last good check held",
    });
    expect(missed.open.checks.at(-1).reasons).toEqual(["Stainless steel 3 mm test piece was not rejected"]);
    await check({
      kind: "detector_challenge",
      detector: "MD-1",
      pieces: [
        { piece: "ferrous", sizeMm: 2, rejected: true },
        { piece: "non_ferrous", sizeMm: 2.5, rejected: true },
        { piece: "stainless_steel", sizeMm: 3, rejected: true },
      ],
    });

    // 250 g nominal: TNE 9 g, so 232 g is below twice the TNE.
    const light = await check({
      kind: "weight_sample",
      readings: [251, 252, 230, 253, 254],
      failureAction: "Filler adjusted",
    });
    expect(light.open.checks.at(-1)).toMatchObject({ passed: false, details: { tne: 9, belowT2: 1 } });
    const good = await check({ kind: "weight_sample", readings: [252, 251, 249, 253, 250] });
    expect(good.open.checks.at(-1)).toMatchObject({ passed: true, details: { mean: 251, belowT1: 0 } });
    expect(good.open.gaps).toEqual([]);

    // Voiding the passing weight sample re-opens the earlier failure.
    const voided = await ok(
      await call("POST", `/production/packing/checks/${good.open.checks.at(-1).id}/void`, {
        reason: "Wrong line",
      }),
    );
    expect(voided.open.gaps).toEqual(["The last weight sample failed and no passing one has followed"]);
    await check({ kind: "weight_sample", readings: [252, 251, 249, 253, 250] });
  });

  it("closes with packaging reconciled, then never changes, and traces a lot to its label", async () => {
    await ok(await call("POST", `/production/batches/${batch}/output`, { quantity: 20, unit: "each" }), 201);
    // Nothing to reconcile, or no printed material with a label pinned, is refused.
    expect(
      await code(
        await call("POST", `/production/packing/${runId}/close`, { packsProduced: 20, reconciliation: [] }),
        400,
      ),
    ).toBeTruthy();
    expect(
      await code(
        await call("POST", `/production/packing/${runId}/close`, {
          packsProduced: 20,
          reconciliation: [{ material: "Outer cases", issued: 2, used: 2, wasted: 0, returned: 0 }],
        }),
        400,
      ),
    ).toBe("printed_packaging_required");
    const close = {
      packsProduced: 20,
      reconciliation: [
        { material: "Printed film", printed: true, issued: 1000, used: 950, wasted: 30, returned: 10 },
        { material: "Outer cases", issued: 5, used: 2, wasted: 0, returned: 3 },
      ],
    };
    expect(await code(await call("POST", `/production/packing/${runId}/close`, close), 400)).toBe(
      "variance_reason_required",
    );
    const closed = await ok(
      await call("POST", `/production/packing/${runId}/close`, {
        ...close,
        commandId: randomUUID(),
        varianceReason: "10 labels lost in a splice; counted at the reel end",
      }),
    );
    expect(closed.open).toBeNull();
    expect(closed.runs[0]).toMatchObject({ status: "closed", packsProduced: 20 });
    expect(closed.runs[0].reconciliation[0].variance).toBe(10);
    expect(
      await code(
        await call("POST", `/production/packing/${runId}/checks`, { kind: "weight_sample", readings: [250] }),
        409,
      ),
    ).toBe("packing_run_closed");

    const detail = await ok(await call("GET", `/production/batches/${batch}`));
    const lotId =
      detail.producedLots?.[0]?.lotId ??
      detail.producedLots?.[0]?.id ??
      detail.records?.find((r: { kind: string }) => r.kind === "output")?.lotId;
    expect(lotId).toBeTruthy();
    const trace = await ok(await call("GET", `/production/lots/${lotId}/packing`));
    expect(trace.batches).toHaveLength(1);
    expect(trace.batches[0]).toMatchObject({ batchCode: "PK-1", unrecorded: false });
    expect(trace.batches[0].packingRuns[0]).toMatchObject({
      status: "closed",
      expectedDateCode: "BB 24 NOV 2026",
      label: { variant: "Standard", versionNumber: 1, recipeId: recipe },
    });
  });

  it("refuses checks the run can't take, and cancelling a batch that is being packed", async () => {
    const second = (
      await ok(
        await call("POST", "/production/batches", {
          recipeId: recipe,
          plannedOn: today,
          batches: 1,
          batchCode: "PK-2",
        }),
        201,
      )
    ).id;
    await ok(await call("POST", `/production/batches/${second}/start`));
    const opened = await ok(
      await call("POST", `/production/batches/${second}/packing`, {
        labelId: label,
        expectedDateCode: "BB 25 NOV 2026",
        detectorRequired: false,
      }),
      201,
    );
    const run = opened.open.id;
    expect(opened.open.gaps).toEqual([
      "No line clearance recorded",
      "No first-off label and code check recorded",
    ]);
    expect(
      await code(
        await call("POST", `/production/packing/${run}/checks`, {
          kind: "weight_sample",
          readings: [250],
          failureAction: "x",
        }),
        409,
      ),
    ).toBe("no_nominal_quantity");
    expect(
      await code(
        await call("POST", `/production/packing/${run}/checks`, {
          kind: "detector_challenge",
          detector: "MD-1",
          pieces: [
            { piece: "ferrous", sizeMm: 2, rejected: true },
            { piece: "non_ferrous", sizeMm: 2.5, rejected: true },
            { piece: "stainless_steel", sizeMm: 3, rejected: true },
          ],
        }),
        409,
      ),
    ).toBe("no_detector");
    expect(
      await code(await call("POST", `/production/batches/${second}/cancel`, { reason: "Wrong recipe" }), 409),
    ).toBe("packing_run_open");
  });
});
