import { z } from "zod";

/**
 * Supplier controls (Phase 3, milestone 3.2.4), part of the Items module beside supplier
 * approval: risk assessments per supplier and item (or for a service provider as a whole), the
 * controls each assessment calls for, self-assessment questionnaires, and a compliance check that
 * says which controls are met by the evidence on record. Pure; shared by server, web and MCP.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const supplierCategories = ["goods", "service"] as const;
export type SupplierCategory = (typeof supplierCategories)[number];
export const supplierCategoryLabels: Record<SupplierCategory, string> = {
  goods: "Goods",
  service: "Service provider",
};

export const supplierRiskLevels = ["low", "medium", "high"] as const;
export type SupplierRiskLevel = (typeof supplierRiskLevels)[number];
export const supplierRiskLevelLabels: Record<SupplierRiskLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const supplierHazards = [
  "microbiological",
  "allergen",
  "physical",
  "chemical",
  "authenticity",
  "other",
] as const;
export type SupplierHazard = (typeof supplierHazards)[number];
export const supplierHazardLabels: Record<SupplierHazard, string> = {
  microbiological: "Microbiological",
  allergen: "Allergen",
  physical: "Physical / foreign body",
  chemical: "Chemical",
  authenticity: "Authenticity / fraud",
  other: "Other",
};

/** What an assessment can require of the supplier before and while it is used. */
export const supplierControls = [
  "certificate",
  "questionnaire",
  "specification",
  "audit",
  "coa_each_delivery",
  "testing_on_receipt",
] as const;
export type SupplierControl = (typeof supplierControls)[number];
export const supplierControlLabels: Record<SupplierControl, string> = {
  certificate: "Valid certification (e.g. BRCGS, SALSA)",
  questionnaire: "Accepted self-assessment questionnaire",
  specification: "Agreed, approved specification",
  audit: "Supplier audit",
  coa_each_delivery: "Certificate of analysis with each delivery",
  testing_on_receipt: "Testing on receipt",
};

export const supplierQuestionnaireStatuses = ["sent", "received", "accepted", "rejected"] as const;
export type SupplierQuestionnaireStatus = (typeof supplierQuestionnaireStatuses)[number];
export const supplierQuestionnaireStatusLabels: Record<SupplierQuestionnaireStatus, string> = {
  sent: "Sent",
  received: "Received",
  accepted: "Accepted",
  rejected: "Rejected",
};

/** A review, certificate or questionnaire expiring within this many days is "due soon". */
export const SUPPLIER_CONTROL_DUE_SOON_DAYS = 30;
/** A questionnaire unanswered this long after it was sent is chased. */
export const SUPPLIER_QUESTIONNAIRE_CHASE_DAYS = 30;

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();
const unique = <T extends string>(list: readonly T[]) => new Set(list).size === list.length;

export const supplierRiskAssessmentSchema = z.object({
  /** The item it covers; null for the supplier as a whole (a service provider, or every item). */
  itemId: z.uuid().nullable().optional(),
  riskLevel: z.enum(supplierRiskLevels),
  hazards: z
    .array(z.enum(supplierHazards))
    .max(supplierHazards.length)
    .refine(unique, "Each hazard once")
    .default([]),
  /** Why this level: the hazards, the supplier's history, how the material is used. */
  rationale: z.string().trim().min(1).max(4000),
  controls: z
    .array(z.enum(supplierControls))
    .max(supplierControls.length)
    .refine(unique, "Each control once")
    .default([]),
  controlNotes: optionalText(2000).optional(),
  /** When it must be assessed again: not in the past. */
  reviewDueOn: isoDate,
});
export type SupplierRiskAssessmentInput = z.infer<typeof supplierRiskAssessmentSchema>;

export const supplierQuestionnaireCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sentOn: isoDate,
  /** Already back: the date it came in. */
  receivedOn: isoDate.nullable().optional(),
  notes: optionalText(2000).optional(),
});
export type SupplierQuestionnaireCreateInput = z.infer<typeof supplierQuestionnaireCreateSchema>;

/** Mark a sent questionnaire received. */
export const supplierQuestionnaireReceiveSchema = z.object({
  receivedOn: isoDate,
  notes: optionalText(2000).optional(),
});
export type SupplierQuestionnaireReceiveInput = z.infer<typeof supplierQuestionnaireReceiveSchema>;

/** Accept or reject a received questionnaire: a person with `manage`. */
export const supplierQuestionnaireReviewSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    /** Accepted answers stand until this date (required to accept). */
    validUntil: isoDate.nullable().optional(),
    reviewNote: optionalText(2000).optional(),
  })
  .refine((r) => r.decision === "rejected" || !!r.validUntil, {
    message: "Say how long an accepted questionnaire stands",
    path: ["validUntil"],
  })
  .refine((r) => r.decision === "accepted" || !!r.reviewNote, {
    message: "Say why it was rejected",
    path: ["reviewNote"],
  });
