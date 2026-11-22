import { describe, expect, it } from "vitest";
import {
  canApproveSpecification,
  diffSpecifications,
  formatParameterLimit,
  itemDiscrepancies,
  specificationApprovalBlockers,
  specificationDraftSchema,
  specificationDueSoonCutoff,
  specificationReviewState,
  type SpecificationContent,
} from "./specifications";

const content = (over: Partial<SpecificationContent> = {}): SpecificationContent => ({
  description: null,
  storage: "chilled",
  storageInstructions: null,
  shelfLifeDays: 10,
  minimumLifeOnReceiptDays: null,
  allergens: ["milk"],
  mayContain: [],
  countryOfOrigin: null,
  provenance: null,
  claims: [],
  packagingDetails: null,
  parameters: [],
  ...over,
});

describe("diffSpecifications", () => {
  it("lists every non-empty field of a first version", () => {
    const diff = diffSpecifications(null, content());
    expect(diff.fields.map((f) => f.field)).toEqual(["storage", "shelfLifeDays", "allergens"]);
    expect(diff.addedAllergens).toEqual(["milk"]);
    expect(diff.impacting).toBe(true);
  });

  it("treats may-contain becoming contains as an added allergen", () => {
    const diff = diffSpecifications(
      content({ allergens: [], mayContain: ["nuts"] }),
      content({ allergens: ["nuts"] }),
    );
    expect(diff.addedAllergens).toEqual(["nuts"]);
    expect(diff.removedAllergens).toEqual([]);
  });

  it("matches parameters by category and name, ignoring case", () => {
    const before = content({
      parameters: [
        {
          category: "chemical",
          name: "pH",
          unit: null,
          min: 4,
          target: null,
          max: 4.6,
          limitText: null,
          method: null,
          note: null,
        },
      ],
    });
    const after = content({
      parameters: [
        {
          category: "chemical",
          name: "PH",
          unit: null,
          min: 4,
          target: null,
          max: 4.4,
          limitText: null,
          method: null,
          note: null,
        },
      ],
    });
    const diff = diffSpecifications(before, after);
    expect(diff.parameters).toEqual([
      { change: "changed", category: "chemical", name: "PH", from: "4–4.6", to: "4–4.4" },
    ]);
    // A tested limit changing affects release, not what's declared.
    expect(diff.impacting).toBe(false);
  });

  it("ignores claim order and finds nothing when nothing changed", () => {
    const diff = diffSpecifications(
      content({ claims: ["Vegan", "Organic"] }),
      content({ claims: ["Organic", "Vegan"] }),
    );
    expect(diff.fields).toEqual([]);
    expect(diff.parameters).toEqual([]);
  });
});

describe("formatParameterLimit", () => {
  it("writes ranges, one-sided limits, targets and text", () => {
    expect(formatParameterLimit({ min: 1, max: 2, target: 1.5, unit: "%", limitText: null })).toBe(
      "1–2 %; target 1.5 %",
    );
    expect(formatParameterLimit({ min: null, max: 100, target: null, unit: "cfu/g", limitText: null })).toBe(
      "≤ 100 cfu/g",
    );
    expect(
      formatParameterLimit({ min: null, max: null, target: null, unit: null, limitText: "Absent in 25 g" }),
    ).toBe("Absent in 25 g");
  });
});

describe("itemDiscrepancies", () => {
  const item = {
    allergens: ["milk"] as const,
    mayContain: [] as const,
    storage: "chilled" as const,
    shelfLifeDays: 10,
  };

  it("flags an item that understates the specification as serious", () => {
    const found = itemDiscrepancies(content({ allergens: ["milk", "eggs"], mayContain: ["nuts"] }), item);
    expect(found.map((d) => [d.kind, d.severity, d.allergens])).toEqual([
      ["allergen_undeclared", "serious", ["eggs"]],
      ["may_contain_undeclared", "serious", ["nuts"]],
    ]);
  });

  it("accepts an item that declares as contained what the specification says it may contain", () => {
    expect(itemDiscrepancies(content({ allergens: [], mayContain: ["milk"] }), item)).toEqual([]);
  });

  it("asks to check an allergen the specification doesn't mention, storage and a shorter shelf life", () => {
    const found = itemDiscrepancies(content({ allergens: [], storage: "frozen", shelfLifeDays: 30 }), item);
    expect(found.map((d) => [d.kind, d.severity])).toEqual([
      ["allergen_unexplained", "check"],
      ["shelf_life_differs", "check"],
      ["storage_differs", "check"],
    ]);
  });

  it("calls an item that outlasts its specification serious", () => {
    expect(itemDiscrepancies(content({ shelfLifeDays: 7 }), item)[0]).toMatchObject({
      kind: "shelf_life_longer",
      severity: "serious",
    });
  });
});

describe("approval", () => {
  const base = {
    kind: "ingredient" as const,
    party: "internal" as const,
    reviewDueOn: "2027-01-01",
    agreedOn: null,
    today: "2026-11-14",
  };

  it("needs storage, shelf life and a future review date for food", () => {
    expect(specificationApprovalBlockers({ ...base, content: content() })).toEqual([]);
    expect(
      specificationApprovalBlockers({
        ...base,
        content: content({ storage: null, shelfLifeDays: null }),
        reviewDueOn: "2026-11-14",
      }),
    ).toEqual(["Set the storage condition", "Set the shelf life", "Set a review date in the future"]);
  });

  it("needs packaging details for packaging, and the other party's agreement", () => {
    expect(
      specificationApprovalBlockers({
        ...base,
        kind: "packaging",
        party: "supplier",
        content: content({ storage: null, shelfLifeDays: null }),
      }),
    ).toEqual([
      "Describe the packaging: material and food-contact compliance",
      "Record the supplier's agreement (who and when)",
    ]);
    expect(
      specificationApprovalBlockers({
        ...base,
        party: "customer",
        content: content(),
        agreedOn: "2026-12-01",
      }),
    ).toEqual(["The agreement date can't be in the future"]);
  });

  it("keeps the last editor from approving unless they are the only manager", () => {
    expect(canApproveSpecification({ lastEditedBy: "a", deciderId: "a", managerIds: ["a", "b"] })).toBe(
      false,
    );
    expect(canApproveSpecification({ lastEditedBy: "a", deciderId: "b", managerIds: ["a", "b"] })).toBe(true);
    expect(canApproveSpecification({ lastEditedBy: "a", deciderId: "a", managerIds: ["a"] })).toBe(true);
  });
});

describe("review state", () => {
  it("is overdue, due soon, ok or none", () => {
    expect(specificationReviewState(null, "2026-11-14")).toBe("none");
    expect(specificationReviewState("2026-11-13", "2026-11-14")).toBe("overdue");
    expect(specificationReviewState("2026-11-14", "2026-11-14")).toBe("due_soon");
    expect(specificationReviewState("2026-12-14", "2026-11-14")).toBe("due_soon");
    expect(specificationReviewState("2026-12-15", "2026-11-14")).toBe("ok");
    expect(specificationDueSoonCutoff("2026-11-14")).toBe("2026-12-14");
  });
});

describe("draft schema", () => {
  it("defaults lists and rejects duplicate claims", () => {
    expect(specificationDraftSchema.parse({})).toMatchObject({
      allergens: [],
      mayContain: [],
      claims: [],
      parameters: [],
    });
    expect(specificationDraftSchema.safeParse({ claims: ["Vegan", "vegan"] }).success).toBe(false);
  });
});
