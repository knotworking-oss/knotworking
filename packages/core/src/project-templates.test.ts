import { describe, expect, it } from "vitest";
import { isModuleId } from "./modules";
import {
  PROJECT_TEMPLATE_MAX_TASKS,
  planProjectTemplate,
  projectFromTemplateSchema,
  projectTemplateDateIssue,
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

  // Fixtures copied from the templates as they shipped before the expansion, so an edit to either
  // template's titles or offsets fails here rather than passing against its own definition.
  it.each([
    [
      "employee_onboarding",
      [
        ["Prepare equipment and workspace", -7],
        ["Set up accounts and access", -3],
        ["Send the first-day agenda", -1],
        ["Introduce the team and review key policies", 0],
        ["Schedule role training", 3],
        ["Hold the first-week check-in", 7],
      ],
    ],
    [
      "client_kickoff",
      [
        ["Confirm scope, contacts and responsibilities", -5],
        ["Share the kickoff agenda", -2],
        ["Hold the kickoff meeting", 0],
        ["Send decisions and next actions", 1],
        ["Confirm milestones and review dates", 3],
      ],
    ],
  ] as const)("leaves the original %s template unchanged", (id, expected) => {
    for (const canUse of [none, all])
      expect(planProjectTemplate(id, canUse).map((t) => [t.title, t.daysFromStart])).toEqual(expected);
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

  const base = {
    commandId: "0193b0a0-0000-7000-8000-000000000001",
    templateId: "site_job",
    name: "Boiler swap",
    teamId: "0193b0a0-0000-7000-8000-000000000002",
    leadId: "0193b0a0-0000-7000-8000-000000000003",
    startDate: "2027-03-01",
  };
  const parses = (input: object) => projectFromTemplateSchema.safeParse({ ...base, ...input }).success;
  const tasks = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ title: `T${i}`, daysFromStart: 0 }));

  it("takes up to the task limit and titles up to 512 characters", () => {
    expect(PROJECT_TEMPLATE_MAX_TASKS).toBe(50);
    expect(parses({ tasks: tasks(50) })).toBe(true);
    expect(parses({ tasks: tasks(51) })).toBe(false);
    expect(parses({ tasks: [{ title: "x".repeat(512), daysFromStart: 0 }] })).toBe(true);
    expect(parses({ tasks: [{ title: "x".repeat(513), daysFromStart: 0 }] })).toBe(false);
    // Trimmed first: surrounding spaces don't count towards the limit, and a blank title is refused.
    expect(parses({ tasks: [{ title: ` ${"x".repeat(512)} `, daysFromStart: 0 }] })).toBe(true);
    expect(parses({ tasks: [{ title: "   ", daysFromStart: 0 }] })).toBe(false);
  });

  it("refuses due dates outside 0001-01-01 to 9999-12-31", () => {
    // Early years keep their century (0050 is not 1950).
    expect(parses({ startDate: "0050-06-15", tasks: [{ title: "Old", daysFromStart: 0 }] })).toBe(true);
    expect(projectTemplateDateIssue("0050-06-15", [-1, 1])).toBeNull();
    expect(parses({ startDate: "0001-01-01", tasks: [{ title: "First", daysFromStart: 0 }] })).toBe(true);
    expect(parses({ startDate: "0001-01-01", tasks: [{ title: "Before", daysFromStart: -1 }] })).toBe(false);
    expect(parses({ startDate: "9999-12-31", tasks: [{ title: "Last", daysFromStart: 0 }] })).toBe(true);
    // 9998-12-31 + 730 days is in year 10000, which would sort before 9998.
    const late = projectFromTemplateSchema.safeParse({
      ...base,
      startDate: "9998-12-31",
      tasks: [{ title: "Too late", daysFromStart: 730 }],
    });
    expect(late.success).toBe(false);
    expect(late.error?.issues[0]?.path).toEqual(["tasks", 0, "daysFromStart"]);
    expect(parses({ startDate: "9998-12-31", tasks: [{ title: "Fits", daysFromStart: 365 }] })).toBe(true);
    // Without edited tasks, the template's own offsets (site_job: -5 to +1 days) are checked.
    expect(parses({ startDate: "0001-01-03" })).toBe(false);
    expect(parses({ startDate: "0001-01-06" })).toBe(true);
    expect(parses({ startDate: "9999-12-31" })).toBe(false);
    expect(parses({ startDate: "0000-12-31" })).toBe(false);
  });
});
