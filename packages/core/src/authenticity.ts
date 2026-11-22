import { z } from "zod";
import { addDays } from "./stock";

/** Food authenticity/VACCP, within Quality. Ratings are the team's judgement, not a statutory score. */
export const authenticityFactors = [
  "history",
  "economic",
  "access",
  "supply_chain",
  "detectability",
] as const;
export type AuthenticityFactor = (typeof authenticityFactors)[number];
export const authenticityFactorLabels: Record<AuthenticityFactor, string> = {
  history: "History and intelligence about fraud",
  economic: "Economic incentives and price pressures",
  access: "Opportunity for substitution, dilution or adulteration",
  supply_chain: "Origin, traceability and supply-chain complexity",
  detectability: "Ability of current checks to detect fraud",
};
export const authenticityLevels = ["unassessed", "low", "medium", "high"] as const;
export const authenticityTriggerKinds = [
  "intelligence",
  "supplier_change",
  "origin_change",
  "price_alert",
  "claim_change",
  "failed_control",
  "evidence_correction",
  "periodic",
  "other",
] as const;
export const authenticityControlKinds = [
  "mitigation",
  "testing",
  "provenance",
  "claim",
  "intelligence_review",
] as const;
const text = (max = 4000) => z.string().trim().min(1).max(max);
const draftText = (max = 4000) => z.string().trim().max(max).default("");
export const authenticityEvidenceSchema = z.object({
  kind: z.enum(["provenance", "claim", "testing", "mitigation", "other"]),
  title: text(200),
  reference: text(2000),
  note: draftText(2000),
  validUntil: z.iso.date().nullable().default(null),
  /** Opaque link only. Test results continue to be read through Testing's own permissions. */
  sampleId: z.uuid().nullable().default(null),
});
export const authenticityControlSchema = z.object({
  id: z.uuid(),
  kind: z.enum(authenticityControlKinds),
  description: text(2000),
  ownerUserId: z.uuid(),
  dueOn: z.iso.date(),
  frequencyDays: z.number().int().min(1).max(3650).nullable().default(null),
  acceptanceCriteria: text(2000),
});
export const authenticityDraftSchema = z.object({
  ownerUserId: z.uuid().nullable().default(null),
  scope: draftText(),
  origin: draftText(1000),
  supplyChain: draftText(),
  factors: z
    .array(
      z.object({
        factor: z.enum(authenticityFactors),
        level: z.enum(authenticityLevels),
        rationale: draftText(2000),
      }),
    )
    .max(authenticityFactors.length)
    .default([])
    .refine((v) => new Set(v.map((x) => x.factor)).size === v.length, "Assess each factor once"),
  vulnerability: z.enum(authenticityLevels).default("unassessed"),
  rationale: draftText(),
  sources: z
    .array(z.object({ title: text(200), reference: text(2000), checkedOn: z.iso.date(), findings: text() }))
    .max(50)
    .default([]),
  evidence: z.array(authenticityEvidenceSchema).max(50).default([]),
  controls: z
    .array(authenticityControlSchema)
    .max(50)
    .default([])
    .refine((v) => new Set(v.map((x) => x.id)).size === v.length, "Control identifiers must be distinct"),
  reviewDueOn: z.iso.date().nullable().default(null),
});
export type AuthenticityDraft = z.infer<typeof authenticityDraftSchema>;
export type AuthenticityControl = z.infer<typeof authenticityControlSchema>;
export const authenticityCreateSchema = z.object({
  commandId: z.uuid(),
  title: text(200),
  itemId: z.uuid(),
  supplierId: z.uuid().nullable().default(null),
  draft: authenticityDraftSchema.prefault({}),
});
export const authenticityVersionCommandSchema = z.object({
  commandId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
});
export const authenticitySaveSchema = authenticityVersionCommandSchema.extend({
  draft: authenticityDraftSchema,
});
export const authenticityApproveSchema = authenticityVersionCommandSchema.extend({
  note: text(),
  triggerIds: z
    .array(z.uuid())
    .max(500)
    .refine((v) => new Set(v).size === v.length, "Each trigger once"),
});
export const authenticityTriggerSchema = z.object({
  commandId: z.uuid(),
  kind: z.enum(authenticityTriggerKinds).exclude(["failed_control", "evidence_correction"]),
  note: text(),
  reference: text(2000),
});
export const authenticityVerificationSchema = z
  .object({
    commandId: z.uuid(),
    verifiedOn: z.iso.date(),
    outcome: z.enum(["pass", "fail"]),
    evidenceReference: text(2000),
    evidenceValidUntil: z.iso.date().nullable().default(null),
    note: text(),
  })
  .refine(
    (v) => v.outcome !== "pass" || !v.evidenceValidUntil || v.evidenceValidUntil >= v.verifiedOn,
    "Passing evidence must still be valid on the verification date",
  );
