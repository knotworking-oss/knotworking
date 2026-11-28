import { z } from "zod";
import type { ModuleId } from "./modules";
import { addDaysToIsoDate, ISO_DATE_MAX, ISO_DATE_MIN, isIsoDateInRange } from "./sops";

/**
 * Built-in project templates (Projects → Use template)
 * ----------------------------------------------------
 * A template is data: starter tasks dated relative to one milestone date (`dateLabel`, day 0), plus
 * optional module steps keyed by module id. Every template works with Tasks alone. When the
 * workspace has a module on and the creator can read it, its steps apply: a step either replaces
 * a starter task (`replaces`, same key, now with the module's wording and a link to its page) or
 * adds a task. Creating a project only makes an editable project and dated tasks; approvals,
 * checks and financial actions stay in each module's own screens.
 *
 * Adding steps for a module that ships later (Invoicing, Routings) is a data-only change: add an
 * entry under its id in `moduleSteps`.
 */

export const projectTemplateIds = [
  "employee_onboarding",
  "client_kickoff",
  "client_delivery",
  "site_job",
  "equipment_commissioning",
  "supplier_onboarding",
  "store_opening",
  "new_product_build",
  "product_launch",
  "kitchen_opening",
] as const;
export type ProjectTemplateId = (typeof projectTemplateIds)[number];

/** How the template picker groups templates, in display order. */
export const projectTemplateWorkflows = {
  people: "People",
  clients: "Client work",
  field: "Field and facilities",
  supply: "Supply and retail",
  manufacturing: "Manufacturing",
  food: "Food",
} as const;
export type ProjectTemplateWorkflow = keyof typeof projectTemplateWorkflows;

/** Most days a template task may sit before or after the milestone date. */
export const PROJECT_TEMPLATE_MAX_OFFSET_DAYS = 730;
/** Most tasks one template project may create. */
export const PROJECT_TEMPLATE_MAX_TASKS = 50;

export interface ProjectTemplateStep {
  /** Stable within the template: the key a client sends back for a generated task. */
  key: string;
  title: string;
  /** Days from the milestone date (negative: before it). */
  daysFromStart: number;
  /** Guidance put in the task description. */
  detail?: string;
  /** A page in the workspace (path under `/<workspace>/`) linked from the task description. */
  link?: { label: string; path: string };
}

export interface ProjectTemplateModuleStep extends ProjectTemplateStep {
  /** The starter task this step replaces; its key must equal `key`. Omit to add a task. */
  replaces?: string;
}

export interface ProjectTemplate {
  label: string;
  workflow: ProjectTemplateWorkflow;
  /** Who the template is for, shown in the picker. */
  audience: string;
  /** The milestone date the tasks are dated from. */
  dateLabel: string;
  /** Materialize the anchor date as a project milestone. */
  milestone?: boolean;
  /** Starter tasks: everything a Tasks-only workspace gets. */
  tasks: readonly ProjectTemplateStep[];
  /** Steps that apply when the module is on and the creator can read it. */
  moduleSteps: Partial<Record<ModuleId, readonly ProjectTemplateModuleStep[]>>;
}

const ASSETS = { label: "Open the asset register", path: "assets" };
const MAINTENANCE = { label: "Open Maintenance", path: "maintenance" };
const CHECKLISTS = { label: "Open Checklists", path: "checklists" };
const PURCHASING = { label: "Open purchase orders", path: "purchasing" };
const NONCONFORMANCES = { label: "Open non-conformances", path: "quality/nonconformances" };

