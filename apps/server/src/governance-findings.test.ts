import { addDays, DEFAULT_TIME_ZONE, todayInZone } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type Res, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const today = todayInZone(DEFAULT_TIME_ZONE);

/**
 * G3: findings drafted by an agent (an API token) that a person accepts or dismisses, and frozen
 * pre-audit snapshots. Clause wording is placeholder text.
 */
describe("standards gap analysis: drafted findings and snapshots (G3)", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let token: string;
  let marcus: string;
  let standard: string;
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${WS}${path}`, { method, cookie, json });
  const asAgent = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, json, headers: { authorization: `Bearer ${token}` } });
  const ok = async (res: Res | Promise<Res>, status = 200): Promise<any> => {
    const r = await res;
    const body = (await r.json()) as any;
    expect(r.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const gaps = async (query = "", cookie = ada) =>
    ok(call("GET", `/governance/standards/${standard}${query}`, undefined, cookie));
  const clause = async (ref: string) => (await gaps()).clauses.find((c: { ref: string }) => c.ref === ref);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    adaId = (await ok(ctx.req("/v1/me", { cookie: ada }))).user.id;
    token = (
      await ok(
        ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "Gap agent", scope: "write" },
        }),
        201,
      )
    ).token;
    const { members } = await ok(call("GET", "/members"));
    const m = members.find((x: { email: string }) => x.email === "marcus@knotworking.dev");
    marcus = (await signIn(ctx, m.email)).cookie;
    // Marcus reads governance but not quality.
    await ok(call("PUT", `/members/${m.userId}/module-access/governance`, { level: "read" }));
    standard = (
      await ok(
        call("POST", "/governance/standards", { code: "BRCGS-FS", name: "Food Safety", issue: "9" }),
        201,
      )
    ).id;
    await ok(
      call("POST", `/governance/standards/${standard}/clauses/import`, {
        csv: [
          "Clause,Title,Fundamental",
          "1.1,Placeholder: commitment,yes",
          "3.9,Placeholder: traceability,yes",
          "4.6,Placeholder: equipment,",
        ].join("\n"),
      }),
    );
    await ok(
      call("PUT", `/governance/clauses/${(await clause("3.9")).id}/evidence`, {
        checkIds: ["traceability_test"],
      }),
    );
  }, 30000);
  afterAll(async () => {
    await ctx?.handle.close();
  });

  it("an agent drafts a finding; it changes nothing until a person accepts it as their own", async () => {
    const trace = await clause("3.9");
    const drafted = await ok(
      asAgent("POST", `/governance/clauses/${trace.id}/drafts`, {
        status: "gap",
        note: "No traceability test on record",
        rationale: "Evidence check: traceability test shows a gap",
        ownerUserId: adaId,
        dueOn: addDays(today, 14),
      }),
      201,
    );
    expect(drafted.drafts[0]).toMatchObject({ state: "open", draftedVia: "agent", status: "gap" });
    expect(drafted.status).toBe("not_assessed");
    const view = await gaps();
    expect(view.summary).toMatchObject({ openDrafts: 1, counts: { gap: 0 } });
    expect((await gaps("?drafts=open")).clauses.map((c: { ref: string }) => c.ref)).toEqual(["3.9"]);
    const draftId = drafted.drafts[0].id;

    // The agent can't accept it, nor assess directly.
    const byAgent = await asAgent("POST", `/governance/drafts/${draftId}/accept`, {
      status: "gap",
      note: "x",
      ownerUserId: adaId,
      dueOn: today,
    });
    expect(byAgent.status).toBe(403);

    // A person accepts, changing the date: the assessment is theirs.
    const accepted = await ok(
      call("POST", `/governance/drafts/${draftId}/accept`, {
        status: "gap",
        note: "No traceability test on record",
        ownerUserId: adaId,
        dueOn: addDays(today, 30),
      }),
    );
    expect(accepted.status).toBe("gap");
    expect(accepted.history[0]).toMatchObject({ assessedBy: adaId, dueOn: addDays(today, 30) });
    expect(accepted.drafts[0]).toMatchObject({
      state: "accepted",
      decidedBy: adaId,
      assessmentId: accepted.history[0].id,
    });
    expect((await gaps()).summary.openDrafts).toBe(0);
    // Decided once.
    expect((await call("POST", `/governance/drafts/${draftId}/dismiss`, { reason: "late" })).status).toBe(
      409,
    );
  });

  it("a new draft replaces the open one; dismissing leaves the status alone", async () => {
    const equipment = await clause("4.6");
    await ok(
      asAgent("POST", `/governance/clauses/${equipment.id}/drafts`, { status: "compliant", note: "First" }),
      201,
    );
    const second = await ok(
      asAgent("POST", `/governance/clauses/${equipment.id}/drafts`, { status: "partial", note: "Second" }),
      201,
    );
    expect(second.drafts.map((d: { state: string; note: string }) => [d.note, d.state])).toEqual([
      ["Second", "open"],
      ["First", "superseded"],
    ]);
    const dismissed = await ok(
      call("POST", `/governance/drafts/${second.drafts[0].id}/dismiss`, { reason: "Calibration is in date" }),
    );
    expect(dismissed).toMatchObject({ status: "not_assessed" });
    expect(dismissed.drafts[0]).toMatchObject({ state: "dismissed", decisionNote: "Calibration is in date" });
    // Drafting is write, so a reader can't.
    const res = await call(
      "POST",
      `/governance/clauses/${equipment.id}/drafts`,
      { status: "gap", note: "x" },
      marcus,
    );
    expect(res.status).toBe(403);
  });

  it("freezes a snapshot that later changes don't touch, and lists what changed since", async () => {
    const commitment = await clause("1.1");
    await ok(call("POST", `/governance/clauses/${commitment.id}/assessments`, { status: "compliant" }), 201);
    const snap = await ok(
      call("POST", `/governance/standards/${standard}/snapshots`, { label: "Pre-audit" }),
      201,
    );
    expect(snap).toMatchObject({ label: "Pre-audit", takenOn: today, clauseCount: 3 });

    await ok(
      call("POST", `/governance/clauses/${commitment.id}/assessments`, {
        status: "gap",
        note: "Policy unsigned",
        ownerUserId: adaId,
        dueOn: addDays(today, 7),
      }),
      201,
    );
    const view = await ok(call("GET", `/governance/snapshots/${snap.id}`));
    expect(view.clauses.find((c: { ref: string }) => c.ref === "1.1").status).toBe("compliant");
    expect(view.summary).toMatchObject({ total: 3, counts: { compliant: 1, gap: 1 } });
    expect(view.summary.evidenceGaps).toEqual(["3.9"]);
    expect(view.changesSince.status).toEqual([
      { ref: "1.1", title: "Placeholder: commitment", then: "compliant", now: "gap" },
    ]);
    const { snapshots } = await ok(call("GET", `/governance/standards/${standard}/snapshots`));
    expect(snapshots).toEqual([expect.objectContaining({ id: snap.id, takenByName: expect.any(String) })]);
    const text = await (await call("GET", `/governance/snapshots/${snap.id}/report.csv`)).text();
    expect(text.split("\n")[1]).toContain("Pre-audit");
    expect(text).toContain("Traceability test in the last 12 months");

    // Taking one is manage.
    expect(
      (await call("POST", `/governance/standards/${standard}/snapshots`, { label: "x" }, marcus)).status,
    ).toBe(403);
  });

  it("hides evidence in a snapshot from a reader who can't see its module", async () => {
    const { snapshots } = await ok(call("GET", `/governance/standards/${standard}/snapshots`));
    const view = await ok(call("GET", `/governance/snapshots/${snapshots[0].id}`, undefined, marcus));
    const trace = view.clauses.find((c: { ref: string }) => c.ref === "3.9");
    expect(trace.evidence[0]).toMatchObject({ status: "unavailable", items: [] });
    expect(trace.evidenceState).toBe("partial_view");
    expect(view.summary.evidenceGaps).toEqual([]);
    const text = await (
      await call("GET", `/governance/snapshots/${snapshots[0].id}/report.csv`, undefined, marcus)
    ).text();
    expect(text).not.toContain("No passing traceability test");
  });

  it("an agent can't replace or dismiss a person's draft, and accepting needs a finding", async () => {
    const equipment = await clause("4.6");
    const mine = await ok(
      call("POST", `/governance/clauses/${equipment.id}/drafts`, { status: "gap", note: "Mine" }),
      201,
    );
    const draftId = mine.drafts[0].id;
    expect(mine.drafts[0].draftedVia).toBe("person");
    expect(
      (
        await asAgent("POST", `/governance/clauses/${equipment.id}/drafts`, {
          status: "compliant",
          note: "x",
        })
      ).status,
    ).toBe(409);
    expect((await asAgent("POST", `/governance/drafts/${draftId}/dismiss`, {})).status).toBe(403);
    expect(
      (await call("POST", `/governance/drafts/${draftId}/accept`, { status: "not_assessed" })).status,
    ).toBe(400);
    expect((await ok(call("POST", `/governance/drafts/${draftId}/dismiss`, {}))).drafts[0].state).toBe(
      "dismissed",
    );
  });
});
