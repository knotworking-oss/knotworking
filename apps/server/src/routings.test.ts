import { DEFAULT_TIME_ZONE, moduleIds, todayInZone, type ModuleId } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const ws = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
/** Generic discrete manufacturing: no Food items, no HACCP, no Labels. */
const genericModules: ModuleId[] = ["items", "recipes", "stock", "production", "routings", "purchasing", "costing"];

type Card = { id: string; position: number; name: string; status: string };

describe("routings and job cards", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  const as = (cookie: string) => ({
    send: (method: string, path: string, json?: unknown) => ctx.req(ws + path, { method, cookie, json }),
  });
  const expectStatus = async (res: Response, status: number) => {
    const body = res.status === 204 ? null : await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const ok = async (method: string, path: string, json?: unknown, status = 200) =>
    expectStatus(await as(ada).send(method, path, json), status);
  const refused = async (method: string, path: string, json: unknown, status: number, code: string) => {
    const body = await expectStatus(await as(ada).send(method, path, json), status);
    expect(body.error.code).toBe(code);
    return body;
  };
  const item = async (code: string, type: string, unit: string, rest: object = {}) =>
    (await ok("POST", "/items", { code, name: code, type, unit, ...rest }, 201)).id as string;

  // Shared between the tests: an assembly batch whose job cards were made while Routings was on.
  let frameRecipe: string;
  let store: string;
  let steelLot: string;
  let boltLot: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${ws}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
  }, 60_000);
  afterAll(async () => ctx?.handle.close());

  it("routes a multi-operation assembly from components to finished stock with Food modules off", async () => {
    await ok("PATCH", "/module-settings", { modules: genericModules });
    store = (await ok("POST", "/stock/locations", { name: "Assembly cell" }, 201)).id;
    const steel = await item("RT-STEEL", "raw_material", "kg", { standardCost: 2 });
    const bolt = await item("RT-BOLT", "component", "each", { standardCost: 0.1 });
    const frame = await item("RT-FRAME", "finished", "each");
    steelLot = (
      await ok(
        "POST",
        "/stock/receipts",
        { itemId: steel, quantity: 20, unit: "kg", locationId: store, receivedOn: today, lotCode: "ST-1" },
        201,
      )
    ).id;
    boltLot = (
      await ok(
        "POST",
        "/stock/receipts",
        { itemId: bolt, quantity: 40, unit: "each", locationId: store, receivedOn: today, lotCode: "BL-1" },
        201,
      )
    ).id;
    const bom = await ok(
      "POST",
      "/boms",
      {
        code: "RT-FRAME-BOM",
        name: "Synthetic frame",
        outputItemId: frame,
        draft: {
          yieldQuantity: 1,
          yieldUnit: "each",
          lines: [
            { itemId: steel, quantity: 2, unit: "kg" },
            { itemId: bolt, quantity: 4, unit: "each" },
          ],
        },
      },
      201,
    );
    frameRecipe = bom.id;
    await ok("POST", `/boms/${bom.id}/draft/approve`);

    // Work centres with capacity and cost rates.
    const centre = async (code: string, costPerHour: number, stations = 1) =>
      (
        await ok(
          "POST",
          "/routings/work-centres",
          { code, name: `Synthetic ${code}`, costPerHour, stations, hoursPerDay: 7.5 },
          201,
        )
      ).id as string;
    const cut = await centre("RT-CUT", 30, 2);
    const weld = await centre("RT-WELD", 45);
    const assemble = await centre("RT-ASM", 25);
    const listed = await ok("GET", "/routings/work-centres?q=RT-CUT");
    expect(listed.workCentres).toEqual([
      expect.objectContaining({ code: "RT-CUT", stations: 2, capacityHoursPerDay: 15, costPerHour: 30 }),
    ]);
    await refused("POST", "/routings/work-centres", { code: "rt-cut", name: "Dup" }, 409, "code_taken");

    // A routing for the bill, versioned: draft, approve, revise.
    const routing = await ok(
      "POST",
      "/routings",
      {
        code: "RT-FRAME",
        name: "Frame build",
        recipeId: bom.id,
        draft: {
          operations: [
            { name: "Cut", workCentreId: cut, setupMinutes: 15, runMinutes: 10 },
            { name: "Weld", workCentreId: weld, setupMinutes: 10, runMinutes: 20 },
          ],
        },
      },
      201,
    );
    expect(routing.recipe).toMatchObject({ id: bom.id, code: "RT-FRAME-BOM" });
    expect(routing.versions[0]).toMatchObject({ versionNumber: 1, status: "draft" });
    await refused(
      "POST",
      "/routings",
      { code: "RT-OTHER", name: "Second", recipeId: bom.id },
      409,
      "routing_exists",
    );
    await ok("POST", `/routings/${routing.id}/draft/approve`);
    const revised = await ok("PUT", `/routings/${routing.id}/draft`, {
      changeNote: "Add final assembly",
      operations: [
        { name: "Cut", workCentreId: cut, setupMinutes: 15, runMinutes: 10 },
        { name: "Weld", workCentreId: weld, setupMinutes: 10, runMinutes: 20 },
        { name: "Assemble", workCentreId: assemble, setupMinutes: 0, runMinutes: 5, instructions: "Torque to spec" },
      ],
    });
    expect(revised.versions.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status])).toEqual([
      [2, "draft"],
      [1, "approved"],
    ]);
    // Approving is a person's sign-off with manage: a member with write can't.
    await ok("PUT", `/members/${marcus.userId}/module-access/routings`, { level: "write" });
    for (const id of ["items", "recipes", "stock", "production"]) {
      await ok("PUT", `/members/${marcus.userId}/module-access/${id}`, { level: "write" });
    }
    const denied = await expectStatus(
      await as(marcus.cookie).send("POST", `/routings/${routing.id}/draft/approve`),
      403,
    );
    expect(denied.error.code).toBe("module_forbidden");
    const approved = await ok("POST", `/routings/${routing.id}/draft/approve`);
    expect(approved.versions.map((v: { status: string }) => v.status)).toEqual(["approved", "superseded"]);
    expect(approved.versions[0].totals).toMatchObject({ setupMinutes: 25, runMinutes: 35 });
    expect((await ok("GET", `/routings?q=RT-FRAME`)).routings[0]).toMatchObject({
      approvedVersion: { versionNumber: 2, operations: 3 },
      draftVersion: null,
    });

    // A production order of five frames gets one job card per operation.
    const batch = await ok(
      "POST",
      "/production/batches",
      { recipeId: bom.id, plannedOn: today, batches: 5, outputLocationId: store },
      201,
    );
    const made = await ok("POST", `/routings/batches/${batch.id}/job-cards`, undefined, 201);
    expect(made.routing).toMatchObject({ code: "RT-FRAME" });
    const cards: Card[] = made.jobCards;
    expect(made.jobCards.map((c: Card & { expected: object }) => [c.position, c.name, c.expected])).toEqual([
      [1, "Cut", { setupMinutes: 15, runMinutes: 50, totalMinutes: 65 }],
      [2, "Weld", { setupMinutes: 10, runMinutes: 100, totalMinutes: 110 }],
      [3, "Assemble", { setupMinutes: 0, runMinutes: 25, totalMinutes: 25 }],
    ]);
    expect(made.summary).toMatchObject({ cards: 3, completed: 0, expectedMinutes: 200 });
    await refused("POST", `/routings/batches/${batch.id}/job-cards`, undefined, 409, "job_cards_exist");
    const [cutCard, weldCard, asmCard] = cards.map((c) => `/routings/job-cards/${c.id}`) as [string, string, string];

    // Nothing is recorded on a batch that hasn't started.
    await refused("POST", `${cutCard}/time`, { minutes: 5 }, 409, "invalid_batch_status");
    await ok("POST", `/production/batches/${batch.id}/start`);

    // Cut: a timer and an entry, the steel used there, four good and one scrapped.
    await ok("POST", `${cutCard}/timer/start`, {}, 201);
    await refused("POST", `${cutCard}/timer/start`, {}, 409, "timer_running");
    await ok("POST", `${cutCard}/timer/stop`);
    await ok("POST", `${cutCard}/time`, { minutes: 60, note: "Saw run" }, 201);
    await ok(
      "POST",
      `${cutCard}/consumption`,
      { lines: [{ lotId: steelLot, locationId: store, quantity: 10, unit: "kg" }] },
      201,
    );
    await refused("POST", `${cutCard}/quantities`, { good: 0, scrap: 1, unit: "each" }, 400, "invalid_input");
    const cutDone = await ok(
      "POST",
      `${cutCard}/quantities`,
      { good: 4, scrap: 1, unit: "each", scrapReason: "Short cut" },
      201,
    );
    expect(cutDone).toMatchObject({ status: "in_progress", good: { base: 4 }, scrap: { base: 1 }, actualMinutes: 61 });
    expect(cutDone.records).toEqual([
      expect.objectContaining({ kind: "consumption", lotCode: "ST-1", quantity: expect.objectContaining({ base: 10000 }) }),
    ]);

    // Weld can't report more than Cut passed as good, nor complete before Cut.
    await refused("POST", `${weldCard}/quantities`, { good: 5, unit: "each" }, 409, "exceeds_previous_good");
    await ok("POST", `${weldCard}/quantities`, { good: 3, unit: "each" }, 201);
    await refused("POST", `${weldCard}/quantities`, { good: 2, unit: "each" }, 409, "exceeds_previous_good");
    await refused("POST", `${weldCard}/complete`, {}, 409, "previous_operation_open");
    // Voiding Cut's good quantity would leave Weld over: refused.
    const cutEntry = (await ok("GET", cutCard)).quantities[0].id;
    await expectStatus(
      await as(ada).send("POST", `${cutCard}/quantities/${cutEntry}/void`, { reason: "Typo" }),
      409,
    );
    await ok("POST", `${cutCard}/complete`, { note: "All cut" });
    await refused("POST", `${cutCard}/time`, { minutes: 5 }, 409, "job_card_closed");

    // Weld: an exception blocks completion until it is resolved.
    await ok("POST", `${weldCard}/quantities`, { good: 1, unit: "each" }, 201);
    await ok("POST", `${weldCard}/time`, { minutes: 90 }, 201);
    const raised = await ok(
      "POST",
      `${weldCard}/exceptions`,
      { kind: "machine", description: "Wire feed jammed" },
      201,
    );
    expect(raised.openExceptions).toBe(1);
    await refused("POST", `${weldCard}/complete`, {}, 409, "open_exceptions");
    await ok("POST", `${weldCard}/exceptions/${raised.exceptions[0].id}/resolve`, { resolution: "Cleared the liner" });
    await ok("POST", `${weldCard}/complete`, {});

    // Assemble: bolts used there, then the output, never more than passed as good, only from the last card.
    await ok(
      "POST",
      `${asmCard}/consumption`,
      { lines: [{ lotId: boltLot, locationId: store, quantity: 16, unit: "each" }] },
      201,
    );
    await refused("POST", `${weldCard}/output`, { quantity: 4, unit: "each" }, 409, "job_card_closed");
    await refused("POST", `${asmCard}/output`, { quantity: 4, unit: "each" }, 409, "output_exceeds_good");
    await ok("POST", `${asmCard}/quantities`, { good: 4, unit: "each" }, 201);
    await ok("POST", `${asmCard}/time`, { minutes: 30 }, 201);
    const output = await ok("POST", `${asmCard}/output`, { quantity: 4, unit: "each", lotCode: "FR-1" }, 201);
    expect(output.output).toMatchObject({ base: 4 });
    const frameLot = output.records.find((r: { kind: string }) => r.kind === "output").lotId as string;

    // The batch completes only once every operation has.
    await refused("POST", `/production/batches/${batch.id}/complete`, {}, 409, "job_cards_open");
    await ok("POST", `${asmCard}/complete`, {});
    const completed = await ok("POST", `/production/batches/${batch.id}/complete`, {});
    expect(completed.status).toBe("completed");

    // Traceability: the finished lot back to the steel and bolt lots, through the batch.
    const trace = await ok("GET", `/production/lots/${frameLot}/trace`);
    expect(trace.lot).toMatchObject({ lotCode: "FR-1" });
    expect(
      trace.backward[0].inputs.map((i: { lot: { lotCode: string }; amount: { base: number } }) => [
        i.lot.lotCode,
        i.amount.base,
      ]).sort(),
    ).toEqual([
      ["BL-1", 16],
      ["ST-1", 10000],
    ]);
    const forward = await ok("GET", `/production/lots/${steelLot}/trace`);
    expect(forward.forward[0].outputs[0]).toMatchObject({ lot: { lotCode: "FR-1" }, amount: { base: 4 } });

    // Costing: work-centre time at each card's rate, on top of the materials.
    const cost = await ok("GET", `/costing/batches/${batch.id}`);
    expect(cost.operations).toMatchObject({
      cards: 3,
      completed: 3,
      actualMinutes: 181,
      // 61 min at 30/h + 90 min at 45/h + 30 min at 25/h.
      actualCost: 110.5,
      finishedGood: { base: 4 },
    });
    expect(cost.operations.operations.map((o: { actualCost: number }) => o.actualCost)).toEqual([30.5, 67.5, 12.5]);
    expect(cost.totalCost).toBeCloseTo(cost.actualCost + cost.conversion.total + 110.5, 2);

    // The job card list and the batch summary agree.
    const open = await ok("GET", "/routings/job-cards?status=completed&batchId=" + batch.id);
    expect(open.total).toBe(3);
    const summary = await ok("GET", `/routings/batches/${batch.id}/job-cards`);
    expect(summary.summary).toMatchObject({ completed: 3, actualCost: 110.5, scrap: 1 });
  });

  it("refuses job card voids and routing approval to API tokens", async () => {
    const token = (
      await (
        await ctx.req("/v1/me/api-tokens", { method: "POST", cookie: ada, json: { name: "agent", scope: "write" } })
      ).json()
    ).token as string;
    const viaToken = (method: string, path: string, json?: unknown) =>
      ctx.req(ws + path, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
    const { jobCards } = await ok("GET", "/routings/job-cards?status=all&limit=1");
    const res = await viaToken("POST", `/routings/job-cards/${jobCards[0].id}/time/${jobCards[0].id}/void`, {
      reason: "x",
    });
    expect(res.status).toBe(403);
    expect((await viaToken("GET", "/routings/work-centres")).status).toBe(200);
  });

  it("cancels a batch's open job cards with the batch, and only unused cards by hand", async () => {
    const batch = await ok(
      "POST",
      "/production/batches",
      { recipeId: frameRecipe, plannedOn: today, batches: 1, outputLocationId: store },
      201,
    );
    const made = await ok("POST", `/routings/batches/${batch.id}/job-cards`, undefined, 201);
    // Unused cards can be cancelled and made again.
    await ok("DELETE", `/routings/batches/${batch.id}/job-cards`);
    const again = await ok("POST", `/routings/batches/${batch.id}/job-cards`, undefined, 201);
    expect(again.jobCards).toHaveLength(3);
    expect(again.jobCards[0].id).not.toBe(made.jobCards[0].id);
    await ok("POST", `/production/batches/${batch.id}/start`);
    await ok("POST", `/routings/job-cards/${again.jobCards[0].id}/timer/start`, {}, 201);
    await refused("DELETE", `/routings/batches/${batch.id}/job-cards`, undefined, 409, "job_cards_in_use");
    await ok("POST", `/production/batches/${batch.id}/cancel`, { reason: "Order withdrawn" });
    const after = await ok("GET", `/routings/job-cards/${again.jobCards[0].id}`);
    expect(after.status).toBe("cancelled");
    expect(after.timeLogs[0]).toMatchObject({ running: false });
  });

  it("leaves batch production, HACCP records and lot traceability unchanged with Routings disabled", async () => {
    // A batch with job cards made while Routings was on.
    const pending = await ok(
      "POST",
      "/production/batches",
      { recipeId: frameRecipe, plannedOn: today, batches: 1, outputLocationId: store },
      201,
    );
    await ok("POST", `/routings/batches/${pending.id}/job-cards`, undefined, 201);

    await ok("PATCH", "/module-settings", { modules: moduleIds.filter((id) => id !== "routings") });
    await refused("GET", "/routings/work-centres", undefined, 404, "module_inactive");
    await refused("GET", `/routings/batches/${pending.id}/job-cards`, undefined, 404, "module_inactive");

    // The frame batch completes as an ordinary batch: its job cards no longer gate it.
    await ok("POST", `/production/batches/${pending.id}/start`);
    await ok(
      "POST",
      `/production/batches/${pending.id}/consumption`,
      {
        lines: [
          { lotId: steelLot, locationId: store, quantity: 2, unit: "kg" },
          { lotId: boltLot, locationId: store, quantity: 4, unit: "each" },
        ],
      },
      201,
    );
    const out = await ok("POST", `/production/batches/${pending.id}/output`, { quantity: 1, unit: "each" }, 201);
    expect((await ok("POST", `/production/batches/${pending.id}/complete`, {})).status).toBe("completed");
    const frameLot = out.outputs.at(-1).lotId as string;
    const back = await ok("GET", `/production/lots/${frameLot}/trace`);
    expect(back.backward[0].inputs.map((i: { lot: { lotCode: string } }) => i.lot.lotCode).sort()).toEqual([
      "BL-1",
      "ST-1",
    ]);
    // Costing has no operations section without Routings.
    expect((await ok("GET", `/costing/batches/${pending.id}`)).operations).toBeNull();

    // A food batch with a CCP reading: batch record, HACCP record and trace as before.
    const veg = await item("RT-VEG", "ingredient", "kg");
    const soup = await item("RT-SOUP", "finished", "l");
    const vegLot = (
      await ok(
        "POST",
        "/stock/receipts",
        { itemId: veg, quantity: 10, unit: "kg", locationId: store, receivedOn: today, lotCode: "VG-1" },
        201,
      )
    ).id;
    const recipe = await ok(
      "POST",
      "/recipes",
      {
        code: "RT-R-SOUP",
        name: "Synthetic soup",
        outputItemId: soup,
        draft: { yieldQuantity: 10, yieldUnit: "l", lines: [{ itemId: veg, quantity: 5, unit: "kg" }] },
      },
      201,
    );
    await ok("POST", `/recipes/${recipe.id}/draft/approve`);
    await ok("PUT", `/members/${marcus.userId}/module-access/assets`, { level: "read" });
    await ok("PUT", `/members/${marcus.userId}/module-access/haccp`, { level: "manage" });
    const plan = await ok(
      "POST",
      "/haccp/plans",
      {
        code: "RT-HACCP",
        name: "Synthetic soups",
        draft: {
          scope: { itemIds: [soup] },
          ccps: [
            {
              code: "CCP1",
              processStep: "Cooking",
              hazardType: "biological",
              hazard: "Survival of vegetative pathogens",
              limitType: "range",
              limitMin: 75,
              limitUnit: "°C",
              monitoringMethod: "Probe the core",
              frequency: { every: 1, unit: "batch" },
              responsibleRole: "Cook",
              correctiveAction: "Continue cooking",
              verification: "Supervisor reviews daily",
            },
          ],
        },
      },
      201,
    );
    await expectStatus(await as(marcus.cookie).send("POST", `/haccp/plans/${plan.id}/draft/approve`, {}), 200);
    const ccp = (await ok("GET", `/haccp/plans/${plan.id}`)).currentVersion.ccps[0].id;
    const soupBatch = await ok(
      "POST",
      "/production/batches",
      { recipeId: recipe.id, plannedOn: today, batches: 1, outputLocationId: store },
      201,
    );
    await ok("POST", `/production/batches/${soupBatch.id}/start`);
    await ok(
      "POST",
      `/production/batches/${soupBatch.id}/consumption`,
      { lines: [{ lotId: vegLot, locationId: store, quantity: 5, unit: "kg" }] },
      201,
    );
    await ok("POST", "/haccp/logs", { ccpId: ccp, value: 82, batchId: soupBatch.id }, 201);
    const soupOut = await ok("POST", `/production/batches/${soupBatch.id}/output`, { quantity: 10, unit: "l" }, 201);
    const done = await ok("POST", `/production/batches/${soupBatch.id}/complete`, {});
    expect(done).toMatchObject({ status: "completed", haccpWarning: expect.anything() });
    const record = await ok("GET", `/haccp/batches/${soupBatch.id}`);
    expect(JSON.stringify(record)).toContain(ccp);
    const soupTrace = await ok("GET", `/production/lots/${soupOut.outputs[0].lotId}/trace`);
    expect(soupTrace.backward[0].inputs[0]).toMatchObject({ lot: { lotCode: "VG-1" }, amount: { base: 5000 } });
  });
});
