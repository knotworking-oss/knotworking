import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../testing/harness";

type Session = Awaited<ReturnType<typeof connect>>;
const open: Session[] = [];
async function session() {
  const s = await connect();
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("governance tools", () => {
  it("sets objectives with progress and plans culture activities", async () => {
    const { call } = await session();
    const o = await call("save_governance_objective", {
      workspace: "acme",
      title: "Cut foreign-body complaints",
      category: "food_safety",
      target: "< 2 per million",
      due_on: "2026-06-30",
      progress: { on: "2026-02-28", rag: "at_risk", value: "3.1", note: "New sieve" },
    });
    expect(o.data).toMatchObject({ title: "Cut foreign-body complaints", latest: { rag: "at_risk" } });
    const updated = await call("save_governance_objective", {
      workspace: "acme",
      objective: "cut foreign-body complaints",
      status: "achieved",
    });
    expect(updated.data.status).toBe("achieved");
    const a = await call("save_culture_activity", {
      workspace: "acme",
      title: "Culture survey",
      kind: "survey",
      planned_on: "2026-02-01",
    });
    expect(a.data.state).toBe("overdue");
    const done = await call("save_culture_activity", {
      workspace: "acme",
      activity: "Culture survey",
      completed_on: "2026-02-20",
      participants: 84,
    });
    expect(done.data.state).toBe("done");
  });

  it("prepares a management review with decisions; signing is a person's", async () => {
    const { call, fake } = await session();
    const r = await call("save_management_review", {
      workspace: "acme",
      title: "Q1 review",
      period_from: "2026-01-01",
      period_to: "2026-03-31",
    });
    expect(r.data).toMatchObject({
      status: "draft",
      signBlockers: expect.arrayContaining(["Record who attended"]),
    });
    expect(r.data.note).toMatch(/no tools/);
    const saved = await call("save_management_review", {
      workspace: "acme",
      review: "Q1 review",
      held_on: "2026-03-01",
      attendees: "Board",
      notes: { complaints: "Trend driven by the sieve" },
      decisions: [{ decision: "Replace the sieve mesh", due_on: "2026-04-01" }],
    });
    expect(saved.data.decisions).toEqual([
      expect.objectContaining({ decision: "Replace the sieve mesh", owner: null }),
    ]);
    expect(saved.data.signBlockers).toEqual([]);
    // Notes merge.
    await call("save_management_review", {
      workspace: "acme",
      review: "Q1 review",
      notes: { audits: "Clean" },
    });
    expect(fake.governanceModule.reviews[0]!.notes).toEqual({
      complaints: "Trend driven by the sieve",
      audits: "Clean",
    });
    const listed = await call("list_management_reviews", { workspace: "acme" });
    expect(listed.data.reviews).toHaveLength(1);
  });

  it("adds requirements to the register", async () => {
    const { call } = await session();
    const req = await call("add_governance_requirement", {
      workspace: "acme",
      source: "legal",
      reference: "Reg (EU) 1169/2011",
      title: "Food information to consumers",
    });
    expect(req.data).toMatchObject({ compliance: "not_assessed" });
    const list = await call("list_governance_requirements", { workspace: "acme" });
    expect(list.data.requirements[0].reference).toBe("Reg (EU) 1169/2011");
  });

  it("imports a standard's clauses and reads its gap analysis; assessing is a person's", async () => {
    const { call, fake, client } = await session();
    const id = "00000000-0000-4000-8000-0000000000aa";
    fake.governanceModule.standards.push({
      id,
      code: "BRCGS-FS",
      issue: "9",
      status: "active",
      name: "Food Safety",
    });
    const bad = await call("import_standard_clauses", {
      workspace: "acme",
      standard: "BRCGS-FS 9",
      csv: "Clause,Title\n1.1,A\n1.1,B",
    });
    expect(bad.data).toMatchObject({
      applied: false,
      errors: [{ line: 3, message: "Clause 1.1 is listed twice" }],
    });
    const done = await call("import_standard_clauses", {
      workspace: "acme",
      standard: "BRCGS-FS",
      csv: "Clause,Title,Fundamental\n1.1.1,Placeholder,yes\n2.1,Placeholder two,",
    });
    expect(done.data).toMatchObject({ applied: true, added: 2 });
    const gaps = await call("get_gap_analysis", { workspace: "acme", standard: id });
    expect(gaps.data.summary).toMatchObject({ total: 2, fundamentalAtRisk: ["1.1.1"] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("assess_standard_clause");
    const clauseId = gaps.data.clauses[0].id;
    const badMap = await call("map_clause_evidence", {
      workspace: "acme",
      clause: clauseId,
      checks: ["made_up"],
    });
    expect(badMap.isError).toBe(true);
    await call("map_clause_evidence", { workspace: "acme", clause: clauseId, checks: ["traceability_test"] });
    const checks = await call("list_evidence_checks", { workspace: "acme" });
    expect(checks.data.checks).toHaveLength(16);
    expect(checks.data.checks.find((c: { id: string }) => c.id === "traceability_test").clauses).toEqual([
      clauseId,
    ]);

    // G3: an agent drafts findings for a person to accept; it can't accept them itself.
    const draft = await call("draft_clause_finding", {
      workspace: "acme",
      clause: clauseId,
      status: "gap",
      finding: "No traceability test on record",
      basis: "Evidence check shows a gap",
    });
    expect(draft.data).toMatchObject({
      status: "not_assessed",
      drafts: [{ state: "open", note: "No traceability test on record" }],
    });
    expect(fake.governanceModule.drafts[0]).toMatchObject({ rationale: "Evidence check shows a gap" });
    expect(tools.map((t) => t.name)).not.toContain("accept_clause_draft");
    const snap = await call("take_gap_snapshot", {
      workspace: "acme",
      standard: "BRCGS-FS 9",
      label: "Pre-audit",
    });
    expect(snap.data).toMatchObject({ label: "Pre-audit", clauseCount: 2 });
    const listed = await call("list_gap_snapshots", { workspace: "acme", standard: id });
    expect(listed.data.snapshots).toHaveLength(1);
    const read = await call("get_gap_snapshot", { workspace: "acme", snapshot: snap.data.id });
    expect(read.data.snapshot.label).toBe("Pre-audit");
  });
});
