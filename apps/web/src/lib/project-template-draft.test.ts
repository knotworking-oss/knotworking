import { describe, expect, it } from "vitest";
import {
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
