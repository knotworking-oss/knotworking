import { addWeeks, DEFAULT_TIME_ZONE, parseActiveModules, todayInZone, weekStart } from "@knotworking/core";
import { demandLines } from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const thisWeek = weekStart(todayInZone(DEFAULT_TIME_ZONE));

describe("demand module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const grant = (moduleId: string, level: string | null) =>
    ctx.req(`${WS}/members/${marcus.userId}/module-access/${moduleId}`, {
      method: "PUT",
      cookie: ada,
      json: { level },
    });
  const ok = async (res: Awaited<ReturnType<TestCtx["req"]>>, status = 200) => {
    const body = res.status === 204 ? null : await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const setLines = (lines: object[], cookie = ada) => as(cookie).send("PUT", "/demand/lines", { lines });
  const summary = async (query: string) => ok(await as(ada).get(`/demand/summary?${query}`));

  // Fixtures.
  let cake: string; // finished, each, 450 g each
  let soup: string; // finished, l
  let dough: string; // wip, kg

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "sales feed", scope: "write" },
        })
      ).json()
    ).token;
    const item = async (body: object) => (await ok(await as(ada).send("POST", "/items", body), 201)).id;
    cake = await item({
      code: "CAKE-1",
      name: "Lemon cake",
      type: "finished",
      unit: "each",
      unitWeightG: 450,
    });
    soup = await item({ code: "SOUP-1", name: "Tomato soup", type: "finished", unit: "l" });
    dough = await item({ code: "DGH-1", name: "Sweet dough", type: "wip", unit: "kg" });
    await item({ code: "FLR-1", name: "Flour", type: "ingredient", unit: "kg" });
    const old = await item({ code: "OLD-1", name: "Old cake", type: "finished", unit: "each" });
    await ok(await as(ada).send("PATCH", `/items/${old}`, { status: "archived" }));
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in, needs the items module too, and read can't write", async () => {
      expect((await as(marcus.cookie).get("/demand/summary")).status).toBe(403);
      await grant("demand", "read");
      expect((await as(marcus.cookie).get("/demand/summary")).status).toBe(403);
      await grant("items", "read");
      expect((await as(marcus.cookie).get("/demand/summary")).status).toBe(200);
      const write = await setLines([{ itemCode: "CAKE-1", period: "2030-W10", quantity: 1 }], marcus.cookie);
      expect(write.status).toBe(403);
      await grant("demand", "write");
    });

    it("is switched off with the module, and can't be on without items", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs", "items"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/demand/summary`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
      expect(() => parseActiveModules("tasks,demand")).toThrow(/needs "items"/);
    }, 60_000);
  });

  describe("setting lines", () => {
    it("creates lines by item code or id, converting the quantity to the base unit", async () => {
      const body = await ok(
        await setLines(
          [
            { itemCode: "cake-1", period: "2030-03-06", quantity: 120 },
            { itemCode: "CAKE-1", period: "2030-W10", quantity: 45, unit: "kg", customer: " Tesco " },
            { itemId: soup, period: "2030-W10", quantity: 500, unit: "ml", note: "trial" },
            { itemId: dough, period: "2030-W11", quantity: 2500, unit: "g" },
          ],
          marcus.cookie,
        ),
      );
      expect(body).toMatchObject({ created: 4, updated: 0, removed: 0, unchanged: 0 });
      expect(body.lines.map((l: any) => [l.action, l.line.periodStart, l.line.week, l.line.amount])).toEqual([
        [
          "create",
          "2030-03-04",
          "2030-W10",
          { base: 120, baseUnit: "each", display: 120, displayUnit: "each" },
        ],
        [
          "create",
          "2030-03-04",
          "2030-W10",
          { base: 100, baseUnit: "each", display: 100, displayUnit: "each" },
        ],
        ["create", "2030-03-04", "2030-W10", { base: 500, baseUnit: "ml", display: 0.5, displayUnit: "l" }],
        ["create", "2030-03-11", "2030-W11", { base: 2500, baseUnit: "g", display: 2.5, displayUnit: "kg" }],
      ]);
      expect(body.lines[1].line).toMatchObject({
        customer: "Tesco",
        source: "manual",
        item: { code: "CAKE-1" },
      });
      expect(body.lines[2].line.note).toBe("trial");
      expect(body.lines[0].line.workspaceId).toBeUndefined();
    });

    it("is idempotent per item, week and customer: re-sending changes nothing, a new quantity replaces", async () => {
      const again = await ok(
        await setLines([
          { itemCode: "CAKE-1", period: "2030-03-08", quantity: 100, customer: "TESCO" },
          { itemCode: "CAKE-1", period: "2030-W10", quantity: 130 },
        ]),
      );
      expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
      expect(again.lines[0].line.customer).toBe("Tesco"); // the stored spelling stays
      expect(again.lines[1].line).toMatchObject({ amount: { base: 130 } });
      const { lines, total } = await ok(await as(ada).get("/demand/lines?itemId=" + cake));
      expect(total).toBe(2);
      expect(lines.map((l: any) => [l.customer, l.amount.base, l.createdByName, l.updatedByName])).toEqual([
        [null, 130, "Marcus Chen", "Ada Park"],
        ["Tesco", 100, "Marcus Chen", "Marcus Chen"],
      ]);
    });

    it("removes a line with quantity null, and keeps its history", async () => {
      const { lines } = await ok(await as(ada).get("/demand/lines?itemId=" + soup));
      const removed = await ok(await setLines([{ itemId: soup, period: "2030-W10", quantity: null }]));
      expect(removed).toMatchObject({ removed: 1, lines: [{ action: "remove", line: null }] });
      expect((await ok(await as(ada).get("/demand/lines?itemId=" + soup))).total).toBe(0);
      const nothing = await ok(await setLines([{ itemId: soup, period: "2030-W10", quantity: null }]));
      expect(nothing).toMatchObject({ removed: 0, unchanged: 1 });

      await ok(await setLines([{ itemId: soup, period: "2030-W10", quantity: 2 }]));
      const history = await ok(await as(ada).get(`/demand/lines/${lines[0].id}/history`));
      expect(history.line.removed).toBe(true);
      expect(
        history.history.map((h: any) => [h.action, h.previous?.display ?? null, h.amount?.display ?? null]),
      ).toEqual([
        ["create", null, 2],
        ["remove", 0.5, null],
        ["create", null, 0.5],
      ]);
      expect(history.history[1]).toMatchObject({ actorName: "Ada Park", source: "manual" });
    });

    it("checks every line and writes nothing when any is wrong", async () => {
      const res = await setLines([
        { itemCode: "CAKE-1", period: "2030-W12", quantity: 5 },
        { itemCode: "NOPE", period: "2030-W12", quantity: 5 },
        { itemCode: "FLR-1", period: "2030-W12", quantity: 5 },
        { itemCode: "OLD-1", period: "2030-W12", quantity: 5 },
        { itemCode: "DGH-1", period: "2030-W12", quantity: 5, unit: "each" },
        { itemCode: "cake-1", period: "2030-03-20", quantity: 6 },
      ]);
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error.code).toBe("invalid_rows");
      expect(error.message).toMatch(/^5 lines have problems; nothing was saved\. Line 2 \(item\): No item/);
      expect(error.details.errors.map((e: any) => [e.row, e.column])).toEqual([
        [2, "item"],
        [3, "item"],
        [4, "item"],
        [5, "unit"],
        [6, "item"],
      ]);
      expect((await ok(await as(ada).get("/demand/lines?from=2030-W12&to=2030-W12"))).total).toBe(0);

      const schema = await setLines([{ itemCode: "CAKE-1", period: "someday", quantity: 1 }]);
      expect(schema.status).toBe(400);
      expect((await schema.json()).error.code).toBe("invalid_input");
    });

    it("lets an API token post demand (source api) and remove a line", async () => {
      const body = await ok(
        await viaToken("PUT", "/demand/lines", {
          lines: [
            {
              itemCode: "DGH-1",
              period: "2030-W12",
              quantity: 4,
              customer: "Wholesale",
              externalRef: "SO-77",
            },
          ],
        }),
      );
      expect(body.lines[0].line).toMatchObject({ source: "api", externalRef: "SO-77" });
      const del = await viaToken("DELETE", `/demand/lines/${body.lines[0].line.id}`);
      expect(del.status).toBe(204);
      expect((await viaToken("DELETE", `/demand/lines/${body.lines[0].line.id}`)).status).toBe(404);
      const history = await ok(await as(ada).get(`/demand/lines/${body.lines[0].line.id}/history`));
      expect(history.history.map((h: any) => [h.action, h.source])).toEqual([
        ["remove", "api"],
        ["create", "api"],
      ]);
    });

    it("writes to the sync log, filtered by module access", async () => {
      const { cursor } = await ok(await ctx.req(`${WS}/sync?after=0`, { cookie: ada }));
      const set = await ok(await setLines([{ itemCode: "CAKE-1", period: "2030-W13", quantity: 7 }]));
      const changes = (await ok(await ctx.req(`${WS}/sync?after=${cursor}`, { cookie: ada }))).changes;
      expect(changes).toEqual([
        expect.objectContaining({ entity: "demand_line", entityId: set.lines[0].line.id, action: "upsert" }),
      ]);
      await grant("demand", "none");
      const hidden = (await ok(await ctx.req(`${WS}/sync?after=${cursor}`, { cookie: marcus.cookie })))
        .changes;
      expect(hidden.filter((c: { entity: string }) => c.entity.startsWith("demand"))).toEqual([]);
      await grant("demand", "write");
      const boot = await ok(await ctx.req(`${WS}/bootstrap`, { cookie: ada }));
      expect(JSON.stringify(boot)).not.toContain("demand_line");
    });
  });

  describe("reading", () => {
    it("lists lines with filters and paging", async () => {
      const all = await ok(await as(ada).get("/demand/lines?from=2030-W10&to=2030-W11"));
      expect(all.lines.map((l: any) => [l.week, l.item.code, l.customer])).toEqual([
        ["2030-W10", "CAKE-1", null],
        ["2030-W10", "CAKE-1", "Tesco"],
        ["2030-W10", "SOUP-1", null],
        ["2030-W11", "DGH-1", null],
      ]);
      expect((await ok(await as(ada).get("/demand/lines?customer=tesco"))).lines).toHaveLength(1);
      expect((await ok(await as(ada).get("/demand/lines?q=soup"))).total).toBe(1);
      expect((await ok(await as(ada).get("/demand/lines?itemCode=dgh-1"))).total).toBe(1);
      expect((await ok(await as(ada).get("/demand/lines?source=api"))).total).toBe(0);
      const page = await ok(await as(ada).get("/demand/lines?limit=2&offset=1"));
      expect([page.lines.length, page.total, page.offset]).toEqual([2, 5, 1]);
    });

    it("sums demand per item per week, optionally by customer", async () => {
      const total = await summary("from=2030-W10&to=2030-W12");
      expect(total.weeks.map((w: any) => w.week)).toEqual(["2030-W10", "2030-W11", "2030-W12"]);
      expect(
        total.rows.map((r: any) => [
          r.item.code,
          r.customer,
          r.periods.map((p: any) => [p.week, p.quantity.base, p.lineCount]),
        ]),
      ).toEqual([
        ["CAKE-1", null, [["2030-W10", 230, 2]]],
        ["DGH-1", null, [["2030-W11", 2500, 1]]],
        ["SOUP-1", null, [["2030-W10", 2000, 1]]],
      ]);
      expect(total.rows[0].total).toEqual({ base: 230, baseUnit: "each", display: 230, displayUnit: "each" });

      const split = await summary("from=2030-W10&to=2030-W10&byCustomer=true&itemId=" + cake);
      expect(split.rows.map((r: any) => [r.customer, r.total.base])).toEqual([
        [null, 130],
        ["Tesco", 100],
      ]);
      expect((await summary("from=2030-W10&to=2030-W12&itemType=wip")).rows).toHaveLength(1);
      expect((await summary("from=2030-W10&to=2030-W12&itemCode=soup-1")).rows[0].item.code).toBe("SOUP-1");
    });

    it("defaults to twelve weeks from this week and refuses ranges over two years", async () => {
      await ok(await setLines([{ itemCode: "CAKE-1", period: addWeeks(thisWeek, 1), quantity: 3 }]));
      const now = await summary("");
      expect(now.from).toBe(thisWeek);
      expect(now.to).toBe(addWeeks(thisWeek, 11));
      expect(now.weeks).toHaveLength(12);
      expect(now.rows.map((r: any) => r.periods[0].periodStart)).toEqual([addWeeks(thisWeek, 1)]);
      const long = await as(ada).get("/demand/summary?from=2030-W01&to=2032-W10");
      expect(long.status).toBe(400);
      expect((await as(ada).get("/demand/summary?from=2030-W12&to=2030-W10")).status).toBe(400);
    });
  });

  describe("CSV import", () => {
    const csv = (rows: string[]) =>
      ["Product code,Week commencing,Qty,Unit,Customer,Description", ...rows].join("\r\n");

    it("previews a dry run with every problem and writes nothing", async () => {
      const res = await as(marcus.cookie).send("POST", "/demand/imports", {
        dryRun: true,
        fileName: "forecast.csv",
        csv: csv([
          "CAKE-1,04/03/2030,130,,,Lemon",
          "CAKE-1,2030-W14,10,,Asda,Lemon",
          "NOPE,2030-W14,1,,,",
          "SOUP-1,2030-W14,-1,,,",
          "DGH-1,2030-W14,1,each,,",
        ]),
      });
      const body = await ok(res);
      expect(body).toMatchObject({
        dryRun: true,
        rowCount: 5,
        ignoredColumns: ["Description"],
        import: null,
      });
      expect(body.errors).toEqual([
        { row: 4, column: "item", message: 'No item has the code "NOPE"' },
        { row: 5, column: "quantity", message: '"-1" is not a quantity of 0 or more' },
        { row: 6, column: "unit", message: expect.stringMatching(/DGH-1 is measured in kg/) },
      ]);
      expect((await ok(await as(ada).get("/demand/lines?from=2030-W14&to=2030-W14"))).total).toBe(0);

      const failed = await as(marcus.cookie).send("POST", "/demand/imports", {
        csv: csv(["NOPE,2030-W14,1,,,"]),
      });
      expect(failed.status).toBe(400);
      expect((await failed.json()).error).toMatchObject({
        code: "invalid_rows",
        message: expect.stringMatching(/^1 row has problems; nothing was saved\. Row 2 \(item\)/),
      });
    });

    it("previews changes, then imports them in one go with source import", async () => {
      const file = csv([
        "CAKE-1,04/03/2030,130,,,Lemon", // unchanged
        "CAKE-1,2030-W10,90,each,tesco,", // update (customer matched case-insensitively)
        "CAKE-1,2030-W14,9,kg,Asda,", // create, 9 kg at 450 g = 20 each
        "SOUP-1,2030-W14,0,,,", // create with zero
      ]);
      const preview = await ok(
        await as(marcus.cookie).send("POST", "/demand/imports", { dryRun: true, csv: file }),
      );
      expect(preview).toMatchObject({ errors: [], created: 2, updated: 1, unchanged: 1 });
      expect(
        preview.changes.map((c: any) => [c.row, c.action, c.week, c.amount.base, c.previous?.base ?? null]),
      ).toEqual([
        [3, "update", "2030-W10", 90, 100],
        [4, "create", "2030-W14", 20, null],
        [5, "create", "2030-W14", 0, null],
      ]);

      const done = await ok(
        await as(marcus.cookie).send("POST", "/demand/imports", { csv: file, fileName: "forecast.csv" }),
        201,
      );
      expect(done).toMatchObject({ dryRun: false, created: 2, updated: 1, unchanged: 1 });
      expect(done.import).toMatchObject({
        fileName: "forecast.csv",
        rowCount: 4,
        createdCount: 2,
        updatedCount: 1,
      });
      const imported = await ok(await as(ada).get(`/demand/lines?importId=${done.import.id}`));
      expect(imported.lines.map((l: any) => [l.week, l.customer, l.source])).toEqual([
        ["2030-W10", "Tesco", "import"],
        ["2030-W14", "Asda", "import"],
        ["2030-W14", null, "import"],
      ]);
      // The unchanged row keeps its source.
      const kept = await ok(await as(ada).get(`/demand/lines?from=2030-W10&to=2030-W10&itemId=${cake}`));
      expect(kept.lines.find((l: any) => l.customer === null).source).toBe("manual");

      const again = await ok(await as(marcus.cookie).send("POST", "/demand/imports", { csv: file }), 201);
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 4, changes: [] });

      const { imports, total } = await ok(await as(ada).get("/demand/imports"));
      expect(total).toBe(2);
      expect(imports[0]).toMatchObject({ unchangedCount: 4, actorName: "Marcus Chen" });
    });

    it("replaces a horizon only when asked: the file's customers' missing lines are removed, with history", async () => {
      await ok(
        await setLines([
          { itemCode: "CAKE-1", period: "2031-W10", quantity: 10 },
          { itemCode: "CAKE-1", period: "2031-W10", customer: "Tesco", quantity: 20 },
          { itemCode: "SOUP-1", period: "2031-W11", quantity: 5 },
          { itemCode: "SOUP-1", period: "2031-W12", quantity: 6 },
          { itemCode: "CAKE-1", period: "2031-W20", quantity: 7 },
        ]),
      );
      const file = "item,period,quantity\nCAKE-1,2031-W10,10\nCAKE-1,2031-W12,3\n";

      // Without the flag a file never removes anything.
      const plain = await ok(await as(ada).send("POST", "/demand/imports", { csv: file, dryRun: true }));
      expect(plain).toMatchObject({ removed: 0, horizon: null, created: 1 });

      const preview = await ok(
        await as(ada).send("POST", "/demand/imports", { csv: file, dryRun: true, replaceHorizon: true }),
      );
      expect(preview).toMatchObject({
        dryRun: true,
        created: 1,
        removed: 2,
        unchanged: 1,
        horizon: { fromWeek: "2031-W10", toWeek: "2031-W12" },
      });
      expect(
        preview.changes
          .filter((c: any) => c.action === "remove")
          .map((c: any) => [c.week, c.item.code, c.customer]),
      ).toEqual([
        // Tesco's line stays: the file only speaks for demand without a customer.
        ["2031-W11", "SOUP-1", null],
        ["2031-W12", "SOUP-1", null],
      ]);
      // Nothing written by a preview.
      expect((await ok(await as(ada).get("/demand/lines?from=2031-W10&to=2031-W12"))).total).toBe(4);

      const done = await ok(
        await as(ada).send("POST", "/demand/imports", { csv: file, replaceHorizon: true }),
        201,
      );
      expect(done).toMatchObject({ created: 1, removed: 2, import: { removedCount: 2 } });
      const left = await ok(await as(ada).get("/demand/lines?from=2031-W10&to=2031-W20"));
      expect(left.lines.map((l: any) => [l.week, l.item.code, l.customer])).toEqual([
        ["2031-W10", "CAKE-1", null],
        ["2031-W10", "CAKE-1", "Tesco"],
        ["2031-W12", "CAKE-1", null],
        ["2031-W20", "CAKE-1", null], // outside the file's range
      ]);

      // History keeps the removal, and the sync log carries the delete.
      const gone = (await ok(await as(ada).get("/demand/lines?from=2031-W11&to=2031-W11"))).lines;
      expect(gone).toEqual([]);
      const week11 = await ctx.handle.db
        .select()
        .from(demandLines)
        .where(eq(demandLines.periodStart, "2031-03-10"));
      const removed = week11.find((l) => l.customer === null);
      expect(removed?.deletedAt).not.toBeNull();
      const hist = await ok(await as(ada).get(`/demand/lines/${removed!.id}/history`));
      expect(hist.history[0]).toMatchObject({ action: "remove", source: "import", importId: done.import.id });

      // A Tesco file replaces Tesco's demand in its weeks and nobody else's.
      const tescoFile = "item,period,customer,quantity\nSOUP-1,2031-W10,tesco,1\nSOUP-1,2031-W12,Tesco,2\n";
      const tescoDone = await ok(
        await as(ada).send("POST", "/demand/imports", { csv: tescoFile, replaceHorizon: true }),
        201,
      );
      expect(tescoDone).toMatchObject({ created: 2, removed: 1 });
      const after = await ok(await as(ada).get("/demand/lines?from=2031-W10&to=2031-W12"));
      expect(after.lines.map((l: any) => [l.week, l.item.code, l.customer])).toEqual([
        ["2031-W10", "CAKE-1", null],
        ["2031-W10", "SOUP-1", "tesco"],
        ["2031-W12", "CAKE-1", null],
        ["2031-W12", "SOUP-1", "Tesco"],
      ]);
    });

    it("removes nothing when the file has problems", async () => {
      const bad = await as(ada).send("POST", "/demand/imports", {
        csv: "item,period,quantity\nCAKE-1,2031-W10,10\nNOPE,2031-W12,1\n",
        replaceHorizon: true,
      });
      expect(bad.status).toBe(400);
      expect((await ok(await as(ada).get("/demand/lines?from=2031-W10&to=2031-W20"))).total).toBe(5);
    });

    it("refuses files without the required columns", async () => {
      const body = await ok(
        await as(ada).send("POST", "/demand/imports", { dryRun: true, csv: "sku,amount\nCAKE-1,3" }),
      );
      expect(body.errors).toEqual([expect.objectContaining({ row: 1, column: "period" })]);
    });
  });
});
