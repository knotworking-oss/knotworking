import { z } from "zod";
import {
  allergenCodes,
  allergens as allergenNames,
  sortAllergens,
  storageConditions,
  storageLabels,
  type AllergenCode,
  type ItemType,
  type StorageCondition,
} from "./items";

/**
 * Specifications module: controlled, versioned specifications for ingredients, packaging and
 * products, agreed with the supplier or customer and approved before they apply. Validation, the
 * version comparison, the item-master cross-check and the approval rules live here, shared by
 * server, web and MCP. No DOM or Node APIs.
 *
 * A specification belongs to one item. A bought-in item can have one per supplier; a product can
 * have an internal specification and customers' own. Its content lives in versions with the same
 * document control as recipes: at most one draft (the only editable version) and one approved
 * version; approving supersedes the previous one, which is kept unchanged.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const specificationStatuses = ["active", "archived"] as const;
export type SpecificationStatus = (typeof specificationStatuses)[number];

export const specificationVersionStatuses = ["draft", "approved", "superseded"] as const;
export type SpecificationVersionStatus = (typeof specificationVersionStatuses)[number];
export const specificationVersionStatusLabels: Record<SpecificationVersionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

/** What a specification covers, from its item's type. */
export const specificationKinds = ["ingredient", "packaging", "product"] as const;
export type SpecificationKind = (typeof specificationKinds)[number];
export const specificationKindLabels: Record<SpecificationKind, string> = {
  ingredient: "Ingredient",
  packaging: "Packaging",
  product: "Product",
};
export const specificationKindOf = (type: ItemType): SpecificationKind =>
  type === "ingredient" ? "ingredient" : type === "packaging" ? "packaging" : "product";
/** The item types each kind covers (for filtering by kind). */
export const itemTypesOfKind: Record<SpecificationKind, readonly ItemType[]> = {
  ingredient: ["ingredient"],
  packaging: ["packaging"],
  product: ["wip", "finished"],
};

/**
 * Who the specification is agreed with. A supplier's specification for a bought-in item, a
 * customer's for a product, or an internal one (our own product, or a generic ingredient standard).
 */
export type SpecificationParty = "supplier" | "customer" | "internal";
export const specificationPartyOf = (spec: {
  supplierId: string | null;
  customerName: string | null;
}): SpecificationParty => (spec.supplierId ? "supplier" : spec.customerName ? "customer" : "internal");

export const specificationParameterCategories = [
  "physical",
  "chemical",
  "microbiological",
  "allergen",
  "sensory",
  "other",
] as const;
export type SpecificationParameterCategory = (typeof specificationParameterCategories)[number];
export const specificationParameterCategoryLabels: Record<SpecificationParameterCategory, string> = {
  physical: "Physical",
  chemical: "Chemical",
  microbiological: "Microbiological",
  allergen: "Allergen",
  sensory: "Sensory",
  other: "Other",
};

/** A review due within this many days shows as "due soon". */
export const SPECIFICATION_REVIEW_DUE_SOON_DAYS = 30;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();
/** Limits are stored as `numeric(18,6)`. */
const sixDecimals = (value: number) => Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-4;
const limit = z
  .number()
  .finite()
  .min(-1_000_000_000)
  .max(1_000_000_000)
  .refine(sixDecimals, "At most 6 decimal places")
  .nullable();

export const specificationParameterInputSchema = z
  .object({
    category: z.enum(specificationParameterCategories),
    name: z.string().trim().min(1).max(120),
    /** e.g. "%", "cfu/g", "mm", "pH". */
    unit: optionalText(20).optional(),
    min: limit.optional(),
    target: limit.optional(),
    max: limit.optional(),
    /** A limit that isn't a number: "Absent in 25 g", "Free from foreign bodies". */
    limitText: optionalText(200).optional(),
    /** Test method or reference, e.g. "ISO 6579-1". */
    method: optionalText(200).optional(),
    note: optionalText(500).optional(),
  })
  .refine((p) => p.min != null || p.max != null || p.target != null || !!p.limitText, {
    message: "Give a minimum, target, maximum or a written limit",
  })
  .refine((p) => p.min == null || p.max == null || p.min <= p.max, {
    message: "The minimum can't be above the maximum",
  })
  .refine(
    (p) => p.target == null || ((p.min == null || p.min <= p.target) && (p.max == null || p.target <= p.max)),
    { message: "The target must lie between the minimum and maximum" },
  );
