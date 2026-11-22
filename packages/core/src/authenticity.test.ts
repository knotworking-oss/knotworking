import { describe, it, expect } from "vitest";
import { newId } from "./ids";
import {
  authenticityDraftSchema,
  authenticityApprovalBlockers,
  authenticityFactors,
  authenticityControlStatus,
  authenticityVerificationSchema,
  type AuthenticityVerification,
} from "./authenticity";
const today = "2026-11-15";
const complete = () =>
  authenticityDraftSchema.parse({
    ownerUserId: newId(),
    scope: "Ingredient authenticity",
    origin: "Known origin",
    supplyChain: "Mill to site",
    factors: authenticityFactors.map((factor) => ({
      factor,
      level: "low",
      rationale: "Reviewed site evidence",
    })),
    vulnerability: "low",
    rationale: "Controls address assessed opportunities",
    sources: [
      {
        title: "Industry intelligence",
        reference: "Alert register",
        checkedOn: today,
        findings: "Reviewed relevant commodity alerts",
      },
    ],
    evidence: [{ kind: "provenance", title: "Chain of custody", reference: "Supplier origin statement" }],
    controls: [
      {
        id: newId(),
        kind: "provenance",
        description: "Check origin declaration",
        ownerUserId: newId(),
        dueOn: today,
        acceptanceCriteria: "Declaration matches approved source",
      },
    ],
    reviewDueOn: "2027-11-15",
  });
describe("authenticity assessment rules", () => {
  it("keeps incomplete work as a draft and requires every factor and a reasoned conclusion to sign", () => {
    const empty = authenticityDraftSchema.parse({});
    expect(authenticityApprovalBlockers(empty, today).length).toBeGreaterThan(8);
    const good = complete();
    expect(authenticityApprovalBlockers(good, today)).toEqual([]);
    good.factors[0]!.level = "unassessed";
    expect(authenticityApprovalBlockers(good, today).join(" ")).toContain("History");
  });
  it("requires current evidence, past/present source checks, a review date and planned controls", () => {
    const d = complete();
    d.evidence[0]!.validUntil = "2026-11-14";
    d.sources[0]!.checkedOn = "2026-11-16";
    d.reviewDueOn = "2026-11-14";
    d.controls = [];
    expect(authenticityApprovalBlockers(d, today)).toHaveLength(4);
  });
  it("rejects duplicate factors/controls and impossible passing evidence dates", () => {
    const d = complete();
    expect(authenticityDraftSchema.safeParse({ ...d, factors: [d.factors[0], d.factors[0]] }).success).toBe(
      false,
    );
    expect(
      authenticityDraftSchema.safeParse({ ...d, controls: [d.controls[0], d.controls[0]] }).success,
    ).toBe(false);
    expect(
      authenticityVerificationSchema.safeParse({
        commandId: newId(),
        verifiedOn: today,
        outcome: "pass",
        evidenceReference: "COA",
        evidenceValidUntil: "2026-11-14",
        note: "Expired evidence",
      }).success,
    ).toBe(false);
  });
});
describe("authenticity control status", () => {
  const control = complete().controls[0]!;
  const record = (extra: Partial<AuthenticityVerification> = {}): AuthenticityVerification => ({
    id: newId(),
    versionId: newId(),
    controlId: control.id,
    verifiedOn: "2026-11-10",
    outcome: "pass",
    evidenceReference: "Verified source",
    evidenceValidUntil: null,
    note: "Checked criteria",
    createdAt: "2026-11-10T12:00:00.000Z",
    actorId: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...extra,
  });
  it("distinguishes pending, due and overdue unverified work", () => {
    expect(authenticityControlStatus({ ...control, dueOn: "2026-11-16" }, [], today).state).toBe("pending");
    expect(authenticityControlStatus(control, [], today).state).toBe("due");
    expect(authenticityControlStatus({ ...control, dueOn: "2026-11-14" }, [], today).state).toBe("overdue");
  });
  it("calculates recurring checks and one-off verification without a regulatory interval", () => {
    expect(authenticityControlStatus(control, [record()], today).state).toBe("verified");
    expect(authenticityControlStatus({ ...control, frequencyDays: 3 }, [record()], today)).toMatchObject({
      state: "overdue",
      nextDueOn: "2026-11-13",
    });
    expect(authenticityControlStatus({ ...control, frequencyDays: 5 }, [record()], today).state).toBe("due");
  });
  it("uses the actual verification date, so a later-entered backdated pass cannot clear a newer failure", () => {
    expect(
      authenticityControlStatus(
        control,
        [
          record({ outcome: "fail", verifiedOn: "2026-11-14" }),
          record({ verifiedOn: "2026-11-12", createdAt: "2026-11-15T12:00:00.000Z" }),
        ],
        today,
      ).state,
    ).toBe("failed");
  });
  it("ignores corrected records, applies expiry and keeps other controls separate", () => {
    const pass = record();
    expect(
      authenticityControlStatus(
        control,
        [pass, record({ outcome: "fail", verifiedOn: today, voidedAt: "2026-11-15T13:00:00Z" })],
        today,
      ).state,
    ).toBe("verified");
    expect(
      authenticityControlStatus(control, [record({ evidenceValidUntil: "2026-11-14" })], today).state,
    ).toBe("expired");
    expect(authenticityControlStatus(control, [record({ controlId: newId() })], today).state).toBe("due");
  });
});
