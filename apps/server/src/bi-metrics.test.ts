import { addDays, biCertifiedMetrics, moduleIds } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { certifiedMetricIds } from "./services/bi/metrics";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/**
 * Certified metrics: each one equals the figure its module's page shows, for
 * the same dates, because both call the same service. A metric needs read on its module.
 */
describe("BI certified metrics", () => {
  let ctx: TestCtx;
  let ada: string;
  let today: string;

  const get = async (path: string, cookie = ada) => {
    const res = await ctx.req(`${WS}${path}`, { cookie });
    const body = await res.json();
    expect(res.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
    return body;
  };
  const metric = async (spec: object) =>
    get(`/bi/query?spec=${encodeURIComponent(JSON.stringify({ dataset: "certified_metrics", ...spec }))}`);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: moduleIds });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    // Today in the workspace zone, from a period the server resolved.
    const probe = await metric({ measures: ["oee"], period: { preset: "today" } });
    today = probe.period.from;
  }, 120_000);
  afterAll(() => ctx.handle.close());

  it("implements every declared metric", () => {
    expect(certifiedMetricIds.sort()).toEqual(biCertifiedMetrics.map((m) => m.id).sort());
  });

  it("OEE equals Production → Performance's site figure", async () => {
    const from = addDays(today, -89);
    const result = await metric({ measures: ["oee"], period: { from, to: addDays(today, 1) } });
    const page = await get(`/production/performance?from=${from}&to=${today}`);
    const expected = page.site.oee === null ? null : Math.round(page.site.oee * 1000) / 10;
    expect(result.rows[0].oee).toBe(expected);
    expect(result.columns[0]).toMatchObject({ key: "oee", unit: "percent" });
  });

  it("cost variance equals Costing → Report for the same dates", async () => {
    const from = `${addDays(`${today.slice(0, 7)}-01`, -200).slice(0, 7)}-01`;
    const result = await metric({
      measures: ["batch_cost_variance"],
      period: { from, to: addDays(today, 1) },
    });
    const page = await get(`/costing/report?period=month&from=${from}&to=${today}`);
    expect(result.rows[0].batch_cost_variance).toBe(
      page.totals.standardCost === null ? null : page.totals.variance.total,
    );
  });

  it("supplier OTIF equals Purchasing → Supplier performance for the same dates", async () => {
    const from = addDays(today, -89);
    const result = await metric({ measures: ["supplier_otif"], period: { from, to: addDays(today, 1) } });
    const page = await get(`/purchasing/supplier-performance?from=${from}&to=${today}`);
    expect(result.rows[0].supplier_otif).toBe(page.totals.otifPercent);
  });

  it("complaint rate equals Quality → Trends over the same months", async () => {
    // The twelve calendar months ending this month, as the trends page shows them.
    let from = `${today.slice(0, 7)}-01`;
    for (let i = 0; i < 11; i++) from = `${addDays(from, -1).slice(0, 7)}-01`;
    const to = `${addDays(`${today.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;
    const result = await metric({ measures: ["complaint_rate"], period: { from, to } });
    const page = await get("/quality/trends?months=12");
    const rate = page.overall.total.perMillion;
    expect(result.rows[0].complaint_rate).toBe(rate === null ? null : Math.round(rate * 10) / 10);
  });

  it("figures as at now equal Costing → Valuation, the Training matrix and the Quality overview", async () => {
    const result = await metric({
      measures: ["stock_value", "training_compliance", "overdue_nonconformances", "open_complaints"],
    });
    const row = result.rows[0];
    expect(row.stock_value).toBe((await get("/costing/valuation")).totals.value);
    const { summary } = await get("/training/matrix");
    const required = Object.values(summary as Record<string, number>).reduce((t, n) => t + n, 0);
    expect(row.training_compliance).toBe(
      required ? Math.round(((summary.current + summary.expiring) / required) * 1000) / 10 : null,
    );
    const quality = await get("/quality/summary");
    expect(row.overdue_nonconformances).toBe(quality.nonconformances.overdue);
    expect(row.open_complaints).toBe(quality.complaints.open + quality.complaints.investigating);
    expect(result.period).toBeNull();
  });

  it("trends a metric by month and compares an untrended one with the period before", async () => {
    const trend = await metric({
      measures: ["oee"],
      groupBy: [{ dim: "period_on", grain: "month" }],
      period: { preset: "last_90_days" },
      sort: [{ by: "period_on", dir: "asc" }],
    });
    expect(trend.rows.length).toBeGreaterThanOrEqual(3);
    expect(trend.rows.map((r: { period_on: string }) => r.period_on)).toEqual(
      [...trend.rows.map((r: { period_on: string }) => r.period_on)].sort(),
    );
    const compared = await metric({
      measures: ["oee"],
      period: { preset: "this_month" },
      compare: "previous_period",
    });
    expect(compared.comparePeriod).not.toBeNull();
    expect(compared.rows[0]).toHaveProperty("oee__compare");
  });

  it("needs read on a metric's module, for people and tokens", async () => {
    const token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "board", scope: "read", modules: ["bi", "quality", "items", "stock"] },
        })
      ).json()
    ).token as string;
    const asToken = (spec: object) =>
      ctx.req(
        `${WS}/bi/query?spec=${encodeURIComponent(JSON.stringify({ dataset: "certified_metrics", ...spec }))}`,
        {
          headers: { authorization: `Bearer ${token}`, origin: "" },
        },
      );
    const allowed = await asToken({ measures: ["open_complaints"] });
    expect(allowed.status, JSON.stringify(await allowed.clone().json())).toBe(200);
    const refused = await asToken({ measures: ["stock_value"] });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("bi_field_forbidden");
    const datasets = await (
      await ctx.req(`${WS}/bi/datasets`, { headers: { authorization: `Bearer ${token}`, origin: "" } })
    ).json();
    const metrics = datasets.datasets.find((d: { id: string }) => d.id === "certified_metrics");
    expect(metrics.measures.map((m: { id: string }) => m.id).sort()).toEqual([
      "complaint_rate",
      "open_complaints",
      "overdue_nonconformances",
    ]);
    expect(metrics.measures[0].certified).toMatchObject({ version: expect.any(String) });
  });
});
