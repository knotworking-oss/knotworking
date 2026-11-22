import { moduleIds } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

/** Agent analyses: sources read again as the caller, figures worked out by the server. */
describe("BI agent analyses", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let priya: { cookie: string; userId: string };
  let orderId: string;

  const req = (cookie: string, method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, cookie, ...(json === undefined ? {} : { json }) });
  const ok = async (res: { status: number; json(): Promise<any> }, status = 200) => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const analysis = (overrides: Record<string, unknown> = {}) => ({
    title: "Cancel the Mill order",
    question: "What if we dropped the Mill order?",
    summary: "Cancelling removes all of the flour arriving this month.",
    scenarios: [
      { id: "now", label: "As things stand", assumptions: "The order arrives as promised." },
      { id: "cancel", label: "Cancel the order", assumptions: "The order is cancelled and not replaced." },
    ],
    sources: [{ id: "po", path: `/purchasing/orders/${orderId}`, note: "The Mill order" }],
    figures: [
      {
        id: "lines",
        label: "Order lines arriving",
        unit: "lines",
        values: {
          now: {
            formula: "count(q)",
            inputs: { q: { source: "po", path: "lines[*].quantity" } },
            expected: 2,
          },
          cancel: { formula: "0" },
        },
      },
      {
        id: "flour",
        label: "Flour arriving",
        values: {
          now: { formula: "q", inputs: { q: { source: "po", path: "lines[0].quantity" } } },
          cancel: { formula: "q - q", inputs: { q: { source: "po", path: "lines[0].quantity" } } },
        },
      },
    ],
    ...overrides,
  });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true, activeModules: moduleIds });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const login = async (email: string) => ({
      userId: members.find((x: { email: string }) => x.email === email).userId,
      cookie: (await signIn(ctx, email)).cookie,
    });
    marcus = await login("marcus@knotworking.dev");
    priya = await login("priya@knotworking.dev");
    const supplier = (await ok(await req(ada, "POST", "/suppliers", { name: "Mill" }), 201)).id;
    const item = async (code: string) =>
      (await ok(await req(ada, "POST", "/items", { code, name: code, type: "ingredient", unit: "kg" }), 201))
        .id;
    const [flour, sugar] = [await item("FLR"), await item("SUG")];
    orderId = (
      await ok(
        await req(ada, "POST", "/purchasing/orders", {
          supplierId: supplier,
          lines: [
            { itemId: flour, quantity: 25, unit: "kg", unitPrice: 0.9 },
            { itemId: sugar, quantity: 10, unit: "kg", unitPrice: 1.2 },
          ],
        }),
        201,
      )
    ).id;
  }, 120_000);
  afterAll(() => ctx.handle.close());

  it("shows an agent a source exactly as an analysis will cite it", async () => {
    const read = await ok(
      await req(ada, "GET", `/bi/sources?path=${encodeURIComponent(`/purchasing/orders/${orderId}`)}`),
    );
    expect(read).toMatchObject({ module: "purchasing", answer: { id: orderId } });
    expect(read.answer.lines).toHaveLength(2);
    for (const path of [
      "/attendance/shifts",
      "/bi/dashboards",
      "/members",
      "/nope",
      "/hse/incidents",
      `/sops/${orderId}/targets`,
      `/purchasing/./orders/${orderId}`,
      `/purchasing/orders/${orderId}/.`,
    ]) {
      const res = await req(ada, "GET", `/bi/sources?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(400);
    }
  });

  let id: string;
  it("verifies every cited value and works out every figure itself", async () => {
    const created = await ok(await req(ada, "POST", "/bi/analyses", analysis()), 201);
    id = created.id;
    const flour = created.analysis.figures.find((f: { id: string }) => f.id === "flour");
    expect(flour.values.cancel.value).toBe(0);
    expect(flour.values.now.value).toBeGreaterThan(0);
    expect(flour.values.now.inputs.q).toMatchObject({ source: "po", path: "lines[0].quantity" });
    expect(created.analysis.modules).toEqual(["purchasing"]);
    const read = await ok(await req(ada, "GET", `/bi/snapshots/${id}`));
    expect(read).toMatchObject({
      kind: "analysis",
      results: { analysis: { hidden: false, title: "Cancel the Mill order" } },
    });
  });

  it("refuses a value that isn't where it is cited, a wrong expected figure, and a source the caller can't read", async () => {
    const wrongPath = analysis();
    (wrongPath.figures as any)[1].values.now.inputs.q.path = "lines[9].quantity";
    const refused = await ok(await req(ada, "POST", "/bi/analyses", wrongPath), 400);
    expect(refused.error.details.issues[0]).toMatchObject({
      path: "figures[1].values.now.inputs.q",
      message: expect.stringContaining("2 entries"),
    });
    const wrongSum = analysis();
    (wrongSum.figures as any)[0].values.now.expected = 3;
    const sum = await ok(await req(ada, "POST", "/bi/analyses", wrongSum), 400);
    expect(sum.error.details.issues[0].path).toBe("figures[0].values.now.expected");
    // Marcus can't read purchasing: the source is read as him, and refused.
    const asMarcus = await ok(await req(marcus.cookie, "POST", "/bi/analyses", analysis()), 400);
    expect(asMarcus.error.details.issues[0]).toMatchObject({
      path: "sources[0]",
      message: expect.stringContaining("refused"),
    });
    // A token is held to its own module allowlist when its sources are read.
    const token = (
      await ok(
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "agent", scope: "write", modules: ["bi", "tasks"] },
        }),
        201,
      )
    ).token as string;
    const viaToken = await ctx.req(`${WS}/bi/analyses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "" },
      json: analysis(),
    });
    expect(viaToken.status).toBe(400);
    expect((await viaToken.json()).error.details.issues[0].path).toBe("sources[0]");
  });

  it("lets its author and managers open it, hiding figures from readers without every source's module", async () => {
    expect((await req(priya.cookie, "GET", `/bi/snapshots/${id}`)).status).toBe(404);
    await ok(await req(ada, "PUT", `/members/${priya.userId}/module-access/bi`, { level: "manage" }));
    await ok(await req(ada, "PUT", `/members/${priya.userId}/module-access/purchasing`, { level: "none" }));
    const hidden = await ok(await req(priya.cookie, "GET", `/bi/snapshots/${id}`));
    expect(hidden.results.analysis.hidden).toBe(true);
    // Nothing that could carry a figure or name a record: values, formulas, the summary, source paths.
    expect(hidden.results.analysis.figures[1].values.now).toEqual({ value: null, formula: "", inputs: {} });
    expect(hidden.results.analysis.summary).toBeNull();
    expect(hidden.results.analysis.sources[0]).toMatchObject({ id: "po", path: "" });
    expect(hidden.results.analysis.sources[0].note).toBeUndefined();
    expect(hidden.results.analysis.scenarios).toHaveLength(2);
    const mine = await ok(await req(ada, "GET", "/bi/snapshots?kind=analysis"));
    expect(mine.snapshots.map((s: { id: string }) => s.id)).toContain(id);
    expect((await ok(await req(marcus.cookie, "GET", "/bi/snapshots?kind=analysis"))).snapshots).toEqual([]);
  });

  it("goes into a board pack, where its audience sees it as issued", async () => {
    const pack = await ok(
      await req(ada, "POST", "/bi/packs", {
        title: "What if",
        asAt: "2026-11-20",
        items: [{ snapshotId: id }],
      }),
      201,
    );
    await ok(
      await req(ada, "POST", `/bi/packs/${pack.id}/issue`, {
        audience: "members",
        memberIds: [marcus.userId],
      }),
    );
    const view = await ok(await req(marcus.cookie, "GET", `/bi/packs/${pack.id}`));
    expect(view.items[0].snapshot.results.analysis.hidden).toBe(false);
    expect(view.items[0].snapshot.results.analysis.figures[0].values.now.value).toBe(2);
  });
});
