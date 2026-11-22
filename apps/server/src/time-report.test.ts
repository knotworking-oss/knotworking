import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

/** Minimal RFC 4180 parser, enough to read back what the export wrote. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return rows;
}

describe("time reports", () => {
  let ctx: TestCtx;
  let ada: string; // owner
  let marcus: string; // member
  let priya: string; // admin
  let guest: string;
  let readToken: string;
  let adaId: string;
  let marcusId: string;
  let priyaId: string;
  let teamId: string;
  let opsTeamId: string;
  let alphaId: string;
  let betaId: string;

  const base = "/v1/workspaces/acme";
  const week = "from=2026-11-02&to=2026-11-08";
  const report = async (query: string, cookie = ada) => {
    const res = await ctx.req(`${base}/time-report?${query}`, { cookie });
    expect(res.status, query).toBe(200);
    return res.json();
  };
  const csv = (query: string, cookie = ada) => ctx.req(`${base}/time-report.csv?${query}`, { cookie });
  const post = async (path: string, cookie: string, json: object) => {
    const res = await ctx.req(`${base}${path}`, { method: "POST", cookie, json });
    expect(res.status, path).toBeLessThan(300);
    return res.json();
  };
  const createTask = async (json: object) => (await post("/tasks", ada, { teamId, ...json })).id as string;
  const log = (taskId: string, cookie: string, json: object) =>
    post(`/tasks/${taskId}/time-entries`, cookie, json);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    priya = (await signIn(ctx, "priya@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${base}/members`, { cookie: ada })).json();
    const idOf = (email: string) => members.find((m: { email: string }) => m.email === email).userId;
    adaId = idOf("ada@knotworking.dev");
    marcusId = idOf("marcus@knotworking.dev");
    priyaId = idOf("priya@knotworking.dev");
    await ctx.req(`${base}/members/${priyaId}`, { method: "PATCH", cookie: ada, json: { role: "admin" } });
    const { url } = await (
      await ctx.req(`${base}/invitations`, {
        method: "POST",
        cookie: ada,
        json: { email: "guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;
    const tokenRes = await ctx.req("/v1/me/api-tokens", {
      method: "POST",
      cookie: ada,
      json: { name: "reports", scope: "read" },
    });
    readToken = (await tokenRes.json()).token;

    const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: ada })).json();
    teamId = boot.teams[0].id;
    opsTeamId = (await post("/teams", ada, { key: "RPT", name: "Operations" })).id;
    alphaId = (await post("/projects", ada, { name: "Alpha" })).id;
    betaId = (await post("/projects", ada, { name: "Beta" })).id;

    const a1 = await createTask({ title: "Alpha one", projectId: alphaId, estimateMinutes: 120 });
    const a2 = await createTask({ title: "Alpha two", projectId: alphaId });
    const b1 = (
      await post("/tasks", ada, {
        teamId: opsTeamId,
        title: "Beta one",
        projectId: betaId,
        estimateMinutes: 60,
      })
    ).id;
    const loose = await createTask({ title: "Loose", estimateMinutes: 30 });
    const gone = await createTask({ title: "Deleted task", projectId: alphaId, estimateMinutes: 999 });

    await log(a1, ada, { minutes: 60, entryDate: "2026-11-02" }); // first day of the week
    await log(a1, ada, { minutes: 30, entryDate: "2026-11-03", note: "=cmd|' /C calc'!A0" });
    await log(a1, marcus, { minutes: 45, entryDate: "2026-11-03" });
    await log(b1, ada, { minutes: 90, entryDate: "2026-11-04" });
    await log(loose, priya, { minutes: 15, entryDate: "2026-11-01" }); // the day before
    await log(loose, priya, { minutes: 10, entryDate: "2026-11-08" }); // last day of the week
    await log(a2, marcus, { minutes: 20, entryDate: "2026-11-09" }); // the day after
    await log(gone, ada, { minutes: 500, entryDate: "2026-11-03" });
    const removed = await log(a1, marcus, { minutes: 77, entryDate: "2026-11-03" });
    expect(
      (await ctx.req(`${base}/time-entries/${removed.id}`, { method: "DELETE", cookie: marcus })).status,
    ).toBe(204);
    expect((await ctx.req(`${base}/tasks/${gone}`, { method: "DELETE", cookie: ada })).status).toBe(204);
    // A timer that is still running has no minutes yet, so it is not in any report.
    await post(`/tasks/${a2}/timer`, priya, { entryDate: "2026-11-05" });
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("aggregation", () => {
    it("groups by project: finished entries in range only, deleted tasks and entries left out", async () => {
      const r = await report(`${week}&groupBy=project`);
      expect(r).toMatchObject({ from: "2026-11-02", to: "2026-11-08", groupBy: "project" });
      expect(r.groups).toEqual([
        {
          key: alphaId,
          name: "Alpha",
          loggedMinutes: 135,
          entryCount: 3,
          taskCount: 1,
          estimateMinutes: 120,
          loggedOnEstimatedMinutes: 135,
        },
        {
          key: betaId,
          name: "Beta",
          loggedMinutes: 90,
          entryCount: 1,
          taskCount: 1,
          estimateMinutes: 60,
          loggedOnEstimatedMinutes: 90,
        },
        {
          key: null,
          name: "No project",
          loggedMinutes: 10,
          entryCount: 1,
          taskCount: 1,
          estimateMinutes: 30,
          loggedOnEstimatedMinutes: 10,
        },
      ]);
      expect(r.totals).toEqual({
        loggedMinutes: 235,
        entryCount: 5,
        taskCount: 3,
        estimateMinutes: 210,
        loggedOnEstimatedMinutes: 235,
      });
    });

    it("defaults to grouping by project", async () => {
      const r = await report(week);
      expect(r.groupBy).toBe("project");
      expect(r.groups).toHaveLength(3);
    });

    it("includes both boundary days and nothing outside them", async () => {
      const first = await report("from=2026-11-02&to=2026-11-02");
      expect(first.totals).toMatchObject({ loggedMinutes: 60, entryCount: 1 });
      const last = await report("from=2026-11-08&to=2026-11-08");
      expect(last.totals).toMatchObject({ loggedMinutes: 10, entryCount: 1 });
      const empty = await report("from=2026-11-05&to=2026-11-07");
      expect(empty.groups).toEqual([]);
      expect(empty.totals).toEqual({
        loggedMinutes: 0,
        entryCount: 0,
        taskCount: 0,
        estimateMinutes: 0,
        loggedOnEstimatedMinutes: 0,
      });
      // The entries just outside the week appear when the range widens by a day on each side.
      expect((await report("from=2026-11-01&to=2026-11-09")).totals.loggedMinutes).toBe(235 + 15 + 20);
    });

    it("groups by person, without estimates (a task's estimate can't be split between people)", async () => {
      const r = await report(`${week}&groupBy=person`);
      expect(r.groups).toEqual([
        {
          key: adaId,
          name: "Ada Park",
          loggedMinutes: 180,
          entryCount: 3,
          taskCount: 2,
          estimateMinutes: null,
          loggedOnEstimatedMinutes: 0,
        },
        {
          key: marcusId,
          name: expect.any(String),
          loggedMinutes: 45,
          entryCount: 1,
          taskCount: 1,
          estimateMinutes: null,
          loggedOnEstimatedMinutes: 0,
        },
        {
          key: priyaId,
          name: expect.any(String),
          loggedMinutes: 10,
          entryCount: 1,
          taskCount: 1,
          estimateMinutes: null,
          loggedOnEstimatedMinutes: 0,
        },
      ]);
      expect(r.totals.estimateMinutes).toBe(210); // each task once
    });

    it("groups by day, oldest first", async () => {
      const r = await report(`${week}&groupBy=day`);
      expect(r.groups.map((g: { key: string; loggedMinutes: number }) => [g.key, g.loggedMinutes])).toEqual([
        ["2026-11-02", 60],
        ["2026-11-03", 75],
        ["2026-11-04", 90],
        ["2026-11-08", 10],
      ]);
      expect(r.groups[1]).toMatchObject({ entryCount: 2, taskCount: 1, estimateMinutes: null });
    });

    it("groups by task with each task's estimate", async () => {
      const r = await report(`${week}&groupBy=task`);
      expect(
        r.groups.map((g: { name: string; loggedMinutes: number; estimateMinutes: number | null }) => [
          g.name,
          g.loggedMinutes,
          g.estimateMinutes,
        ]),
      ).toEqual([
        ["Alpha one", 135, 120],
        ["Beta one", 90, 60],
        ["Loose", 10, 30],
      ]);
      expect(r.groups.every((g: { taskCount: number }) => g.taskCount === 1)).toBe(true);
    });

    it("keeps time on unestimated tasks out of the estimate comparison", async () => {
      const r = await report("from=2026-11-01&to=2026-11-30&groupBy=project");
      const alpha = r.groups.find((g: { key: string | null }) => g.key === alphaId);
      // Alpha two has 20 minutes and no estimate: it adds to the total, not to the comparison.
      expect(alpha).toMatchObject({
        loggedMinutes: 155,
        estimateMinutes: 120,
        loggedOnEstimatedMinutes: 135,
      });
      const tasks = await report("from=2026-11-01&to=2026-11-30&groupBy=task");
      expect(tasks.groups.find((g: { name: string }) => g.name === "Alpha two")).toMatchObject({
        loggedMinutes: 20,
        estimateMinutes: null,
        loggedOnEstimatedMinutes: 0,
      });
    });

    it("agrees with the project time route over the same days", async () => {
      const res = await ctx.req(`${base}/projects/${alphaId}/time`, { cookie: marcus });
      const time = await res.json();
      const r = await report(`from=2026-11-01&to=2026-11-30&projectId=${alphaId}`, marcus);
      expect(r.totals.loggedMinutes).toBe(time.loggedMinutes);
      expect(r.groups[0].estimateMinutes).toBe(time.estimateMinutes);
    });

    it("filters by project, team and person, combined with AND", async () => {
      expect((await report(`${week}&projectId=${alphaId}`)).totals.loggedMinutes).toBe(135);
      expect((await report(`${week}&teamId=${opsTeamId}`)).totals.loggedMinutes).toBe(90);
      expect((await report(`${week}&teamId=${teamId}`)).totals.loggedMinutes).toBe(145);
      expect((await report(`${week}&userId=${marcusId}`)).totals.loggedMinutes).toBe(45);
      expect((await report(`${week}&userId=${adaId}&projectId=${alphaId}`)).totals).toMatchObject({
        loggedMinutes: 90,
        entryCount: 2,
      });
      expect((await report(`${week}&userId=${marcusId}&teamId=${opsTeamId}`)).groups).toEqual([]);
      // An id that matches nothing is an empty report, not an error.
      const nobody = "01900000-0000-7000-8000-000000000000";
      expect((await report(`${week}&projectId=${nobody}`)).totals.loggedMinutes).toBe(0);
    });

    it("counts a task's time once it is moved between projects as the task is now", async () => {
      const t = await createTask({ title: "Mover", projectId: betaId });
      await log(t, ada, { minutes: 11, entryDate: "2026-12-01" });
      const before = await report("from=2026-12-01&to=2026-12-01&groupBy=project");
      expect(before.groups).toMatchObject([{ key: betaId, loggedMinutes: 11 }]);
      await ctx.req(`${base}/tasks/${t}`, { method: "PATCH", cookie: ada, json: { projectId: alphaId } });
      const after = await report("from=2026-12-01&to=2026-12-01&groupBy=project");
      expect(after.groups).toMatchObject([{ key: alphaId, loggedMinutes: 11 }]);
    });
  });

  describe("validation", () => {
    const bad = async (query: string) => {
      const res = await ctx.req(`${base}/time-report?${query}`, { cookie: ada });
      expect(res.status, query).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_input");
    };

    it("requires a valid range with from <= to", async () => {
      await bad("");
      await bad("from=2026-11-02");
      await bad("to=2026-11-02");
      await bad("from=2026-11-08&to=2026-11-02");
      await bad("from=2026-02-30&to=2026-03-02");
      await bad("from=yesterday&to=today");
      await bad("from=2026-11-02T00:00:00Z&to=2026-11-08");
    });

    it("limits the range to 366 days", async () => {
      expect(
        (await ctx.req(`${base}/time-report?from=2025-01-01&to=2026-01-01`, { cookie: ada })).status,
      ).toBe(200);
      await bad("from=2025-01-01&to=2026-01-02");
      await bad("from=2000-01-01&to=2026-01-01");
    });

    it("rejects unknown groupings and malformed ids", async () => {
      await bad(`${week}&groupBy=weekday`);
      await bad(`${week}&projectId=not-a-uuid`);
      await bad(`${week}&teamId=1`);
      await bad(`${week}&userId=`);
    });

    it("validates the CSV export the same way", async () => {
      expect((await csv("from=2026-11-08&to=2026-11-02")).status).toBe(400);
      expect((await csv("")).status).toBe(400);
    });
  });

  describe("permissions", () => {
    it("lets every role read the same report: it only aggregates what entries already expose", async () => {
      const q = `${week}&groupBy=person`;
      const asOwner = await report(q, ada);
      expect(await report(q, priya)).toEqual(asOwner);
      expect(await report(q, marcus)).toEqual(asOwner);
      expect(await report(q, guest)).toEqual(asOwner);
      // ...which is what a member can read through the entries routes and the bootstrap anyway.
      const boot = await (await ctx.req(`${base}/bootstrap`, { cookie: guest })).json();
      const seen = boot.timeEntries.filter(
        (e: { userId: string; entryDate: string; minutes: number | null }) =>
          e.userId === adaId &&
          e.minutes !== null &&
          e.entryDate >= "2026-11-02" &&
          e.entryDate <= "2026-11-08",
      );
      expect(seen.reduce((s: number, e: { minutes: number }) => s + e.minutes, 0)).toBe(180);
    });

    it("works with API tokens, JSON and CSV, and needs some credential", async () => {
      const headers = { authorization: `Bearer ${readToken}`, origin: "" };
      const json = await ctx.req(`${base}/time-report?${week}`, { headers });
      expect(json.status).toBe(200);
      expect((await json.json()).totals.loggedMinutes).toBe(235);
      const file = await ctx.req(`${base}/time-report.csv?${week}`, { headers });
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("text/csv");
      expect((await ctx.req(`${base}/time-report?${week}`, { headers: { origin: "" } })).status).toBe(401);
      expect((await ctx.req(`${base}/time-report.csv?${week}`, { headers: { origin: "" } })).status).toBe(
        401,
      );
    });

    it("never includes email addresses", async () => {
      for (const cookie of [ada, guest]) {
        const body = await (await ctx.req(`${base}/time-report?${week}&groupBy=person`, { cookie })).text();
        expect(body).not.toContain("@");
        expect(await (await csv(week, cookie)).text()).not.toContain("@knotworking.dev");
      }
    });

    it("is read-only: guests still can't log time", async () => {
      const res = await ctx.req(`${base}/time-report?${week}`, { method: "POST", cookie: guest, json: {} });
      // No such write route (404/405); the module gate refuses a guest write first (403 read_only).
      expect([403, 404, 405]).toContain(res.status);
    });
  });

  describe("CSV export", () => {
    it("sends a download with a safe name and no caching", async () => {
      const res = await csv(week);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="time-report-acme-2026-11-02-to-2026-11-08.csv"',
      );
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("has one row per finished entry, oldest first, matching the report", async () => {
      const rows = parseCsv(await (await csv(week)).text());
      expect(rows[0]).toEqual(["Date", "Person", "Project", "Team", "Task", "Minutes", "Hours", "Note"]);
      const body = rows.slice(1);
      expect(body).toHaveLength(5);
      expect(body.map((r) => r[0])).toEqual([
        "2026-11-02",
        "2026-11-03",
        "2026-11-03",
        "2026-11-04",
        "2026-11-08",
      ]);
      expect(body[0]).toEqual([
        "2026-11-02",
        "Ada Park",
        "Alpha",
        expect.any(String),
        "Alpha one",
        "60",
        "1.00",
        "",
      ]);
      expect(body[3]).toEqual(["2026-11-04", "Ada Park", "Beta", "Operations", "Beta one", "90", "1.50", ""]);
      expect(body[4]![2]).toBe("No project");
      expect(body.reduce((s, r) => s + Number(r[5]), 0)).toBe(235);
      // Excluded: running timer, deleted entry, deleted task, entries outside the range.
      expect(body.some((r) => r[4] === "Deleted task")).toBe(false);
      expect(body.some((r) => r[5] === "77" || r[5] === "500")).toBe(false);
    });

    it("applies the same filters as the report", async () => {
      const rows = parseCsv(await (await csv(`${week}&userId=${marcusId}`)).text()).slice(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]![5]).toBe("45");
      expect(parseCsv(await (await csv(`${week}&teamId=${opsTeamId}`)).text()).slice(1)).toHaveLength(1);
      expect(parseCsv(await (await csv(`${week}&projectId=${alphaId}`)).text()).slice(1)).toHaveLength(3);
      // No entries: just the header.
      expect(parseCsv(await (await csv("from=2026-11-05&to=2026-11-07")).text())).toHaveLength(1);
    });

    it("neutralises spreadsheet formulas in every text cell", async () => {
      const text = await (await csv(week)).text();
      expect(text).toContain("'=cmd|' /C calc'!A0");
      expect(text).not.toMatch(/(^|,)=cmd/m);

      const t = await createTask({ title: "@SUM(A1)" });
      await log(t, ada, { minutes: 5, entryDate: "2026-12-10", note: "+1 line" });
      const t2 = await createTask({ title: "-2+3" });
      await log(t2, ada, { minutes: 5, entryDate: "2026-12-10", note: "   =1+1" });
      const rows = parseCsv(await (await csv("from=2026-12-10&to=2026-12-10")).text()).slice(1);
      expect(rows.map((r) => [r[4], r[7]])).toEqual(
        expect.arrayContaining([
          ["'@SUM(A1)", "'+1 line"],
          ["'-2+3", "'=1+1"],
        ]),
      );
      for (const r of rows) for (const cell of r) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    });

    it("quotes commas, quotes and line breaks so rows stay intact", async () => {
      const t = await createTask({ title: 'Say "hi", then leave' });
      await log(t, ada, { minutes: 7, entryDate: "2026-12-11", note: "line one\nline two, with comma" });
      const text = await (await csv("from=2026-12-11&to=2026-12-11")).text();
      expect(text).toContain('"Say ""hi"", then leave"');
      expect(text).toContain('"line one\nline two, with comma"');
      const rows = parseCsv(text);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toHaveLength(8);
      expect(rows[1]![4]).toBe('Say "hi", then leave');
      expect(rows[1]![7]).toBe("line one\nline two, with comma");
      expect(text.endsWith("\r\n")).toBe(true);
    });
  });
});