export const projectTemplates: Record<ProjectTemplateId, ProjectTemplate> = {
  employee_onboarding: {
    label: "Employee onboarding",
    workflow: "people",
    audience: "Any team welcoming a new starter",
    dateLabel: "Employee start date",
    tasks: [
      { key: "equipment", title: "Prepare equipment and workspace", daysFromStart: -7 },
      { key: "accounts", title: "Set up accounts and access", daysFromStart: -3 },
      { key: "agenda", title: "Send the first-day agenda", daysFromStart: -1 },
      { key: "introductions", title: "Introduce the team and review key policies", daysFromStart: 0 },
      { key: "training", title: "Schedule role training", daysFromStart: 3 },
      { key: "check_in", title: "Hold the first-week check-in", daysFromStart: 7 },
    ],
    moduleSteps: {},
  },
  client_kickoff: {
    label: "Client kickoff",
    workflow: "clients",
    audience: "Teams starting work with a client",
    dateLabel: "Kickoff date",
    milestone: true,
    tasks: [
      { key: "scope", title: "Confirm scope, contacts and responsibilities", daysFromStart: -5 },
      { key: "agenda", title: "Share the kickoff agenda", daysFromStart: -2 },
      { key: "meeting", title: "Hold the kickoff meeting", daysFromStart: 0 },
      { key: "actions", title: "Send decisions and next actions", daysFromStart: 1 },
      { key: "milestones", title: "Confirm milestones and review dates", daysFromStart: 3 },
    ],
    moduleSteps: {},
  },
  client_delivery: {
    label: "Client delivery",
    workflow: "clients",
    audience: "Consultancies and agencies",
    dateLabel: "Delivery date",
    tasks: [
      { key: "scope", title: "Confirm scope and acceptance criteria", daysFromStart: -21 },
      { key: "milestones", title: "Plan milestones and review dates", daysFromStart: -20 },
      { key: "review", title: "Review deliverables with the client", daysFromStart: -3 },
      { key: "sign_off", title: "Collect client sign-off", daysFromStart: 0 },
      {
        key: "billing",
        title: "Prepare billing",
        daysFromStart: 2,
        detail: "Agree the billable amount and pass it to whoever raises invoices.",
      },
    ],
    moduleSteps: {
      client_services: [
        {
          key: "billing",
          replaces: "billing",
          title: "Prepare billing from the signed-off quote",
          daysFromStart: 2,
          detail: "Record the sign-off on the service quote, then use its billing draft.",
          link: { label: "Open Client services", path: "client-services" },
        },
      ],
      invoicing: [
        {
          key: "invoice",
          title: "Raise the invoice",
          daysFromStart: 3,
          detail:
            "Draft the customer invoice from the signed-off quote (or manually), choose each line's tax rate, then issue it in Invoicing.",
          link: { label: "Open Invoicing", path: "invoicing" },
        },
      ],
    },
  },
  site_job: {
    label: "Site job",
    workflow: "field",
    audience: "Trades and field teams",
    dateLabel: "Visit date",
    tasks: [
      { key: "schedule", title: "Schedule the visit with the customer", daysFromStart: -5 },
      { key: "tools", title: "Prepare tools and materials", daysFromStart: -1 },
      { key: "site_checks", title: "Complete site checks", daysFromStart: 0 },
      { key: "handover", title: "Hand over the work", daysFromStart: 1 },
    ],
    moduleSteps: {
      purchasing: [
        {
          key: "materials_order",
          title: "Order materials for the job",
          daysFromStart: -4,
          link: PURCHASING,
        },
      ],
      assets: [
        {
          key: "tools",
          replaces: "tools",
          title: "Prepare tools and equipment",
          daysFromStart: -1,
          detail: "Check the tools and equipment you are taking against the asset register.",
          link: ASSETS,
        },
      ],
      checklists: [
        {
          key: "site_checks",
          replaces: "site_checks",
          title: "Complete the site checklist",
          daysFromStart: 0,
          detail: "Run the site checklist on the day. Failed items raise follow-up actions.",
          link: CHECKLISTS,
        },
      ],
    },
  },
  equipment_commissioning: {
    label: "Equipment commissioning",
    workflow: "field",
    audience: "Equipment and facilities teams",
    dateLabel: "Commissioning date",
    tasks: [
      {
        key: "register",
        title: "Register the asset",
        daysFromStart: -2,
        detail: "Record the make, model, serial number and location.",
      },
      { key: "acceptance", title: "Carry out acceptance checks", daysFromStart: 0 },
      { key: "warranty", title: "Record warranty details", daysFromStart: 1 },
      { key: "maintenance", title: "Schedule maintenance", daysFromStart: 3 },
    ],
    moduleSteps: {
      assets: [
        {
          key: "register",
          replaces: "register",
          title: "Register the asset",
          daysFromStart: -2,
          detail: "Add it to the asset register with its make, model, serial number and location.",
          link: ASSETS,
        },
        {
          key: "warranty",
          replaces: "warranty",
          title: "Record warranty details on the asset",
          daysFromStart: 1,
          link: ASSETS,
        },
      ],
      checklists: [
        {
          key: "acceptance",
          replaces: "acceptance",
          title: "Carry out acceptance checks",
          daysFromStart: 0,
          detail: "Run an acceptance checklist and record any failures.",
          link: CHECKLISTS,
        },
      ],
      maintenance: [
        {
          key: "maintenance",
          replaces: "maintenance",
          title: "Schedule planned maintenance",
          daysFromStart: 3,
          detail: "Set up recurring maintenance for the new asset.",
          link: MAINTENANCE,
        },
      ],
    },
  },
  supplier_onboarding: {
    label: "Supplier onboarding",
    workflow: "supply",
    audience: "Wholesale and distribution",
    dateLabel: "Trial order date",
    tasks: [
      { key: "details", title: "Review supplier details and terms", daysFromStart: -10 },
      { key: "catalogue", title: "Check the catalogue and prices", daysFromStart: -5 },
      { key: "trial_order", title: "Place a trial order", daysFromStart: 0 },
      { key: "first_receipt", title: "Review the first receipt", daysFromStart: 7 },
    ],
    moduleSteps: {
      items: [
        {
          key: "details",
          replaces: "details",
          title: "Review the supplier record and approval",
          daysFromStart: -10,
          link: { label: "Open Suppliers", path: "suppliers" },
        },
      ],
      purchasing: [
        {
          key: "trial_order",
          replaces: "trial_order",
          title: "Place a trial purchase order",
          daysFromStart: 0,
          link: PURCHASING,
        },
        {
          key: "first_receipt",
          replaces: "first_receipt",
          title: "Review the first delivery against the order",
          daysFromStart: 7,
          link: PURCHASING,
        },
      ],
      quality: [
        {
          key: "delivery_issues",
          title: "Record any delivery issues as non-conformances",
          daysFromStart: 8,
          link: NONCONFORMANCES,
        },
      ],
    },
  },
  store_opening: {
    label: "Store opening",
    workflow: "supply",
    audience: "Retail",
    dateLabel: "Opening date",
    tasks: [
      { key: "equipment", title: "Set up equipment and fixtures", daysFromStart: -14 },
      { key: "supplies", title: "Arrange opening supplies", daysFromStart: -10 },
      { key: "opening_checks", title: "Run opening checks", daysFromStart: -1 },
      { key: "first_week", title: "Review the first week", daysFromStart: 7 },
    ],
    moduleSteps: {
      assets: [
        {
          key: "equipment",
          replaces: "equipment",
          title: "Set up equipment and add it to the asset register",
          daysFromStart: -14,
          link: ASSETS,
        },
      ],
      purchasing: [
        {
          key: "supplies",
          replaces: "supplies",
          title: "Order opening supplies",
          daysFromStart: -10,
          link: PURCHASING,
        },
      ],
      checklists: [
        {
          key: "opening_checks",
          replaces: "opening_checks",
          title: "Run the opening checklist",
          daysFromStart: -1,
          link: CHECKLISTS,
        },
      ],
    },
  },
  new_product_build: {
    label: "New product build",
    workflow: "manufacturing",
    audience: "General manufacturing",
    dateLabel: "Handover date",
    tasks: [
      { key: "bom", title: "Review the bill of materials", daysFromStart: -21 },
      { key: "plan_trial", title: "Plan a trial build", daysFromStart: -14 },
      { key: "first_build", title: "Check the first build", daysFromStart: -7 },
      { key: "handover", title: "Approve handover to production", daysFromStart: 0 },
    ],
    moduleSteps: {
      routings: [
        {
          key: "routing",
          title: "Set up work centres and the routing",
          daysFromStart: -16,
          detail:
            "Order the operations, give each its work centre and setup and run times, and approve the routing before the trial build.",
          link: { label: "Open Routings", path: "routings" },
        },
      ],
      recipes: [
        {
          key: "bom",
          replaces: "bom",
          title: "Review the bill of materials",
          daysFromStart: -21,
          link: { label: "Open bills of materials", path: "recipes" },
        },
      ],
      purchasing: [
        {
          key: "trial_materials",
          title: "Order materials for the trial build",
          daysFromStart: -18,
          link: PURCHASING,
        },
      ],
      quality: [
        {
          key: "first_build",
          replaces: "first_build",
          title: "Check the first build",
          daysFromStart: -7,
          detail: "Record anything outside specification as a non-conformance.",
          link: NONCONFORMANCES,
        },
      ],
    },
  },
  product_launch: {
    label: "Product launch",
    workflow: "food",
    audience: "Food manufacturing",
    dateLabel: "Launch date",
    tasks: [
      { key: "recipes", title: "Review recipes and allergens", daysFromStart: -28 },
      { key: "labels", title: "Verify labels", daysFromStart: -21 },
      { key: "trial_batch", title: "Plan a trial batch", daysFromStart: -14 },
      { key: "traceability", title: "Review traceability", daysFromStart: -7 },
    ],
    moduleSteps: {
      recipes: [
        {
          key: "recipes",
          replaces: "recipes",
          title: "Review recipes and allergens",
          daysFromStart: -28,
          link: { label: "Open Recipes", path: "recipes" },
        },
      ],
      labels: [
        {
          key: "labels",
          replaces: "labels",
          title: "Verify labels against the recipe",
          daysFromStart: -21,
          detail: "Check the label, then approve it in Labels.",
          link: { label: "Open Labels", path: "labels" },
        },
      ],
      production: [
        {
          key: "trial_batch",
          replaces: "trial_batch",
          title: "Plan a trial batch",
          daysFromStart: -14,
          link: { label: "Open Production", path: "production" },
        },
      ],
      stock: [
        {
          key: "traceability",
          replaces: "traceability",
          title: "Review traceability for the trial batch",
          daysFromStart: -7,
          detail: "Trace the trial batch from its ingredient lots to finished stock.",
          link: { label: "Open Stock", path: "stock" },
        },
      ],
      quality: [
        {
          key: "launch_issues",
          title: "Record any launch issues as non-conformances",
          daysFromStart: 7,
          link: NONCONFORMANCES,
        },
      ],
    },
  },
  kitchen_opening: {
    label: "Kitchen opening",
    workflow: "food",
    audience: "Foodservice",
    dateLabel: "Opening date",
    tasks: [
      { key: "equipment", title: "Prepare the equipment", daysFromStart: -10 },
      { key: "checks", title: "Set up opening and closing checks", daysFromStart: -7 },
      { key: "food_safety", title: "Review food safety records", daysFromStart: -3 },
      { key: "brief", title: "Brief the team", daysFromStart: -1 },
    ],
    moduleSteps: {
      assets: [
        {
          key: "equipment",
          replaces: "equipment",
          title: "Prepare the equipment and add it to the asset register",
          daysFromStart: -10,
          link: ASSETS,
        },
      ],
      maintenance: [
        {
          key: "maintenance",
          title: "Schedule equipment maintenance",
          daysFromStart: -9,
          link: MAINTENANCE,
        },
      ],
      checklists: [
        {
          key: "checks",
          replaces: "checks",
          title: "Set up opening and closing checklists",
          daysFromStart: -7,
          detail: "Create daily checklists for opening and closing.",
          link: CHECKLISTS,
        },
      ],
      haccp: [
        {
          key: "food_safety",
          replaces: "food_safety",
          title: "Review food safety records",
          daysFromStart: -3,
          link: { label: "Open Food safety records", path: "haccp" },
        },
      ],
    },
  },
};