export type SpecificationParameterInput = z.infer<typeof specificationParameterInputSchema>;

const allergenList = z.array(z.enum(allergenCodes)).max(allergenCodes.length);

/**
 * The full content of a draft version. Saving replaces the draft's fields and all of its
 * parameters (in the order given). A draft may be incomplete; approval is not (see
 * {@link specificationApprovalBlockers}).
 */
export const specificationDraftSchema = z
  .object({
    /** What the material or product is: description, composition, appearance. */
    description: optionalText(5000).optional(),
    storage: z.enum(storageConditions).nullable().optional(),
    storageInstructions: optionalText(1000).optional(),
    /** Total shelf life from production (from receipt for a bought-in item without a date), days. */
    shelfLifeDays: z.number().int().min(1).max(3650).nullable().optional(),
    /** Bought-in items: the least remaining life accepted at goods-in, days. */
    minimumLifeOnReceiptDays: z.number().int().min(0).max(3650).nullable().optional(),
    allergens: allergenList.default([]),
    mayContain: allergenList.default([]),
    countryOfOrigin: optionalText(200).optional(),
    /** Variety, species, chain of custody, farm assurance: what the product's provenance claims rest on. */
    provenance: optionalText(2000).optional(),
    /** Claims the material supports or the product makes: "Organic", "Vegan", "Free range". */
    claims: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    /** Packaging: material, food-contact compliance, dimensions, recyclability. */
    packagingDetails: optionalText(2000).optional(),
    parameters: z.array(specificationParameterInputSchema).max(200).default([]),
    /** When the specification must be reviewed again (required to approve). */
    reviewDueOn: isoDate.nullable().optional(),
    /** The supplier's or customer's signatory, when they agreed this version. */
    agreedBy: optionalText(200).optional(),
    agreedOn: isoDate.nullable().optional(),
    /** Their reference for this version (document number, issue). */
    agreementReference: optionalText(200).optional(),
    /** What changed since the previous version. */
    changeNote: optionalText(2000).optional(),
  })
  .refine((d) => !d.mayContain.some((code) => d.allergens.includes(code)), {
    message: 'An allergen can\'t be both contained and "may contain"',
    path: ["mayContain"],
  })
  .refine((d) => !d.agreedOn === !d.agreedBy, {
    message: "Record who agreed the specification together with the date",
    path: ["agreedOn"],
  })
  .refine(
    (d) =>
      d.minimumLifeOnReceiptDays == null ||
      d.shelfLifeDays == null ||
      d.minimumLifeOnReceiptDays <= d.shelfLifeDays,
    {
      message: "The minimum life on receipt can't exceed the shelf life",
      path: ["minimumLifeOnReceiptDays"],
    },
  )
  .refine(
    (d) => {
      const keys = d.parameters.map(parameterKey);
      return new Set(keys).size === keys.length;
    },
    { message: "Each parameter name may appear once per category", path: ["parameters"] },
  )
  .refine((d) => new Set(d.claims.map((c) => c.toLowerCase())).size === d.claims.length, {
    message: "Each claim may appear once",
    path: ["claims"],
  });
export type SpecificationDraftInput = z.infer<typeof specificationDraftSchema>;

const specificationFields = {
  /** Document number, unique among live specifications, case-insensitively. */
  code: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  /** Bought-in items only: the supplier whose specification this is. */
  supplierId: z.uuid().nullable(),
  /** Products only: the customer this specification is agreed with. */
  customerName: optionalText(200),
};

