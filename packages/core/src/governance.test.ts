import { describe, expect, it } from "vitest";
import {
  governanceConcernSubmitSchema,
  governanceConcernUpdateSchema,
  governanceCultureState,
  governanceDueStatus,
  governanceReviewCreateSchema,
  governanceSignBlockers,
} from "./governance";

const D = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";

describe("governance rules", () => {
  it("works out due dates and culture activity states", () => {
    expect(governanceDueStatus(null, "2026-03-01")).toBe("none");
    expect(governanceDueStatus("2026-02-28", "2026-03-01")).toBe("overdue");
    expect(governanceDueStatus("2026-03-10", "2026-03-01")).toBe("due_soon");
    expect(governanceDueStatus("2026-04-10", "2026-03-01")).toBe("ok");
    const a = { plannedOn: "2026-02-01", completedOn: null, cancelledAt: null };
    expect(governanceCultureState(a, "2026-03-01")).toBe("overdue");
    expect(governanceCultureState({ ...a, plannedOn: "2026-03-05" }, "2026-03-01")).toBe("planned");
    expect(governanceCultureState({ ...a, completedOn: "2026-02-02" }, "2026-03-01")).toBe("done");
    expect(governanceCultureState({ ...a, cancelledAt: new Date() }, "2026-03-01")).toBe("cancelled");
  });

  it("blocks signing until the review is held, attended and its actions can be followed up", () => {
    const base = { heldOn: null, attendees: null, decisions: [], followUpTeamId: null, tasksActive: true };
    expect(governanceSignBlockers(base, "2026-03-01")).toEqual([
      "Record when the review was held",
      "Record who attended",
    ]);
    expect(
      governanceSignBlockers({ ...base, heldOn: "2026-03-02", attendees: "Board" }, "2026-03-01"),
    ).toEqual(["The review can't be signed before it is held"]);
    const owned = {
      ...base,
      heldOn: "2026-03-01",
      attendees: "Board",
      decisions: [{ id: D, topic: null, decision: "Fix the sieve", ownerUserId: U, dueOn: null }],
    };
    expect(governanceSignBlockers(owned, "2026-03-01")).toEqual([
      "Choose the team the follow-up tasks go to",
      'Set a due date for "Fix the sieve"',
    ]);
    // Without the Tasks module no team is needed; the decision is still recorded.
    expect(governanceSignBlockers({ ...owned, tasksActive: false }, "2026-03-01")).toEqual([
      'Set a due date for "Fix the sieve"',
    ]);
  });

  it("validates concerns and reviews", () => {
    expect(governanceConcernSubmitSchema.safeParse({ category: "other", description: "short" }).success).toBe(
      false,
    );
    expect(
      governanceConcernSubmitSchema.parse({ category: "other", description: "A longer description of it" })
        .anonymous,
    ).toBe(false);
    expect(governanceConcernUpdateSchema.safeParse({ status: "closed" }).success).toBe(false);
    expect(governanceConcernUpdateSchema.safeParse({ status: "closed", outcome: "Fixed" }).success).toBe(
      true,
    );
    expect(
      governanceReviewCreateSchema.safeParse({ title: "Q", periodFrom: "2026-03-01", periodTo: "2026-02-01" })
        .success,
    ).toBe(false);
  });
});
