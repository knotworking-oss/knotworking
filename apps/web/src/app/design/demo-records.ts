import type { DespatchImpactReport } from "@knotworking/core";
import { describeLimit, stockAmount, type UnitCode } from "@knotworking/core";
import type { HaccpBatchRecord, LotTrace } from "@/lib/api";

/**
 * Static records for the `/design` showcase: a lot's production trace and a batch's food safety
 * record, shaped like the API's responses, so the components render without calling the API.
 */

const at = "2026-11-10T09:30:00.000Z";
const amount = (base: number, unit: UnitCode) => stockAmount(base, { unit });
const item = (id: string, code: string, name: string, type: "ingredient" | "finished", unit: UnitCode) => ({
  id,
  code,
  name,
  type,
  unit,
  status: "active" as const,
});
const flour = item("item-flour", "FLR", "Flour", "ingredient", "kg");
const cake = item("item-cake", "CAKE", "Lemon cake", "finished", "each");
const box = item("item-box", "BOX6", "Box of six cakes", "finished", "each");

const lot = (
  id: string,
  lotCode: string,
  lotItem: typeof flour,
  status: "available" | "quarantine",
  onHand: number,
  supplier?: { name: string; lotCode: string },
) => ({
  id,
  lotCode,
  item: lotItem,
  status,
  expiresOn: "2026-12-01",
  expiryType: "best_before" as const,
  expiryState: "ok" as const,
  supplierName: supplier?.name ?? null,
  supplierLotCode: supplier?.lotCode ?? null,
  onHand: amount(onHand, lotItem.unit),
});
const flourLot = lot("lot-flour", "FL-2611", flour, "available", 4000, {
  name: "Mill & Co",
  lotCode: "M-8812",
});
const cakeLot = lot("lot-cake", "B261110-1", cake, "available", 12);
const boxLot = lot("lot-box", "B261110-2", box, "quarantine", 2);

const batch = (id: string, batchCode: string, code: string, name: string) => ({
  id,
  batchCode,
  status: "completed" as const,
  plannedOn: "2026-11-10",
  completedAt: at,
  recipe: { id: `recipe-${code}`, code, name },
  recipeVersion: { id: `version-${code}`, versionNumber: 2 },
});
const cakeBatch = batch("batch-cake", "B261110-1", "R-CAKE", "Lemon cake");
const boxBatch = batch("batch-box", "B261110-2", "R-BOX", "Box of six");

/** The cake lot: made from flour, then boxed. */
export const demoLotTrace: LotTrace = {
  lot: {
    id: cakeLot.id,
    lotCode: cakeLot.lotCode,
    item: cake,
    status: "available",
    expiresOn: cakeLot.expiresOn,
    expiryType: cakeLot.expiryType,
  },
  massBalance: {
    received: amount(0, "each"),
    returned: amount(0, "each"),
    produced: amount(24, "each"),
    consumed: amount(12, "each"),
    despatched: amount(0, "each"),
    wasted: amount(0, "each"),
    adjusted: amount(0, "each"),
    transferred: amount(0, "each"),
    onHand: amount(12, "each"),
    input: amount(24, "each"),
    adjustedPercent: 0,
  },
  backward: [
    {
      depth: 1,
      batch: cakeBatch,
      produced: { lot: cakeLot, amount: amount(24, "each") },
      inputs: [{ lot: flourLot, amount: amount(2000, "kg") }],
    },
  ],
  forward: [
    {
      depth: 1,
      batch: boxBatch,
      consumed: { lot: cakeLot, amount: amount(12, "each") },
      outputs: [{ lot: boxLot, amount: amount(2, "each") }],
    },
  ],
};

const ccpRow = (
  id: string,
  code: string,
  processStep: string,
  limit: {
    limitType: "range" | "pass_fail";
    limitMin: number | null;
    limitMax: number | null;
    limitUnit: string | null;
    passCriterion: string | null;
  },
  frequency: { every: number; unit: "batch" | "hour" | "day" },
  frequencyText: string,
) => ({
  id,
  versionId: "version-haccp",
  code,
  sortOrder: 0,
  stepId: null,
  processStep,
  hazardType: "biological" as const,
  hazard: "Survival of vegetative pathogens",
  ...limit,
  monitoringMethod: "Probe the core of the largest piece",
  duringProduction: false,
  responsibleRole: "Baker",
  correctiveAction: "Continue baking until the core reaches 75 °C",
  verification: "Supervisor reviews the log daily",
  createdAt: at,
  updatedAt: at,
  frequency,
  frequencyText,
  limitText: describeLimit(limit),
});
const baking = ccpRow(
  "ccp-bake",
  "CCP1",
  "Baking",
  { limitType: "range", limitMin: 75, limitMax: null, limitUnit: "°C", passCriterion: null },
  { every: 1, unit: "batch" },
  "Every batch",
);
const metal = ccpRow(
  "ccp-metal",
  "CCP2",
  "Metal detection",
  {
    limitType: "pass_fail",
    limitMin: null,
    limitMax: null,
    limitUnit: null,
    passCriterion: "No metal detected",
  },
  { every: 1, unit: "batch" },
  "Every batch",
);
const plan = { id: "plan-bakery", code: "HACCP-01", name: "Bakery" };

