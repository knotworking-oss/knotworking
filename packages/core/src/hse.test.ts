import { describe, it, expect } from "vitest";
import { hseApprovalBlockers, hseContentSchema, hseDue, hsePermitCloseSchema } from "./hse";
import { newId } from "./ids";
describe("HSE approval and due rules", () => {
  it("requires a dated SDS and assessed residual hazards, without inventing reporting deadlines", () => {
    const c = hseContentSchema.parse({
      scope: "Process",
      basis: "Procedure",
      controls: "Guard",
      response: "Stop",
      ownerUserId: newId(),
      reviewDueOn: "2026-12-01",
    });
    expect(hseApprovalBlockers("coshh", c, "2026-11-15").join()).toContain("SDS");
    expect(hseApprovalBlockers("risk_assessment", c, "2026-11-15").join()).toContain("residual risk");
  });
  it("derives due dates from the latest business-dated valid check", () => {
    expect(hseDue("2026-11-01", 7, null, "2026-11-15")).toEqual({ dueOn: "2026-11-01", state: "overdue" });
    expect(hseDue(null, 7, { performedOn: "2026-11-10", nextDueOn: null }, "2026-11-15")).toEqual({
      dueOn: "2026-11-17",
      state: "scheduled",
    });
    expect(hseDue(null, null, null, "2026-11-15").state).toBe("not_scheduled");
  });
  it("cannot close a permit with unchecked return-to-service assertions", () => {
    expect(
      hsePermitCloseSchema.safeParse({
        commandId: newId(),
        expectedRevision: 1,
        reason: "Done",
        workComplete: true,
        toolsRemoved: true,
        protectionsRestored: true,
        isolationsRemovedSafely: true,
        safeToReturn: false,
      }).success,
    ).toBe(false);
  });
});
