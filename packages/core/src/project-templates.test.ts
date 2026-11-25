import { describe, expect, it } from "vitest";
import { isModuleId } from "./modules";
import {
  planProjectTemplate,
  projectFromTemplateSchema,
  projectTemplateIds,
  projectTemplateModules,
  projectTemplates,
  projectTemplatesByWorkflow,
  projectTemplateWorkflows,
} from "./project-templates";

const none = () => false;
const all = () => true;

describe("project templates", () => {
  it("lists every template once in the picker, grouped by workflow", () => {
    const groups = projectTemplatesByWorkflow();
    expect(groups.flatMap((g) => g.ids).sort()).toEqual([...projectTemplateIds].sort());
    expect(groups.map((g) => g.workflow)).toEqual(
      Object.keys(projectTemplateWorkflows).filter((w) => groups.some((g) => g.workflow === w)),
    );
  });

  it.each(projectTemplateIds)("%s is well formed", (id) => {
    const template = projectTemplates[id];
    const keys = template.tasks.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(template.tasks.length).toBeGreaterThan(0);
    const replaced = new Set<string>();
    for (const moduleId of projectTemplateModules(id)) {
      expect(isModuleId(moduleId)).toBe(true);
      for (const step of template.moduleSteps[moduleId] ?? []) {
        if (step.replaces) {
          // A replacement keeps the starter task's key, so a sent key resolves per creator.
          expect(step.key).toBe(step.replaces);
          expect(keys).toContain(step.replaces);
          expect(replaced.has(step.replaces)).toBe(false);
          replaced.add(step.replaces);
        } else {
          expect(keys).not.toContain(step.key);
        }
        expect(step.link?.path ?? "").not.toMatch(/^\//);
      }
    }
    const everything = planProjectTemplate(id, all).map((t) => t.key);
    expect(new Set(everything).size).toBe(everything.length);
  });

  it("keeps a Tasks-only plan to the starter tasks, sorted by date", () => {
    const plan = planProjectTemplate("equipment_commissioning", none);
    expect(plan.map((t) => [t.key, t.daysFromStart, t.module])).toEqual([
      ["register", -2, null],
      ["acceptance", 0, null],
      ["warranty", 1, null],
      ["maintenance", 3, null],
    ]);
    expect(plan.every((t) => !t.link)).toBe(true);
  });

  it("replaces and adds steps only for modules the creator can use", () => {
    const plan = planProjectTemplate("site_job", (m) => m === "checklists" || m === "purchasing");
    expect(plan.map((t) => [t.key, t.module])).toEqual([
      ["schedule", null],
      ["materials_order", "purchasing"],
      ["tools", null],
      ["site_checks", "checklists"],
      ["handover", null],
    ]);
    expect(plan.find((t) => t.key === "site_checks")?.link?.path).toBe("checklists");
  });

  it("leaves the two original templates unchanged", () => {
    expect(planProjectTemplate("employee_onboarding", all).map((t) => t.daysFromStart)).toEqual([
      -7, -3, -1, 0, 3, 7,
    ]);
    expect(planProjectTemplate("client_kickoff", all).map((t) => t.title)).toEqual([
      "Confirm scope, contacts and responsibilities",
      "Share the kickoff agenda",
      "Hold the kickoff meeting",
      "Send decisions and next actions",
      "Confirm milestones and review dates",
    ]);
  });

  it("validates edited tasks", () => {
    const base = {
      commandId: "0193b0a0-0000-7000-8000-000000000001",
      templateId: "site_job",
      name: "Boiler swap",
      teamId: "0193b0a0-0000-7000-8000-000000000002",
      leadId: "0193b0a0-0000-7000-8000-000000000003",
      startDate: "2027-03-01",
    };
    expect(projectFromTemplateSchema.safeParse(base).success).toBe(true);
    expect(
      projectFromTemplateSchema.safeParse({
        ...base,
        tasks: [
          { step: "schedule", title: "Call the customer", daysFromStart: -2 },
          { title: "Extra", daysFromStart: 4 },
        ],
      }).success,
    ).toBe(true);
    expect(projectFromTemplateSchema.safeParse({ ...base, tasks: [] }).success).toBe(false);
    expect(
      projectFromTemplateSchema.safeParse({
        ...base,
        tasks: [
          { step: "schedule", title: "A", daysFromStart: 0 },
          { step: "schedule", title: "B", daysFromStart: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      projectFromTemplateSchema.safeParse({ ...base, tasks: [{ title: "Far", daysFromStart: 5000 }] })
        .success,
    ).toBe(false);
    expect(
      projectFromTemplateSchema.safeParse({ ...base, tasks: [{ title: "Half", daysFromStart: 1.5 }] })
        .success,
    ).toBe(false);
  });
});
