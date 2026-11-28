import type { WorkspaceRole } from "./enums";
import type { SyncEntityType } from "./sync";

/**
 * Modules
 * -------
 * Knotworking is a platform (sign-in, workspaces, members, teams, API tokens, the sync log,
 * attachments, notifications, search) plus modules that can be switched on per environment and
 * granted per member. This file is the single source of truth every client and the server share:
 *
 *  1. **Environment**: `KNOTWORKING_MODULES` (comma-separated ids) says which modules are active.
 *     Tables of inactive modules still exist; their routes answer 404 and their data is left out
 *     of the bootstrap, the sync log, search and the MCP tool list.
 *  2. **Member access**: admins give each member a level per active module (`member_module_access`).
 *     Without an explicit grant a module's `defaultAccess` applies.
 *
 * See docs/modules.md for the contract a new module must meet.
 */

export const moduleIds = [
  "tasks",
  "docs",
  "time",
  "calendar",
  "assets",
  "maintenance",
  "checklists",
  "items",
  "food_items",
  "recipes",
  "sops",
  "stock",
  "customers",
  "despatch",
  "sales",
  "demand",
  "production",
  "routings",
  "haccp",
  "people",
  "training",
  "attendance",
  "quality",
  "purchasing",
  "costing",
  "site",
  "labels",
  "specifications",
  "testing",
  "npd",
  "defence",
  "governance",
  "hse",
  "hse_incidents",
  "assistant",
  "accounting",
  "workforce",
  "workforce_hr",
  "bi",
  "purchase_requests",
  "client_services",
  "crm",
  "invoicing",
] as const;
export type ModuleId = (typeof moduleIds)[number];

/**
 * What a member may do in a module, lowest first. `manage` is for module-specific privileged
 * actions (approving a controlled document, posting a stock adjustment); plain routes only ask
 * for `read` (safe methods) or `write`.
 */
export const moduleAccessLevels = ["none", "read", "write", "manage"] as const;
export type ModuleAccessLevel = (typeof moduleAccessLevels)[number];

export interface ModuleDefinition {
  id: ModuleId;
  name: string;
  description: string;
  /**
   * Hard dependencies: modules that must be active (and readable by the member) for this one to
   * work. They must come earlier in `moduleIds`.
   */
  dependsOn: readonly ModuleId[];
  /**
   * Soft dependencies: modules this one integrates with but works without. When they are active
   * and the caller can read them, extra features appear (links, figures, pages); otherwise the
   * code checks at runtime and leaves them out. Never affects activation or access, and has no
   * ordering requirement.
   */
  enhancedBy: readonly ModuleId[];
  /**
   * Access without an explicit grant. `role`: members get `write`, guests `read` (how the
   * workspace behaved before modules). `none`: opt-in, an admin must grant it.
   */
  defaultAccess: "role" | "none";
  /**
   * Whether the module is on when `KNOTWORKING_MODULES` is unset or blank. `false` is a feature
   * flag: the module exists but must be named in `KNOTWORKING_MODULES` (or `all`) to switch it on.
   */
  defaultActive: boolean;
  /** Sync-log entity types this module owns. Entities of no module belong to the platform. */
  syncEntities: readonly SyncEntityType[];
}

