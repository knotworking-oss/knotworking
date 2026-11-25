import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addHaccpAsset, makeApp, signIn, type TestCtx } from "./test-utils";

/**
 * The site module's later additions: four-eyes on releases, glass register import, pest trends,
 * work orders, the calibration instrument link, other storage measures and the allergen risk of a
 * changeover. The first file (`site.test.ts`) covers the programmes themselves.
 */

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const DEPENDENCIES = ["assets", "items", "recipes", "stock", "demand", "production", "haccp"] as const;

describe("site programmes: later additions", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let agentToken: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (token: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const error = async (res: Awaited<ReturnType<TestCtx["req"]>>, status: number) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body.error.code as string;
  };

  let packing: string;
  let dispatch: string;
  let milkBatch: string;
  let plainBatch: string;
  let eggBatch: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    agentToken = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write" },
        })
      ).json()
    ).token as string;
    for (const id of DEPENDENCIES) await grant(id, "read");
    await grant("site", "write");

    const area = async (name: string, code?: string) =>
      (await addHaccpAsset(as(ada).send, { kind: "area", name, code })).id as string;
    packing = await area("Packing hall", "PK");
    dispatch = await area("Dispatch");

    const product = async (code: string, allergens: string[]) => {
      const veg = (
        await ok(
          await as(ada).send("POST", "/items", {
            code: `ING-${code}`,
            name: `Ingredient ${code}`,
            type: "ingredient",
            unit: "kg",
            allergens,
          }),
          201,
        )
      ).id;
      const out = (
        await ok(
          await as(ada).send("POST", "/items", {
            code,
            name: `Product ${code}`,
            type: "finished",
            unit: "l",
          }),
          201,
        )
      ).id;
      const recipe = await ok(
        await as(ada).send("POST", "/recipes", {
          code: `R-${code}`,
          name: `Recipe ${code}`,
          outputItemId: out,
          draft: { yieldQuantity: 10, yieldUnit: "l", lines: [{ itemId: veg, quantity: 5, unit: "kg" }] },
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/recipes/${recipe.id}/draft/approve`));
      return (
        await ok(
          await as(ada).send("POST", "/production/batches", {
            recipeId: recipe.id,
            plannedOn: today,
            batches: 1,
          }),
          201,
        )
      ).id as string;
    };
    milkBatch = await product("MILK", ["milk"]);
    eggBatch = await product("EGG", ["eggs"]);
    plainBatch = await product("PLAIN", []);
  }, 90_000);

  afterAll(async () => {
    await ctx.handle.close();
  });

  describe("four-eyes on a release", () => {
    it("refuses the person who reported or cleaned, until someone else with manage signs", async () => {
      await grant("site", "manage");
      const raised = await ok(
        await as(ada).send("POST", "/site/glass/breakages", {
          areaId: packing,
          description: "Diffuser cracked",
          quarantined: "Line 1 product",
          cleanDown: "Stripped and swabbed",
        }),
        201,
      );
      const release = (cookie: string) =>
        as(cookie).send("POST", `/site/glass/breakages/${raised.id}/release`, {});
      expect(await error(await release(ada), 403)).toBe("four_eyes");
      const released = await ok(await release(marcus.cookie));
      expect(released).toMatchObject({ status: "released", releasedBy: marcus.userId });
    });

    it("lets the only manager sign their own report off", async () => {
      await grant("site", "write");
      const raised = await ok(
        await as(ada).send("POST", "/site/glass/breakages", {
          areaId: packing,
          description: "Lamp broke",
          quarantined: "Nothing",
          cleanDown: "Swept",
        }),
        201,
      );
      await ok(await as(ada).send("POST", `/site/glass/breakages/${raised.id}/release`, {}));
    });

    it("applies the same rule to the hygiene clearance after maintenance", async () => {
      await grant("site", "manage");
      const asset = await ok(
        await as(ada).send("POST", "/assets", { kind: "equipment", name: "Oven", parentAreaId: packing }),
        201,
      );
      const task = await ok(
        await as(ada).send("POST", "/site/maintenance/tasks", {
          assetId: asset.id,
          title: "Seals",
          frequency: { every: 1, unit: "month" },
          clearanceRequired: true,
        }),
        201,
      );
      const record = await ok(
        await as(ada).send("POST", "/site/maintenance/records", { taskId: task.id, workDone: "Seals" }),
        201,
      );
      const clear = (cookie: string) =>
        as(cookie).send("POST", `/site/maintenance/records/${record.id}/clearance`, {});
      expect(await error(await clear(ada), 403)).toBe("four_eyes");
      expect(await ok(await clear(marcus.cookie))).toMatchObject({ awaitingClearance: false });
      await grant("site", "write");
    });
  });

  describe("glass register import", () => {
    const csv = [
      "area,description,kind,quantity,location,check frequency",
      "Packing hall,Window east wall,glass,2,East wall,monthly",
      "PK,Light diffuser,brittle plastic,6,Ceiling,every 3 months",
      "Dispatch,Mirror,glass,1,,weekly",
    ].join("\r\n");
    const run = (body: unknown, token = false) =>
      token
        ? viaToken(agentToken, "POST", "/site/glass/items/import", body)
        : as(ada).send("POST", "/site/glass/items/import", body);

    it("checks first, then imports, and a second import changes nothing", async () => {
      const preview = await ok(await run({ csv, dryRun: true }));
      expect(preview).toMatchObject({ dryRun: true, created: 3, updated: 0 });
      expect((await ok(await as(ada).get("/site/glass/items"))).items).toHaveLength(0);

      const done = await ok(await run({ csv, fileName: "glass.csv" }), 201);
      expect(done).toMatchObject({ dryRun: false, created: 3, updated: 0 });
      const { items } = await ok(await as(ada).get("/site/glass/items"));
      expect(items).toHaveLength(3);
      expect(items.find((i: { description: string }) => i.description === "Light diffuser")).toMatchObject({
        kind: "brittle_plastic",
        quantity: 6,
        area: { name: "Packing hall" },
        checkFrequency: { every: 3, unit: "month" },
      });

      const again = await ok(await run({ csv }), 201);
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    });

    it("updates a matching item and refuses unknown areas without writing anything", async () => {
      const changed = csv.replace("glass,2,East wall", "glass,4,East wall");
      const res = await ok(await run({ csv: changed }, true), 201);
      expect(res).toMatchObject({ created: 0, updated: 1 });
      expect(res.changes[0]).toMatchObject({ action: "update", fields: ["quantity"] });

      const bad = `${csv}\r\nNowhere,Window,glass,1,,monthly\r\nPacking hall,New lamp,glass,1,,monthly`;
      expect(await error(await run({ csv: bad }), 400)).toBe("invalid_rows");
      const list = (await ok(await as(ada).get("/site/glass/items"))).items;
      expect(list).toHaveLength(3);
      const dry = await ok(await run({ csv: bad, dryRun: true }));
      expect(dry.errors).toEqual([expect.objectContaining({ row: 5, column: "area" })]);
    });

    it("can mark an item removed, and needs write access", async () => {
      const removed = csv
        .replace("monthly\r\nPK", "monthly,removed\r\nPK")
        .replace("check frequency", "check frequency,status");
      expect(await ok(await run({ csv: removed }), 201)).toMatchObject({ updated: 1 });
      expect((await ok(await as(ada).get("/site/glass/items"))).items).toHaveLength(2);
      await grant("site", "read");
      expect((await run({ csv })).status).toBe(201);
      expect(
        (await as(marcus.cookie).send("POST", "/site/glass/items/import", { csv, dryRun: true })).status,
      ).toBe(403);
      await grant("site", "write");
    });
  });

  describe("pest trends", () => {
    it("charts sightings over time per device, area and pest, leaving out corrected visits", async () => {
      const dev = async (code: string, areaId: string | null) =>
        (
          await ok(
            await as(ada).send("POST", "/site/pest/devices", {
              kind: "rodent_bait_station",
              code,
              location: `Near ${code}`,
              areaId,
            }),
            201,
          )
        ).id as string;
      const d1 = await dev("RB-01", packing);
      const d2 = await dev("RB-02", null);
      const visit = (visitedOn: string, findings: unknown[]) =>
        as(ada).send("POST", "/site/pest/visits", {
          contractor: "Pest Co",
          visitedOn,
          nextVisitOn: null,
          findings,
        });
      const first = await ok(
        await visit(addDays(today, -60), [
          { deviceId: d1, activity: "none" },
          { deviceId: d2, activity: "low", pest: "mice", count: 1 },
        ]),
        201,
      );
      await ok(
        await visit(addDays(today, -30), [
          { deviceId: d1, activity: "low", pest: "mice", count: 2 },
          { deviceId: d2, activity: "none" },
        ]),
        201,
      );
      await ok(
        await visit(addDays(today, -1), [{ deviceId: d1, activity: "high", pest: "rats", count: 5 }]),
        201,
      );
      // A correction replaces the first visit: only the corrected findings count.
      await ok(
        await as(ada).send("POST", `/site/pest/visits/${first.id}/correct`, {
          reason: "Wrong device",
          contractor: "Pest Co",
          visitedOn: addDays(today, -60),
          nextVisitOn: null,
          findings: [
            { deviceId: d1, activity: "none" },
            { deviceId: d2, activity: "none" },
          ],
        }),
        201,
      );

      const byDevice = await ok(await as(ada).get("/site/pest/trends"));
      expect(byDevice).toMatchObject({ groupBy: "device", visits: 3 });
      expect(byDevice.series.map((s: { label: string }) => s.label)).toEqual(["RB-01", "RB-02"]);
      expect(byDevice.series[0]).toMatchObject({ sightings: 7, highest: "high", direction: "up" });
      expect(byDevice.series[1].points.map((p: { sightings: number }) => p.sightings)).toEqual([0, 0]);

      const byArea = await ok(await as(ada).get("/site/pest/trends?groupBy=area"));
      expect(byArea.series.map((s: { label: string }) => s.label)).toEqual(["Packing hall", "No area"]);
      const byPest = await ok(await as(ada).get("/site/pest/trends?groupBy=pest"));
      expect(byPest.series.map((s: { label: string; sightings: number }) => [s.label, s.sightings])).toEqual([
        ["rats", 5],
        ["mice", 2],
      ]);
      const recent = await ok(await as(ada).get(`/site/pest/trends?from=${addDays(today, -10)}`));
      expect(recent.visits).toBe(1);
      expect((await viaToken(agentToken, "GET", "/site/pest/trends")).status).toBe(200);
    });
  });

  describe("work orders", () => {
    let asset: string;
    let task: string;
    let order: string;

    it("raises a breakdown (an agent may) and starts it", async () => {
      asset = (
        await ok(
          await as(ada).send("POST", "/assets", {
            kind: "equipment",
            code: "MX-1",
            name: "Mixer",
            parentAreaId: packing,
          }),
          201,
        )
      ).id;
      task = (
        await ok(
          await as(ada).send("POST", "/site/maintenance/tasks", {
            assetId: asset,
            title: "Grease",
            frequency: { every: 1, unit: "month" },
          }),
          201,
        )
      ).id;
      const raised = await ok(
        await viaToken(agentToken, "POST", "/site/maintenance/work-orders", {
          assetId: asset,
          title: "Mixer seized",
          priority: "urgent",
          stopsProduction: true,
        }),
        201,
      );
      order = raised.id;
      expect(raised).toMatchObject({
        kind: "breakdown",
        status: "requested",
        source: "api",
        priority: "urgent",
        stopsProduction: true,
        area: { name: "Packing hall" },
        asset: { name: "Mixer" },
        isOpen: true,
        totalCost: null,
      });
      await ok(
        await as(ada).send("POST", "/site/maintenance/work-orders", {
          assetId: asset,
          title: "Fit a guard",
          kind: "request",
          priority: "low",
          taskId: task,
        }),
        201,
      );
      expect(
        await error(
          await as(ada).send("POST", "/site/maintenance/work-orders", {
            assetId: asset,
            title: "x",
            taskId: "0190a1a0-0000-7000-8000-000000000009",
          }),
          404,
        ),
      ).toBe("not_found");
      const started = await ok(
        await as(ada).send("PATCH", `/site/maintenance/work-orders/${order}`, {
          status: "in_progress",
          assignedTo: marcus.userId,
          sparesUsed: "Drive belt",
          partsCost: 12.5,
        }),
      );
      expect(started).toMatchObject({
        status: "in_progress",
        startedAt: expect.any(String),
        assignedToName: expect.any(String),
        totalCost: 12.5,
      });
      const { workOrders } = await ok(await as(ada).get("/site/maintenance/work-orders"));
      expect(workOrders.map((w: { title: string }) => w.title)).toEqual(["Mixer seized", "Fit a guard"]);
      expect((await ok(await as(ada).get("/site/due"))).counts.openWorkOrders).toBe(2);
    });

    it("is completed by a person with spares and costs, once", async () => {
      expect(
        await error(
          await viaToken(agentToken, "POST", `/site/maintenance/work-orders/${order}/complete`, {
            workDone: "Fixed",
          }),
          403,
        ),
      ).toBe("token_not_allowed");
      expect(
        await error(await as(ada).send("POST", `/site/maintenance/work-orders/${order}/complete`, {}), 400),
      ).toBe("invalid_input");
      const done = await ok(
        await as(marcus.cookie).send("POST", `/site/maintenance/work-orders/${order}/complete`, {
          workDone: "Replaced belt and bearing",
          labourCost: 40,
          contractorCost: 100.25,
          downtimeMinutes: 90,
        }),
      );
      expect(done).toMatchObject({
        status: "completed",
        isOpen: false,
        sparesUsed: "Drive belt",
        partsCost: 12.5,
        totalCost: 152.75,
        downtimeMinutes: 90,
        completedByName: expect.any(String),
      });
      expect(
        await error(
          await as(ada).send("PATCH", `/site/maintenance/work-orders/${order}`, { title: "later" }),
          409,
        ),
      ).toBe("work_order_closed");
      expect(
        await error(
          await as(ada).send("POST", `/site/maintenance/work-orders/${order}/cancel`, { reason: "x" }),
          409,
        ),
      ).toBe("work_order_closed");
      expect((await ok(await as(ada).get("/site/due"))).counts.openWorkOrders).toBe(1);
    });

    it("can be cancelled with a reason, and is filtered by status", async () => {
      const open = (await ok(await as(ada).get("/site/maintenance/work-orders"))).workOrders[0];
      expect(
        await error(await as(ada).send("POST", `/site/maintenance/work-orders/${open.id}/cancel`, {}), 400),
      ).toBe("invalid_input");
      const cancelled = await ok(
        await as(ada).send("POST", `/site/maintenance/work-orders/${open.id}/cancel`, {
          reason: "Not needed",
        }),
      );
      expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Not needed" });
      expect((await ok(await as(ada).get("/site/maintenance/work-orders?status=cancelled"))).total).toBe(1);
      expect((await ok(await as(ada).get("/site/maintenance/work-orders?status=all"))).total).toBe(2);
      expect((await ok(await as(ada).get("/site/maintenance/work-orders"))).total).toBe(0);
    });

    it("refuses a task of another asset and an archived asset", async () => {
      const other = (
        await ok(await as(ada).send("POST", "/assets", { kind: "equipment", name: "Slicer" }), 201)
      ).id;
      expect(
        await error(
          await as(ada).send("POST", "/site/maintenance/work-orders", {
            assetId: other,
            title: "x",
            taskId: task,
          }),
          400,
        ),
      ).toBe("invalid_input");
      await ok(await as(ada).send("POST", `/assets/${other}/archive`, {}));
      expect(
        await error(
          await as(ada).send("POST", "/site/maintenance/work-orders", { assetId: other, title: "x" }),
          409,
        ),
      ).toBe("asset_archived");
    });
  });

  describe("calibration instrument link", () => {
    it("links an asset to an instrument of the HACCP register, read-only", async () => {
      const probe = (
        await addHaccpAsset(as(ada).send, {
          kind: "equipment",
          code: "PRB-01",
          name: "Probe 1",
          calibrationFrequency: { every: 1, unit: "month" },
          calibrationTolerance: 0.5,
          measurementUnit: "°C",
        })
      ).id as string;
      const plain = (await addHaccpAsset(as(ada).send, { kind: "equipment", name: "Scoop" })).id as string;
      const { instruments } = await ok(await as(ada).get("/site/calibration-instruments"));
      expect(instruments).toEqual([
        expect.objectContaining({ id: probe, name: "Probe 1", state: "due", linkedAssetId: null }),
      ]);

      // The asset is the register's; Site only links it to the instrument it is.
      const newAsset = async (name: string) =>
        (await ok(await as(ada).send("POST", "/assets", { kind: "equipment", name }), 201)).id as string;
      const link = (id: string, calibrationInstrumentId: string | null) =>
        as(ada).send("PATCH", `/site/maintenance/assets/${id}`, { calibrationInstrumentId });
      const asset = await ok(await link(await newAsset("Probe thermometer"), probe));
      expect(asset.calibrationInstrument).toMatchObject({
        id: probe,
        name: "Probe 1",
        calibrationFrequencyText: "Monthly",
        lastCalibration: null,
        state: "due",
      });
      // Calibrating in HACCP shows up here without the site module writing to HACCP.
      await ok(
        await as(ada).send("POST", "/haccp/calibration", {
          assetId: probe,
          referenceReading: 100,
          actualReading: 100.2,
        }),
        201,
      );
      const { assets } = await ok(await as(ada).get("/site/maintenance/assets"));
      expect(assets.find((a: { id: string }) => a.id === asset.id).calibrationInstrument).toMatchObject({
        state: "ok",
        lastCalibration: { passed: true },
      });
      expect(
        (await ok(await as(ada).get("/site/calibration-instruments"))).instruments[0].linkedAssetId,
      ).toBe(asset.id);

      expect(await error(await link(await newAsset("Second"), probe), 409)).toBe("instrument_linked");
      expect(await error(await link(await newAsset("Third"), plain), 400)).toBe("invalid_input");
      expect(await error(await link(await newAsset("Fourth"), packing), 404)).toBe("not_found");
      // Unlinking leaves the HACCP record alone.
      const unlinked = await ok(await link(asset.id, null));
      expect(unlinked.calibrationInstrument).toBeNull();
    });
  });

  describe("storage measures", () => {
    it("monitors humidity with its own unit and limits, and keeps the measure fixed once read", async () => {
      const unit = await ok(
        await as(ada).send("POST", "/site/storage/units", {
          name: "Dry store humidity",
          kind: "ambient",
          measure: "humidity",
          limitMin: 40,
          limitMax: 65,
        }),
        201,
      );
      expect(unit).toMatchObject({ measure: "humidity", unit: "%RH", limitsText: "40 to 65 %RH" });
      const temp = await ok(
        await as(ada).send("POST", "/site/storage/units", { name: "Chiller", kind: "chiller", limitMax: 5 }),
        201,
      );
      expect(temp).toMatchObject({ measure: "temperature", unit: "°C" });

      expect(
        await error(
          await as(ada).send("POST", "/site/storage/units", {
            name: "Bad",
            kind: "ambient",
            measure: "humidity",
            limitMax: 120,
          }),
          400,
        ),
      ).toBe("invalid_input");
      expect(
        await error(
          await as(ada).send("POST", "/site/storage/units", {
            name: "Gas",
            kind: "other",
            measure: "other",
            limitMax: 3,
          }),
          400,
        ),
      ).toBe("invalid_input");

      const reading = await ok(
        await as(ada).send("POST", "/site/storage/readings", { unitId: unit.id, value: 72 }),
        201,
      );
      expect(reading).toMatchObject({ withinLimits: false, readingText: "72 %RH" });
      expect(
        await error(
          await as(ada).send("PATCH", `/site/storage/units/${unit.id}`, { measure: "temperature" }),
          409,
        ),
      ).toBe("measure_has_readings");
      // Without readings the measure may change, and takes the new measure's unit.
      const changed = await ok(
        await as(ada).send("PATCH", `/site/storage/units/${temp.id}`, { measure: "humidity", limitMax: 60 }),
      );
      expect(changed).toMatchObject({ measure: "humidity", unit: "%RH" });

      const { units } = await ok(await as(ada).get("/site/storage/units?measure=humidity"));
      expect(units).toHaveLength(2);
      expect((await ok(await as(ada).get("/site/storage/units?measure=pressure"))).units).toEqual([]);
    });
  });

  describe("allergen risk of a changeover", () => {
    let template: string;
    const results = async () => {
      const { items } = await ok(await as(ada).get(`/site/checklists/templates/${template}`));
      return items as { id: string }[];
    };

    it("works out the risk before a check is recorded", async () => {
      template = (
        await ok(
          await as(ada).send("POST", "/site/checklists/templates", {
            name: "Changeover line 1",
            kind: "allergen_changeover",
            areaId: dispatch,
            items: [{ prompt: "Line stripped and washed" }],
          }),
          201,
        )
      ).id;
      const risk = await ok(
        await as(ada).get(
          `/site/checklists/allergen-risk?previousBatchId=${milkBatch}&nextBatchId=${plainBatch}`,
        ),
      );
      expect(risk).toMatchObject({ status: "review", carriedOver: ["milk"], notDeclaredAfter: ["milk"] });
      expect(risk.warnings).toHaveLength(2);
      expect(
        (
          await ok(
            await as(ada).get(
              `/site/checklists/allergen-risk?previousBatchId=${plainBatch}&nextBatchId=${milkBatch}`,
            ),
          )
        ).status,
      ).toBe("none");
      expect(
        (await ok(await as(ada).get(`/site/checklists/allergen-risk?previousBatchId=${milkBatch}`))).status,
      ).toBe("unknown");
      expect(
        await error(
          await as(ada).get(
            "/site/checklists/allergen-risk?previousBatchId=0190a1a0-0000-7000-8000-000000000009",
          ),
          404,
        ),
      ).toBe("not_found");
    });

    it("carries the warning on a recorded check and never blocks recording or signing off", async () => {
      const items = await results();
      const check = await ok(
        await as(ada).send("POST", "/site/checklists/checks", {
          templateId: template,
          results: items.map((i) => ({ itemId: i.id, result: "pass" })),
          previousBatchId: milkBatch,
          nextBatchId: eggBatch,
        }),
        201,
      );
      expect(check.allergenRisk).toMatchObject({ status: "review", carriedOver: ["milk"] });
      expect(check.allergenRisk.previous.contains).toEqual(["milk"]);
      await ok(
        await as(ada).send("POST", `/site/checklists/checks/${check.id}/sign-off`, { decision: "approve" }),
      );
      expect((await ok(await as(ada).get(`/site/checklists/checks/${check.id}`))).signOffStatus).toBe(
        "approved",
      );

      const unnamed = await ok(
        await as(ada).send("POST", "/site/checklists/checks", {
          templateId: template,
          results: items.map((i) => ({ itemId: i.id, result: "pass" })),
        }),
        201,
      );
      expect(unnamed.allergenRisk.status).toBe("unknown");
      // Other kinds of check carry no allergen risk.
      const prestart = await ok(
        await as(ada).send("POST", "/site/checklists/templates", {
          name: "Pre-start",
          kind: "prestart",
          items: [{ prompt: "Guards on" }],
        }),
        201,
      );
      const check2 = await ok(
        await as(ada).send("POST", "/site/checklists/checks", {
          templateId: prestart.id,
          results: [{ itemId: prestart.items[0].id, result: "pass" }],
        }),
        201,
      );
      expect(check2.allergenRisk).toBeNull();
    });
  });
});
