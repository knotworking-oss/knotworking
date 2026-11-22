import { describe, expect, it } from "vitest";
import { labelPrintState } from "./label-print";

describe("labelPrintState", () => {
  it("lets only an approved, current label go on pack", () => {
    expect(labelPrintState({ status: "approved", stale: false })).toMatchObject({ banner: null });
  });

  it("stamps a draft DRAFT, even when it is out of date", () => {
    expect(labelPrintState({ status: "draft", stale: false }).banner).toBe("DRAFT");
    expect(labelPrintState({ status: "draft", stale: true }).banner).toBe("DRAFT");
  });

  it("stamps an approved label that went stale NEEDS REVIEW", () => {
    const state = labelPrintState({ status: "approved", stale: true });
    expect(state.banner).toBe("NEEDS REVIEW");
    expect(state.reason).toMatch(/changed after approval/);
  });

  it("stamps a replaced label SUPERSEDED", () => {
    expect(labelPrintState({ status: "superseded", stale: false }).banner).toBe("SUPERSEDED");
  });
});