const log = (
  id: string,
  ccp: typeof baking,
  reading: { value: number | null; passed: boolean | null; readingText: string },
  fields: Partial<HaccpBatchRecord["logs"][number]> = {},
): HaccpBatchRecord["logs"][number] => ({
  id,
  planId: plan.id,
  planVersionId: "version-haccp",
  ccpId: ccp.id,
  ccpCode: ccp.code,
  batchId: "batch-demo",
  value: reading.value,
  passed: reading.passed,
  withinLimits: true,
  deviationReason: null,
  note: null,
  source: "manual",
  checkedAt: at,
  recordedBy: "user-ada",
  correctsLogId: null,
  correctionReason: null,
  reviewStatus: "approved",
  reviewedBy: "user-ada",
  reviewedAt: at,
  reviewNote: null,
  createdAt: at,
  recordedByName: "Ada Park",
  reviewedByName: "Ada Park",
  readingText: reading.readingText,
  ccp: {
    id: ccp.id,
    code: ccp.code,
    processStep: ccp.processStep,
    hazardType: ccp.hazardType,
    limitType: ccp.limitType,
    limitMin: ccp.limitMin,
    limitMax: ccp.limitMax,
    limitUnit: ccp.limitUnit,
    passCriterion: ccp.passCriterion,
    limitText: ccp.limitText,
    monitoringMethod: ccp.monitoringMethod,
    correctiveAction: ccp.correctiveAction,
    frequency: ccp.frequency,
  },
  plan,
  batch: { id: "batch-demo", batchCode: "B261110-3" },
  correctedByLogId: null,
  correctiveActions: [],
  ...fields,
});

/** A batch in progress: one deviation (corrected, with its corrective action open) and a reading awaiting review. */
export const demoBatchRecord: HaccpBatchRecord = {
  batch: { id: "batch-demo", batchCode: "B261110-3", status: "in_progress" },
  logs: [
    log(
      "log-3",
      metal,
      { value: null, passed: true, readingText: "Pass" },
      { source: "api", reviewStatus: "pending", reviewedBy: null, reviewedAt: null, reviewedByName: null },
    ),
    log(
      "log-2",
      baking,
      { value: 71, passed: null, readingText: "71 °C" },
      {
        withinLimits: false,
        deviationReason: "below_min",
        correctsLogId: "log-1",
        correctionReason: "Probe re-read",
      },
    ),
    log(
      "log-1",
      baking,
      { value: 68, passed: null, readingText: "68 °C" },
      {
        withinLimits: false,
        deviationReason: "below_min",
        correctedByLogId: "log-2",
        correctiveActions: [{ id: "ca-1", title: "CCP1 Baking: 68 °C (limit ≥ 75 °C)", status: "open" }],
      },
    ),
  ],
  ccps: [
    {
      plan,
      ccp: baking,
      checks: 1,
      awaitingReview: 0,
      lastCheckedAt: at,
      deviations: 1,
    },
    {
      plan,
      ccp: metal,
      checks: 1,
      awaitingReview: 1,
      lastCheckedAt: at,
      deviations: 0,
    },
  ],
  missingChecks: 0,
  awaitingReview: 1,
  openDeviations: 1,
  openCorrectiveActions: 1,
};

/** CCPs for the check and correction dialogs. */
export const demoCcps = { baking, metal };

