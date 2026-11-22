import { describe, expect, it } from "vitest";
import {
  defenceApprovalBlockers,
  defenceCheckSchema,
  defenceControlDue,
  defenceReviewStatus,
  defenceThreatRating,
  diffDefenceThreats,
  type DefenceThreat,
} from "./defence";

const threat = (over: Partial<DefenceThreat> = {}): DefenceThreat => ({
  id: "11111111-1111-4111-8111-111111111111",
  area: "Silo",
  threat: "Contamination at the fill point",
  source: "intruder",
  likelihood: 2,
  impact: 3,
  existingControls: null,
  mitigation: null,
  controlIds: [],
  ...over,
});

describe("food defence rules", () => {
  it("rates threats by likelihood × impact", () => {
    expect(defenceThreatRating({ likelihood: 2, impact: 3 })).toEqual({ score: 6, rating: "low" });
    expect(defenceThreatRating({ likelihood: 2, impact: 4 })).toEqual({ score: 8, rating: "medium" });
    expect(defenceThreatRating({ likelihood: 3, impact: 4 })).toEqual({ score: 12, rating: "medium" });
    expect(defenceThreatRating({ likelihood: 3, impact: 5 })).toEqual({ score: 15, rating: "high" });
  });

  it("blocks approval without threats, a future review date, or a mitigation for high threats", () => {
    const today = "2026-03-01";
    expect(defenceApprovalBlockers({ threats: [], reviewDueOn: null }, today, new Set())).toEqual([
      "Record at least one threat",
      "Set the next review date",
    ]);
    expect(defenceApprovalBlockers({ threats: [threat()], reviewDueOn: today }, today, new Set())).toEqual([
      "The next review date must be in the future",
    ]);
    const high = threat({ likelihood: 5, impact: 5, controlIds: ["c1"] });
    expect(defenceApprovalBlockers({ threats: [high], reviewDueOn: "2027-01-01" }, today, new Set())).toEqual(
      [expect.stringContaining("needs a mitigation"), expect.stringContaining("no longer exists")],
    );
    expect(
      defenceApprovalBlockers(
        { threats: [{ ...high, mitigation: "Lock" }], reviewDueOn: "2027-01-01" },
        today,
        new Set(["c1"]),
      ),
    ).toEqual([]);
  });

  it("works out when a control is due", () => {
    expect(defenceControlDue(7, null, "2026-03-01")).toEqual({ dueOn: "2026-03-01", status: "never" });
    expect(defenceControlDue(7, "2026-02-01", "2026-03-01")).toEqual({
      dueOn: "2026-02-08",
      status: "overdue",
    });
    expect(defenceControlDue(7, "2026-02-23", "2026-03-01")).toEqual({
      dueOn: "2026-03-02",
      status: "due_soon",
    });
    expect(defenceControlDue(7, "2026-02-25", "2026-03-01").status).toBe("ok");
    expect(defenceControlDue(30, "2026-02-25", "2026-03-01")).toEqual({ dueOn: "2026-03-27", status: "ok" });
    // A daily check done today is up to date; it is due soon on the day it falls due.
    expect(defenceControlDue(1, "2026-03-01", "2026-03-01").status).toBe("ok");
    expect(defenceControlDue(1, "2026-02-28", "2026-03-01").status).toBe("due_soon");
    expect(defenceReviewStatus("2026-02-28", "2026-03-01")).toBe("overdue");
    expect(defenceReviewStatus(null, "2026-03-01")).toBe("never");
  });

  it("lists what a review changes", () => {
    const a = threat();
    const b = threat({ id: "22222222-2222-4222-8222-222222222222", area: "Store" });
    expect(
      diffDefenceThreats(
        [a, b],
        [{ ...a, likelihood: 4 }, threat({ id: "33333333-3333-4333-8333-333333333333", area: "Gate" })],
      ),
    ).toEqual([
      { id: a.id, area: "Silo", change: "rerated", detail: "6 (low) → 12 (medium)" },
      expect.objectContaining({ area: "Gate", change: "added" }),
      expect.objectContaining({ area: "Store", change: "removed" }),
    ]);
    expect(diffDefenceThreats([a], [{ ...a, mitigation: "x" }])[0]!.change).toBe("changed");
  });

  it("a failed check says what was wrong", () => {
    expect(defenceCheckSchema.safeParse({ checkedOn: "2026-03-01", outcome: "fail" }).success).toBe(false);
    expect(defenceCheckSchema.safeParse({ checkedOn: "2026-03-01", outcome: "pass" }).success).toBe(true);
  });
});