export const modules: Record<ModuleId, ModuleDefinition> = {
  invoicing: {
    id: "invoicing",
    name: "Invoicing",
    description:
      "Customer invoices, credit notes and approved billing from sales, despatch and client services.",
    dependsOn: ["customers"],
    enhancedBy: ["sales", "despatch", "client_services", "accounting"],
    defaultAccess: "none",
    defaultActive: false,
    syncEntities: [],
  },
  client_services: {
    id: "client_services",
    name: "Client services",
    description: "Fixed-fee and hourly quotes, project delivery, and draft billing exports.",
    dependsOn: ["customers", "time"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["service_quote"],
  },
  crm: {
    id: "crm",
    name: "CRM",
    description:
      "Leads, opportunities on a configurable pipeline, owners and follow-ups, built on the customer register.",
    dependsOn: ["customers"],
    // Quotes and the handoff to an order (Sales) or a delivery project (Client services).
    enhancedBy: ["sales", "client_services"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["crm_stage", "crm_lead", "crm_opportunity", "crm_activity"],
  },
  purchase_requests: {
    id: "purchase_requests",
    name: "Purchase requests",
    description: "Submit spending requests and record a designated approver's decision.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "role",
    defaultActive: true,
    syncEntities: [],
  },
  workforce: {
    id: "workforce",
    name: "Workforce planning",
    description: "Personal leave requests and availability for planning.",
    dependsOn: ["people"],
    enhancedBy: ["attendance", "training", "production"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [],
  },
  workforce_hr: {
    id: "workforce_hr",
    name: "Private HR records",
    description: "Restricted absence, sickness, reviews and employment notes.",
    dependsOn: ["workforce"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [],
  },
  accounting: {
    id: "accounting",
    name: "Accounting integrations",
    description: "Optional accounting connections and reviewed financial mappings.",
    dependsOn: [],
    enhancedBy: ["purchasing", "items", "customers"],
    defaultAccess: "none",
    defaultActive: false,
    syncEntities: [],
  },
  tasks: {
    id: "tasks",
    name: "Tasks and projects",
    description: "Tasks, workflow states, labels, dependencies, comments and projects.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "role",
    defaultActive: true,
    syncEntities: [
      "workflow_state",
      "label",
      "project",
      "project_team",
      "task",
      "task_label",
      "task_relation",
      "task_view",
      "task_follower",
      "project_milestone",
      "project_section",
      "project_member",
      "project_update",
      "comment",
    ],
  },
  docs: {
    id: "docs",
    name: "Documents",
    description: "The team wiki: documents, version history and backlinks.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "role",
    defaultActive: true,
    syncEntities: ["document"],
  },
  time: {
    id: "time",
    name: "Time tracking",
    description: "Logged time, timers and time reports on tasks and projects.",
    dependsOn: ["tasks"],
    enhancedBy: [],
    defaultAccess: "role",
    defaultActive: true,
    syncEntities: ["time_entry"],
  },
  calendar: {
    id: "calendar",
    name: "Calendar and meetings",
    description: "Workspace meetings and each member's connected calendars.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "role",
    // Off until someone switches it on: the Google and Microsoft sync has not run against real accounts.
    defaultActive: false,
    syncEntities: ["meeting", "meeting_attendee"],
  },
  assets: {
    id: "assets",
    name: "Assets",
    description:
      "One register of areas, equipment, vehicles, IT, tools and other assets: codes, where they are, make and serial, purchase and warranty, and who looks after them.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["asset"],
  },
  maintenance: {
    id: "maintenance",
    name: "Maintenance",
    description:
      "Recurring asset maintenance, completed work records and work orders for breakdowns and requests.",
    dependsOn: ["assets"],
    enhancedBy: ["haccp"],
    defaultActive: true,
    defaultAccess: "none",
    // Keep the existing entity IDs so earlier sync log entries retain their owner.
    syncEntities: ["site_asset", "site_maintenance_task", "site_maintenance_record", "site_work_order"],
  },
  checklists: {
    id: "checklists",
    name: "Checklists",
    description:
      "Reusable checklists, recurring schedules, completed checks and follow-up actions for failures.",
    dependsOn: [],
    enhancedBy: [],
    defaultActive: true,
    defaultAccess: "none",
    syncEntities: [
      "checklist_template",
      "checklist_item",
      "checklist_check",
      "checklist_check_item",
      "checklist_action",
    ],
  },
  items: {
    id: "items",
    name: "Items and suppliers",
    description: "Catalogue of materials, products and services with units, costs and supplier links.",
    dependsOn: [],
    enhancedBy: ["food_items"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [
      "supplier",
      "item",
      "item_supplier",
      "supplier_risk_assessment",
      "supplier_questionnaire",
      "supplier_control_settings",
    ],
  },
  food_items: {
    id: "food_items",
    name: "Food items",
    description: "Allergen declarations, storage conditions and shelf life on items.",
    dependsOn: ["items"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["food_item"],
  },
  recipes: {
    id: "recipes",
    name: "Recipes",
    description: "Versioned bills of materials with yields, scaling, cost roll-up and approval before use.",
    dependsOn: ["items"],
    enhancedBy: ["food_items"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["recipe", "recipe_version", "recipe_line"],
  },
  sops: {
    id: "sops",
    name: "SOPs",
    description:
      "Standard operating procedures under document control: drafts, review and approval, effective and review dates, read-and-acknowledge records.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["sop", "sop_version", "sop_acknowledgement", "sop_target", "sop_copy"],
  },
  stock: {
    id: "stock",
    name: "Stock",
    description:
      "Locations, lots with use-by and best-before dates, goods-in and an append-only movement ledger with traceability.",
    dependsOn: ["items"],
    enhancedBy: ["food_items"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["stock_location", "stock_lot", "stock_movement", "lot_release_rule"],
  },
  customers: {
    id: "customers",
    name: "Customers",
    description: "Shared customer accounts, addresses and contacts for distribution traceability.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["customer"],
  },
  sales: {
    id: "sales",
    name: "Sales",
    description: "Customer quotes, price agreements, sales orders and delivery commitments.",
    dependsOn: ["customers", "items"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["sales_order", "sales_price", "sales_external_reference"],
  },
  despatch: {
    id: "despatch",
    name: "Despatch",
    description: "Customer-linked lot despatches, delivery notes and recipient tracing on the stock ledger.",
    dependsOn: ["customers", "stock"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["despatch"],
  },
  demand: {
    id: "demand",
    name: "Demand planning",
    description:
      "Demand per product per week, by customer: entered by hand, imported from CSV or posted by the sales system, with totals for production planning.",
    dependsOn: ["items"],
    enhancedBy: ["stock", "production"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["demand_line", "demand_import", "demand_pack_unit"],
  },
  production: {
    id: "production",
    name: "Production",
    description:
      "Batch schedule from approved recipe versions, material requirements against stock, and batch records that consume and produce lots.",
    dependsOn: ["recipes", "stock"],
    enhancedBy: ["demand", "sales", "haccp", "labels", "specifications", "costing", "food_items"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [
      "production_batch",
      "production_record",
      "production_line",
      "production_line_recipe",
      "production_reservation",
      "production_non_working_day",
      "production_line_shift",
      "production_changeover",
      "production_downtime",
      "production_reject",
      "production_labour",
      "production_packing_run",
      "production_packing_check",
      "production_device",
      "production_device_reading",
    ],
  },
  routings: {
    id: "routings",
    name: "Routings",
    description:
      "Discrete manufacturing: work centres with capacity and cost rates, versioned routings of ordered operations for each bill of materials, and job cards per operation of a production batch with time, good and scrap quantities and exceptions.",
    dependsOn: ["production"],
    enhancedBy: ["costing"],
    defaultAccess: "none",
    defaultActive: true,
    // Job card time, quantities and exceptions are paginated reads, never synced.
    syncEntities: ["work_centre", "routing", "routing_version", "routing_operation", "job_card"],
  },
  haccp: {
    id: "haccp",
    name: "Food safety records",
    description:
      "HACCP plan under document control, CCP monitoring logs with automatic out-of-limit flagging, corrective actions, and cleaning and calibration records.",
    // Cleaning and calibration are scheduled against areas and equipment of the asset register.
    dependsOn: ["assets"],
    enhancedBy: ["items", "recipes", "stock", "production", "food_items"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [
      "haccp_plan",
      "haccp_plan_version",
      "haccp_process_step",
      "haccp_ccp",
      "haccp_ccp_log",
      "haccp_corrective_action",
      "haccp_asset",
      "haccp_cleaning_record",
      "haccp_calibration_record",
      "haccp_day_signoff",
      "haccp_hazard_library",
      "haccp_plan_template",
    ],
  },
  people: {
    id: "people",
    name: "People",
    description:
      "The staff register: everyone who works on site, with or without a login, their 6-digit staff numbers, kiosk PINs and job roles.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["staff", "job_role", "staff_job_role"],
  },
  training: {
    id: "training",
    name: "Training",
    description:
      "Training courses (SOP-based or external), the training matrix by job role, and training records with competency sign-off, expiry and refresher dates.",
    dependsOn: ["people"],
    enhancedBy: ["sops"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["training_course", "training_requirement", "training_record"],
  },
  attendance: {
    id: "attendance",
    name: "Attendance",
    description:
      "Clocking in and out on a tablet kiosk, shifts and payroll exports, the on-site register and evacuation roll calls, and visitor sign-in.",
    dependsOn: ["people"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    // Clock times are personal data: like private calendar events, none of it is in the sync log.
    syncEntities: [],
  },
  quality: {
    id: "quality",
    name: "Quality",
    description:
      "Complaints, CAPA, internal audits, mock recalls, live incidents and food authenticity vulnerability assessments with versioned reviews and verified controls.",
    dependsOn: [],
    enhancedBy: ["items", "stock", "production", "despatch", "testing"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [
      "quality_complaint",
      "quality_nonconformance",
      "quality_audit",
      "quality_recall_test",
      "quality_audit_programme",
      "quality_sales_volume",
      "quality_incident",
      "quality_authenticity",
    ],
  },
  purchasing: {
    id: "purchasing",
    name: "Purchasing",
    description:
      "Purchase orders for stock items, services, subscriptions and non-stock goods, raised by hand or from the material shortfall; goods-in against an order with part, over and under deliveries; supplier invoices with a three-way match against order and delivery; and supplier performance: on time, in full and rejected deliveries.",
    dependsOn: ["items"],
    enhancedBy: ["stock", "production", "quality"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [
      "purchase_order",
      "purchase_order_line",
      "purchase_receipt",
      "purchase_invoice",
      "purchase_invoice_line",
      "purchasing_settings",
      "purchase_order_email",
      "purchase_supplier_price",
      "purchase_credit_note",
      "purchase_credit_note_line",
    ],
  },
  costing: {
    id: "costing",
    name: "Costing",
    description:
      "Actual cost per batch from the lots it consumed and their purchase prices, flowing through work in progress, yield variance, and standard against actual by product and period.",
    dependsOn: ["recipes", "production", "purchasing"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    // Costs are computed on read from the other modules' records. Only what people set is stored:
    // period closes (the frozen figures), standard cost history and absorption rates.
    syncEntities: ["costing_period_close", "costing_standard_cost", "costing_absorption_rate"],
  },
  site: {
    id: "site",
    name: "Site programmes",
    description:
      "Prerequisite programmes: pest control, the glass and brittle plastics register, storage temperature logging, and pre-start and allergen changeover checks, with what is due across them.",
    dependsOn: ["assets"],
    enhancedBy: ["maintenance", "checklists", "production", "food_items"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [
      "site_pest_device",
      "site_pest_visit",
      "site_pest_finding",
      "site_glass_item",
      "site_glass_check",
      "site_glass_breakage",
      "site_storage_unit",
      "site_storage_reading",
      "site_corrective_action",
      "site_checklist_template",
      "site_checklist_item",
      "site_checklist_check",
      "site_checklist_check_item",
    ],
  },
  labels: {
    id: "labels",
    name: "Labels and nutrition",
    description:
      "Nutrition per 100 g on ingredients, rolled up through recipe versions; ingredient declarations in weight order with allergens emphasised (UK PPDS); and product labels approved per recipe version.",
    dependsOn: ["recipes", "food_items"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["item_label_data", "product_label"],
  },
  specifications: {
    id: "specifications",
    name: "Specifications",
    description:
      "Controlled, versioned specifications for ingredients, packaging and products: limits, allergens, storage, shelf life, provenance and claims, agreed with the supplier or customer, approved, reviewed, and checked against the item, recipes, labels and open production.",
    dependsOn: ["items", "food_items"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    // Metadata only: a version's content (limits, provenance, agreement) is read through endpoints.
    syncEntities: ["specification", "specification_version"],
  },
  testing: {
    id: "testing",
    name: "Testing",
    description:
      "Laboratories, sampling points and risk-based sampling plans; samples from stock lots and environmental or water points with results judged against limits from the plan or the approved specification; failed results open an investigation and hold the lot; trends.",
    dependsOn: ["items", "stock"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    // Metadata only: results, limits and investigation findings are read through endpoints.
    syncEntities: ["testing_laboratory", "testing_sampling_point", "testing_plan", "testing_sample"],
  },
  npd: {
    id: "npd",
    name: "Product development",
    description:
      "New product development: the brief, kitchen and factory trials, shelf-life studies and sensory panels, HACCP, artwork and customer sign-offs, and a launch checklist read from the recipe, specification and label.",
    dependsOn: ["items", "recipes", "food_items"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["npd_project", "npd_trial"],
  },
  defence: {
    id: "defence",
    name: "Food defence",
    description:
      "Threat assessments of the site against deliberate contamination and malicious acts, reviewed and versioned; security controls with routine checks that show when they are overdue or failed; incident-scenario exercises; and visitors on site from the Attendance register.",
    dependsOn: [],
    enhancedBy: ["attendance"],
    defaultAccess: "none",
    defaultActive: true,
    // Metadata only: threats, check notes and exercise findings describe the site's weak points and
    // are read through endpoints by members with access.
    syncEntities: [
      "defence_assessment",
      "defence_assessment_version",
      "defence_control",
      "defence_check",
      "defence_exercise",
    ],
  },
  governance: {
    id: "governance",
    name: "Management review",
    description:
      "Food safety and quality objectives with progress, the food safety culture plan, confidential concerns any member can raise, the legal and customer requirement register, and management reviews that gather evidence from the other modules, record decisions and create follow-up tasks when signed.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    // Confidential concerns are never synced; reviews sync as metadata only.
    syncEntities: [
      "governance_objective",
      "governance_culture_activity",
      "governance_requirement",
      "governance_review",
      "governance_standard",
      "governance_standard_clause",
      "governance_clause_assessment",
      "governance_clause_task",
      "governance_clause_evidence",
      "governance_clause_draft",
      "governance_gap_snapshot",
    ],
  },
  hse: {
    id: "hse",
    name: "Health, safety and environment",
    description: "Assessments, COSHH, contractor permits, inspections, waste and utilities.",
    dependsOn: ["training"],
    // Contractor permits are raised against an asset of the register.
    enhancedBy: ["assets"],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: ["hse_record", "hse_entry", "hse_permit"],
  },
  hse_incidents: {
    id: "hse_incidents",
    name: "HSE incidents (restricted)",
    description: "Restricted accident/near-miss health details and investigations; signed-in people only.",
    dependsOn: ["hse"],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    syncEntities: [],
  },
  bi: {
    id: "bi",
    name: "Dashboards",
    description:
      "Dashboards and board reporting over the other modules' data. Every figure is computed from the catalogue with the viewer's own access: a dataset of a module they can't read shows nothing.",
    dependsOn: [],
    enhancedBy: [],
    // Members read and build drafts; `manage` publishes and freezes board snapshots.
    defaultAccess: "role",
    // Disabled by default: name `bi` in KNOTWORKING_MODULES.
    defaultActive: false,
    syncEntities: ["bi_dashboard", "bi_dashboard_version", "bi_snapshot", "bi_board_pack"],
  },
  assistant: {
    id: "assistant",
    name: "Assistant",
    description:
      "A chat sidebar where each member talks to an AI model with their own API key (Claude, OpenAI, Gemini, Mistral, Grok, Groq or DeepSeek), working in the workspace through the MCP tools under their permissions.",
    dependsOn: [],
    enhancedBy: [],
    defaultAccess: "none",
    defaultActive: true,
    // Conversations are personal and never synced.
    syncEntities: [],
  },
};

export const moduleList: readonly ModuleDefinition[] = moduleIds.map((id) => modules[id]);

export const workspacePresets = ["general_business", "food_manufacturing"] as const;
export type WorkspacePreset = (typeof workspacePresets)[number];

export const workspacePresetDetails = {
  general_business: {
    label: "General Business",
    description: "Projects, docs, people operations, purchase approvals and client services.",
  },
  food_manufacturing: {
    label: "Food Manufacturing",
    description: "Adds production, stock, purchasing, traceability and food safety.",
  },
} satisfies Record<WorkspacePreset, { label: string; description: string }>;

const generalBusinessModules: readonly ModuleId[] = [
  "tasks",
  "docs",
  "calendar",
  "time",
  "assets",
  "sops",
  "customers",
  "people",
  "training",
  "workforce",
  "workforce_hr",
  "bi",
  "assistant",
  "purchase_requests",
  "client_services",
  "hse",
  "hse_incidents",
];

/** Null keeps a workspace on the installation's module list, including after an upgrade. */
export function activeWorkspaceModules(
  available: readonly ModuleId[],
  selection: readonly ModuleId[] | null,
): readonly ModuleId[] {
  if (selection === null) return available;
  const requested = new Set(selection);
  const installed = new Set(available);
  const active = new Set<ModuleId>();
  for (const id of moduleIds) {
    if (requested.has(id) && installed.has(id) && modules[id].dependsOn.every((dep) => active.has(dep))) {
      active.add(id);
    }
  }
  return [...active];
}

export function workspacePresetModules(preset: WorkspacePreset): readonly ModuleId[] | null {
  return preset === "general_business" ? generalBusinessModules : null;
}

export const isModuleId = (value: string): value is ModuleId =>
  (moduleIds as readonly string[]).includes(value);

const levelRank: Record<ModuleAccessLevel, number> = { none: 0, read: 1, write: 2, manage: 3 };

/** Whether `level` is at least `needed`. */
export const hasModuleLevel = (level: ModuleAccessLevel | undefined, needed: ModuleAccessLevel) =>
  levelRank[level ?? "none"] >= levelRank[needed];

const entityOwners: Partial<Record<SyncEntityType, ModuleId>> = Object.fromEntries(
  moduleList.flatMap((m) => m.syncEntities.map((entity) => [entity, m.id])),
);

/** The module that owns a sync entity type, or `null` for platform entities. */
export const moduleOfEntity = (entity: SyncEntityType): ModuleId | null => entityOwners[entity] ?? null;

export class ModuleConfigError extends Error {}

/**
 * Modules that once lived inside another and were split out, with the modules that now depend on
 * them. A list written before the split names the dependant but not the new module; it is added
 * for them (with a deprecation warning) rather than refusing to start. `food_items` came out of
 * `items`: Labels, Specifications and Product development need it.
 */
const legacySplitModules: { id: ModuleId; neededBy: readonly ModuleId[] }[] = [
  { id: "food_items", neededBy: ["labels", "specifications", "npd"] },
];

/**
 * Parses `KNOTWORKING_MODULES`. Unset or blank means every module that is on by default
 * (`defaultActive`; a flagged module such as `calendar` must be named); `all` means every module
 * including flagged ones; `none` means the platform alone. Unknown ids and missing dependencies are configuration errors (the API refuses to
 * start), so a typo can't silently switch a module off.
 *
 * One exception keeps lists written before a module was split out working: a list that names, say,
 * `labels` but not `food_items` (which Labels needs since it left Items) gets `food_items` added,
 * and `onWarning` is told to add it to the list (the API and MCP server log it at startup).
 */
export function parseActiveModules(
  value: string | undefined | null,
  onWarning: (message: string) => void = () => {},
): ModuleId[] {
  const raw = (value ?? "").trim();
  if (!raw) return moduleIds.filter((id) => modules[id].defaultActive);
  if (raw.toLowerCase() === "all") return [...moduleIds];
  if (raw.toLowerCase() === "none") return [];
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = ids.filter((id) => !isModuleId(id));
  if (unknown.length) {
    throw new ModuleConfigError(
      `KNOTWORKING_MODULES: unknown module ${unknown.map((u) => `"${u}"`).join(", ")}. Known modules: ${moduleIds.join(", ")}`,
    );
  }
  const active = new Set(ids as ModuleId[]);
  for (const legacy of legacySplitModules) {
    if (active.has(legacy.id)) continue;
    const named = legacy.neededBy.filter((id) => active.has(id));
    if (!named.length) continue;
    active.add(legacy.id);
    onWarning(
      `KNOTWORKING_MODULES: ${named.map((m) => `"${m}"`).join(", ")} ${named.length === 1 ? "needs" : "need"} "${legacy.id}", which is now its own module; it has been switched on. Add "${legacy.id}" to KNOTWORKING_MODULES: a later release will refuse to start without it.`,
    );
  }
  for (const id of active) {
    const missing = modules[id].dependsOn.filter((dep) => !active.has(dep));
    if (missing.length) {
      throw new ModuleConfigError(
        `KNOTWORKING_MODULES: "${id}" needs ${missing.map((m) => `"${m}"`).join(", ")} to be active too`,
      );
    }
  }
  // Manifest order, so dependencies come before their dependants.
  return moduleIds.filter((id) => active.has(id));
}

/** A member's level per **active** module. Inactive modules are absent (treat as `none`). */
export type ModuleAccessMap = Partial<Record<ModuleId, ModuleAccessLevel>>;

/**
 * A member's effective access:
 *  - owners and admins get `manage` on every active module (they hand out access anyway);
 *  - otherwise the explicit grant, or the module's default for the role;
 *  - guests never get more than `read`;
 *  - an API token's allowlist (`allow`) can only take modules away, admins included;
 *  - a module is `none` when one it depends on is `none`.
 */
export function resolveModuleAccess(input: {
  role: WorkspaceRole;
  active: readonly ModuleId[];
  grants: ModuleAccessMap;
  /**
   * An API token's module allowlist: modules outside it are `none` for that token, whatever its
   * owner may do. `null` or absent means no restriction (sessions, and tokens made for everything).
   */
  allow?: readonly ModuleId[] | null | undefined;
}): ModuleAccessMap {
  const { role, grants } = input;
  const active = new Set(input.active);
  const out: ModuleAccessMap = {};
  // Manifest order: dependencies are resolved before their dependants.
  for (const id of moduleIds) {
    if (!active.has(id)) continue;
    const def = modules[id];
    let level: ModuleAccessLevel;
    if (role === "owner" || role === "admin") level = "manage";
    else {
      level = grants[id] ?? (def.defaultAccess === "role" ? (role === "guest" ? "read" : "write") : "none");
      if (role === "guest" && hasModuleLevel(level, "write")) level = "read";
    }
    if (input.allow && !input.allow.includes(id)) level = "none";
    if (def.dependsOn.some((dep) => !hasModuleLevel(out[dep], "read"))) level = "none";
    out[id] = level;
  }
  return out;
}

/** One module as a client sees it: only active modules are ever listed. */
export interface ModuleSummary {
  id: ModuleId;
  name: string;
  description: string;
  dependsOn: readonly ModuleId[];
  /** Modules that add features to this one when active and readable (soft dependencies). */
  enhancedBy: readonly ModuleId[];
  /** The caller's effective level. */
  access: ModuleAccessLevel;
}

export const summarizeModules = (access: ModuleAccessMap): ModuleSummary[] =>
  moduleIds
    .filter((id) => id in access)
    .map((id) => ({
      id,
      name: modules[id].name,
      description: modules[id].description,
      dependsOn: modules[id].dependsOn,
      enhancedBy: modules[id].enhancedBy,
      access: access[id] ?? "none",
    }));