export type SupplierQuestionnaireReviewInput = z.infer<typeof supplierQuestionnaireReviewSchema>;

// ─── Compliance ──────────────────────────────────────────────────────────────

const dayNumber = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
const daysUntil = (iso: string, today: string) => dayNumber(iso) - dayNumber(today);

export interface ComplianceAssessment {
  id: string;
  itemId: string | null;
  itemCode: string | null;
  riskLevel: SupplierRiskLevel;
  controls: readonly SupplierControl[];
  reviewDueOn: string;
}

export interface ComplianceFacts {
  supplier: {
    category: SupplierCategory;
    approvalStatus: "pending" | "approved" | "suspended" | "rejected";
    reviewDueOn: string | null;
    certification: string | null;
    certificateExpiresOn: string | null;
  };
  /** Current (not superseded) assessments. */
  assessments: readonly ComplianceAssessment[];
  questionnaires: readonly {
    id: string;
    title: string;
    status: SupplierQuestionnaireStatus;
    sentOn: string;
    validUntil: string | null;
  }[];
  /** Items the supplier is listed for (goods suppliers). */
  items: readonly { id: string; code: string }[];
  /** Items with an approved specification agreed with this supplier; null when Specifications is off. */
  specifiedItemIds: readonly string[] | null;
  today: string;
}

export type ControlState = "met" | "missing" | "expiring" | "at_goods_in" | "not_tracked";

export interface ControlStatus {
  control: SupplierControl;
  state: ControlState;
  detail: string;
}

export interface ComplianceIssue {
  kind:
    | "no_assessment"
    | "item_not_assessed"
    | "assessment_overdue"
    | "assessment_due_soon"
    | "control_missing"
    | "control_expiring"
    | "approval_review_overdue"
    | "questionnaire_chase";
  severity: "action" | "warning";
  message: string;
}

/**
 * Where a supplier stands against its controls: for each current assessment, whether each control
 * it requires is met by the evidence on record, and the issues to act on. Audits and goods-in
 * controls aren't evidenced here: they are reported as such, never as met.
 */
