import { describe, expect, it } from "vitest";
import {
  draftDateIssue,
  draftTaskDate,
  draftTaskOffset,
  draftTasksInput,
  draftTemplateSpan,
  draftTemplateTasks,
  suggestedTemplateModules,
} from "./project-template-draft";

describe("project template drafts", () => {
  it("drafts the viewer's plan and keeps dates relative to the milestone", () => {
    const rows = draftTemplateTasks("equipment_commissioning", (m) => m === "assets");
    expect(rows.map((r) => [r.step, r.module])).toEqual([
      ["register", "assets"],
      ["acceptance", null],
      ["warranty", "assets"],
      ["maintenance", null],
    ]);
    expect(draftTaskDate("2027-03-01", rows[0]!)).toBe("2027-02-27");
    expect(draftTaskOffset("2027-03-01", "2027-02-27")).toBe(-2);
    expect(draftTemplateSpan("2027-03-01", rows)).toEqual({ start: "2027-02-27", target: "2027-03-04" });
    expect(draftTemplateSpan("2027-03-01", [])).toBeNull();
  });

  it("flags due dates outside 0001–9999 the way the API does", () => {
    const row = (daysFromStart: number) => ({ id: "r", title: "T", daysFromStart, module: null });
    expect(draftDateIssue("9998-12-31", [row(0), row(365)])).toBeNull();
    expect(draftDateIssue("9998-12-31", [row(730)])).toMatch(/after 9999-12-31/);
    expect(draftDateIssue("0001-01-01", [row(-1)])).toMatch(/before 0001-01-01/);
    expect(draftDateIssue("0050-06-15", [row(0)])).toBeNull();
    expect(draftTaskDate("0050-06-15", row(0))).toBe("0050-06-15");
    expect(draftTemplateSpan("9998-12-31", [row(730)])).toBeNull();
  });

  it("sends edited rows with their step keys, and custom rows without one", () => {
    expect(
      draftTasksInput([
        { id: "a", step: "register", title: " Register the press ", daysFromStart: -3, module: "assets" },
        { id: "b", title: "Train operators", daysFromStart: 4, module: null },
      ]),
    ).toEqual([
      { step: "register", title: "Register the press", daysFromStart: -3 },
      { title: "Train operators", daysFromStart: 4 },
    ]);
  });

  it("says which suggested modules apply", () => {
    expect(
      suggestedTemplateModules("equipment_commissioning", [
        { id: "assets", access: "read" },
        { id: "checklists", access: "none" },
      ]),
    ).toEqual([
      { id: "assets", state: "available" },
      { id: "checklists", state: "no_access" },
      { id: "maintenance", state: "inactive" },
    ]);
  });
});
