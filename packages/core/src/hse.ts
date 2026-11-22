import { z } from "zod";
import { addDays } from "./stock";
const text = (n: number) => z.string().trim().min(1).max(n);
const memo = z.string().trim().max(6000).default("");
const day = z.iso.date();
export const hseKinds = [
  "risk_assessment",
  "coshh",
  "contractor",
  "inspection",
  "emergency",
  "waste",
  "utility",
  "environmental_obligation",
] as const;
export type HseKind = (typeof hseKinds)[number];
export const hseKindLabels: Record<HseKind, string> = {
  risk_assessment: "Risk assessment",
  coshh: "COSHH / SDS",
  contractor: "Contractor competence",
  inspection: "Statutory inspection",
  emergency: "Emergency exercise",
  waste: "Waste handling",
  utility: "Utilities",
  environmental_obligation: "Environmental obligation",
};
export const hseHazardSchema = z.object({
  hazard: text(1000),
  peopleAtRisk: text(1000),
  likelihood: z.number().int().min(1).max(5),
  severity: z.number().int().min(1).max(5),
  controls: text(3000),
  residualLikelihood: z.number().int().min(1).max(5),
  residualSeverity: z.number().int().min(1).max(5),
  rationale: text(2000),
});
export const hseContentSchema = z.object({
  scope: memo,
  basis: memo,
  controls: memo,
  response: memo,
  ownerUserId: z.uuid().nullable().default(null),
  reviewDueOn: day.nullable().default(null),
  firstCheckDueOn: day.nullable().default(null),
  frequencyDays: z.number().int().min(1).max(3650).nullable().default(null),
  subject: z.string().trim().max(500).default(""),
  evidenceReference: memo,
  sdsIssuedOn: day.nullable().default(null),
  sdsAttachmentId: z.uuid().nullable().default(null),
  supplierId: z.uuid().nullable().default(null),
  competenceExpiresOn: day.nullable().default(null),
  actionTaskIds: z
    .array(z.uuid())
    .max(30)
    .default([])
    .refine((a) => new Set(a).size === a.length, "Duplicate task"),
  courseIds: z
    .array(z.uuid())
    .max(30)
    .default([])
    .refine((a) => new Set(a).size === a.length, "Duplicate course"),
  hazards: z.array(hseHazardSchema).max(100).default([]),
  unit: z.string().trim().max(30).default(""),
  wasteCode: z.string().trim().max(80).default(""),
  authorisationReference: z.string().trim().max(300).default(""),
});
export type HseContent = z.infer<typeof hseContentSchema>;
const command = { commandId: z.uuid() };
const reviewed = { ...command, expectedRevision: z.number().int().positive() };
export const hseCreateSchema = z.object({
  ...command,
  title: text(200),
  kind: z.enum(hseKinds),
  content: hseContentSchema,
});
export const hseSaveSchema = z.object({ ...reviewed, content: hseContentSchema, reason: text(2000) });
export const hseActionSchema = z.object({ ...reviewed, reason: text(2000) });
/**
 * Issuing or resuming a permit names the evidence the manager reviewed: the approved contractor
 * and assessment versions shown on the permit. A version approved since then must be reviewed first.
 */
export const hsePermitSignSchema = hseActionSchema.extend({
  reviewedEvidence: z.object({
    contractorVersionId: z.uuid(),
    assessmentVersionIds: z.array(z.uuid()).max(50),
  }),
});
export type HsePermitSign = z.infer<typeof hsePermitSignSchema>;
export const hsePageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const hseListSchema = hsePageSchema.extend({
  kind: z.enum(hseKinds).optional(),
  status: z.enum(["active", "archived"]).default("active"),
});
export const hseEntrySchema = z
  .object({
    ...reviewed,
    performedOn: day,
    outcome: z.enum(["pass", "fail", "recorded"]),
    findings: text(6000),
    actions: memo,
    evidenceReference: text(2000),
    nextDueOn: day.nullable().default(null),
    quantity: z
      .number()
      .finite()
      .positive()
      .max(1_000_000_000)
      .refine((v) => Math.round(v * 1e4) > 0, "Quantity rounds to zero")
      .nullable()
      .default(null),
    periodFrom: day.nullable().default(null),
    resolvesEntryId: z.uuid().nullable().default(null),
  })
  .refine((v) => v.outcome !== "fail" || !!v.actions, "A failed check needs immediate action")
  .refine((v) => !v.periodFrom || v.periodFrom <= v.performedOn, "Period starts after its end");
export const hseEntryVoidSchema = z.object({ ...reviewed, reason: text(2000) });
export const hsePermitBodySchema = z
  .object({
    contractorRecordId: z.uuid(),
    assessmentIds: z
      .array(z.uuid())
      .min(1)
      .max(20)
      .refine((a) => new Set(a).size === a.length, "Duplicate assessment"),
    assetId: z.uuid(),
    staffId: z.uuid().nullable().default(null),
    visitId: z.uuid().nullable().default(null),
    startsOn: day,
    endsOn: day,
    workScope: text(4000),
    precautions: text(4000),
    isolationRequired: z.boolean(),
    isolationPoints: z.string().trim().max(4000).default(""),
    inductionChecked: z.boolean(),
    ppeChecked: z.boolean(),
    emergencyReady: z.boolean(),
  })
  .refine((v) => v.endsOn >= v.startsOn, "Permit ends before it starts")
  .refine((v) => !v.isolationRequired || !!v.isolationPoints, "Record every isolation point");
