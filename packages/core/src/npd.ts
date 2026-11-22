import { z } from "zod";
import { storageConditions, type StorageCondition } from "./items";
import type { ModuleId } from "./modules";

/**
 * New product development (Phase 3, milestone 3.2.5): a development brief, trials (kitchen,
 * factory, shelf life, sensory), the people's sign-offs (HACCP review, artwork, customer) and a
 * launch checklist that reads the rest from the records: the linked recipe approved, a factory
 * trial passed, the target shelf life proven, and, where those modules are on, an approved
 * specification and product label. Approved commercial recipes stay in Recipes. Pure; shared by
 * server, web and MCP.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** Working stages a project moves through freely; `launched` and `cancelled` are final. */
export const npdWorkingStages = ["brief", "development", "trials", "validation"] as const;
export const npdStatuses = [...npdWorkingStages, "launched", "cancelled"] as const;
export type NpdStatus = (typeof npdStatuses)[number];
export const npdStatusLabels: Record<NpdStatus, string> = {
  brief: "Brief",
  development: "Development",
  trials: "Trials",
  validation: "Validation",
  launched: "Launched",
  cancelled: "Cancelled",
};
export const isNpdFinal = (status: NpdStatus) => status === "launched" || status === "cancelled";

export const npdTrialKinds = ["kitchen", "factory", "shelf_life", "sensory"] as const;
export type NpdTrialKind = (typeof npdTrialKinds)[number];
export const npdTrialKindLabels: Record<NpdTrialKind, string> = {
  kitchen: "Kitchen trial",
  factory: "Factory trial",
  shelf_life: "Shelf-life study",
  sensory: "Sensory panel",
};

export const npdTrialOutcomes = ["pass", "adjust", "fail"] as const;
export type NpdTrialOutcome = (typeof npdTrialOutcomes)[number];
export const npdTrialOutcomeLabels: Record<NpdTrialOutcome, string> = {
  pass: "Pass",
  adjust: "Needs changes",
  fail: "Fail",
};

/** Checklist items a person signs; the rest are read from the records. */
export const npdSignoffKeys = ["haccp_reviewed", "artwork_agreed", "customer_signoff"] as const;
export type NpdSignoffKey = (typeof npdSignoffKeys)[number];
export const npdSignoffLabels: Record<NpdSignoffKey, string> = {
  haccp_reviewed: "HACCP plan reviewed for the new product",
  artwork_agreed: "Artwork agreed",
  customer_signoff: "Customer sign-off",
};

export interface NpdSignoff {
  /** Who signed: our reviewer, or the customer's signatory. */
  by: string;
  on: string;
  reference: string | null;
  recordedBy: string;
  recordedAt: string;
}
export type NpdSignoffs = Partial<Record<NpdSignoffKey, NpdSignoff>>;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();
const money = z
  .number()
  .finite()
  .min(0)
  .max(1_000_000)
  .refine((v) => Math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-6, "At most 4 decimal places");

const briefFields = {
  name: z.string().trim().min(1).max(200),
  /** The product concept: what it is, who it's for, why. */
  brief: optionalText(10_000),
  customerName: optionalText(200),
  targetLaunchOn: isoDate.nullable(),
  /** Target cost per unit of the output item, in the workspace currency. */
  targetCost: money.nullable(),
  targetShelfLifeDays: z.number().int().min(1).max(3650).nullable(),
  storage: z.enum(storageConditions).nullable(),
  claims: z.array(z.string().trim().min(1).max(80)).max(30),
  /** Constraints: allergens to avoid, line, packaging format, price point. */
  constraints: optionalText(4000),
  /** The item the project will make, once created in Items. */
  outputItemId: z.uuid().nullable(),
  /** Its recipe, once drafted in Recipes. */
  recipeId: z.uuid().nullable(),
};