export const authenticityVoidSchema = z.object({ commandId: z.uuid(), reason: text() });
export const authenticityArchiveSchema = authenticityVersionCommandSchema.extend({ reason: text() });
export const authenticityListQuerySchema = z.object({
  itemId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  q: z.string().trim().max(200).default(""),
  state: z.enum(["all", "active", "needs_review", "overdue_controls", "archived"]).default("active"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1e7).default(0),
});
export type AuthenticityCreateInput = z.infer<typeof authenticityCreateSchema>;
export type AuthenticitySaveInput = z.infer<typeof authenticitySaveSchema>;
export type AuthenticityApproveInput = z.infer<typeof authenticityApproveSchema>;
export type AuthenticityTriggerInput = z.infer<typeof authenticityTriggerSchema>;
export type AuthenticityVerificationInput = z.infer<typeof authenticityVerificationSchema>;
export type AuthenticityListQuery = z.infer<typeof authenticityListQuerySchema>;
export type AuthenticityVersionCommand = z.infer<typeof authenticityVersionCommandSchema>;
export type AuthenticityArchiveInput = z.infer<typeof authenticityArchiveSchema>;
export type AuthenticityVoidInput = z.infer<typeof authenticityVoidSchema>;

export function authenticityApprovalBlockers(draft: AuthenticityDraft, today: string): string[] {
  const issues: string[] = [];
  if (!draft.ownerUserId) issues.push("Assign an assessment owner");
  if (!draft.scope || !draft.origin || !draft.supplyChain)
    issues.push("Describe the scope, origin and supply chain");
  for (const factor of authenticityFactors) {
    const f = draft.factors.find((x) => x.factor === factor);
    if (!f || f.level === "unassessed" || !f.rationale)
      issues.push(`Assess and explain: ${authenticityFactorLabels[factor]}`);
  }
  if (draft.vulnerability === "unassessed" || !draft.rationale)
    issues.push("Conclude the vulnerability level and explain the judgement");
  if (!draft.sources.length) issues.push("Record intelligence sources and findings");
  if (draft.sources.some((s) => s.checkedOn > today))
    issues.push("Intelligence checks cannot be dated in the future");
  if (!draft.evidence.length) issues.push("Record provenance, claim or other supporting evidence");
  if (draft.evidence.some((e) => e.validUntil && e.validUntil < today))
    issues.push("Replace or review expired supporting evidence");
  if (!draft.controls.length) issues.push("Plan at least one mitigation or verification control");
  if (!draft.reviewDueOn || draft.reviewDueOn < today)
    issues.push("Set the next review date to today or later");
  return issues;
}
export interface AuthenticityVerification {
  id: string;
  versionId: string;
  controlId: string;
  verifiedOn: string;
  outcome: "pass" | "fail";
  evidenceReference: string;
  evidenceValidUntil: string | null;
  note: string;
  createdAt: string;
  actorId: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}
export type AuthenticityControlState = "pending" | "due" | "overdue" | "failed" | "expired" | "verified";
export function authenticityControlStatus(
  control: Pick<AuthenticityControl, "id" | "dueOn" | "frequencyDays">,
  records: readonly Pick<
    AuthenticityVerification,
    "id" | "controlId" | "verifiedOn" | "outcome" | "evidenceValidUntil" | "createdAt" | "voidedAt"
  >[],
  today: string,
) {
  const last = records
    .filter((v) => v.controlId === control.id && !v.voidedAt)
    .sort(
      (a, b) =>
        b.verifiedOn.localeCompare(a.verifiedOn) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    )[0];
  const nextDueOn =
    last?.outcome === "pass"
      ? control.frequencyDays
        ? addDays(last.verifiedOn, control.frequencyDays)
        : null
      : control.dueOn;
  let state: AuthenticityControlState;
  if (last?.outcome === "fail") state = "failed";
  else if (last?.evidenceValidUntil && last.evidenceValidUntil < today) state = "expired";
  else if (nextDueOn && nextDueOn < today) state = "overdue";
  else if (nextDueOn === today) state = "due";
  else state = last?.outcome === "pass" ? "verified" : "pending";
  return { state, nextDueOn, lastVerificationId: last?.id ?? null };
}
export interface AuthenticityVersion {
  id: string;
  number: number;
  status: "draft" | "approved" | "superseded";
  body: AuthenticityDraft;
  subject: { itemCode: string; itemName: string; supplierCode: string | null; supplierName: string | null };
  createdAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalNote: string | null;
}
export interface AuthenticityTrigger {
  id: string;
  kind: (typeof authenticityTriggerKinds)[number];
  note: string;
  reference: string;
  createdAt: string;
  actorId: string | null;
  resolvedByVersionId: string | null;
}
export interface AuthenticitySummary {
  id: string;
  reference: string;
  title: string;
  itemId: string;
  supplierId: string | null;
  itemCode: string;
  itemName: string;
  supplierName: string | null;
  status: "active" | "archived";
  currentVersionId: string | null;
  draftVersionId: string | null;
  vulnerability: AuthenticityDraft["vulnerability"];
  reviewDueOn: string | null;
  needsReview: boolean;
  openTriggers: number;
  overdueControls: number;
  failedControls: number;
  pendingControls: number;
  updatedAt: string;
}
export interface AuthenticityDetail extends AuthenticitySummary {
  versions: AuthenticityVersion[];
  triggers: AuthenticityTrigger[];
  verifications: AuthenticityVerification[];
  controls: (AuthenticityControl & ReturnType<typeof authenticityControlStatus>)[];
  approvalBlockers: string[];
  archivedAt: string | null;
  archivedBy: string | null;
  archiveReason: string | null;
  today: string;
}