export function supplierCompliance(facts: ComplianceFacts) {
  const { supplier, today } = facts;
  const issues: ComplianceIssue[] = [];
  const soon = (iso: string) => daysUntil(iso, today) <= SUPPLIER_CONTROL_DUE_SOON_DAYS;

  const certificate = (): ControlStatus => {
    if (!supplier.certification)
      return { control: "certificate", state: "missing", detail: "No certification recorded" };
    if (!supplier.certificateExpiresOn)
      return {
        control: "certificate",
        state: "missing",
        detail: `${supplier.certification}: no expiry date recorded`,
      };
    if (supplier.certificateExpiresOn < today)
      return {
        control: "certificate",
        state: "missing",
        detail: `${supplier.certification} expired ${supplier.certificateExpiresOn}`,
      };
    return soon(supplier.certificateExpiresOn)
      ? {
          control: "certificate",
          state: "expiring",
          detail: `${supplier.certification} expires ${supplier.certificateExpiresOn}`,
        }
      : {
          control: "certificate",
          state: "met",
          detail: `${supplier.certification} until ${supplier.certificateExpiresOn}`,
        };
  };
  const accepted = facts.questionnaires
    .filter((q) => q.status === "accepted" && q.validUntil && q.validUntil >= today)
    .sort((a, b) => (b.validUntil ?? "").localeCompare(a.validUntil ?? ""))[0];
  const questionnaire = (): ControlStatus =>
    !accepted
      ? { control: "questionnaire", state: "missing", detail: "No accepted questionnaire in date" }
      : soon(accepted.validUntil!)
        ? {
            control: "questionnaire",
            state: "expiring",
            detail: `${accepted.title} stands until ${accepted.validUntil}`,
          }
        : {
            control: "questionnaire",
            state: "met",
            detail: `${accepted.title} stands until ${accepted.validUntil}`,
          };
  const specification = (a: ComplianceAssessment): ControlStatus => {
    if (facts.specifiedItemIds === null)
      return {
        control: "specification",
        state: "not_tracked",
        detail: "The Specifications module is switched off",
      };
    const wanted = a.itemId ? [a.itemId] : facts.items.map((i) => i.id);
    const missing = wanted.filter((id) => !facts.specifiedItemIds!.includes(id));
    if (wanted.length === 0)
      return { control: "specification", state: "missing", detail: "No item to specify" };
    return missing.length
      ? {
          control: "specification",
          state: "missing",
          detail: `No approved specification with this supplier for ${missing.length} item${missing.length === 1 ? "" : "s"}`,
        }
      : {
          control: "specification",
          state: "met",
          detail: "Approved specification agreed with this supplier",
        };
  };

  const assessments = facts.assessments.map((a) => {
    const controls: ControlStatus[] = a.controls.map((control) => {
      switch (control) {
        case "certificate":
          return certificate();
        case "questionnaire":
          return questionnaire();
        case "specification":
          return specification(a);
        case "audit":
          return { control, state: "not_tracked", detail: "Record audits as attachments; not checked here" };
        default:
          return { control, state: "at_goods_in", detail: "Applies to each delivery at goods-in" };
      }
    });
    const scope = a.itemCode ?? "the supplier";
    if (a.reviewDueOn < today) {
      issues.push({
        kind: "assessment_overdue",
        severity: "action",
        message: `Risk assessment for ${scope} was due for review ${a.reviewDueOn}`,
      });
    } else if (soon(a.reviewDueOn)) {
      issues.push({
        kind: "assessment_due_soon",
        severity: "warning",
        message: `Risk assessment for ${scope} is due for review ${a.reviewDueOn}`,
      });
    }
    for (const c of controls) {
      if (c.state === "missing") {
        issues.push({
          kind: "control_missing",
          severity: "action",
          message: `${supplierControlLabels[c.control]} (${scope}): ${c.detail}`,
        });
      } else if (c.state === "expiring") {
        issues.push({
          kind: "control_expiring",
          severity: "warning",
          message: `${supplierControlLabels[c.control]} (${scope}): ${c.detail}`,
        });
      }
    }
    return { ...a, controls };
  });

  const wholeSupplier = facts.assessments.some((a) => a.itemId === null);
  if (facts.assessments.length === 0) {
    issues.push({
      kind: "no_assessment",
      severity: "action",
      message:
        supplier.category === "service"
          ? "No risk assessment of this service provider"
          : "No risk assessment of this supplier",
    });
  } else if (supplier.category === "goods" && !wholeSupplier) {
    const assessed = new Set(facts.assessments.map((a) => a.itemId));
    for (const item of facts.items.filter((i) => !assessed.has(i.id))) {
      issues.push({
        kind: "item_not_assessed",
        severity: "action",
        message: `${item.code} is bought from this supplier without a risk assessment`,
      });
    }
  }
  if (supplier.approvalStatus === "approved" && supplier.reviewDueOn && supplier.reviewDueOn < today) {
    issues.push({
      kind: "approval_review_overdue",
      severity: "action",
      message: `Supplier approval was due for review ${supplier.reviewDueOn}`,
    });
  }
  for (const q of facts.questionnaires.filter((q) => q.status === "sent")) {
    if (daysUntil(today, q.sentOn) >= SUPPLIER_QUESTIONNAIRE_CHASE_DAYS) {
      issues.push({
        kind: "questionnaire_chase",
        severity: "warning",
        message: `${q.title} was sent ${q.sentOn} and hasn't come back`,
      });
    }
  }
  const levels: SupplierRiskLevel[] = ["low", "medium", "high"];
  const highest = facts.assessments.reduce<SupplierRiskLevel | null>(
    (m, a) => (m === null || levels.indexOf(a.riskLevel) > levels.indexOf(m) ? a.riskLevel : m),
    null,
  );
  return {
    riskLevel: highest,
    assessments,
    issues,
    actionCount: issues.filter((i) => i.severity === "action").length,
  };
}

// ─── Enforcement ─────────────────────────────────────────────────────────────

/**
 * A workspace setting: `report` (the default) only shows open supplier control issues; `block`
 * also refuses approving a supplier and sending it a purchase order while it has issues needing
 * action, unless a person with manage records an override reason.
 */
export const supplierControlEnforcements = ["report", "block"] as const;
export type SupplierControlEnforcement = (typeof supplierControlEnforcements)[number];

export const supplierControlSettingsSchema = z.object({
  enforcement: z.enum(supplierControlEnforcements),
});
export type SupplierControlSettingsInput = z.infer<typeof supplierControlSettingsSchema>;

/** Why a supplier was approved or ordered from despite open control issues (people only). */
export const supplierControlsOverrideReason = z.string().trim().min(1).max(2000);

/** What an override recorded: the reason and the issues open at the time. */
export interface SupplierControlsOverride {
  reason: string;
  issues: string[];
}

/**
 * The issues that block under `block`: those needing action. Approving a supplier sets a new
 * review date, so an overdue approval review doesn't block the approval itself.
 */
export function blockingSupplierIssues(
  issues: readonly ComplianceIssue[],
  purpose: "approval" | "order",
): ComplianceIssue[] {
  return issues.filter(
    (i) => i.severity === "action" && !(purpose === "approval" && i.kind === "approval_review_overdue"),
  );
}