export const specificationCreateSchema = z.object({
  id: z.uuid().optional(),
  code: specificationFields.code,
  title: specificationFields.title,
  itemId: z.uuid(),
  supplierId: specificationFields.supplierId.optional(),
  customerName: specificationFields.customerName.optional(),
  /** Content of version 1, saved as a draft. */
  draft: specificationDraftSchema.optional(),
});
export type SpecificationCreateInput = z.infer<typeof specificationCreateSchema>;

export const specificationUpdateSchema = z
  .object({ ...specificationFields, status: z.enum(specificationStatuses) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type SpecificationUpdateInput = z.infer<typeof specificationUpdateSchema>;

export const specificationReviewFilters = ["overdue", "due_soon", "attention"] as const;
export type SpecificationReviewFilter = (typeof specificationReviewFilters)[number];

export const specificationListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** Default: active specifications only. */
  status: z.enum([...specificationStatuses, "all"]).default("active"),
  kind: z.enum(specificationKinds).optional(),
  itemId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  /**
   * `overdue`: the approved version's review date has passed. `due_soon`: it falls within
   * {@link SPECIFICATION_REVIEW_DUE_SOON_DAYS}. `attention`: either, or no approved version yet.
   */
  review: z.enum(specificationReviewFilters).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SpecificationListQuery = z.infer<typeof specificationListQuerySchema>;

// ─── Content and comparison ──────────────────────────────────────────────────

export interface SpecificationParameter {
  category: SpecificationParameterCategory;
  name: string;
  unit: string | null;
  min: number | null;
  target: number | null;
  max: number | null;
  limitText: string | null;
  method: string | null;
  note: string | null;
}

/** The fields of a version that make up what was agreed and approved. */
export interface SpecificationContent {
  description: string | null;
  storage: StorageCondition | null;
  storageInstructions: string | null;
  shelfLifeDays: number | null;
  minimumLifeOnReceiptDays: number | null;
  allergens: readonly AllergenCode[];
  mayContain: readonly AllergenCode[];
  countryOfOrigin: string | null;
  provenance: string | null;
  claims: readonly string[];
  packagingDetails: string | null;
  parameters: readonly SpecificationParameter[];
}

/** Parameters are matched across versions by category and name, ignoring case. */
export const parameterKey = (p: { category: string; name: string }) =>
  `${p.category}:${p.name.trim().toLowerCase()}`;

/** A parameter's limit in words: "3.5–4.5 %", "≤ 100 cfu/g", "Absent in 25 g". */
export function formatParameterLimit(
  p: Pick<SpecificationParameter, "min" | "target" | "max" | "unit" | "limitText">,
) {
  const unit = p.unit ? ` ${p.unit}` : "";
  const parts: string[] = [];
  if (p.min != null && p.max != null) parts.push(`${p.min}–${p.max}${unit}`);
  else if (p.min != null) parts.push(`≥ ${p.min}${unit}`);
  else if (p.max != null) parts.push(`≤ ${p.max}${unit}`);
  if (p.target != null) parts.push(`target ${p.target}${unit}`);
  if (p.limitText) parts.push(p.limitText);
  return parts.join("; ");
}

export type SpecificationField =
  | "description"
  | "storage"
  | "storageInstructions"
  | "shelfLifeDays"
  | "minimumLifeOnReceiptDays"
  | "allergens"
  | "mayContain"
  | "countryOfOrigin"
  | "provenance"
  | "claims"
  | "packagingDetails";

export const specificationFieldLabels: Record<SpecificationField, string> = {
  description: "Description",
  storage: "Storage",
  storageInstructions: "Storage instructions",
  shelfLifeDays: "Shelf life",
  minimumLifeOnReceiptDays: "Minimum life on receipt",
  allergens: "Contains",
  mayContain: "May contain",
  countryOfOrigin: "Country of origin",
  provenance: "Provenance",
  claims: "Claims",
  packagingDetails: "Packaging details",
};

/**
 * Fields whose change can make a recipe, label or open batch wrong: what they declare, how the
 * product is kept and how long it lasts. Other changes are recorded but don't count as impacting.
 */
const impactingFields: ReadonlySet<SpecificationField> = new Set([
  "allergens",
  "mayContain",
  "storage",
  "shelfLifeDays",
  "claims",
  "countryOfOrigin",
]);

export interface SpecificationFieldChange {
  field: SpecificationField;
  label: string;
  /** Display text of the previous and new values ("—" when empty). */
  from: string;
  to: string;
  impacting: boolean;
}

export interface SpecificationParameterChange {
  change: "added" | "removed" | "changed";
  category: SpecificationParameterCategory;
  name: string;
  /** The limit as text before and after (null when added or removed). */
  from: string | null;
  to: string | null;
}

export interface SpecificationDiff {
  fields: SpecificationFieldChange[];
  parameters: SpecificationParameterChange[];
  /** Allergens newly contained or "may contain": the change most likely to need a label change. */
  addedAllergens: AllergenCode[];
  removedAllergens: AllergenCode[];
  /** True when something that recipes, labels or production rely on changed. */
  impacting: boolean;
}

const EMPTY = "—";
const textOf = (field: SpecificationField, content: SpecificationContent): string => {
  const value = content[field];
  if (value === null || value === undefined) return EMPTY;
  if (field === "allergens" || field === "mayContain") {
    const codes = value as readonly AllergenCode[];
    return codes.length ? codes.map((c) => allergenNames[c]).join(", ") : EMPTY;
  }
  if (field === "claims") {
    const claims = value as readonly string[];
    return claims.length ? [...claims].sort((a, b) => a.localeCompare(b)).join(", ") : EMPTY;
  }
  if (field === "storage") return storageLabels[value as StorageCondition];
  if (field === "shelfLifeDays" || field === "minimumLifeOnReceiptDays") {
    return `${value} day${value === 1 ? "" : "s"}`;
  }
  return String(value).trim() || EMPTY;
};

const parameterSignature = (p: SpecificationParameter) =>
  JSON.stringify([p.unit ?? null, p.min, p.target, p.max, p.limitText ?? null, p.method ?? null]);

/**
 * What changed from `previous` to `next`. With no previous version everything in `next` is new,
 * so every non-empty field and parameter is listed.
 */
export function diffSpecifications(
  previous: SpecificationContent | null,
  next: SpecificationContent,
): SpecificationDiff {
  const fields: SpecificationFieldChange[] = [];
  for (const field of Object.keys(specificationFieldLabels) as SpecificationField[]) {
    const to = textOf(field, next);
    const from = previous ? textOf(field, previous) : EMPTY;
    if (from === to) continue;
    fields.push({
      field,
      label: specificationFieldLabels[field],
      from,
      to,
      impacting: impactingFields.has(field),
    });
  }
  const before = new Map((previous?.parameters ?? []).map((p) => [parameterKey(p), p]));
  const after = new Map(next.parameters.map((p) => [parameterKey(p), p]));
  const parameters: SpecificationParameterChange[] = [];
  for (const [key, p] of after) {
    const old = before.get(key);
    if (!old)
      parameters.push({
        change: "added",
        category: p.category,
        name: p.name,
        from: null,
        to: formatParameterLimit(p),
      });
    else if (parameterSignature(old) !== parameterSignature(p)) {
      parameters.push({
        change: "changed",
        category: p.category,
        name: p.name,
        from: formatParameterLimit(old),
        to: formatParameterLimit(p),
      });
    }
  }
  for (const [key, p] of before) {
    if (!after.has(key)) {
      parameters.push({
        change: "removed",
        category: p.category,
        name: p.name,
        from: formatParameterLimit(p),
        to: null,
      });
    }
  }
  const mentioned = (c: SpecificationContent | null) =>
    new Set([...(c?.allergens ?? []), ...(c?.mayContain ?? [])]);
  const was = mentioned(previous);
  const now = mentioned(next);
  // Moving from "may contain" to "contains" is an addition too: the declaration gets stronger.
  const wasContained = new Set(previous?.allergens ?? []);
  const addedAllergens = sortAllergens([
    ...[...now].filter((c) => !was.has(c)),
    ...next.allergens.filter((c) => !wasContained.has(c)),
  ]);
  const removedAllergens = sortAllergens([...was].filter((c) => !now.has(c)));
  return {
    fields,
    parameters,
    addedAllergens,
    removedAllergens,
    // Parameters are what's tested; changing one affects release, not what's declared.
    impacting: fields.some((f) => f.impacting),
  };
}

export const isEmptyDiff = (diff: SpecificationDiff) =>
  diff.fields.length === 0 && diff.parameters.length === 0;

// ─── Item master cross-check ─────────────────────────────────────────────────

export type SpecificationDiscrepancyKind =
  | "allergen_undeclared"
  | "may_contain_undeclared"
  | "allergen_unexplained"
  | "shelf_life_longer"
  | "shelf_life_differs"
  | "storage_differs";

export interface SpecificationDiscrepancy {
  kind: SpecificationDiscrepancyKind;
  /** "serious" when the item master understates a hazard or overstates how long it lasts. */
  severity: "serious" | "check";
  message: string;
  allergens?: AllergenCode[];
}

export interface ItemMasterFacts {
  allergens: readonly AllergenCode[];
  mayContain: readonly AllergenCode[];
  storage: StorageCondition;
  shelfLifeDays: number | null;
}

/**
 * Where the item record, which recipes, labels and stock use, disagrees with an approved
 * specification. Specifications don't rewrite the item: a person decides which one is wrong.
 *
 * - The specification says it contains an allergen the item doesn't declare as contained, or may
 *   contain one the item doesn't mention at all: the item understates (serious).
 * - The item declares an allergen as contained that the specification doesn't mention: check it
 *   (the item may cover several suppliers' specifications).
 * - The item's shelf life is longer than the specification's (serious: stock would be dated beyond
 *   what was agreed) or shorter (check).
 * - Storage differs (check).
 */
export function itemDiscrepancies(
  spec: SpecificationContent,
  item: ItemMasterFacts,
): SpecificationDiscrepancy[] {
  const out: SpecificationDiscrepancy[] = [];
  const itemContains = new Set(item.allergens);
  const itemMentions = new Set([...item.allergens, ...item.mayContain]);
  const specMentions = new Set([...spec.allergens, ...spec.mayContain]);
  const undeclared = sortAllergens(spec.allergens.filter((c) => !itemContains.has(c)));
  if (undeclared.length) {
    out.push({
      kind: "allergen_undeclared",
      severity: "serious",
      allergens: undeclared,
      message: `The specification contains ${undeclared.map((c) => allergenNames[c]).join(", ")}, which the item doesn't declare as contained`,
    });
  }
  const mayUndeclared = sortAllergens(spec.mayContain.filter((c) => !itemMentions.has(c)));
  if (mayUndeclared.length) {
    out.push({
      kind: "may_contain_undeclared",
      severity: "serious",
      allergens: mayUndeclared,
      message: `The specification may contain ${mayUndeclared.map((c) => allergenNames[c]).join(", ")}, which the item doesn't mention`,
    });
  }
  const unexplained = sortAllergens(item.allergens.filter((c) => !specMentions.has(c)));
  if (unexplained.length) {
    out.push({
      kind: "allergen_unexplained",
      severity: "check",
      allergens: unexplained,
      message: `The item declares ${unexplained.map((c) => allergenNames[c]).join(", ")}, which the specification doesn't mention`,
    });
  }
  if (spec.shelfLifeDays != null && item.shelfLifeDays != null && spec.shelfLifeDays !== item.shelfLifeDays) {
    const longer = item.shelfLifeDays > spec.shelfLifeDays;
    out.push({
      kind: longer ? "shelf_life_longer" : "shelf_life_differs",
      severity: longer ? "serious" : "check",
      message: longer
        ? `The item's shelf life (${item.shelfLifeDays} days) is longer than the specification's (${spec.shelfLifeDays} days)`
        : `The item's shelf life (${item.shelfLifeDays} days) is shorter than the specification's (${spec.shelfLifeDays} days)`,
    });
  }
  if (spec.storage && spec.storage !== item.storage) {
    out.push({
      kind: "storage_differs",
      severity: "check",
      message: `The specification says ${storageLabels[spec.storage].toLowerCase()}; the item is kept ${storageLabels[item.storage].toLowerCase()}`,
    });
  }
  return out;
}

// ─── Approval and review ─────────────────────────────────────────────────────

export interface SpecificationApprovalInput {
  kind: SpecificationKind;
  party: SpecificationParty;
  content: SpecificationContent;
  reviewDueOn: string | null;
  agreedOn: string | null;
  /** The workspace's today. */
  today: string;
}

/**
 * Why a draft can't be approved yet; empty when it can. A specification is the agreed standard
 * the material or product is bought, made and released against, so it must say how it's kept and
 * how long it lasts (or, for packaging, what it is), carry a future review date, and, when it is
 * a supplier's or customer's, record their agreement.
 */
export function specificationApprovalBlockers(input: SpecificationApprovalInput): string[] {
  const blockers: string[] = [];
  const { content } = input;
  if (input.kind === "packaging") {
    if (!content.packagingDetails)
      blockers.push("Describe the packaging: material and food-contact compliance");
  } else {
    if (!content.storage) blockers.push("Set the storage condition");
    if (content.shelfLifeDays == null) blockers.push("Set the shelf life");
  }
  if (!input.reviewDueOn) blockers.push("Set a review date");
  else if (input.reviewDueOn <= input.today) blockers.push("Set a review date in the future");
  if (input.party !== "internal" && !input.agreedOn) {
    blockers.push(
      input.party === "supplier"
        ? "Record the supplier's agreement (who and when)"
        : "Record the customer's agreement (who and when)",
    );
  }
  if (input.agreedOn && input.agreedOn > input.today)
    blockers.push("The agreement date can't be in the future");
  return blockers;
}

/**
 * Four-eyes: whoever made the last edit to a draft can't approve it, unless nobody else has
 * `manage` (a one-person team can still keep its documents controlled).
 */
export function canApproveSpecification(input: {
  lastEditedBy: string | null;
  deciderId: string;
  managerIds: readonly string[];
}): boolean {
  if (input.lastEditedBy !== input.deciderId) return true;
  return input.managerIds.every((id) => id === input.deciderId);
}

export type SpecificationReviewState = "none" | "ok" | "due_soon" | "overdue";

const dayNumber = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

/** Where an approved version stands against its review date (`none`: nothing approved). */
export function specificationReviewState(
  reviewDueOn: string | null,
  today: string,
): SpecificationReviewState {
  if (!reviewDueOn) return "none";
  const days = dayNumber(reviewDueOn) - dayNumber(today);
  if (days < 0) return "overdue";
  if (days <= SPECIFICATION_REVIEW_DUE_SOON_DAYS) return "due_soon";
  return "ok";
}

/** The last day counted as "due soon" from `today`, for filtering in queries. */
export function specificationDueSoonCutoff(today: string): string {
  const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + SPECIFICATION_REVIEW_DUE_SOON_DAYS);
  return d.toISOString().slice(0, 10);
}
