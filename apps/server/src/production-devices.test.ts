import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { beforeAll, describe, expect, it } from "vitest";
import { addHaccpAsset, makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

describe("device adapters (3.5.4)", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Res, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const code = async (res: Res, status: number) => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };

  let asset: string;
  let scale: string;
  let run: string;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const readings = async (json: object) =>
    ok(await call("POST", `/production/devices/${scale}/readings`, json));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    for (const module of ["recipes", "items", "food_items"])
      await ok(await call("PUT", `/members/${m.userId}/module-access/${module}`, { level: "read" }));
    await ok(await call("PUT", `/members/${m.userId}/module-access/labels`, { level: "write" }));
    const item = async (body: object) => (await ok(await call("POST", "/items", body), 201)).id as string;
    const flour = await item({ code: "DV-FLR", name: "Flour", type: "ingredient", unit: "kg" });
    const loaf = await item({ code: "DV-LOAF", name: "Loaf 400 g", type: "finished", unit: "each" });
    const recipe = (
      await ok(
        await call("POST", "/recipes", {
          code: "R-DV",
          name: "Loaf",
          outputItemId: loaf,
          draft: {
            yieldQuantity: 10,
            yieldUnit: "each",
            lines: [{ itemId: flour, quantity: 4, unit: "kg" }],
          },
        }),
        201,
      )
    ).id;
    await ok(await call("POST", `/recipes/${recipe}/draft/approve`));
    const label = (
      await ok(
        await call("POST", "/labelling/labels", { recipeId: recipe, includeNutrition: false }, marcus),
        201,
      )
    ).id;
    await ok(await call("POST", `/labelling/labels/${label}/approve`));
    const batch = (
      await ok(
        await call("POST", "/production/batches", {
          recipeId: recipe,
          plannedOn: today,
          batches: 1,
          batchCode: "DV-1",
        }),
        201,
      )
    ).id;
    await ok(await call("POST", `/production/batches/${batch}/start`));
    run = (
      await ok(
        await call("POST", `/production/batches/${batch}/packing`, {
          labelId: label,
          expectedDateCode: "BB 30 NOV 2026",
          nominalQuantity: 400,
        }),
        201,
      )
    ).open.id;
    asset = (
      await addHaccpAsset(call, {
        kind: "equipment",
        code: "SCALE-1",
        name: "Pack scale 1",
        calibrationFrequency: { every: 1, unit: "month" },
        calibrationTolerance: 1,
        measurementUnit: "g",
      })
    ).id;
  });

  it("registers devices with an identity and unit, and their calibration state from HACCP equipment", async () => {
    expect(
      await code(
        await call("POST", "/production/devices", { code: "SC-1", name: "Pack scale", kind: "scale" }),
        400,
      ),
    ).toBeTruthy();
    const created = await ok(
      await call("POST", "/production/devices", {
        code: "SC-1",
        name: "Pack scale",
        kind: "scale",
        unit: "kg",
        haccpAssetId: asset,
      }),
      201,
    );
    scale = created.id;
    expect(created.calibration.state).toBe("unknown");
    expect(
      await code(
        await call("POST", "/production/devices", { code: "sc-1", name: "Twin", kind: "scale", unit: "g" }),
        409,
      ),
    ).toBe("code_taken");
    // Registering devices is configuration: manage only.
    expect(
      await code(
        await call(
          "POST",
          "/production/devices",
          { code: "SC-2", name: "Other", kind: "scale", unit: "g" },
          marcus,
        ),
        403,
      ),
    ).toBeTruthy();
    await ok(
      await call("POST", "/haccp/calibration", {
        assetId: asset,
        referenceReading: 500,
        actualReading: 500.4,
        method: "Certified 500 g mass",
        nextDueOn: addDays(today, 30),
      }),
      201,
    );
    const { devices } = await ok(await call("GET", "/production/devices"));
    expect(devices.find((d: { id: string }) => d.id === scale).calibration).toMatchObject({
      state: "in_date",
      nextDueOn: addDays(today, 30),
    });
  });

  it("keeps HACCP equipment and calibration dates to HACCP readers", async () => {
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    for (const module of ["stock", "demand"])
      await ok(await call("PUT", `/members/${m.userId}/module-access/${module}`, { level: "read" }));
    await ok(await call("PUT", `/members/${m.userId}/module-access/production`, { level: "manage" }));
    await ok(await call("PUT", `/members/${m.userId}/module-access/haccp`, { level: "none" }));
    const seen = await ok(await call("GET", "/production/devices", undefined, marcus));
    expect(seen.devices.find((d: { id: string }) => d.id === scale)).toMatchObject({
      haccpAssetId: null,
      linkedToEquipment: true,
      calibration: { state: "in_date", lastCalibratedAt: null, nextDueOn: null },
    });
    expect(
      await code(
        await call(
          "POST",
          "/production/devices",
          { code: "SC-M", name: "Marcus's scale", kind: "scale", unit: "g", haccpAssetId: asset },
          marcus,
        ),
        403,
      ),
    ).toBe("haccp_access_required");
    // An area reads as not found, without its name; a scale can't read in °C.
    const area = (await addHaccpAsset(call, { kind: "area", name: "Secret cold room" })).id;
    const refused = await call("POST", "/production/devices", {
      code: "SC-A",
      name: "Area scale",
      kind: "scale",
      unit: "g",
      haccpAssetId: area,
    });
    expect(refused.status).toBe(404);
    expect(JSON.stringify(await refused.json())).not.toContain("Secret cold room");
    expect(
      await code(
        await call("POST", "/production/devices", { code: "SC-T", name: "Odd", kind: "scale", unit: "°C" }),
        400,
      ),
    ).toBeTruthy();
  });

  it("takes buffered readings once, converting units and refusing conflicts, bad units and future times", async () => {
    const at = new Date().toISOString();
    const first = await readings({
      readings: [
        { readingId: "1001", takenAt: at, value: 0.402, unit: "kg" },
        { readingId: "1002", takenAt: at, value: 405, unit: "g" },
        { readingId: "1003", takenAt: at, value: 0.399, unit: "kg" },
        { readingId: "1004", takenAt: at, value: 0.401, unit: "kg" },
        { readingId: "1005", takenAt: at, value: 0.404, unit: "kg" },
        // Buffered while the gateway was offline: two hours old, so late.
        { readingId: "0990", takenAt: ago(120), value: 0.403, unit: "kg" },
        { readingId: "1006", takenAt: at, value: 4, unit: "°C" },
        {
          readingId: "1007",
          takenAt: new Date(Date.now() + 3_600_000).toISOString(),
          value: 0.4,
          unit: "kg",
        },
        { readingId: "1001", takenAt: at, value: 0.402, unit: "kg" },
      ],
    });
    expect(first).toMatchObject({
      accepted: 6,
      duplicate: 1,
      conflict: 0,
      rejected: 2,
      late: 1,
      calibrationState: "in_date",
    });
    expect(first.results.find((r: { readingId: string }) => r.readingId === "1006").reason).toContain(
      "doesn't convert",
    );
    expect(first.results.find((r: { readingId: string }) => r.readingId === "1007").reason).toContain(
      "future",
    );

    // The gateway resends after a lost response: everything is a duplicate; a changed value conflicts.
    const again = await readings({
      readings: [
        { readingId: "1001", takenAt: at, value: 0.402, unit: "kg" },
        { readingId: "1002", takenAt: at, value: 0.999, unit: "kg" },
      ],
    });
    expect(again).toMatchObject({ accepted: 0, duplicate: 1, conflict: 1 });

    // More than 6 decimals: stored rounded, and an exact resend is still a duplicate.
    const precise = { readingId: "1008", takenAt: at, value: 0.4001234567, unit: "kg" };
    expect((await readings({ readings: [precise] })).accepted).toBe(1);
    expect((await readings({ readings: [precise] })).duplicate).toBe(1);

    const list = await ok(await call("GET", `/production/devices/${scale}/readings?unused=true`));
    const g1002 = list.readings.find((r: { readingId: string }) => r.readingId === "1002");
    expect(g1002).toMatchObject({ value: 0.405, sentValue: 405, sentUnit: "g", calibrationState: "in_date" });
  });

  it("turns in-date readings into a weight sample once, and never readings from before the run", async () => {
    // Taken two days ago, before the scale was calibrated: stamped with the state then, not now.
    const old = await readings({
      readings: [{ readingId: "0500", takenAt: ago(2 * 24 * 60), value: 0.4, unit: "kg" }],
    });
    expect(old).toMatchObject({ accepted: 1, late: 1, calibrationState: "in_date" });
    const oldRow = (
      await ok(await call("GET", `/production/devices/${scale}/readings?unused=true`))
    ).readings.find((r: { readingId: string }) => r.readingId === "0500");
    expect(oldRow.calibrationState).toBe("unknown");
    expect(
      await code(
        await call("POST", `/production/packing/${run}/checks/weight-from-device`, {
          deviceId: scale,
          readingIds: [old.results[0].id],
        }),
        409,
      ),
    ).toBe("device_calibration");

    const list = await ok(await call("GET", `/production/devices/${scale}/readings?unused=true`));
    const byId = new Map(list.readings.map((r: { readingId: string; id: string }) => [r.readingId, r.id]));
    const ids = ["1001", "1002", "1003", "1004", "1005"].map((r) => byId.get(r));
    expect(
      await code(
        await call("POST", `/production/packing/${run}/checks/weight-from-device`, {
          deviceId: scale,
          readingIds: [...ids, byId.get("0990")],
        }),
        409,
      ),
    ).toBe("device_calibration"); // 0990 was taken before the scale was first calibrated
    const done = await ok(
      await call("POST", `/production/packing/${run}/checks/weight-from-device`, {
        deviceId: scale,
        readingIds: ids,
      }),
      201,
    );
    const check = done.open.checks.at(-1);
    expect(check).toMatchObject({
      kind: "weight_sample",
      passed: true,
      details: { readings: [402, 405, 399, 401, 404], deviceCode: "SC-1", mean: 402.2 },
    });
    expect(
      await code(
        await call("POST", `/production/packing/${run}/checks/weight-from-device`, {
          deviceId: scale,
          readingIds: ids,
        }),
        409,
      ),
    ).toBe("reading_used");
  });

  it("stops using readings while calibration has failed, and refuses a retired device", async () => {
    await ok(
      await call("POST", "/haccp/calibration", {
        assetId: asset,
        referenceReading: 500,
        actualReading: 503,
        method: "Certified 500 g mass",
        nextDueOn: addDays(today, 30),
      }),
      201,
    );
    const failed = await readings({
      readings: [{ readingId: "2001", takenAt: ago(0), value: 0.4, unit: "kg" }],
    });
    expect(failed.calibrationState).toBe("failed");
    expect(
      await code(
        await call("POST", `/production/packing/${run}/checks/weight-from-device`, {
          deviceId: scale,
          readingIds: [failed.results[0].id],
        }),
        409,
      ),
    ).toBe("device_calibration");

    const detector = await ok(
      await call("POST", "/production/devices", { code: "MD-1", name: "Detector", kind: "metal_detector" }),
      201,
    );
    expect(
      await code(
        await call("POST", `/production/devices/${detector.id}/readings`, {
          readings: [{ readingId: "1", takenAt: ago(0), value: 1, unit: "g" }],
        }),
        409,
      ),
    ).toBe("device_not_measuring");
    await ok(await call("PATCH", `/production/devices/${scale}`, { status: "retired" }));
    expect(
      await code(
        await call("POST", `/production/devices/${scale}/readings`, {
          readings: [{ readingId: "3001", takenAt: ago(0), value: 0.4, unit: "kg" }],
        }),
        409,
      ),
    ).toBe("device_retired");
  });

  it("refuses unlinked devices, out-of-range values and readings that aren't pack weights", async () => {
    const plain = await ok(
      await call("POST", "/production/devices", {
        code: "SC-G",
        name: "Bench scale",
        kind: "scale",
        unit: "g",
      }),
      201,
    );
    const sent = await ok(
      await call("POST", `/production/devices/${plain.id}/readings`, {
        readings: [
          { readingId: "big", takenAt: ago(0), value: 1e9, unit: "kg" },
          { readingId: "ok", takenAt: ago(0), value: 401, unit: "g" },
        ],
      }),
    );
    // One bad reading never fails the batch.
    expect(sent).toMatchObject({ accepted: 1, rejected: 1 });
    expect(sent.results[0].reason).toBe("Out of range");
    expect(
      await code(
        await call("POST", `/production/packing/${run}/checks/weight-from-device`, {
          deviceId: plain.id,
          readingIds: [sent.results[1].id],
        }),
        409,
      ),
    ).toBe("device_not_calibrated");
  });
});
