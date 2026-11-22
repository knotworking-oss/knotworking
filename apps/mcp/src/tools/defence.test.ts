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

describe("food defence tools", () => {
  it("adds controls, drafts an assessment linking them by name and opens a review", async () => {
    const { call, fake } = await session();
    const gate = await call("add_defence_control", {
      workspace: "acme",
      name: "Yard gate locked",
      kind: "perimeter",
      frequency_days: 1,
    });
    expect(gate.data).toMatchObject({ name: "Yard gate locked", frequencyDays: 1 });
    const draft = await call("draft_defence_assessment", {
      workspace: "acme",
      title: "Site TACCP",
      threats: [
        {
          area: "Silo",
          threat: "Contamination at the fill point",
          source: "intruder",
          likelihood: 3,
          impact: 5,
          controls: ["yard gate locked"],
        },
      ],
    });
    expect(draft.data.draft.threats[0]).toMatchObject({
      score: 15,
      rating: "high",
      controls: ["Yard gate locked"],
    });
    expect(draft.data.approvalBlockers.join(" ")).toMatch(/needs a mitigation/);
    expect(draft.data.note).toMatch(/no tools/);
    const threat = draft.data.draft.threats[0];
    const saved = await call("draft_defence_assessment", {
      workspace: "acme",
      assessment: "site taccp",
      threats: [{ ...threat, controls: threat.controls, mitigation: "Lockable cap" }],
      review_due_on: "2027-03-01",
    });
    expect(saved.data.approvalBlockers).toEqual([]);

    // A person approves in the app; the agent can then open a review.
    fake.defenceModule.approve(saved.data.id);
    const review = await call("start_defence_review", {
      workspace: "acme",
      assessment: "Site TACCP",
      trigger: "incident",
      reason: "Gate found open",
    });
    expect(review.data.draft).toMatchObject({ version: 2, reviewTrigger: "incident" });
    expect(review.data.approved.version).toBe(1);

    const controls = await call("list_defence_controls", { workspace: "acme" });
    expect(controls.data.controls[0]).toMatchObject({ name: "Yard gate locked", dueStatus: "never" });
    const overview = await call("get_food_defence_overview", { workspace: "acme" });
    expect(overview.data.counts.overdueControls).toBe(1);
  });

  it("refuses an unknown control name", async () => {
    const { call } = await session();
    const res = await call("draft_defence_assessment", {
      workspace: "acme",
      title: "x",
      threats: [{ area: "a", threat: "b", source: "visitor", likelihood: 1, impact: 1, controls: ["nope"] }],
    });
    expect(res.data.error.code).toBe("not_found");
  });
});
