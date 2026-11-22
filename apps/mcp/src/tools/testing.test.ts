import { newId } from "@knotworking/core";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session(options: Parameters<typeof connect>[0] = {}) {
  const s = await connect(options);
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("testing tools", () => {
  it("lists plans due and logs a point sample under a plan", async () => {
    const { call } = await session();
    const due = await call("get_testing_due", { workspace: "acme" });
    expect(due.data.plans[0]).toMatchObject({
      name: "Weekly Listeria swab",
      samplingPoint: { code: "HC-Z1-01" },
      state: "overdue",
      analytes: ["Listeria spp."],
    });
    const logged = await call("log_test_sample", {
      workspace: "acme",
      sampling_point: "hc-z1-01",
      plan: "weekly listeria swab",
      sampled_on: "2026-01-05",
    });
    expect(logged.data).toMatchObject({
      reference: "S-2026-0001",
      laboratory: "Micro Labs",
      outcome: "pending",
      results: [{ analyte: "Listeria spp.", limit: "Not detected", needs: "outcome" }],
    });
    expect(logged.data.note).toMatch(/no tool/);
    const after = await call("get_testing_due", { workspace: "acme" });
    expect(after.data.plans[0]).toMatchObject({ lastSampledOn: "2026-01-05", state: "due_soon" });
    const both = await call("log_test_sample", { workspace: "acme", sampled_on: "2026-01-05" });
    expect(both.isError).toBe(true);
  });

  it("records a failing lot result: the lot is held and an investigation opened", async () => {
    const { call, fake } = await session();
    const flour = fake.itemsModule.items.find((i) => i.code === "FLR-001")!;
    fake.stockModule.lots.push({
      id: newId(),
      itemId: flour.id,
      lotCode: "L-77",
      status: "available",
      supplierLotCode: null,
    });
    const logged = await call("log_test_sample", {
      workspace: "acme",
      lot: "L-77",
      sampled_on: "2026-01-05",
      analytes: [{ category: "chemical", name: "Moisture", unit: "%", max: 15.5 }],
    });
    expect(logged.data).toMatchObject({ lot: { lotCode: "L-77", status: "available" }, item: "FLR-001" });
    const resultId = logged.data.results[0].resultId;
    // A numeric limit needs the value.
    const missing = await call("record_test_results", {
      workspace: "acme",
      sample: logged.data.reference,
      reported_on: "2026-01-05",
      results: [{ result_id: resultId, outcome: "pass" }],
    });
    expect(missing.isError).toBe(true);
    const failed = await call("record_test_results", {
      workspace: "acme",
      sample: logged.data.reference,
      reported_on: "2026-01-05",
      results: [{ result_id: resultId, value: 16.2 }],
    });
    expect(failed.data).toMatchObject({
      outcome: "fail",
      status: "complete",
      lotHeld: true,
      lot: { status: "quarantine" },
      investigation: { status: "open" },
    });
    const open_ = await call("list_test_samples", { workspace: "acme", investigation: "open" });
    expect(open_.data.samples.map((s: { reference: string }) => s.reference)).toEqual([
      logged.data.reference,
    ]);
    const trend = await call("get_test_trend", { workspace: "acme", analyte: "moisture" });
    expect(trend.data.summary).toMatchObject({ results: 1, fails: 1 });
    expect(trend.data.points[0]).toMatchObject({ source: "L-77", value: 16.2 });
  });

  it("has no tool to close investigations", async () => {
    const { client } = await session();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => n.includes("investigation"))).toBe(false);
  });
});
