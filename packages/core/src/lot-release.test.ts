import { describe, expect, it } from "vitest";
import {
  evaluateLotRelease,
  lotReleaseRuleInputSchema,
  canApproveReleaseException,
  exceptionCovers,
  releaseBlockers,
  type ReleaseFacts,
} from "./lot-release";

const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  active: ["items", "stock", "testing", "specifications", "production", "haccp"],
  rule: null,
  samples: [],
  approvedSpecification: null,
  batches: [],
  ccpLogs: [],
  openCorrectiveActions: [],
  ...over,
});
const rule = (over: Record<string, unknown> = {}) => ({
  requirePassingTest: false,
  requiredAnalytes: [],
  requireApprovedSpecification: false,
  requireCcpReviewed: false,
  note: null,
  version: 3,
  ...over,
});
const status = (f: ReleaseFacts, kind: string) =>
  evaluateLotRelease(f).checks.find((c) => c.kind === kind)?.status;

describe("evaluateLotRelease", () => {
  it("passes a lot with nothing against it", () => {
    const e = evaluateLotRelease(facts());
    expect(e.blocked).toBe(false);
    expect(e.ruleVersion).toBeNull();
  });

  it("skips testing checks when Testing is off", () => {
    const e = evaluateLotRelease(facts({ active: ["items", "stock"] }));
    expect(e.checks.map((c) => c.kind)).toEqual(["packing_checks"]);
  });

  it("ignores cancelled samples and resolves a failure only with a later passing retest", () => {
    const failed = {
      id: "s1",
      reference: "S-1",
      sampledOn: "2026-01-01",
      status: "complete" as const,
      outcome: "fail" as const,
      investigationStatus: "closed" as const,
      results: [{ name: "Moisture", outcome: "fail" as const }],
    };
    const cancelled = { ...failed, id: "s0", status: "cancelled" as const, investigationStatus: null };
    expect(status(facts({ samples: [cancelled] }), "test_failed")).toBe("pass");
    expect(status(facts({ samples: [failed] }), "test_failed")).toBe("block");
    const otherAnalyte = {
      ...failed,
      id: "s2",
      outcome: "pass" as const,
      investigationStatus: null,
      results: [{ name: "Ash", outcome: "pass" as const }],
    };
    expect(status(facts({ samples: [failed, otherAnalyte] }), "test_failed")).toBe("block");
    const retest = {
      ...otherAnalyte,
      id: "s3",
      sampledOn: "2026-01-02",
      results: [{ name: "moisture", outcome: "pass" as const }],
    };
    expect(status(facts({ samples: [failed, retest] }), "test_failed")).toBe("pass");
    expect(
      status(facts({ samples: [{ ...failed, investigationStatus: "open" }, retest] }), "investigation_open"),
    ).toBe("block");
  });

  it("blocks a rule that needs a switched-off module", () => {
    const e = evaluateLotRelease(
      facts({
        active: ["items", "stock"],
        rule: rule({
          requirePassingTest: true,
          requireApprovedSpecification: true,
          requireCcpReviewed: true,
        }),
      }),
    );
    expect(e.blocked).toBe(true);
    expect(releaseBlockers(e)).toEqual([
      expect.stringContaining("Testing module is switched off"),
      expect.stringContaining("Specifications module is switched off"),
      expect.stringContaining("Food safety records module is switched off"),
    ]);
    expect(e.ruleVersion).toBe(3);
  });

  it("needs a batch's CCP readings approved and its corrective actions closed, showing deviations", () => {
    const batches = [{ id: "b1", batchCode: "B1" }];
    const log = {
      id: "l1",
      ccpCode: "CCP1",
      batchCode: "B1",
      checkedAt: "2026-01-01T10:00:00Z",
      withinLimits: false,
      reviewStatus: "pending" as const,
    };
    const withRule = { rule: rule({ requireCcpReviewed: true }), batches };
    expect(status(facts({ ...withRule, ccpLogs: [log] }), "ccp_review")).toBe("block");
    const approved = { ...log, reviewStatus: "approved" as const };
    const e = evaluateLotRelease(facts({ ...withRule, ccpLogs: [approved] }));
    expect(e.blocked).toBe(false);
    // A handled deviation is shown, never blocking.
    expect(e.checks.find((c) => c.kind === "deviations")?.status).toBe("info");
    expect(
      status(
        facts({
          ...withRule,
          ccpLogs: [approved],
          openCorrectiveActions: [{ id: "a1", title: "Re-cook", batchCode: "B1" }],
        }),
        "corrective_actions",
      ),
    ).toBe("block");
  });
});

describe("lotReleaseRuleInputSchema", () => {
  it("only takes analytes with a required test, once each", () => {
    expect(lotReleaseRuleInputSchema.safeParse({ requiredAnalytes: ["Salmonella"] }).success).toBe(false);
    expect(
      lotReleaseRuleInputSchema.safeParse({ requirePassingTest: true, requiredAnalytes: ["A", "a"] }).success,
    ).toBe(false);
    expect(lotReleaseRuleInputSchema.parse({})).toMatchObject({
      requirePassingTest: false,
      requiredAnalytes: [],
    });
  });
});

describe("release exception approval", () => {
  it("needs a second manager unless the requester is the only one", () => {
    expect(canApproveReleaseException({ requestedBy: "a", deciderId: "b", managerIds: ["a", "b"] })).toEqual({
      allowed: true,
      selfApproved: false,
    });
    expect(canApproveReleaseException({ requestedBy: "a", deciderId: "a", managerIds: ["a", "b"] })).toEqual({
      allowed: false,
      selfApproved: false,
    });
    expect(canApproveReleaseException({ requestedBy: "a", deciderId: "a", managerIds: ["a"] })).toEqual({
      allowed: true,
      selfApproved: true,
    });
  });

  it("covers fewer blockers and records, not new ones or a changed rule", () => {
    const asked = {
      ruleVersion: 2,
      checks: [
        { kind: "tests_pending", status: "block", detail: "1 sample", refs: [{ id: "s1" }, { id: "s2" }] },
        { kind: "specification", status: "block", detail: "No approved specification", refs: [] },
        { kind: "deviations", status: "info", detail: "", refs: [] },
      ],
    };
    const now = (
      checks: { kind: string; status: string; detail?: string; refs?: { id: string }[] }[],
      v = 2,
    ) => ({
      ruleVersion: v,
      checks,
    });
    expect(
      exceptionCovers(asked, now([{ kind: "tests_pending", status: "block", refs: [{ id: "s1" }] }])),
    ).toBe(true);
    expect(
      exceptionCovers(asked, now([{ kind: "test_failed", status: "block", refs: [{ id: "s1" }] }])),
    ).toBe(false);
    expect(
      exceptionCovers(asked, now([{ kind: "tests_pending", status: "block", refs: [{ id: "s1" }] }], 3)),
    ).toBe(false);
    // A new record under a kind that was already blocking isn't covered.
    expect(
      exceptionCovers(asked, now([{ kind: "tests_pending", status: "block", refs: [{ id: "s3" }] }])),
    ).toBe(false);
    // A blocker naming no records must read as it did.
    expect(
      exceptionCovers(
        asked,
        now([{ kind: "specification", status: "block", detail: "No approved specification", refs: [] }]),
      ),
    ).toBe(true);
    expect(
      exceptionCovers(asked, now([{ kind: "specification", status: "block", detail: "Expired", refs: [] }])),
    ).toBe(false);
  });
});