/** The templates in each picker group, in picker order. */
export function projectTemplatesByWorkflow(): {
  workflow: ProjectTemplateWorkflow;
  ids: ProjectTemplateId[];
}[] {
  return (Object.keys(projectTemplateWorkflows) as ProjectTemplateWorkflow[])
    .map((workflow) => ({
      workflow,
      ids: projectTemplateIds.filter((id) => projectTemplates[id].workflow === workflow),
    }))
    .filter((group) => group.ids.length > 0);
}

/** Modules that add steps to a template, in definition order. */
export const projectTemplateModules = (templateId: ProjectTemplateId): ModuleId[] =>
  Object.keys(projectTemplates[templateId].moduleSteps) as ModuleId[];

export interface PlannedTemplateTask extends ProjectTemplateStep {
  /** The module whose step this is; null for a starter task. */
  module: ModuleId | null;
}

/**
 * The tasks a template creates for someone who can use the modules `canUse` accepts (active in
 * the workspace and readable by the creator), sorted by date; ties keep definition order.
 */
export function planProjectTemplate(
  templateId: ProjectTemplateId,
  canUse: (moduleId: ModuleId) => boolean,
): PlannedTemplateTask[] {
  const template = projectTemplates[templateId];
  const planned: PlannedTemplateTask[] = template.tasks.map((task) => ({ ...task, module: null }));
  for (const moduleId of projectTemplateModules(templateId)) {
    if (!canUse(moduleId)) continue;
    for (const { replaces, ...step } of template.moduleSteps[moduleId] ?? []) {
      const task = { ...step, module: moduleId };
      const index = replaces ? planned.findIndex((p) => p.key === replaces) : -1;
      if (index >= 0) planned[index] = task;
      else planned.push(task);
    }
  }
  return planned
    .map((task, order) => ({ task, order }))
    .sort((a, b) => a.task.daysFromStart - b.task.daysFromStart || a.order - b.order)
    .map(({ task }) => task);
}

