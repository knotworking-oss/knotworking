import { describe, expect, it } from "vitest";
import {
  clauseAssessmentSchema,
  clauseDraftSchema,
  gapSnapshotCreateSchema,
  compareClauseRefs,
  parseClauseCsv,
  sectionOfRef,
  summariseGaps,
} from "./governance-standards";

describe("clause references", () => {
  it("sort by number, not text", () => {
    expect(["2.1", "1.1.10", "1.1.2", "1.10", "1.2"].sort(compareClauseRefs)).toEqual([
      "1.1.2",
      "1.1.10",
      "1.2",
      "1.10",
      "2.1",
    ]);
    expect(sectionOfRef("3.9.2")).toBe("3");
  });
});

describe("clause import", () => {
  it("accepts common column names in any order and defaults the section", () => {
    const r = parseClauseCsv(
      'Requirement,Clause No,Heading,Fundamental\n"Text",1.1.1,Commitment,Yes\n,5.4.2,Fraud,',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      {
        ref: "1.1.1",
        title: "Commitment",
        text: "Text",
        section: "1",
        sectionTitle: null,
        fundamental: true,
      },
      { ref: "5.4.2", title: "Fraud", text: null, section: "5", sectionTitle: null, fundamental: false },
    ]);
  });

  it("reports missing columns and bad rows by line", () => {
    expect(parseClauseCsv("Title\nx").errors[0]!.message).toMatch(/clause column/);
    const r = parseClauseCsv("Clause,Title\n1.1,A\n1.1,B\n,C\n1.2,");
    expect(r.errors).toEqual([
      { line: 3, message: "Clause 1.1 is listed twice" },
      { line: 4, message: "No clause number" },
      { line: 5, message: "Clause 1.2 has no title" },
    ]);
  });
});

describe("assessments", () => {
  it("need a note unless compliant, and an owner and date for findings", () => {
    expect(clauseAssessmentSchema.safeParse({ status: "compliant" }).success).toBe(true);
    expect(clauseAssessmentSchema.safeParse({ status: "not_applicable" }).success).toBe(false);
    expect(clauseAssessmentSchema.safeParse({ status: "gap", note: "x" }).success).toBe(false);
    expect(
      clauseAssessmentSchema.safeParse({
        status: "gap",
        note: "x",
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        dueOn: "2026-12-01",
      }).success,
    ).toBe(true);
  });
});

describe("gap summary", () => {
  it("counts by status and section, open and overdue findings, and fundamentals at risk", () => {
    const s = summariseGaps(
      [
        { ref: "1.1", section: "1", fundamental: true, status: "compliant", dueOn: null },
        { ref: "1.2", section: "1", fundamental: true, status: "not_assessed", dueOn: null },
        { ref: "2.1", section: "2", fundamental: false, status: "gap", dueOn: "2026-11-01" },
        { ref: "2.2", section: "2", fundamental: false, status: "partial", dueOn: "2026-12-01" },
        { ref: "10.1", section: "10", fundamental: true, status: "not_applicable", dueOn: null },
      ],
      "2026-11-16",
    );
    expect(s).toMatchObject({
      total: 5,
      assessed: 4,
      assessedPercent: 80,
      openFindings: 2,
      overdueFindings: 1,
    });
    expect(s.fundamentalAtRisk).toEqual(["1.2"]);
    expect(s.sections.map((x) => x.section)).toEqual(["1", "2", "10"]);
  });
});

describe("evidence", () => {
  it("states a clause's evidence from its checks, and flags compliant clauses with a gap", async () => {
    const { clauseEvidenceState, evidenceConflict, evidenceCheckIds, evidenceChecks } =
      await import("./governance-standards");
    expect(clauseEvidenceState([])).toBe("none");
    expect(clauseEvidenceState([{ status: "met" }, { status: "gap" }])).toBe("gap");
    expect(clauseEvidenceState([{ status: "met" }, { status: "unavailable" }])).toBe("partial_view");
    expect(clauseEvidenceState([{ status: "met" }])).toBe("met");
    expect(evidenceConflict("compliant", "gap")).toBe(true);
    expect(evidenceConflict("not_applicable", "gap")).toBe(true);
    expect(evidenceConflict("gap", "gap")).toBe(false);
    expect(evidenceConflict("compliant", "partial_view")).toBe(false);
    for (const id of evidenceCheckIds) expect(evidenceChecks[id].id).toBe(id);
  });
});

describe("drafted findings and snapshots (G3)", () => {
  it("a draft proposes a real finding with wording; owner and date are only suggestions", () => {
    expect(clauseDraftSchema.safeParse({ status: "gap", note: "No test on record" }).success).toBe(true);
    expect(clauseDraftSchema.safeParse({ status: "not_assessed", note: "x" }).success).toBe(false);
    expect(clauseDraftSchema.safeParse({ status: "compliant", note: "" }).success).toBe(false);
    expect(gapSnapshotCreateSchema.safeParse({ label: "  " }).success).toBe(false);
  });
});