export const demoDistributionImpact: DespatchImpactReport = {
  rootLotId: "impact-flour",
  generatedAt: "2026-11-14T10:30:00.000Z",
  scope: "forward_production_and_despatch",
  coverage: {
    status: "partial",
    reasons: ["depth_limit"],
    depth: 1,
    limits: { lots: 2000, batches: 2000, links: 10000 },
  },
  lots: [
    {
      id: "impact-flour",
      lotCode: "FLOUR-014",
      depth: 0,
      item: { id: "flour", code: "FLR", name: "Flour", unit: "kg" },
      status: "available",
      expiresOn: null,
      onHand: stockAmount(2000, { unit: "kg" }),
      despatched: stockAmount(0, { unit: "kg" }),
    },
    {
      id: "impact-mix",
      lotCode: "MIX-008",
      depth: 1,
      item: { id: "mix", code: "MIX", name: "Cake mix", unit: "kg" },
      status: "quarantine",
      expiresOn: null,
      onHand: stockAmount(500, { unit: "kg" }),
      despatched: stockAmount(0, { unit: "kg" }),
    },
  ],
  batches: [{ id: "impact-batch", batchCode: "B261114-008", status: "completed", depth: 1, outputLinks: 1 }],
  summary: { lots: 2, batches: 1, customers: 0, despatches: 0, deliveryLines: 0 },
  deliveries: { lines: [], total: 0, limit: 50, offset: 0 },
};

/** Authenticity/VACCP example: the plan is signed; an overdue control still needs attention. */
export const demoAuthenticityVersion: import("@knotworking/core").AuthenticityVersion = {
  id: "auth-version-1",
  number: 1,
  status: "approved",
  createdAt: "2026-11-14T09:00:00.000Z",
  createdBy: "auth-ada",
  updatedBy: "auth-ada",
  approvedAt: "2026-11-14T12:00:00.000Z",
  approvedBy: "auth-ada",
  approvalNote: "Reviewed the declared origin and commodity intelligence; verify each planned control.",
  subject: {
    itemCode: "SPICE-01",
    itemName: "Ground spice",
    supplierCode: "MILL",
    supplierName: "Example mill",
  },
  body: {
    ownerUserId: "auth-ada",
    scope: "Authenticity of bought-in ground spice and its provenance claim",
    origin: "Declared single-country origin",
    supplyChain: "Grower → processor → mill → site, sealed deliveries",
    factors: [
      {
        factor: "history",
        level: "high",
        rationale: "Recorded commodity adulteration incidents justify targeted verification.",
      },
      {
        factor: "economic",
        level: "high",
        rationale: "Price volatility and higher-value origin claims create an incentive to substitute.",
      },
      {
        factor: "access",
        level: "medium",
        rationale: "Several processing stages create opportunities before sealed delivery.",
      },
      {
        factor: "supply_chain",
        level: "medium",
        rationale: "Named processing sites and source records are available for review.",
      },
      {
        factor: "detectability",
        level: "medium",
        rationale: "Visual checks are limited; use a suitable authenticity test and source verification.",
      },
    ],
    vulnerability: "high",
    rationale: "Retain enhanced source checks and risk-based testing against the declared identity.",
    sources: [
      {
        title: "Commodity intelligence review",
        reference: "Site intelligence register INT-2026-11",
        checkedOn: "2026-11-14",
        findings: "Reviewed recent commodity alerts and their relevance to this supply route.",
      },
    ],
    evidence: [
      {
        kind: "provenance",
        title: "Origin declaration",
        reference: "Controlled supplier origin statement",
        validUntil: "2027-11-14",
        sampleId: null,
        note: "Supports the declared origin; independently verify the supply route.",
      },
    ],
    controls: [
      {
        id: "auth-control-1",
        kind: "provenance",
        description: "Verify chain of custody and declared origin",
        ownerUserId: "auth-ada",
        dueOn: "2026-11-14",
        frequencyDays: 90,
        acceptanceCriteria: "Named source and route match the agreed specification",
      },
      {
        id: "auth-control-2",
        kind: "testing",
        description: "Review the authenticity test report",
        ownerUserId: "auth-ada",
        dueOn: "2026-11-20",
        frequencyDays: null,
        acceptanceCriteria: "A suitable accredited method supports the declared identity",
      },
    ],
    reviewDueOn: "2027-11-14",
  },
};
export const demoAuthenticitySummary: import("@knotworking/core").AuthenticitySummary = {
  id: "auth-demo",
  reference: "AUTH-000001",
  title: "Ground spice authenticity",
  itemId: "spice",
  supplierId: "mill",
  itemCode: "SPICE-01",
  itemName: "Ground spice",
  supplierName: "Example mill",
  status: "active",
  currentVersionId: "auth-version-1",
  draftVersionId: null,
  vulnerability: "high",
  reviewDueOn: "2027-11-14",
  needsReview: true,
  openTriggers: 0,
  overdueControls: 1,
  failedControls: 0,
  pendingControls: 1,
  updatedAt: "2026-11-14T12:00:00.000Z",
};