/**
 * Why tasks dated `offsets` days from `startDate` can't be created, or null: every due date must
 * fall from 0001-01-01 to 9999-12-31 (a five-digit year would sort before 9999). The API and the
 * preview use the same check.
 */
export function projectTemplateDateIssue(startDate: string, offsets: readonly number[]): string | null {
  if (!isIsoDateInRange(startDate)) return `Choose a date from ${ISO_DATE_MIN} to ${ISO_DATE_MAX}`;
  if (!offsets.length) return null;
  for (const offset of [Math.min(...offsets), Math.max(...offsets)]) {
    const due = addDaysToIsoDate(startDate, offset);
    if (isIsoDateInRange(due)) continue;
    // Past 9999 the year is written `+010000`, which sorts before every four-digit year.
    return due.startsWith("+")
      ? `A task would be due after ${ISO_DATE_MAX}; choose an earlier date`
      : `A task would be due before ${ISO_DATE_MIN}; choose a later date`;
  }
  return null;
}

const supportedDate = z.iso
  .date()
  .refine(isIsoDateInRange, `Choose a date from ${ISO_DATE_MIN} to ${ISO_DATE_MAX}`);

/** One task to create, as the person edited it in the preview. */
export const projectTemplateTaskSchema = z.object({
  /** The template step this task came from; custom tasks have none. */
  step: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(512),
  daysFromStart: z
    .number()
    .int()
    .min(-PROJECT_TEMPLATE_MAX_OFFSET_DAYS)
    .max(PROJECT_TEMPLATE_MAX_OFFSET_DAYS),
});
export type ProjectTemplateTaskInput = z.infer<typeof projectTemplateTaskSchema>;

