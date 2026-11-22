import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

/**
 * Clause wording here is placeholder text: a real standard's text comes from the workspace's own
 * licensed copy and never ships with the software.
 */
const csv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
const HEAD = ["Clause", "Title", "Text", "Section title", "Fundamental"];

describe("standards gap analysis (G1)", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let marcus: { cookie: string; userId: string };
  let teamId: string;
  let standard: string;
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
  const gaps = async (query = "") => ok(await call("GET", `/governance/standards/${standard}${query}`));
  const clauseId = async (ref: string) =>
    (await gaps()).clauses.find((c: { ref: string }) => c.ref === ref).id as string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const a = await signIn(ctx, "ada@knotworking.dev");
    ada = a.cookie;
    adaId = (await ok(await ctx.req("/v1/me", { cookie: ada }))).user.id;
    const { members } = await ok(await call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    await ok(await call("PUT", `/members/${m.userId}/module-access/governance`, { level: "write" }));
    const boot = await ok(await call("GET", "/bootstrap"));
    teamId = boot.teams[0].id;
  });

  it("keeps a library of standards by issue; only manage adds them", async () => {
    const created = await ok(
      await call("POST", "/governance/standards", {
        code: "BRCGS-FS",
        name: "BRCGS Global Standard Food Safety",
        issue: "9",
        publisher: "BRCGS",
      }),
      201,
    );
    standard = created.id;
    expect(
      await code(
        await call("POST", "/governance/standards", { code: "brcgs-fs", name: "Again", issue: "9" }),
        409,
      ),
    ).toBe("standard_exists");
    expect(
      await code(
        await call("POST", "/governance/standards", { code: "X", name: "X", issue: "1" }, marcus.cookie),
        403,
      ),
    ).toBeTruthy();
  });

  it("imports clauses from the workspace's own copy, all or nothing, and corrects them on re-import", async () => {
    const bad = await ok(
      await call("POST", `/governance/standards/${standard}/clauses/import`, {
        csv: csv([
          HEAD,
          ["1.1.1", "Example clause", "", "", ""],
          ["1.1.1", "Twice", "", "", ""],
          ["1.1.2", "", "", "", ""],
        ]),
      }),
    );
    expect(bad).toMatchObject({ applied: false, added: 0 });
    expect(bad.errors.map((e: { line: number }) => e.line)).toEqual([3, 4]);
    expect((await gaps()).clauses).toHaveLength(0);

    const rows = [
      HEAD,
      ["1.1.1", "Example commitment clause", "Placeholder text", "Senior management commitment", "yes"],
      ["1.1.2", "Example review clause", "", "Senior management commitment", ""],
      ["1.1.10", "Example later clause", "", "", ""],
      ["2.1.1", "Example HACCP clause", "", "Food safety plan", "yes"],
      ["3.9.1", "Example traceability clause", "", "Traceability", "no"],
    ];
    const dry = await ok(
      await call("POST", `/governance/standards/${standard}/clauses/import`, {
        csv: csv(rows),
        dryRun: true,
      }),
    );
    expect(dry).toMatchObject({ applied: false, added: 5, errors: [] });
    expect((await gaps()).clauses).toHaveLength(0);
    await ok(await call("POST", `/governance/standards/${standard}/clauses/import`, { csv: csv(rows) }));
    const again = await ok(
      await call("POST", `/governance/standards/${standard}/clauses/import`, {
        csv: csv([
          ...rows.slice(0, 2),
          ["1.1.2", "Corrected review clause", "", "Senior management commitment", ""],
          ["4.1.1", "Example site clause", "", "", ""],
        ]),
      }),
    );
    expect(again).toMatchObject({ applied: true, added: 1, updated: 1, unchanged: 1 });

    const view = await gaps();
    // Clause order, not text order: 1.1.10 after 1.1.2.
    expect(view.clauses.map((c: { ref: string }) => c.ref)).toEqual([
      "1.1.1",
      "1.1.2",
      "1.1.10",
      "2.1.1",
      "3.9.1",
      "4.1.1",
    ]);
    expect(view.summary).toMatchObject({ total: 6, assessed: 0, fundamentalAtRisk: ["1.1.1", "2.1.1"] });
    expect(
      view.summary.sections.map((s: { section: string; title: string | null }) => [s.section, s.title]),
    ).toEqual([
      ["1", "Senior management commitment"],
      ["2", "Food safety plan"],
      ["3", "Traceability"],
      ["4", null],
    ]);
  });

  it("records a person's assessment of each clause as history, with owners and dates for findings", async () => {
    const commitment = await clauseId("1.1.1");
    await ok(
      await call("POST", `/governance/clauses/${commitment}/assessments`, {
        status: "compliant",
        note: "Food safety policy signed this year; management review held",
      }),
      201,
    );
    const haccp = await clauseId("2.1.1");
    // A gap needs an owner and a date, and anything but compliant a note.
    expect(
      await code(
        await call("POST", `/governance/clauses/${haccp}/assessments`, {
          status: "gap",
          note: "Plan not reviewed",
        }),
        400,
      ),
    ).toBeTruthy();
    expect(
      await code(
        await call("POST", `/governance/clauses/${haccp}/assessments`, { status: "not_applicable" }),
        400,
      ),
    ).toBeTruthy();
    await ok(
      await call(
        "POST",
        `/governance/clauses/${haccp}/assessments`,
        { status: "gap", note: "HACCP plan review overdue", ownerUserId: adaId, dueOn: addDays(today, -1) },
        marcus.cookie,
      ),
      201,
    );
    const site = await clauseId("4.1.1");
    await ok(
      await call("POST", `/governance/clauses/${site}/assessments`, {
        status: "not_applicable",
        note: "No outdoor storage on this site",
      }),
      201,
    );
    // A later assessment supersedes, and the earlier one stays as history.
    const fixed = await ok(
      await call("POST", `/governance/clauses/${commitment}/assessments`, {
        status: "partial",
        note: "Policy not displayed in the bakery",
        ownerUserId: marcus.userId,
        dueOn: addDays(today, 14),
      }),
      201,
    );
    expect(fixed.status).toBe("partial");
    expect(fixed.history.map((h: { status: string }) => h.status)).toEqual(["partial", "compliant"]);

    const view = await gaps();
    expect(view.summary).toMatchObject({
      assessed: 3,
      openFindings: 2,
      overdueFindings: 1,
      fundamentalAtRisk: ["1.1.1", "2.1.1"],
    });
    expect(view.summary.counts).toMatchObject({ partial: 1, gap: 1, not_applicable: 1, not_assessed: 3 });
    const haccpRow = view.clauses.find((c: { ref: string }) => c.ref === "2.1.1");
    expect(haccpRow.assessment).toMatchObject({
      ownerName: expect.any(String),
      overdue: true,
      note: "HACCP plan review overdue",
    });
    // Filters narrow the list, never the summary.
    const onlyGaps = await gaps("?status=gap");
    expect(onlyGaps.clauses.map((c: { ref: string }) => c.ref)).toEqual(["2.1.1"]);
    expect(onlyGaps.summary.total).toBe(6);
    expect((await gaps("?fundamental=true")).clauses).toHaveLength(2);
  });

  it("raises a task to close a finding, and exports the analysis as CSV", async () => {
    const haccp = await clauseId("2.1.1");
    const raised = await ok(await call("POST", `/governance/clauses/${haccp}/tasks`, { teamId }), 201);
    expect(raised.taskId).toBeTruthy();
    const row = (await gaps()).clauses.find((c: { ref: string }) => c.ref === "2.1.1");
    expect(row.tasks).toHaveLength(1);
    expect(row.tasks[0].title).toBe("BRCGS-FS 2.1.1: Example HACCP clause");
    expect(row.tasks[0].dueDate).toBe(addDays(today, -1));
    // Only a finding needs a task.
    expect(
      await code(await call("POST", `/governance/clauses/${await clauseId("3.9.1")}/tasks`, { teamId }), 409),
    ).toBe("no_open_finding");

    const res = await call("GET", `/governance/standards/${standard}/report.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toContain("Clause");
    expect(text).toContain("HACCP plan review overdue");
  });

  it("lists standards with their progress, and archives a superseded issue", async () => {
    const { standards } = await ok(await call("GET", "/governance/standards"));
    expect(standards[0]).toMatchObject({
      code: "BRCGS-FS",
      clauses: 6,
      assessed: 3,
      openFindings: 2,
      fundamentalAtRisk: 2,
    });
    await ok(await call("PATCH", `/governance/standards/${standard}`, { status: "archived" }));
    expect(
      await code(
        await call("POST", `/governance/clauses/${await clauseId("3.9.1")}/assessments`, {
          status: "compliant",
        }),
        409,
      ),
    ).toBe("standard_archived");
  });
});
