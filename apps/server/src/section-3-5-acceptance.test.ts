import { addDays, DEFAULT_TIME_ZONE, newId, todayInZone } from "@knotworking/core";
import { beforeAll, describe, expect, it } from "vitest";
import { prepareDespatch } from "./despatch-test-helpers";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);
const tomorrow = addDays(today, 1);

/**
 * Section 3.5 acceptance exercise (docs/phase-3.md), end to end through the API: execute a
 * short-life daily schedule with a changeover, record downtime and rejects, and reconstruct which
 * approved label and pack specification was used on each dispatched lot.
 *
 * Two short-life loaves (three days' life) are due to a customer tomorrow. They are planned on one
 * line today; the day plan's proposal puts the allergen-free loaf first so the milk loaf follows
 * with a short changeover instead of an allergen clean-down. Both are made and packed against their
 * approved labels with line clearance, code, detector and weight checks; a breakdown and rejects
 * are recorded; OEE follows the written definitions; the lots are released and despatched, and
 * each despatched lot traces back to the label version and specification its packs carried.
 */
describe("Section 3.5 acceptance exercise", () => {
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

  let line: string;
  let store: string;
  let customer: string;
  const product: Record<"plain" | "milk", string> = { plain: "", milk: "" };
  const recipe: Record<"plain" | "milk", string> = { plain: "", milk: "" };
  const label: Record<"plain" | "milk", string> = { plain: "", milk: "" };
  const batch: Record<"plain" | "milk", string> = { plain: "", milk: "" };
  const lot: Record<"plain" | "milk", string> = { plain: "", milk: "" };
  let spec: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    for (const module of ["recipes", "items", "food_items"])
      await ok(await call("PUT", `/members/${m.userId}/module-access/${module}`, { level: "read" }));
    for (const module of ["labels", "specifications"])
      await ok(await call("PUT", `/members/${m.userId}/module-access/${module}`, { level: "write" }));

    const item = async (body: object) => (await ok(await call("POST", "/items", body), 201)).id as string;
    const flour = await item({
      code: "AC5-FLR",
      name: "Flour",
      type: "ingredient",
      unit: "kg",
      allergens: ["cereals_gluten"],
    });
    const milk = await item({
      code: "AC5-MLK",
      name: "Milk",
      type: "ingredient",
      unit: "kg",
      allergens: ["milk"],
    });
    const make = async (
      key: "plain" | "milk",
      name: string,
      allergens: string[],
      lines: [string, number][],
    ) => {
      product[key] = await item({
        code: `AC5-${key.toUpperCase()}`,
        name,
        type: "finished",
        unit: "each",
        allergens,
        shelfLifeDays: 3,
      });
      recipe[key] = (
        await ok(
          await call("POST", "/recipes", {
            code: `R-AC5-${key.toUpperCase()}`,
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
      // Drafted by one person, approved by another.
      label[key] = (
        await ok(
          await call("POST", "/labelling/labels", { recipeId: recipe[key], includeNutrition: false }, marcus),
          201,
        )
      ).id;
      await ok(await call("POST", `/labelling/labels/${label[key]}/approve`));
    };
    await make("plain", "Fresh white loaf", ["cereals_gluten"], [[flour, 4]]);
    await make(
      "milk",
      "Fresh milk loaf",
      ["cereals_gluten", "milk"],
      [
        [flour, 4],
        [milk, 1],
      ],
    );

    // The milk loaf's pack specification, approved by a second person.
    spec = (
      await ok(
        await call(
          "POST",
          "/specifications",
          {
            code: "AC5-SPEC-MILK",
            title: "Fresh milk loaf, 400 g",
            itemId: product.milk,
            draft: {
              description: "Milk loaf, 400 g bagged",
              storage: "ambient",
              shelfLifeDays: 3,
              allergens: ["cereals_gluten", "milk"],
              mayContain: [],
              claims: [],
              parameters: [],
              packagingDetails: "Printed bag, clip-sealed",
              reviewDueOn: "2099-01-01",
            },
          },
          marcus,
        ),
        201,
      )
    ).id;
    await ok(await call("POST", `/specifications/${spec}/draft/approve`));

    store = (await ok(await call("POST", "/stock/locations", { name: "AC5 dispatch" }), 201)).id;
    customer = (
      await ok(
        await call("POST", "/customers", { code: "AC5-SHOP", name: "Corner shop", address: "1 High St" }),
        201,
      )
    ).id;
    line = (await ok(await call("POST", "/production/lines", { name: "Bakery 1", hoursPerDay: 8 }), 201)).id;
    await ok(
      await call("PUT", `/production/lines/${line}/shifts`, {
        shifts: [{ name: "Day", weekdays: [1, 2, 3, 4, 5, 6, 7], start: "05:00", end: "17:00" }],
      }),
    );
    await ok(
      await call("PATCH", `/production/lines/${line}`, { changeoverMinutes: 10, allergenCleanMinutes: 40 }),
    );
    for (const key of ["plain", "milk"] as const)
      await ok(
        await call("PUT", `/production/lines/${line}/recipes/${recipe[key]}`, { rate: 10, unit: "each" }),
      );
    await ok(
      await call("PUT", `/production/lines/${line}/changeovers`, {
        rules: [{ fromRecipeId: recipe.plain, toRecipeId: recipe.milk, minutes: 5, note: "Same dough line" }],
      }),
    );
  });

  it("plans the short-life day from confirmed orders, with an explained order and a changeover", async () => {
    const order = await ok(
      await call("POST", "/sales/orders", {
        commandId: newId(),
        kind: "order",
        document: {
          customerId: customer,
          currency: "GBP",
          terms: "Net 30",
          lines: (["plain", "milk"] as const).map((k) => ({
            itemId: product[k],
            quantity: 18,
            unit: "each",
            dueOn: tomorrow,
            unitPrice: 1.2,
          })),
        },
      }),
      201,
    );
    await ok(
      await call("POST", `/sales/orders/${order.id}/confirm`, {
        commandId: newId(),
        expectedRevision: order.revision,
        reason: "Standing order",
      }),
    );
    // Planned with codes that put the milk loaf first by default.
    for (const [key, code] of [
      ["milk", "AC5-A-MILK"],
      ["plain", "AC5-B-PLAIN"],
    ] as const)
      batch[key] = (
        await ok(
          await call("POST", "/production/batches", {
            recipeId: recipe[key],
            plannedOn: today,
            batches: 2,
            batchCode: code,
            lineId: line,
            outputLocationId: store,
          }),
          201,
        )
      ).id;

    const daily = await ok(await call("GET", "/production/daily-demand?days=3"));
    for (const key of ["plain", "milk"] as const) {
      const row = daily.items.find((r: { item: { id: string } }) => r.item.id === product[key]);
      expect(row.days[0]).toMatchObject({ date: today, planned: 20, committed: 0 });
      expect(row.days[1]).toMatchObject({ date: tomorrow, committed: 18, projected: 2, short: false });
    }

    const day = await ok(await call("GET", `/production/schedule/day?lineId=${line}&date=${today}`));
    expect(day.steps.map((s: { batchCode: string }) => s.batchCode)).toEqual(["AC5-A-MILK", "AC5-B-PLAIN"]);
    expect(day.cleanDowns).toBe(1);
    expect(day.proposal.order.map((s: { batchCode: string }) => s.batchCode)).toEqual([
      "AC5-B-PLAIN",
      "AC5-A-MILK",
    ]);
    // The allergen-free loaf starts the day, so the milk loaf follows without a clean-down.
    expect(day.proposal.order[0].reason).toBe("Starts the day: fewest allergens (Cereals containing gluten)");
    expect(day.proposal).toMatchObject({
      improves: true,
      current: { cleanDowns: 1 },
      proposed: { cleanDowns: 0 },
    });
    const applied = await ok(
      await call("PUT", "/production/schedule/sequence", {
        lineId: line,
        date: today,
        batchIds: [batch.plain, batch.milk],
        expectedBatchIds: [batch.milk, batch.plain],
      }),
    );
    expect(applied).toMatchObject({ cleanDowns: 0, changeoverMinutes: 5 });
    expect(applied.steps[1]).toMatchObject({ startClock: "07:05", endClock: "09:05" });
    expect(applied.steps[1].changeover).toMatchObject({ minutes: 5, source: "rule" });
  });

  it("makes and packs both against their approved labels, recording downtime and rejects", async () => {
    const packCheck = async (run: string, json: object) =>
      ok(await call("POST", `/production/packing/${run}/checks`, json), 201);
    for (const key of ["plain", "milk"] as const) {
      await ok(await call("POST", `/production/batches/${batch[key]}/start`));
      const packing = await ok(
        await call("POST", `/production/batches/${batch[key]}/packing`, {
          labelId: label[key],
          ...(key === "milk"
            ? {
                specificationVersionId: (
                  await ok(await call("GET", `/production/batches/${batch.milk}/packing`))
                ).candidates.specifications[0].id,
              }
            : {}),
          expectedDateCode: `USE BY ${addDays(today, 3)}`,
          nominalQuantity: 400,
        }),
        201,
      );
      const run = packing.open.id;
      await packCheck(run, {
        kind: "line_clearance",
        items: {
          previous_product_removed: true,
          previous_packaging_and_labels_removed: true,
          coders_and_printers_cleared: true,
          line_clean_and_ready: true,
        },
      });
      await packCheck(run, {
        kind: "first_off",
        labelCorrect: true,
        dateCodeSeen: `use by ${addDays(today, 3)}`,
        lotCodeSeen: packing.open.expectedLotCode,
        legible: true,
      });
      await packCheck(run, {
        kind: "detector_challenge",
        detector: "MD-Bakery-1",
        pieces: [
          { piece: "ferrous", sizeMm: 2, rejected: true },
          { piece: "non_ferrous", sizeMm: 2.5, rejected: true },
          { piece: "stainless_steel", sizeMm: 3, rejected: true },
        ],
      });
      // 400 g nominal: TNE 12 g.
      await packCheck(run, { kind: "weight_sample", readings: [402, 405, 399, 401, 404] });
    }

    // A 20 min breakdown during the plain loaf, and underweight rejects on the milk loaf.
    await ok(
      await call("POST", "/production/downtime", {
        lineId: line,
        date: today,
        minutes: 20,
        reason: "breakdown",
        batchId: batch.plain,
        note: "Divider jam",
      }),
      201,
    );
    await ok(
      await call("POST", `/production/batches/${batch.milk}/rejects`, {
        quantity: 2,
        unit: "each",
        reason: "underweight",
      }),
      201,
    );

    for (const key of ["plain", "milk"] as const) {
      const made = await ok(
        await call("POST", `/production/batches/${batch[key]}/output`, { quantity: 18, unit: "each" }),
        201,
      );
      lot[key] = made.records.find((r: { kind: string }) => r.kind === "output").lotId;
      const packing = await ok(await call("GET", `/production/batches/${batch[key]}/packing`));
      expect(packing.open.gaps).toEqual([]);
      await ok(
        await call("POST", `/production/packing/${packing.open.id}/close`, {
          packsProduced: 18,
          reconciliation: [
            { material: "Printed bag", printed: true, issued: 25, used: 18, wasted: 2, returned: 5 },
          ],
        }),
      );
      await ok(await call("POST", `/production/batches/${batch[key]}/complete`, { note: "Day complete" }));
    }

    // OEE by its definitions: 720 min shift, 20 min unplanned; 36 good + 2 rejects at 10 an hour.
    const perf = await ok(
      await call("GET", `/production/performance?from=${today}&to=${today}&lineId=${line}`),
    );
    expect(perf.definitions.version).toBe("oee-v1");
    expect(perf.lines[0].days[0]).toMatchObject({
      capacityMinutes: 720,
      plannedProductionMinutes: 720,
      unplannedDowntimeMinutes: 20,
      runMinutes: 700,
      idealMinutesTotal: 228,
      idealMinutesGood: 216,
      quality: 0.9474,
      oee: 0.3,
    });
    expect(perf.lines[0].downtimeByReason[0]).toMatchObject({ reason: "breakdown", minutes: 20 });
    expect(perf.lines[0].rejectsByReason[0]).toMatchObject({
      reason: "underweight",
      records: 1,
      idealMinutes: 12,
    });
  });

  it("despatches the short-life lots and traces each to the label and specification its packs carried", async () => {
    for (const key of ["plain", "milk"] as const) {
      const detail = await ok(await call("GET", `/stock/lots/${lot[key]}`));
      expect(detail.lot?.expiresOn ?? detail.expiresOn).toBe(addDays(today, 3));
      await ok(
        await call("POST", `/stock/lots/${lot[key]}/status`, { status: "available", note: "QA release" }),
      );
    }
    const draft = await ok(
      await call("POST", "/despatch", {
        customerId: customer,
        despatchedOn: today,
        lines: (["plain", "milk"] as const).map((k) => ({
          lotId: lot[k],
          quantity: 18,
          unit: "each",
          locationId: store,
        })),
      }),
      201,
    );
    const prepared = await prepareDespatch(call, draft.id, draft.updatedAt);
    if (prepared.error) await ok(prepared.error);
    const confirmed = await ok(
      await call("POST", `/despatch/${draft.id}/confirm`, {
        commandId: newId(),
        expectedUpdatedAt: prepared.stamp,
      }),
    );
    const dispatchedLots: string[] = confirmed.lines.map((l: { lotId: string }) => l.lotId);
    expect(new Set(dispatchedLots)).toEqual(new Set([lot.plain, lot.milk]));

    for (const lotId of dispatchedLots) {
      const key = lotId === lot.plain ? "plain" : "milk";
      const trace = await ok(await call("GET", `/production/lots/${lotId}/packing`));
      expect(trace.batches).toHaveLength(1);
      expect(trace.batches[0]).toMatchObject({ batchId: batch[key], unrecorded: false });
      const [run] = trace.batches[0].packingRuns;
      expect(run).toMatchObject({
        status: "closed",
        expectedDateCode: `USE BY ${addDays(today, 3)}`,
        label: { recipeId: recipe[key], variant: "Standard", versionNumber: 1 },
      });
      expect(run.specification).toEqual(
        key === "milk" ? expect.objectContaining({ code: "AC5-SPEC-MILK", versionNumber: 1 }) : null,
      );
    }
  });
});
