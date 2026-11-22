import { describe, expect, it } from "vitest";
import {
  supplierCompliance,
  supplierQuestionnaireReviewSchema,
  supplierRiskAssessmentSchema,
  type ComplianceFacts,
} from "./supplier-controls";

const facts = (over: Partial<ComplianceFacts> = {}): ComplianceFacts => ({
  supplier: {
    category: "goods",
    approvalStatus: "approved",
    reviewDueOn: "2027-06-01",
    certification: "BRCGS AA",
    certificateExpiresOn: "2027-06-01",
  },
  assessments: [],
  questionnaires: [],
  items: [{ id: "i1", code: "FLR" }],
  specifiedItemIds: [],
  today: "2026-11-14",
  ...over,
});
const assessment = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  itemId: "i1",
  itemCode: "FLR",
  riskLevel: "high" as const,
  controls: [] as never[],
  reviewDueOn: "2027-06-01",
  ...over,
});

describe("supplierCompliance", () => {
  it("asks for an assessment first", () => {
    const c = supplierCompliance(facts());
    expect(c.issues.map((i) => i.kind)).toEqual(["no_assessment"]);
    expect(c.riskLevel).toBeNull();
  });

  it("reports items bought without an assessment, unless the supplier is assessed as a whole", () => {
    const items = [
      { id: "i1", code: "FLR" },
      { id: "i2", code: "SUG" },
    ];
    expect(
      supplierCompliance(facts({ items, assessments: [assessment()] })).issues.map((i) => i.message),
    ).toEqual(["SUG is bought from this supplier without a risk assessment"]);
    expect(
      supplierCompliance(
        facts({
          items,
          assessments: [
            assessment(),
            assessment({ id: "a2", itemId: null, itemCode: null, riskLevel: "low" }),
          ],
        }),
      ).issues,
    ).toEqual([]);
  });

  it("judges each control from the evidence", () => {
    const c = supplierCompliance(
      facts({
        supplier: { ...facts().supplier, certificateExpiresOn: "2026-11-01" },
        assessments: [
          assessment({
            controls: ["certificate", "questionnaire", "specification", "audit", "testing_on_receipt"],
          }),
        ],
        questionnaires: [
          { id: "q1", title: "SAQ", status: "accepted", sentOn: "2026-01-01", validUntil: "2026-12-01" },
        ],
        specifiedItemIds: ["i1"],
      }),
    );
    expect(c.assessments[0]!.controls.map((x) => x.state)).toEqual([
      "missing",
      "expiring",
      "met",
      "not_tracked",
      "at_goods_in",
    ]);
    expect(c.actionCount).toBe(1);
    expect(c.riskLevel).toBe("high");
  });

  it("can't check specifications when the module is off, and flags reviews, approval and unanswered questionnaires", () => {
    const c = supplierCompliance(
      facts({
        supplier: { ...facts().supplier, reviewDueOn: "2026-10-01" },
        assessments: [assessment({ controls: ["specification"], reviewDueOn: "2026-11-01" })],
        questionnaires: [{ id: "q1", title: "SAQ", status: "sent", sentOn: "2026-09-01", validUntil: null }],
        specifiedItemIds: null,
      }),
    );
    expect(c.assessments[0]!.controls[0]!.state).toBe("not_tracked");
    expect(c.issues.map((i) => i.kind)).toEqual([
      "assessment_overdue",
      "approval_review_overdue",
      "questionnaire_chase",
    ]);
  });
});

describe("validation", () => {
  it("needs a rationale and unique controls, and a validity to accept or a reason to reject", () => {
    expect(
      supplierRiskAssessmentSchema.safeParse({ riskLevel: "low", rationale: "", reviewDueOn: "2027-01-01" })
        .success,
    ).toBe(false);
    expect(
      supplierRiskAssessmentSchema.safeParse({
        riskLevel: "low",
        rationale: "x",
        controls: ["audit", "audit"],
        reviewDueOn: "2027-01-01",
      }).success,
    ).toBe(false);
    expect(supplierQuestionnaireReviewSchema.safeParse({ decision: "accepted" }).success).toBe(false);
    expect(
      supplierQuestionnaireReviewSchema.safeParse({ decision: "rejected", reviewNote: "Incomplete" }).success,
    ).toBe(true);
  });
});
