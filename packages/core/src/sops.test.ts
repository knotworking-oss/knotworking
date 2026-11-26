import { describe, expect, it } from "vitest";
import {
  addDaysToIsoDate,
  addMonthsToIsoDate,
  canApproveSopVersion,
  defaultSopReviewDueOn,
  isIsoDateInRange,
  isoToday,
  sopCopyCloseSchema,
  sopCopyIssueSchema,
  sopCopyListQuerySchema,
  sopCreateSchema,
  sopDecisionSchema,
  sopDraftSchema,
  sopListQuerySchema,
  sopReminderDueOn,
  sopReminderRound,
  sopReviewState,
  sopSubmitSchema,
  sopUpdateSchema,
} from "./sops";

describe("review dates", () => {
  it("defaults the review date to the effective date plus the interval", () => {
    expect(defaultSopReviewDueOn("2026-03-15", 12)).toBe("2027-03-15");
    expect(defaultSopReviewDueOn("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonthsToIsoDate("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsToIsoDate("2026-08-31", 6)).toBe("2027-02-28");
    // Years below 100 keep their century; past 9999 the year is written in the expanded form.
    expect(addMonthsToIsoDate("0050-01-31", 1)).toBe("0050-02-28");
    expect(addDaysToIsoDate("0050-06-15", 0)).toBe("0050-06-15");
    expect(addDaysToIsoDate("0099-12-31", 1)).toBe("0100-01-01");
    expect(addDaysToIsoDate("9998-12-31", 730)).toBe("+010000-12-30");
    expect(isIsoDateInRange("+010000-12-30")).toBe(false);
    expect(isIsoDateInRange("0050-06-15")).toBe(true);
  });

  it("classifies a review date as overdue, soon or ok", () => {
    const today = "2026-06-01";
    expect(sopReviewState(null, today)).toBeNull();
    expect(sopReviewState("2026-05-31", today)).toBe("overdue");
    expect(sopReviewState("2026-06-01", today)).toBe("soon");
    expect(sopReviewState("2026-07-01", today)).toBe("soon");
    expect(sopReviewState("2026-07-02", today)).toBe("ok");
    expect(isoToday(new Date("2026-06-01T23:59:00Z"))).toBe(today);
  });
});

describe("four-eyes", () => {
  it("lets anyone but the submitter approve", () => {
    expect(canApproveSopVersion({ submittedBy: "a", deciderId: "b", managerIds: ["a", "b"] })).toBe(true);
    expect(canApproveSopVersion({ submittedBy: null, deciderId: "b", managerIds: ["b"] })).toBe(true);
  });

  it("refuses the submitter unless they are the only member with manage", () => {
    expect(canApproveSopVersion({ submittedBy: "a", deciderId: "a", managerIds: ["a", "b"] })).toBe(false);
    expect(canApproveSopVersion({ submittedBy: "a", deciderId: "a", managerIds: ["a"] })).toBe(true);
  });
});

describe("sop schemas", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wash" }] }] };

  it("trims and normalises header fields", () => {
    const sop = sopCreateSchema.parse({ code: " SOP-001 ", title: " Hand washing ", category: " " });
    expect(sop).toEqual({ code: "SOP-001", title: "Hand washing", category: null });
    expect(sopCreateSchema.safeParse({ code: "", title: "x" }).success).toBe(false);
    expect(sopUpdateSchema.safeParse({}).success).toBe(false);
    expect(sopUpdateSchema.safeParse({ reviewIntervalMonths: 0 }).success).toBe(false);
    expect(sopUpdateSchema.parse({ status: "archived" })).toEqual({ status: "archived" });
  });

  it("validates draft content as a document body", () => {
    expect(sopDraftSchema.safeParse({ content: doc }).success).toBe(true);
    expect(sopDraftSchema.safeParse({ content: null, expectedDraftUpdatedAt: null }).success).toBe(true);
    expect(sopDraftSchema.safeParse({ content: { type: "page" } }).success).toBe(false);
    expect(sopDraftSchema.safeParse({ content: doc, expectedDraftUpdatedAt: "yesterday" }).success).toBe(
      false,
    );
  });

  it("needs a change summary to submit and a note to reject", () => {
    expect(sopSubmitSchema.safeParse({ changeSummary: "  " }).success).toBe(false);
    expect(sopDecisionSchema.safeParse({ decision: "reject" }).success).toBe(false);
    expect(sopDecisionSchema.safeParse({ decision: "reject", note: "Step 3 is wrong" }).success).toBe(true);
    expect(sopDecisionSchema.parse({ decision: "approve" })).toEqual({ decision: "approve" });
    expect(sopDecisionSchema.safeParse({ decision: "approve", effectiveOn: "1 June" }).success).toBe(false);
    expect(sopDecisionSchema.safeParse({ decision: "publish" }).success).toBe(false);
  });

  it("defaults the list to active SOPs", () => {
    expect(sopListQuerySchema.parse({})).toMatchObject({ status: "active", limit: 50, offset: 0 });
    expect(sopListQuerySchema.safeParse({ due: "later" }).success).toBe(false);
  });
});