export const hsePermitCreateSchema = z.object({ ...command, title: text(200), body: hsePermitBodySchema });
export const hsePermitSaveSchema = z.object({ ...reviewed, body: hsePermitBodySchema, reason: text(2000) });
export const hsePermitCloseSchema = z.object({
  ...reviewed,
  reason: text(2000),
  workComplete: z.literal(true),
  toolsRemoved: z.literal(true),
  protectionsRestored: z.literal(true),
  isolationsRemovedSafely: z.literal(true),
  safeToReturn: z.literal(true),
});
export const hsePermitListSchema = hsePageSchema.extend({
  status: z.enum(["draft", "issued", "suspended", "closed", "cancelled"]).optional(),
});
export const hseIncidentKinds = [
  "accident",
  "near_miss",
  "dangerous_occurrence",
  "ill_health",
  "unsafe_condition",
  "environmental",
] as const;
export type HseIncidentKind = (typeof hseIncidentKinds)[number];
export const hseIncidentKindLabels: Record<HseIncidentKind, string> = {
  accident: "Accident",
  near_miss: "Near miss",
  dangerous_occurrence: "Dangerous occurrence",
  ill_health: "Work-related ill health",
  unsafe_condition: "Unsafe condition or act",
  environmental: "Environmental incident",
};
export const hseIncidentOutcomes = ["none", "first_aid", "medical_treatment", "lost_time", "major"] as const;
export type HseIncidentOutcome = (typeof hseIncidentOutcomes)[number];
export const hseIncidentOutcomeLabels: Record<HseIncidentOutcome, string> = {
  none: "No injury",
  first_aid: "First aid",
  medical_treatment: "Medical treatment",
  lost_time: "Lost time",
  major: "Major injury",
};
export const hseIncidentBodySchema = z.object({
  kind: z.enum(hseIncidentKinds),
  occurredOn: day,
  place: text(500),
  summary: text(3000),
  staffIds: z.array(z.uuid()).max(30).default([]),
  healthDetails: memo,
  immediateActions: text(4000),
  ownerUserId: z.uuid(),
  investigation: memo,
  rootCause: memo,
  correctiveActions: memo,
  effectiveness: memo,
  reportingDecision: z.enum(["not_assessed", "required", "not_required"]).default("not_assessed"),
  reportingBasis: memo,
  reportingDueOn: day.nullable().default(null),
  reportReference: memo,
  /** The worst outcome for anyone hurt; `none` for a near miss or no injury. */
  outcome: z.enum(hseIncidentOutcomes).default("none"),
});
export const hseIncidentCreateSchema = z.object({ ...command, body: hseIncidentBodySchema });
export const hseIncidentSaveSchema = z.object({
  ...reviewed,
  body: hseIncidentBodySchema,
  reason: text(2000),
});
export const hseIncidentListSchema = hsePageSchema.extend({ status: z.enum(["open", "closed"]).optional() });
export function hseApprovalBlockers(kind: HseKind, c: HseContent, today: string): string[] {
  const errors: string[] = [];
  for (const key of ["scope", "basis", "controls", "response"] as const)
    if (!c[key]) errors.push(`Complete ${key}`);
  if (!c.ownerUserId) errors.push("Choose an accountable owner");
  if (!c.reviewDueOn || c.reviewDueOn < today) errors.push("Set a current or future review date");
  if (kind === "risk_assessment" && !c.hazards.length)
    errors.push("Assess at least one hazard and residual risk");
  if (kind === "coshh" && (!c.subject || !c.evidenceReference || !c.sdsIssuedOn || c.sdsIssuedOn > today))
    errors.push("Record the substance and a dated SDS reference");
  if (
    kind === "contractor" &&
    (!c.supplierId || !c.evidenceReference || !c.competenceExpiresOn || c.competenceExpiresOn < today)
  )
    errors.push("Record a service provider and current competence evidence/expiry");
  if (
    ["inspection", "emergency", "environmental_obligation"].includes(kind) &&
    (!c.firstCheckDueOn || !c.evidenceReference)
  )
    errors.push("Set the first due date and applicable procedure/requirement reference");
  if (kind === "waste" && (!c.supplierId || !c.wasteCode || !c.authorisationReference || !c.unit))
    errors.push("Record the waste code, unit, service provider and carrier authorisation reference");
  if (kind === "utility" && (!c.subject || !c.unit))
    errors.push("Record the resource/meter and measurement unit");
  return errors;
}
export function hseDue(
  first: string | null,
  frequency: number | null,
  latest: { performedOn: string; nextDueOn: string | null } | null,
  today: string,
) {
  const dueOn = latest
    ? (latest.nextDueOn ?? (frequency ? addDays(latest.performedOn, frequency) : null))
    : first;
  return {
    dueOn,
    state: !dueOn
      ? ("not_scheduled" as const)
      : dueOn < today
        ? ("overdue" as const)
        : dueOn === today
          ? ("due" as const)
          : ("scheduled" as const),
  };
}
export type HseCreate = z.infer<typeof hseCreateSchema>;
export type HseSave = z.infer<typeof hseSaveSchema>;
export type HseAction = z.infer<typeof hseActionSchema>;
export type HsePage = z.infer<typeof hsePageSchema>;
export type HseList = z.infer<typeof hseListSchema>;
export type HseEntry = z.infer<typeof hseEntrySchema>;
export type HsePermitBody = z.infer<typeof hsePermitBodySchema>;
export type HsePermitCreate = z.infer<typeof hsePermitCreateSchema>;
export type HsePermitSave = z.infer<typeof hsePermitSaveSchema>;
export type HsePermitClose = z.infer<typeof hsePermitCloseSchema>;
export type HseIncidentBody = z.infer<typeof hseIncidentBodySchema>;
export type HseIncidentCreate = z.infer<typeof hseIncidentCreateSchema>;
export type HseIncidentSave = z.infer<typeof hseIncidentSaveSchema>;