export const npdProjectCreateSchema = z.object({
  id: z.uuid().optional(),
  /** Unique among live projects, case-insensitively. */
  code: z.string().trim().min(1).max(40),
  name: briefFields.name,
  brief: briefFields.brief.optional(),
  customerName: briefFields.customerName.optional(),
  targetLaunchOn: briefFields.targetLaunchOn.optional(),
  targetCost: briefFields.targetCost.optional(),
  targetShelfLifeDays: briefFields.targetShelfLifeDays.optional(),
  storage: briefFields.storage.optional(),
  claims: briefFields.claims.default([]),
  constraints: briefFields.constraints.optional(),
  outputItemId: briefFields.outputItemId.optional(),
  recipeId: briefFields.recipeId.optional(),
});
export type NpdProjectCreateInput = z.infer<typeof npdProjectCreateSchema>;

export const npdProjectUpdateSchema = z
  .object({
    ...briefFields,
    code: z.string().trim().min(1).max(40),
    /** A working stage, or `cancelled` with `cancelReason`. Launch has its own route. */
    status: z.enum([...npdWorkingStages, "cancelled"]),
    cancelReason: optionalText(2000),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to update")
  .refine((p) => p.status !== "cancelled" || !!p.cancelReason, {
    message: "Say why the project is cancelled",
    path: ["cancelReason"],
  });
export type NpdProjectUpdateInput = z.infer<typeof npdProjectUpdateSchema>;

export const npdTrialSchema = z
  .object({
    kind: z.enum(npdTrialKinds),
    heldOn: isoDate,
    /** What was tried: the formulation, process, line, panel. */
    description: z.string().trim().min(1).max(4000),
    /** The recipe version trialled, when there is one. */
    recipeVersionId: z.uuid().nullable().optional(),
    outcome: z.enum(npdTrialOutcomes),
    findings: optionalText(4000).optional(),
    /** Shelf-life studies: the life the product kept to, in days, under `storage`. */
    achievedShelfLifeDays: z.number().int().min(0).max(3650).nullable().optional(),
    storage: z.enum(storageConditions).nullable().optional(),
  })
  .refine((t) => t.kind !== "shelf_life" || t.achievedShelfLifeDays != null, {
    message: "A shelf-life study records the life achieved",
    path: ["achievedShelfLifeDays"],
  });
export type NpdTrialInput = z.infer<typeof npdTrialSchema>;

export const npdSignoffSchema = z.object({
  key: z.enum(npdSignoffKeys),
  by: z.string().trim().min(1).max(200),
  on: isoDate,
  reference: optionalText(200).optional(),
});
export type NpdSignoffInput = z.infer<typeof npdSignoffSchema>;

export const npdProjectListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** `open`: any working stage. Default: open. */
  status: z.enum([...npdStatuses, "open", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type NpdProjectListQuery = z.infer<typeof npdProjectListQuerySchema>;

// ─── Launch checklist ────────────────────────────────────────────────────────

export type NpdCheckKey =
  | "brief_complete"
  | "product_linked"
  | "recipe_approved"
  | "factory_trial"
  | "shelf_life"
  | "specification"
  | "label"
  | NpdSignoffKey;

export interface NpdCheck {
  key: NpdCheckKey;
  label: string;
  /** `na`: doesn't apply (no customer, or the module is switched off). */
  status: "met" | "missing" | "na";
  detail: string;
  /** Signed by a person rather than read from the records. */
  manual: boolean;
}

export interface NpdChecklistFacts {
  active: readonly ModuleId[];
  project: {
    name: string;
    brief: string | null;
    customerName: string | null;
    targetLaunchOn: string | null;
    targetShelfLifeDays: number | null;
    storage: StorageCondition | null;
    outputItemId: string | null;
    recipeId: string | null;
    signoffs: NpdSignoffs;
  };
  /** The linked recipe's approved version number, or null. */
  recipeApprovedVersion: number | null;
  trials: readonly {
    kind: NpdTrialKind;
    outcome: NpdTrialOutcome;
    heldOn: string;
    achievedShelfLifeDays: number | null;
  }[];
  /** The output item's approved specification (code and version), or null. */
  approvedSpecification: string | null;
  /** The linked recipe's approved product label (product name and version), or null. */
  approvedLabel: string | null;
}

/** What must be true to launch, and where the project stands against it. */
export function npdLaunchChecklist(facts: NpdChecklistFacts): { checks: NpdCheck[]; ready: boolean } {
  const { project, trials } = facts;
  const checks: NpdCheck[] = [];
  const add = (key: NpdCheckKey, label: string, status: NpdCheck["status"], detail: string, manual = false) =>
    checks.push({ key, label, status, detail, manual });

  const briefMissing = [
    !project.brief && "concept",
    !project.targetLaunchOn && "launch date",
    !project.targetShelfLifeDays && "target shelf life",
    !project.storage && "storage",
  ].filter(Boolean);
  add(
    "brief_complete",
    "Brief complete",
    briefMissing.length ? "missing" : "met",
    briefMissing.length
      ? `Missing: ${briefMissing.join(", ")}`
      : "Concept, launch date, shelf life and storage set",
  );
  add(
    "product_linked",
    "Product and recipe linked",
    project.outputItemId && project.recipeId ? "met" : "missing",
    project.outputItemId && project.recipeId
      ? "The item and its recipe are linked"
      : `Link the ${[!project.outputItemId && "item", !project.recipeId && "recipe"].filter(Boolean).join(" and ")}`,
  );
  add(
    "recipe_approved",
    "Recipe approved",
    facts.recipeApprovedVersion ? "met" : "missing",
    facts.recipeApprovedVersion
      ? `Approved v${facts.recipeApprovedVersion}`
      : "The recipe has no approved version",
  );
  const factory = trials.filter((t) => t.kind === "factory" && t.outcome === "pass");
  add(
    "factory_trial",
    "Factory trial passed",
    factory.length ? "met" : "missing",
    factory.length
      ? `Passed on ${factory
          .map((t) => t.heldOn)
          .sort()
          .at(-1)}`
      : "No passing factory trial",
  );
  const target = project.targetShelfLifeDays;
  const best = trials
    .filter((t) => t.kind === "shelf_life" && t.outcome === "pass" && t.achievedShelfLifeDays != null)
    .reduce<number | null>(
      (m, t) => (m === null || t.achievedShelfLifeDays! > m ? t.achievedShelfLifeDays! : m),
      null,
    );
  add(
    "shelf_life",
    "Shelf life proven",
    target != null && best != null && best >= target ? "met" : "missing",
    target == null
      ? "Set a target shelf life in the brief"
      : best == null
        ? `No passing shelf-life study (target ${target} days)`
        : best >= target
          ? `${best} days proven against a target of ${target}`
          : `Best proven ${best} days, short of the ${target}-day target`,
  );
  if (facts.active.includes("specifications")) {
    add(
      "specification",
      "Specification approved",
      facts.approvedSpecification ? "met" : "missing",
      facts.approvedSpecification ?? "The product has no approved specification",
    );
  } else add("specification", "Specification approved", "na", "The Specifications module is switched off");
  if (facts.active.includes("labels")) {
    add(
      "label",
      "Product label approved",
      facts.approvedLabel ? "met" : "missing",
      facts.approvedLabel ?? "The recipe has no approved product label",
    );
  } else add("label", "Product label approved", "na", "The Labels module is switched off");
  for (const key of npdSignoffKeys) {
    const s = project.signoffs[key];
    if (key === "customer_signoff" && !project.customerName) {
      add(key, npdSignoffLabels[key], "na", "No customer named in the brief", true);
      continue;
    }
    add(
      key,
      npdSignoffLabels[key],
      s ? "met" : "missing",
      s ? `${s.by} on ${s.on}${s.reference ? ` (${s.reference})` : ""}` : "Not signed yet",
      true,
    );
  }
  return { checks, ready: checks.every((c) => c.status !== "missing") };
}