describe("reminder rounds", () => {
  it("is on the first reminder once the period has passed, and repeats every interval", () => {
    expect(sopReminderRound(13, 14, 7)).toBeNull();
    expect(sopReminderRound(14, 14, 7)).toBe(0);
    expect(sopReminderRound(20, 14, 7)).toBe(0);
    expect(sopReminderRound(21, 14, 7)).toBe(1);
    expect(sopReminderRound(35, 14, 7)).toBe(3);
  });

  it("never repeats without an interval", () => {
    expect(sopReminderRound(3, 3, null)).toBe(0);
    expect(sopReminderRound(300, 3, null)).toBe(0);
  });

  it("works out the day a round falls due", () => {
    expect(sopReminderDueOn("2026-11-01", 14, 7, 0)).toBe("2026-11-15");
    expect(sopReminderDueOn("2026-11-01", 14, 7, 2)).toBe("2026-11-29");
    expect(sopReminderDueOn("2026-11-01", 14, null, 0)).toBe("2026-11-15");
  });

  it("takes a repeat interval in days, or null, on the SOP", () => {
    const base = { code: "SOP-1", title: "Cleaning" };
    expect(sopCreateSchema.parse({ ...base, ackReminderRepeatDays: 7 }).ackReminderRepeatDays).toBe(7);
    expect(sopCreateSchema.safeParse({ ...base, ackReminderRepeatDays: 0 }).success).toBe(false);
    expect(sopUpdateSchema.parse({ ackReminderRepeatDays: null })).toEqual({ ackReminderRepeatDays: null });
  });
});

describe("controlled copy schemas", () => {
  it("needs someone or somewhere to issue to", () => {
    expect(sopCopyIssueSchema.safeParse({}).success).toBe(false);
    expect(sopCopyIssueSchema.safeParse({ issuedTo: "  " }).success).toBe(false);
    expect(sopCopyIssueSchema.safeParse({ issuedTo: "Packing room" }).success).toBe(true);
    expect(
      sopCopyIssueSchema.safeParse({ issuedToUserId: "0190a000-0000-7000-8000-000000000001" }).success,
    ).toBe(true);
  });

  it("closes a copy as returned or destroyed", () => {
    expect(sopCopyCloseSchema.safeParse({ status: "returned" }).success).toBe(true);
    expect(sopCopyCloseSchema.safeParse({ status: "issued" }).success).toBe(false);
  });

  it("lists copies still out by default", () => {
    expect(sopCopyListQuerySchema.parse({})).toMatchObject({ status: "issued", limit: 100 });
    expect(sopCopyListQuerySchema.parse({ outOfDate: "true" }).outOfDate).toBe(true);
  });
});
