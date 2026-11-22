import { describe, expect, it } from "vitest";
import { npdLaunchChecklist, npdProjectUpdateSchema, npdTrialSchema, type NpdChecklistFacts } from "./npd";

const facts = (
  over: Partial<NpdChecklistFacts> = {},
  project: Partial<NpdChecklistFacts["project"]> = {},
): NpdChecklistFacts => ({
  active: ["items", "recipes", "specifications", "labels"],
  project: {
    name: "Tart",
    brief: "Concept",
    customerName: null,
    targetLaunchOn: "2027-01-01",
    targetShelfLifeDays: 10,
    storage: "chilled",
    outputItemId: "i1",
    recipeId: "r1",
    signoffs: {
      haccp_reviewed: { by: "A", on: "2026-11-01", reference: null, recordedBy: "u", recordedAt: "x" },
      artwork_agreed: { by: "B", on: "2026-11-01", reference: null, recordedBy: "u", recordedAt: "x" },
    },
    ...project,
  },
  recipeApprovedVersion: 2,
  trials: [
    { kind: "factory", outcome: "pass", heldOn: "2026-11-01", achievedShelfLifeDays: null },
    { kind: "shelf_life", outcome: "pass", heldOn: "2026-11-02", achievedShelfLifeDays: 12 },
  ],
  approvedSpecification: "SPEC-1 v1",
  approvedLabel: "Tart (Standard v1)",
  ...over,
});

describe("npdLaunchChecklist", () => {
  it("is ready when every check is met, with no customer to sign", () => {
    const c = npdLaunchChecklist(facts());
    expect(c.ready).toBe(true);
    expect(c.checks.find((x) => x.key === "customer_signoff")?.status).toBe("na");
  });

  it("only counts passing trials, and shelf life against the target", () => {
    const c = npdLaunchChecklist(
      facts({
        trials: [
          { kind: "factory", outcome: "adjust", heldOn: "2026-11-01", achievedShelfLifeDays: null },
          { kind: "shelf_life", outcome: "fail", heldOn: "2026-11-02", achievedShelfLifeDays: 20 },
          { kind: "shelf_life", outcome: "pass", heldOn: "2026-11-03", achievedShelfLifeDays: 9 },
        ],
      }),
    );
    expect(c.ready).toBe(false);
    expect(c.checks.find((x) => x.key === "factory_trial")?.status).toBe("missing");
    expect(c.checks.find((x) => x.key === "shelf_life")?.detail).toBe(
      "Best proven 9 days, short of the 10-day target",
    );
  });

  it("doesn't apply checks for switched-off modules, but needs a named customer's sign-off", () => {
    const c = npdLaunchChecklist(
      facts(
        { active: ["items", "recipes"], approvedSpecification: null, approvedLabel: null },
        { customerName: "Shop" },
      ),
    );
    expect(c.checks.filter((x) => x.status === "na").map((x) => x.key)).toEqual(["specification", "label"]);
    expect(c.checks.find((x) => x.key === "customer_signoff")?.status).toBe("missing");
  });

  it("lists what the brief and links are missing", () => {
    const c = npdLaunchChecklist(facts({}, { brief: null, storage: null, recipeId: null }));
    expect(c.checks.find((x) => x.key === "brief_complete")?.detail).toBe("Missing: concept, storage");
    expect(c.checks.find((x) => x.key === "product_linked")?.detail).toBe("Link the recipe");
  });
});

describe("validation", () => {
  it("needs a reason to cancel and the achieved life for a shelf-life study", () => {
    expect(npdProjectUpdateSchema.safeParse({ status: "cancelled" }).success).toBe(false);
    expect(
      npdTrialSchema.safeParse({
        kind: "shelf_life",
        heldOn: "2026-11-01",
        description: "x",
        outcome: "pass",
      }).success,
    ).toBe(false);
  });
});
