import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { beforeAll, describe, expect, it } from "vitest";
import { addHaccpAsset, makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

/**
 * G2 evidence checks against live records. The seed has no quality, HACCP or governance records,
 * so each check starts from nothing; clause wording is placeholder text.
 */
describe("standards gap analysis: evidence checks (G2)", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let standard: string;
  let lot: string;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const ok = async (res: Res, status = 200): Promise<any> => {
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const gaps = async (query = "", cookie = ada) =>
    ok(await call("GET", `/governance/standards/${standard}${query}`, undefined, cookie));
  const clause = async (ref: string, cookie = ada) =>
    (await gaps("", cookie)).clauses.find((c: { ref: string }) => c.ref === ref);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    // Marcus reads governance but not quality: quality evidence must stay hidden from him.
    await ok(await call("PUT", `/members/${m.userId}/module-access/governance`, { level: "read" }));

    standard = (
      await ok(
        await call("POST", "/governance/standards", { code: "BRCGS-FS", name: "Food Safety", issue: "9" }),
        201,
      )
    ).id;
    await ok(
      await call("POST", `/governance/standards/${standard}/clauses/import`, {
        csv: [
          "Clause,Title,Fundamental",
          "1.1,Placeholder: commitment,yes",
          "3.9,Placeholder: traceability,yes",
          "4.6,Placeholder: equipment,",
          "5.1,Placeholder: product design,",
        ].join("\n"),
      }),
    );
    const map = async (ref: string, checkIds: string[]) =>
      ok(await call("PUT", `/governance/clauses/${(await clause(ref)).id}/evidence`, { checkIds }));
    await map("1.1", ["management_review", "requirements_register"]);
    await map("3.9", ["traceability_test"]);
    await map("4.6", ["calibration"]);

    const item = (
      await ok(
        await call("POST", "/items", { code: "EV-CAKE", name: "Cake", type: "finished", unit: "each" }),
        201,
      )
    ).id;
    const store = (await ok(await call("POST", "/stock/locations", { name: "EV store" }), 201)).id;
    lot = (
      await ok(
        await call("POST", "/stock/receipts", {
          itemId: item,
          quantity: 100,
          unit: "each",
          locationId: store,
          receivedOn: today,
          reason: "Opening",
        }),
        201,
      )
    ).id;
  });

  it("evaluates mapped checks against live records, from nothing on record", async () => {
    const commitment = await clause("1.1");
    // Sorted by label: "Legal and customer requirements reviewed" before "Management review…".
    expect(commitment.evidence.map((e: { id: string; status: string }) => [e.id, e.status])).toEqual([
      ["requirements_register", "no_data"],
      ["management_review", "gap"],
    ]);
    expect(commitment.evidenceState).toBe("gap");
    const trace = await clause("3.9");
    expect(trace.evidence[0]).toMatchObject({
      id: "traceability_test",
      status: "gap",
      detail: "No passing traceability test on record",
    });
    expect((await clause("4.6")).evidence[0]).toMatchObject({ status: "no_data" });
    expect((await clause("5.1")).evidenceState).toBe("none");
  });

  it("flags a clause assessed compliant while its evidence shows a gap, until the evidence is met", async () => {
    const trace = await clause("3.9");
    await ok(
      await call("POST", `/governance/clauses/${trace.id}/assessments`, {
        status: "compliant",
        note: "Tested in spring",
      }),
      201,
    );
    let view = await gaps();
    expect(view.summary).toMatchObject({ clausesWithEvidence: 3, conflicts: ["3.9"] });
    expect(view.summary.evidenceGaps).toEqual(expect.arrayContaining(["1.1", "3.9"]));
    expect((await gaps("?evidence=conflict")).clauses.map((c: { ref: string }) => c.ref)).toEqual(["3.9"]);

    // A passing traceability test today clears the gap and the conflict.
    await ok(
      await call("POST", "/quality/recall-tests", {
        conductedOn: today,
        lotId: lot,
        direction: "both",
        startedAt: new Date(Date.now() - 120 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 60_000).toISOString(),
        quantityExpected: 100,
        quantityTraced: 100,
      }),
      201,
    );
    view = await gaps();
    const after = view.clauses.find((c: { ref: string }) => c.ref === "3.9");
    expect(after).toMatchObject({ evidenceState: "met", conflict: false });
    expect(after.evidence[0].detail).toContain(`Passed ${today}`);
    expect(view.summary.conflicts).toEqual([]);
  });

  it("lists the records behind a gap: overdue calibration", async () => {
    const asset = (
      await addHaccpAsset(call, {
        kind: "equipment",
        code: "PRB-1",
        name: "Probe thermometer",
        calibrationFrequency: { every: 1, unit: "month" },
        calibrationTolerance: 0.5,
        measurementUnit: "°C",
      })
    ).id;
    await ok(
      await call("POST", "/haccp/calibration", {
        assetId: asset,
        calibratedAt: new Date(`${addDays(today, -60)}T09:00:00Z`).toISOString(),
        referenceReading: 0,
        actualReading: 0.2,
        nextDueOn: addDays(today, -30),
      }),
      201,
    );
    const equipment = await clause("4.6");
    expect(equipment.evidence[0]).toMatchObject({
      status: "gap",
      detail: "1 calibration overdue or never done",
    });
    expect(equipment.evidence[0].items[0].label).toContain("Probe thermometer");
  });

  it("counts equipment never calibrated as a gap, not met", async () => {
    await addHaccpAsset(call, {
      kind: "equipment",
      code: "PRB-2",
      name: "Spare probe",
      calibrationFrequency: { every: 1, unit: "month" },
      calibrationTolerance: 0.5,
      measurementUnit: "°C",
    });
    const [check] = (await clause("4.6")).evidence;
    expect(check).toMatchObject({ status: "gap", detail: "2 calibrations overdue or never done" });
    expect(check.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: expect.stringContaining("Spare probe"), detail: "never done" }),
      ]),
    );
  });

  it("hides evidence from modules the reader can't see, and keeps mapping to managers", async () => {
    const seen = await clause("3.9", marcus.cookie);
    expect(seen.evidence[0]).toMatchObject({ status: "unavailable", items: [] });
    expect(seen.evidenceState).toBe("partial_view");
    expect(JSON.stringify(seen.evidence)).not.toContain("Passed");
    const res = await call("PUT", `/governance/clauses/${seen.id}/evidence`, { checkIds: [] }, marcus.cookie);
    expect(res.status).toBe(403);
  });

  it("lists every check with the clauses mapped to it, and exports evidence in the CSV", async () => {
    const { checks } = await ok(await call("GET", "/governance/evidence-checks"));
    expect(checks).toHaveLength(16);
    // Every evaluator runs: a failure would read "Couldn't be checked".
    expect(checks.filter((c: { detail: string }) => c.detail.startsWith("Couldn't be checked"))).toEqual([]);
    // Every module is on and Ada reads them all: no check may be hidden from her.
    expect(checks.filter((c: { status: string }) => c.status === "unavailable")).toEqual([]);
    // Who hasn't acknowledged an SOP is for SOP managers: the check gives counts per SOP only.
    const acks = checks.find((c: { id: string }) => c.id === "sop_acknowledgements");
    for (const i of acks.items) expect(i.detail).toMatch(/^\d+ (person|people), oldest \d+ days$/);
    expect(checks.find((c: { id: string }) => c.id === "traceability_test")).toMatchObject({
      status: "met",
      clauses: ["BRCGS-FS 3.9"],
    });
    const text = await (await call("GET", `/governance/standards/${standard}/report.csv`)).text();
    expect(text.split("\n")[0]).toContain("Evidence gaps");
    expect(text).toContain("Measuring equipment calibrated: 2 calibrations overdue or never done");

    // Unmapping removes the evidence.
    const equipment = await clause("4.6");
    await ok(await call("PUT", `/governance/clauses/${equipment.id}/evidence`, { checkIds: [] }));
    expect((await clause("4.6")).evidenceState).toBe("none");
  });
});