export const projectFromTemplateSchema = z
  .object({
    commandId: z.uuid(),
    templateId: z.enum(projectTemplateIds),
    name: z.string().trim().min(1).max(256),
    teamId: z.uuid(),
    leadId: z.uuid(),
    /** The milestone date (`dateLabel`) that task dates are relative to. */
    startDate: supportedDate,
    /**
     * The tasks to create, edited from the template's plan. Omitted: the plan for the creator's
     * modules as it stands.
     */
    tasks: z
      .array(projectTemplateTaskSchema)
      .min(1, "Keep at least one task")
      .max(PROJECT_TEMPLATE_MAX_TASKS)
      .refine((tasks) => {
        const steps = tasks.flatMap((task) => (task.step ? [task.step] : []));
        return new Set(steps).size === steps.length;
      }, "Each template step can be used once")
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (!isIsoDateInRange(input.startDate)) return; // already reported
    if (input.tasks) {
      input.tasks.forEach((task, i) => {
        const issue = projectTemplateDateIssue(input.startDate, [task.daysFromStart]);
        if (issue) ctx.addIssue({ code: "custom", path: ["tasks", i, "daysFromStart"], message: issue });
      });
      return;
    }
    // The template as it stands: checked with every module's steps, whichever the creator gets.
    const offsets = planProjectTemplate(input.templateId, () => true).map((step) => step.daysFromStart);
    const issue = projectTemplateDateIssue(input.startDate, offsets);
    if (issue) ctx.addIssue({ code: "custom", path: ["startDate"], message: issue });
  });
export type ProjectFromTemplateInput = z.infer<typeof projectFromTemplateSchema>;
