import { z } from "zod";
import { roundQuantity } from "./items";
import { addDaysToIsoDate, addMonthsToIsoDate } from "./sops";
import { dateInZone } from "./time-zone";

/**
 * Food safety records module (`haccp`): the HACCP plan under document control, CCP monitoring
 * logs, corrective actions, and cleaning and calibration records (UK, BRCGS, Codex HACCP).
 *
 * Shared vocabulary, validation schemas and the pure rules: whether a reading is within its
 * critical limits (`evaluateReading`), when a check is next due (`checkDueState`), whether a
 * calibration passes. No DOM or Node APIs.
 *
 * Monitoring logs and cleaning and calibration records are append-only: a correction is a new row
 * that points at the one it corrects. Approving a plan version, correcting a reading, reviewing a
 * reading that an API token recorded, closing a corrective action and attesting cleaning or
 * calibration are a person's acts.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** The hazard a critical control point controls (Codex: biological, chemical, physical; plus allergens). */
export const haccpHazardTypes = ["biological", "chemical", "physical", "allergen"] as const;
export type HaccpHazardType = (typeof haccpHazardTypes)[number];
export const haccpHazardTypeLabels: Record<HaccpHazardType, string> = {
  biological: "Biological",
  chemical: "Chemical",
  physical: "Physical",
  allergen: "Allergen",
};

export const haccpPlanStatuses = ["active", "archived"] as const;
export type HaccpPlanStatus = (typeof haccpPlanStatuses)[number];

/**
 * Document control, as for recipes: a plan has at most one `draft` (the only editable version)
 * and at most one `approved` version (the latest sign-off). Approving a draft supersedes the
 * previous approved version; superseded versions are kept and never change. Which version is in
 * force follows the effective dates, not these labels (`versionInForce`): a version approved for a
 * later date leaves the previous one in force until then.
 */
export const haccpPlanVersionStatuses = ["draft", "approved", "superseded"] as const;
export type HaccpPlanVersionStatus = (typeof haccpPlanVersionStatuses)[number];
export const haccpPlanVersionStatusLabels: Record<HaccpPlanVersionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

/** Months between reviews of a plan unless it says otherwise (BRCGS: at least annually). */
export const DEFAULT_HACCP_REVIEW_INTERVAL_MONTHS = 12;

/**
 * A critical limit is either a measured `range` (a minimum, a maximum or both, inclusive, with a
 * unit such as °C or pH) or a `pass_fail` criterion ("no metal detected").
 */
export const ccpLimitTypes = ["range", "pass_fail"] as const;
export type CcpLimitType = (typeof ccpLimitTypes)[number];
export const ccpLimitTypeLabels: Record<CcpLimitType, string> = {
  range: "Measured range",
  pass_fail: "Pass or fail",
};

/**
 * How often something is checked: every N hours, days, weeks or months, or once per production
 * batch (`batch`: due for every batch in progress that the plan covers).
 */
export const checkFrequencyUnits = ["batch", "hour", "day", "week", "month"] as const;
export type CheckFrequencyUnit = (typeof checkFrequencyUnits)[number];
/** Units a cleaning or calibration schedule may use (not per batch). */
export const scheduleFrequencyUnits = ["hour", "day", "week", "month"] as const;
export type ScheduleFrequencyUnit = (typeof scheduleFrequencyUnits)[number];

export interface CheckFrequency {
  every: number;
  unit: CheckFrequencyUnit;
}

const unitWords: Record<CheckFrequencyUnit, [string, string]> = {
  batch: ["batch", "batches"],
  hour: ["hour", "hours"],
  day: ["day", "days"],
  week: ["week", "weeks"],
  month: ["month", "months"],
};

/** "Every batch", "Every 2 hours", "Daily", "Monthly". */
export function describeFrequency(frequency: CheckFrequency): string {
  const { every, unit } = frequency;
  if (every === 1) {
    if (unit === "batch") return "Every batch";
    if (unit === "hour") return "Hourly";
    if (unit === "day") return "Daily";
    if (unit === "week") return "Weekly";
    return "Monthly";
  }
  return `Every ${every} ${unitWords[unit][1]}`;
}

/** Areas are cleaned; equipment is cleaned and may be calibrated (probe thermometers, scales). */
export const haccpAssetKinds = ["area", "equipment"] as const;
export type HaccpAssetKind = (typeof haccpAssetKinds)[number];
export const haccpAssetKindLabels: Record<HaccpAssetKind, string> = { area: "Area", equipment: "Equipment" };

export const haccpAssetStatuses = ["active", "archived"] as const;
export type HaccpAssetStatus = (typeof haccpAssetStatuses)[number];

/**
 * Where a monitoring reading or corrective action came from: `manual` (a person in the app) or
 * `api` (an API token: a sensor feed or an agent; its readings await a person's review). It
 * follows the credential, so it can't be claimed.
 */
export const haccpSources = ["manual", "api"] as const;
export type HaccpSource = (typeof haccpSources)[number];

/**
 * Where a CCP reading stands in review. A person's own reading is `approved` when it is written:
 * their entry is the attestation. A reading from an API token (a sensor feed or an agent) is
 * `pending` until a person with `manage` approves or rejects it (a one-time stamp: who, when and a
 * note; rejecting needs the note). A pending reading counts as done for what's due and is
 * evaluated at once: an out-of-limit one opens its corrective action straight away.
 */
export const ccpLogReviewStatuses = ["pending", "approved", "rejected"] as const;
export type CcpLogReviewStatus = (typeof ccpLogReviewStatuses)[number];
export const ccpLogReviewStatusLabels: Record<CcpLogReviewStatus, string> = {
  pending: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
};
/** What a reviewer decides about a pending reading. */
export const ccpLogReviewDecisions = ["approve", "reject"] as const;
export type CcpLogReviewDecision = (typeof ccpLogReviewDecisions)[number];

/** The review status a new reading starts with: a person's is approved, a token's is pending. */
export const initialReviewStatus = (source: HaccpSource): CcpLogReviewStatus =>
  source === "manual" ? "approved" : "pending";

/** The review status a decision leads to. */
export const reviewStatusFor = (decision: CcpLogReviewDecision): CcpLogReviewStatus =>
  decision === "approve" ? "approved" : "rejected";

/**
 * Whether a reading counts as done for what's due: pending and approved readings do (nothing is
 * entered twice while it waits for review); a rejected one doesn't, so the check is due again.
 */
export const countsAsDone = (log: { reviewStatus: CcpLogReviewStatus }) => log.reviewStatus !== "rejected";

/** Whether a reading waits for a person's review: pending, and not replaced by a correction. */
export const awaitsReview = (log: {
  reviewStatus: CcpLogReviewStatus;
  correctedByLogId?: string | null | undefined;
}) => log.reviewStatus === "pending" && !log.correctedByLogId;

/** A corrective action is open until a person with `manage` closes it. */
export const correctiveActionStatuses = ["open", "closed"] as const;
export type CorrectiveActionStatus = (typeof correctiveActionStatuses)[number];
export const correctiveActionStatusLabels: Record<CorrectiveActionStatus, string> = {
  open: "Open",
  closed: "Closed",
};

/** Why a reading is outside its critical limits. */
export const deviationReasons = ["below_min", "above_max", "failed"] as const;
export type DeviationReason = (typeof deviationReasons)[number];
export const deviationReasonLabels: Record<DeviationReason, string> = {
  below_min: "Below minimum",
  above_max: "Above maximum",
  failed: "Failed",
};

/** Readings, limits and calibration values are `numeric(14,4)`. */
export const HACCP_VALUE_DECIMALS = 4;

// ─── Critical limits ─────────────────────────────────────────────────────────

export interface CriticalLimit {
  limitType: CcpLimitType;
  limitMin: number | null;
  limitMax: number | null;
  limitUnit: string | null;
  passCriterion: string | null;
}

/** A reading: a measured value for a range, or pass/fail for a criterion. */
export type CcpReading = { value: number } | { passed: boolean };

export type ReadingEvaluation =
  { withinLimits: true; reason: null } | { withinLimits: false; reason: DeviationReason };

/**
 * Whether a reading is within the CCP's critical limits. Limits are inclusive (a core temperature
 * of exactly 75 °C meets "at least 75 °C"). `null` when the reading doesn't fit the limit (a value
 * for a pass/fail criterion, or pass/fail for a measured range).
 */
export function evaluateReading(limit: CriticalLimit, reading: CcpReading): ReadingEvaluation | null {
  if (limit.limitType === "pass_fail") {
    if (!("passed" in reading)) return null;
    return reading.passed ? { withinLimits: true, reason: null } : { withinLimits: false, reason: "failed" };
  }
  if (!("value" in reading) || !Number.isFinite(reading.value)) return null;
  const value = roundQuantity(reading.value, HACCP_VALUE_DECIMALS);
  if (limit.limitMin !== null && value < roundQuantity(limit.limitMin, HACCP_VALUE_DECIMALS)) {
    return { withinLimits: false, reason: "below_min" };
  }
  if (limit.limitMax !== null && value > roundQuantity(limit.limitMax, HACCP_VALUE_DECIMALS)) {
    return { withinLimits: false, reason: "above_max" };
  }
  return { withinLimits: true, reason: null };
}

const withUnit = (value: number, unit: string | null) => (unit ? `${value} ${unit}` : String(value));

/** "≥ 75 °C", "≤ 5 °C", "0–5 °C", or the pass criterion. */
export function describeLimit(limit: CriticalLimit): string {
  if (limit.limitType === "pass_fail") return limit.passCriterion ?? "Pass";
  const { limitMin: min, limitMax: max, limitUnit: unit } = limit;
  if (min !== null && max !== null) return unit ? `${min}–${max} ${unit}` : `${min}–${max}`;
  if (min !== null) return `≥ ${withUnit(min, unit)}`;
  if (max !== null) return `≤ ${withUnit(max, unit)}`;
  return "No limit set";
}

/** A reading as text: "72.5 °C", "Pass", "Fail". */
export function describeReading(
  limit: Pick<CriticalLimit, "limitUnit">,
  reading: { value: number | null; passed: boolean | null },
): string {
  if (reading.value !== null) return withUnit(reading.value, limit.limitUnit);
  if (reading.passed !== null) return reading.passed ? "Pass" : "Fail";
  return "—";
}

// ─── When a check is due ─────────────────────────────────────────────────────

/**
 * Where a scheduled check stands:
 *  - `overdue`: its due time (hourly checks) or date (daily and longer) has passed;
 *  - `due`: due today, or never done;
 *  - `soon`: due within `HACCP_DUE_SOON_DAYS`;
 *  - `ok`: comfortably ahead;
 *  - `idle`: a check made only during production, and nothing the plan covers is in production.
 */
export const dueStates = ["overdue", "due", "soon", "ok", "idle"] as const;
export type DueState = (typeof dueStates)[number];
export const dueStateLabels: Record<DueState, string> = {
  overdue: "Overdue",
  due: "Due",
  soon: "Due soon",
  ok: "Up to date",
  idle: "Not in production",
};
/** States the "what's due" view lists by default. */
export const actionableDueStates = ["overdue", "due"] as const satisfies readonly DueState[];

/** A check is "due soon" from this many days before its date. */
export const HACCP_DUE_SOON_DAYS = 7;

const dueRank: Record<DueState, number> = { overdue: 0, due: 1, soon: 2, ok: 3, idle: 4 };
/** Orders checks most urgent first. */
export const compareDueStates = (a: DueState, b: DueState) => dueRank[a] - dueRank[b];

/** `date` (`YYYY-MM-DD`) plus a schedule interval (calendar arithmetic, UTC). Hours count as days. */
export function addFrequencyToDate(date: string, frequency: { every: number; unit: ScheduleFrequencyUnit }) {
  switch (frequency.unit) {
    case "hour":
      return addDaysToIsoDate(date, Math.ceil(frequency.every / 24));
    case "day":
      return addDaysToIsoDate(date, frequency.every);
    case "week":
      return addDaysToIsoDate(date, frequency.every * 7);
    case "month":
      return addMonthsToIsoDate(date, frequency.every);
  }
}

/** Where a due date stands against today: past it, today, within the soon window, or later. */
export function dateDueState(
  dueOn: string,
  today: string,
  soonDays: number = HACCP_DUE_SOON_DAYS,
): Exclude<DueState, "idle"> {
  if (dueOn < today) return "overdue";
  if (dueOn === today) return "due";
  return dueOn <= addDaysToIsoDate(today, soonDays) ? "soon" : "ok";
}

export interface DueResult {
  state: DueState;
  /** The date the next check falls on; `null` when it has never been done (due now). */
  dueOn: string | null;
  /** For hourly checks: the moment the next check falls due (ISO). */
  dueAt: string | null;
}

/**
 * When a scheduled check (not a per-batch one) is next due, from the last time it was done.
 *
 * Hourly checks run on the clock: due at the last check plus the interval, overdue the moment
 * that passes. Daily, weekly and monthly checks run on the calendar (the workspace's time zone): a daily check done
 * yesterday is due today and overdue tomorrow. A check never done is due now. A check made only
 * during production (`duringProduction`) is `idle` while nothing it covers is in production.
 */
export function checkDueState(input: {
  frequency: { every: number; unit: ScheduleFrequencyUnit };
  lastAt: Date | string | null;
  now?: Date;
  /** The workspace's time zone: daily, weekly and monthly checks run on its calendar. */
  timeZone: string;
  duringProduction?: boolean;
  producing?: boolean;
}): DueResult {
  const now = input.now ?? new Date();
  const zone = input.timeZone;
  const today = dateInZone(now, zone);
  const last = input.lastAt === null ? null : new Date(input.lastAt);
  let result: DueResult;
  if (!last) result = { state: "due", dueOn: null, dueAt: null };
  else if (input.frequency.unit === "hour") {
    const dueAt = new Date(last.getTime() + input.frequency.every * 3_600_000);
    const dueOn = dateInZone(dueAt, zone);
    result = {
      state: dueAt.getTime() < now.getTime() ? "overdue" : dateDueState(dueOn, today),
      dueOn,
      dueAt: dueAt.toISOString(),
    };
  } else {
    const dueOn = addFrequencyToDate(dateInZone(last, zone), input.frequency);
    result = { state: dateDueState(dueOn, today), dueOn, dueAt: null };
  }
  if (input.duringProduction && !input.producing) result.state = "idle";
  return result;
}

// ─── Which version is in force ───────────────────────────────────────────────

/** The fields of a plan version that decide when it is in force. */
export interface PlanVersionTiming {
  id: string;
  versionNumber: number;
  status: HaccpPlanVersionStatus;
  effectiveOn: string | null;
  approvedAt: Date | string | null;
}

/**
 * Where a version stands on a date: `in_force`; `scheduled` (signed off, takes effect on its
 * `effectiveOn`); `replaced` (was in force, or was replaced by a later approval before it took
 * effect); or `draft`.
 */
export const planVersionStates = ["draft", "scheduled", "in_force", "replaced"] as const;
export type PlanVersionState = (typeof planVersionStates)[number];
export const planVersionStateLabels: Record<PlanVersionState, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  in_force: "In force",
  replaced: "Replaced",
};

/** Signed off: approved or superseded, with an approval stamp and an effective date. */
export const isSignedOffVersion = (version: PlanVersionTiming) =>
  (version.status === "approved" || version.status === "superseded") &&
  version.approvedAt !== null &&
  version.effectiveOn !== null;

/**
 * The version of a plan in force on `on` (an ISO date): of the signed-off versions that have taken
 * effect by then (`effectiveOn <= on`), the one approved last, which is the highest version number
 * (versions are numbered in the order they are drafted and approved one at a time; on a shared
 * effective date the higher number wins). Approving a version with a future effective date leaves
 * the previous one in force until that date; status labels don't decide it. `null` before the
 * first version takes effect.
 */
export function versionInForce<T extends PlanVersionTiming>(versions: readonly T[], on: string): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (!isSignedOffVersion(v) || v.effectiveOn! > on) continue;
    if (!best || v.versionNumber > best.versionNumber) best = v;
  }
  return best;
}

/**
 * Where each version stands on `on`, and for the version in force the date the next signed-off
 * version takes over (`inForceUntil`, the last day being the day before), or `null` if none is
 * scheduled. A signed-off version later than the one in force is `scheduled` unless an even later
 * approval takes effect on or before its date (it is then `replaced` without ever taking effect).
 */
export function planVersionSchedule<T extends PlanVersionTiming>(
  versions: readonly T[],
  on: string,
): {
  inForce: T | null;
  inForceUntil: string | null;
  /** The next version to take effect, if one is scheduled. */
  next: T | null;
  states: Map<string, PlanVersionState>;
} {
  const inForce = versionInForce(versions, on);
  const signedOff = versions.filter(isSignedOffVersion);
  const later = signedOff.filter((v) => !inForce || v.versionNumber > inForce.versionNumber);
  const scheduled = later.filter(
    (v) => !later.some((w) => w.versionNumber > v.versionNumber && w.effectiveOn! <= v.effectiveOn!),
  );
  let next: T | null = null;
  for (const v of scheduled) if (!next || v.effectiveOn! < next.effectiveOn!) next = v;
  const states = new Map<string, PlanVersionState>();
  for (const v of versions) {
    states.set(
      v.id,
      !isSignedOffVersion(v)
        ? "draft"
        : v.id === inForce?.id
          ? "in_force"
          : scheduled.includes(v)
            ? "scheduled"
            : "replaced",
    );
  }
  return { inForce, inForceUntil: next?.effectiveOn ?? null, next, states };
}

// ─── Plan scope ──────────────────────────────────────────────────────────────

/** What a plan covers: products (items) and recipes. Both empty means the whole site. */
export interface HaccpScope {
  itemIds: readonly string[];
  recipeIds: readonly string[];
}

/** Whether a batch (its recipe and output item) falls under a plan's scope. */
export const scopeCoversBatch = (scope: HaccpScope, batch: { recipeId: string; outputItemId: string }) =>
  (scope.itemIds.length === 0 && scope.recipeIds.length === 0) ||
  scope.recipeIds.includes(batch.recipeId) ||
  scope.itemIds.includes(batch.outputItemId);

// ─── Calibration ─────────────────────────────────────────────────────────────

/**
 * Whether a calibration check passes: the instrument's reading is within `tolerance` of the
 * reference (inclusive). `null` without a tolerance: the person says whether it passed.
 */
export function calibrationPasses(input: {
  referenceReading: number;
  actualReading: number;
  tolerance: number | null;
}): boolean | null {
  if (input.tolerance === null) return null;
  const error = roundQuantity(Math.abs(input.actualReading - input.referenceReading), HACCP_VALUE_DECIMALS);
  return error <= roundQuantity(input.tolerance, HACCP_VALUE_DECIMALS);
}

// ─── Hazard analysis ─────────────────────────────────────────────────────────

/**
 * The hazard analysis behind a plan version (Codex principle 1): the ordered process steps, the
 * hazards at each step with a likelihood and a severity, the control measure for each, and the
 * Codex decision tree answers (Q1 to Q4) that make a step a critical control point. It is
 * versioned with the plan (same document control) and stored on the version's steps.
 */
export const HAZARD_SCALE_MAX = 5;
export const hazardScaleLabels: Record<number, string> = {
  1: "Very low",
  2: "Low",
  3: "Medium",
  4: "High",
  5: "Very high",
};

export const hazardRiskLevels = ["low", "medium", "high"] as const;
export type HazardRiskLevel = (typeof hazardRiskLevels)[number];
export const hazardRiskLabels: Record<HazardRiskLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Likelihood times severity (1 to 25): up to 4 is low, up to 12 medium, above that high. */
export function hazardRisk(likelihood: number, severity: number): { score: number; level: HazardRiskLevel } {
  const score = likelihood * severity;
  return { score, level: score <= 4 ? "low" : score <= 12 ? "medium" : "high" };
}

/** The Codex decision tree, in the order it is asked. */
export const decisionTreeQuestions = [
  { id: "q1", text: "Do control measures exist for this hazard at this step?" },
  {
    id: "q2",
    text: "Is the step specifically designed to eliminate the hazard or reduce it to an acceptable level?",
  },
  {
    id: "q3",
    text: "Could contamination with the hazard occur at, or increase to, an unacceptable level?",
  },
  { id: "q4", text: "Will a later step eliminate the hazard or reduce it to an acceptable level?" },
] as const;

export interface DecisionAnswers {
  q1: boolean | null;
  q2: boolean | null;
  q3: boolean | null;
  q4: boolean | null;
}

export const decisionOutcomes = ["ccp", "not_ccp", "no_control", "incomplete"] as const;
export type DecisionOutcome = (typeof decisionOutcomes)[number];
export const decisionOutcomeLabels: Record<DecisionOutcome, string> = {
  ccp: "CCP",
  not_ccp: "Not a CCP",
  no_control: "No control measure",
  incomplete: "Not decided",
};

/**
 * Where the answers lead. Q1 no: no control measure exists here, so the step, process or product
 * needs changing (or control isn't needed at this step); it is not a CCP as it stands. Q2 yes:
 * a CCP. Q2 no: Q3 no means no CCP is needed; Q3 yes: Q4 yes means a later step controls it (not a
 * CCP here), Q4 no means a CCP. Unanswered questions on the path leave it `incomplete`.
 */
export function decisionTreeOutcome(a: DecisionAnswers): DecisionOutcome {
  if (a.q1 === null) return "incomplete";
  if (!a.q1) return "no_control";
  if (a.q2 === null) return "incomplete";
  if (a.q2) return "ccp";
  if (a.q3 === null) return "incomplete";
  if (!a.q3) return "not_ccp";
  if (a.q4 === null) return "incomplete";
  return a.q4 ? "not_ccp" : "ccp";
}

/** The first answer given that the path doesn't reach (e.g. Q3 after Q2 yes), or `null`. */
export function decisionPathError(a: DecisionAnswers): keyof DecisionAnswers | null {
  if (a.q1 !== true && a.q2 !== null) return "q2";
  if (a.q2 !== false && a.q3 !== null) return "q3";
  if (a.q3 !== true && a.q4 !== null) return "q4";
  return null;
}

/** A step and its hazards, as far as the checks below need them. */
export interface AnalysisStep {
  id: string;
  name: string;
  hazards: readonly (DecisionAnswers & {
    hazardType: HaccpHazardType;
    description: string;
    likelihood: number;
    severity: number;
    controlMeasure: string | null;
  })[];
}

export interface AnalysisNote {
  stepId: string;
  stepName: string;
  /** `warning`: the plan can still be approved, but a reviewer should look. */
  text: string;
}

/**
 * Consistency between the analysis and the CCP list, for the reviewer (never blocks approval): a
 * hazard the decision tree makes a CCP at a step with no CCP defined, a CCP on a step where no
 * hazard is judged a CCP, a hazard of high risk still undecided or with no control measure.
 */
export function analysisNotes(
  steps: readonly AnalysisStep[],
  ccps: readonly { code: string; stepId: string | null }[],
): AnalysisNote[] {
  const notes: AnalysisNote[] = [];
  for (const step of steps) {
    const here = ccps.filter((c) => c.stepId === step.id);
    const outcomes = step.hazards.map((h) => ({ h, outcome: decisionTreeOutcome(h) }));
    const flagged = outcomes.filter((o) => o.outcome === "ccp");
    if (flagged.length > 0 && here.length === 0) {
      notes.push({
        stepId: step.id,
        stepName: step.name,
        text: `${step.name}: the decision tree makes ${flagged.map((o) => `"${o.h.description}"`).join(", ")} a CCP, but no CCP is defined at this step`,
      });
    }
    for (const ccp of here) {
      if (flagged.length === 0) {
        notes.push({
          stepId: step.id,
          stepName: step.name,
          text: `${ccp.code} is at ${step.name}, but no hazard there is judged a CCP by the decision tree`,
        });
      }
    }
    for (const { h, outcome } of outcomes) {
      if (hazardRisk(h.likelihood, h.severity).level !== "high") continue;
      if (outcome === "incomplete") {
        notes.push({
          stepId: step.id,
          stepName: step.name,
          text: `${step.name}: "${h.description}" is a high risk and the decision tree is not finished`,
        });
      } else if (outcome === "no_control" || (!h.controlMeasure && outcome !== "ccp")) {
        notes.push({
          stepId: step.id,
          stepName: step.name,
          text: `${step.name}: "${h.description}" is a high risk with no control measure`,
        });
      }
    }
  }
  return notes;
}

/** One box of the process flow diagram. */
export interface FlowNode {
  id: string;
  /** 1, 2, 3 in the order of the process. */
  number: number;
  name: string;
  description: string | null;
  /** The codes of the CCPs at this step. */
  ccpCodes: string[];
  hazardCount: number;
  /** A hazard here is judged a CCP by the decision tree, or a CCP is defined here. */
  isCcp: boolean;
}

/** The process flow: the steps in order, with their CCPs. The web renders it. */
export function processFlow(
  steps: readonly (AnalysisStep & { description?: string | null })[],
  ccps: readonly { code: string; stepId: string | null }[],
): FlowNode[] {
  return steps.map((step, i) => {
    const ccpCodes = ccps.filter((c) => c.stepId === step.id).map((c) => c.code);
    return {
      id: step.id,
      number: i + 1,
      name: step.name,
      description: step.description ?? null,
      ccpCodes,
      hazardCount: step.hazards.length,
      isCcp: ccpCodes.length > 0 || step.hazards.some((h) => decisionTreeOutcome(h) === "ccp"),
    };
  });
}

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
/** Refused rather than rounded: a value the database can't hold exactly is a mistake. */
const fourDecimals = (value: number) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6;
const measurement = z
  .number()
  .finite()
  .min(-1_000_000_000)
  .max(1_000_000_000)
  .refine(fourDecimals, "At most 4 decimal places");
const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const booleanQuery = z.enum(["true", "false"]).transform((v) => v === "true");

export const checkFrequencySchema = z.object({
  every: z.number().int().min(1).max(1000),
  unit: z.enum(checkFrequencyUnits),
});
export const scheduleFrequencySchema = z.object({
  every: z.number().int().min(1).max(1000),
  unit: z.enum(scheduleFrequencyUnits),
});

/** One critical control point of a plan version (Codex principles 2 to 7). */
export const ccpInputSchema = z
  .object({
    /** Short reference, unique within the version, e.g. `CCP1`. Logs follow it across versions. */
    code: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .regex(/^[\w.\- ]+$/, "Letters, digits, spaces, dots and dashes only"),
    processStep: requiredText(200),
    /** The process step of the hazard analysis this CCP sits at (its `ref`). */
    stepRef: z.string().trim().min(1).max(40).nullable().optional(),
    hazardType: z.enum(haccpHazardTypes),
    /** The hazard controlled here, e.g. "Survival of Listeria monocytogenes". */
    hazard: requiredText(1000),
    limitType: z.enum(ccpLimitTypes),
    limitMin: measurement.nullable().optional(),
    limitMax: measurement.nullable().optional(),
    /** e.g. `°C`, `pH`, `minutes`; none for a dimensionless value. */
    limitUnit: optionalText(20).optional(),
    /** For `pass_fail`: what a pass is, e.g. "No metal detected; test pieces rejected". */
    passCriterion: optionalText(500).optional(),
    monitoringMethod: requiredText(1000),
    frequency: checkFrequencySchema,
    /** Only checked while something the plan covers is in production (e.g. every 2 hours on the line). */
    duringProduction: z.boolean().default(false),
    /** Who monitors, as a role ("Line leader"): people change, roles stay in the plan. */
    responsibleRole: requiredText(200),
    /** What to do when the limit is breached: shown when a deviation is recorded. */
    correctiveAction: requiredText(2000),
    verification: requiredText(2000),
  })
  .superRefine((ccp, ctx) => {
    const min = ccp.limitMin ?? null;
    const max = ccp.limitMax ?? null;
    if (ccp.limitType === "range") {
      if (min === null && max === null)
        ctx.addIssue({ code: "custom", path: ["limitMin"], message: "Give a minimum, a maximum or both" });
      if (min !== null && max !== null && min > max)
        ctx.addIssue({ code: "custom", path: ["limitMax"], message: "The maximum is below the minimum" });
      if (ccp.passCriterion)
        ctx.addIssue({
          code: "custom",
          path: ["passCriterion"],
          message: "A measured range has no pass criterion",
        });
    } else {
      if (!ccp.passCriterion)
        ctx.addIssue({ code: "custom", path: ["passCriterion"], message: "Say what a pass is" });
      if (min !== null || max !== null)
        ctx.addIssue({
          code: "custom",
          path: ["limitMin"],
          message: "A pass/fail criterion has no minimum or maximum",
        });
    }
  });
export type CcpInput = z.infer<typeof ccpInputSchema>;

const decisionAnswer = z.boolean().nullable().default(null);
/** The fields of one hazard of the hazard analysis (shared by plan steps and the hazard library). */
const hazardFields = {
  hazardType: z.enum(haccpHazardTypes),
  description: requiredText(1000),
  likelihood: z.number().int().min(1).max(HAZARD_SCALE_MAX),
  severity: z.number().int().min(1).max(HAZARD_SCALE_MAX),
  controlMeasure: optionalText(2000).optional(),
  q1: decisionAnswer,
  q2: decisionAnswer,
  q3: decisionAnswer,
  q4: decisionAnswer,
  /** Why the decision tree was answered as it was. */
  justification: optionalText(1000).optional(),
};
function refineHazard(
  h: {
    q1: boolean | null;
    q2: boolean | null;
    q3: boolean | null;
    q4: boolean | null;
    controlMeasure?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  const bad = decisionPathError(h);
  if (bad) {
    ctx.addIssue({
      code: "custom",
      path: [bad],
      message: `${bad.toUpperCase()} doesn't apply: an earlier answer ends the decision tree`,
    });
  }
  if (h.q1 === true && !h.controlMeasure) {
    ctx.addIssue({ code: "custom", path: ["controlMeasure"], message: "Name the control measure" });
  }
}
/** One hazard at a process step, with its control measure and the decision tree answers. */
export const hazardInputSchema = z.object(hazardFields).superRefine(refineHazard);
export type HazardInput = z.infer<typeof hazardInputSchema>;

/** A process step of the hazard analysis. `ref` is the key CCPs point at (`stepRef`). */
export const processStepInputSchema = z.object({
  ref: z.string().trim().min(1).max(40),
  name: requiredText(200),
  description: optionalText(1000).optional(),
  hazards: z.array(hazardInputSchema).max(30).default([]),
});
export type ProcessStepInput = z.infer<typeof processStepInputSchema>;

/**
 * The full content of a draft plan version. Saving replaces the draft's scope, notes and whole CCP
 * list (in the order given). A draft may have no CCPs yet; approval needs at least one.
 */
/** The hazard analysis and CCPs of a draft: shared by drafts and plan templates. */
const stepsList = z
  .array(processStepInputSchema)
  .max(100)
  .refine((list) => new Set(list.map((s) => s.ref)).size === list.length, "Two steps have the same ref");
const stepsField = stepsList.default([]);
const ccpsField = z
  .array(ccpInputSchema)
  .max(50)
  .refine(
    (list) => new Set(list.map((c) => c.code.toLowerCase())).size === list.length,
    "Two CCPs have the same code",
  );
function refineStepRefs(
  draft: { steps: { ref: string }[]; ccps: { stepRef?: string | null | undefined }[] },
  ctx: z.RefinementCtx,
) {
  const refs = new Set(draft.steps.map((s) => s.ref));
  draft.ccps.forEach((ccp, i) => {
    if (ccp.stepRef && !refs.has(ccp.stepRef)) {
      ctx.addIssue({
        code: "custom",
        path: ["ccps", i, "stepRef"],
        message: "This CCP points at a step that isn't in the analysis",
      });
    }
  });
}

export const haccpPlanDraftSchema = z
  .object({
    scope: z
      .object({
        itemIds: z.array(z.uuid()).max(200).default([]),
        recipeIds: z.array(z.uuid()).max(200).default([]),
      })
      .default({ itemIds: [], recipeIds: [] }),
    /** The process covered, prerequisites relied on, the HACCP team: free text. */
    scopeNote: optionalText(5000).optional(),
    /** What changed since the previous version. */
    changeNote: optionalText(2000).optional(),
    /** The hazard analysis: the process steps in order, with their hazards. */
    steps: stepsField,
    ccps: ccpsField,
  })
  .superRefine(refineStepRefs);
export type HaccpPlanDraftInput = z.infer<typeof haccpPlanDraftSchema>;

const planFields = {
  /** Document reference, e.g. `HACCP-01`. Unique among live plans, case-insensitively. */
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  reviewIntervalMonths: z.number().int().min(1).max(60),
  /** How often the hazard analysis is reviewed; `null`: as often as the plan itself. */
  hazardReviewIntervalMonths: z.number().int().min(1).max(60).nullable(),
};

export const haccpPlanCreateSchema = z
  .object({
    /** Client-generated id, like tasks. */
    id: z.uuid().optional(),
    code: planFields.code,
    name: planFields.name,
    description: planFields.description.optional(),
    reviewIntervalMonths: planFields.reviewIntervalMonths.optional(),
    hazardReviewIntervalMonths: planFields.hazardReviewIntervalMonths.optional(),
    /** Content of version 1, saved as a draft. */
    draft: haccpPlanDraftSchema.optional(),
    /**
     * Start from a plan template (`haccp_plan_templates`): its hazard analysis and CCPs become the
     * draft, copied by value. Not together with `draft`.
     */
    templateId: z.uuid().optional(),
  })
  .refine((v) => !(v.draft && v.templateId), {
    path: ["templateId"],
    message: "Give a draft or a template to start from, not both",
  });
export type HaccpPlanCreateInput = z.infer<typeof haccpPlanCreateSchema>;

/**
 * The plan's header (`write`, tokens allowed). Its status is not here: archiving or restoring a
 * plan takes it out of or back into force, a sign-off (`haccpPlanStatusSchema`). Strict, so a
 * `status` sent here is refused rather than silently dropped.
 */
export const haccpPlanUpdateSchema = z
  .object(planFields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type HaccpPlanUpdateInput = z.infer<typeof haccpPlanUpdateSchema>;

/** Archive or restore a plan: `manage` and a signed-in person, like approval. */
export const haccpPlanStatusSchema = z.object({ status: z.enum(haccpPlanStatuses) });
export type HaccpPlanStatusInput = z.infer<typeof haccpPlanStatusSchema>;

/** The sign-off on a draft: a person with `manage`. */
export const haccpPlanApproveSchema = z.object({
  /** Default: today. May be in the future. */
  effectiveOn: isoDate.optional(),
  /** Default: `effectiveOn` plus the plan's review interval. */
  reviewDueOn: isoDate.optional(),
  /**
   * When the hazard analysis is next reviewed. Approving a version that has a hazard analysis counts
   * as a review of it. Default: `effectiveOn` plus the plan's hazard review interval.
   */
  hazardReviewDueOn: isoDate.optional(),
  note: optionalText(2000).optional(),
});
export type HaccpPlanApproveInput = z.infer<typeof haccpPlanApproveSchema>;

/** Records that the hazard analysis was reviewed (a sign-off: `manage` and a signed-in person). */
export const haccpHazardReviewSchema = z.object({
  /** When it is next due. Default: today plus the plan's hazard review interval. */
  nextDueOn: isoDate.optional(),
  note: optionalText(2000).optional(),
});
export type HaccpHazardReviewInput = z.infer<typeof haccpHazardReviewSchema>;

/** How often the hazard analysis is reviewed: its own interval, else the plan's. */
export const hazardReviewIntervalOf = (plan: {
  reviewIntervalMonths: number;
  hazardReviewIntervalMonths: number | null;
}): number => plan.hazardReviewIntervalMonths ?? plan.reviewIntervalMonths;

/** The default date the hazard analysis is next reviewed, from the day it was last reviewed. */
export const defaultHazardReviewDueOn = (
  from: string,
  plan: { reviewIntervalMonths: number; hazardReviewIntervalMonths: number | null },
): string => addMonthsToIsoDate(from, hazardReviewIntervalOf(plan));

/** The hazard review is flagged as coming up this many days ahead (the same window as a plan's review). */
export const HAZARD_REVIEW_SOON_DAYS = 30;

/**
 * Where the hazard analysis stands against its own review date: `overdue` once passed, `due`
 * today, `soon` within {@link HAZARD_REVIEW_SOON_DAYS}, otherwise `ok`. `null` with no date.
 */
export const hazardReviewState = (
  dueOn: string | null | undefined,
  today: string,
): Exclude<DueState, "idle"> | null => (dueOn ? dateDueState(dueOn, today, HAZARD_REVIEW_SOON_DAYS) : null);

// ─── The hazard library and plan templates ───────────────────────────────────

/**
 * A reusable hazard of the workspace's hazard library. A plan's hazard analysis copies it into a
 * step (by value), so the library can be edited or pruned without touching an approved plan.
 * Saving replaces the entry (`PUT`).
 */
export const hazardLibraryEntrySchema = z
  .object({
    title: requiredText(200),
    /** A process step it usually belongs to ("Cooking"): a search aid. */
    stepName: optionalText(200).optional(),
    ...hazardFields,
  })
  .superRefine(refineHazard);
export type HazardLibraryEntryInput = z.infer<typeof hazardLibraryEntrySchema>;

export const hazardLibraryListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  hazardType: z.enum(haccpHazardTypes).optional(),
  ...paging,
});
export type HazardLibraryListQuery = z.infer<typeof hazardLibraryListQuerySchema>;

/** What a hazard library entry becomes in a step of a plan: the entry's hazard fields. */
export const hazardFromLibraryEntry = (entry: {
  hazardType: HaccpHazardType;
  description: string;
  likelihood: number;
  severity: number;
  controlMeasure: string | null;
  justification: string | null;
  q1: boolean | null;
  q2: boolean | null;
  q3: boolean | null;
  q4: boolean | null;
}) => ({
  hazardType: entry.hazardType,
  description: entry.description,
  likelihood: entry.likelihood,
  severity: entry.severity,
  controlMeasure: entry.controlMeasure,
  justification: entry.justification,
  q1: entry.q1,
  q2: entry.q2,
  q3: entry.q3,
  q4: entry.q4,
});

const templateContent = {
  name: requiredText(200),
  description: optionalText(2000).optional(),
  steps: stepsField,
  // A template may be a skeleton: a hazard analysis with no CCPs yet.
  ccps: ccpsField.default([]),
};
/** A plan template: a hazard analysis and CCPs a new plan starts from. Saving replaces it (`PUT`). */
export const haccpPlanTemplateSchema = z.object(templateContent).superRefine(refineStepRefs);
export type HaccpPlanTemplateInput = z.infer<typeof haccpPlanTemplateSchema>;

/**
 * Creates a template, either from content or, with `fromPlanId`, from a plan: its draft when it has
 * one, else the version in force (its steps and CCPs, not its scope).
 */
export const haccpPlanTemplateCreateSchema = z
  .object({
    name: templateContent.name,
    description: templateContent.description,
    steps: stepsList.optional(),
    ccps: ccpsField.optional(),
    fromPlanId: z.uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.fromPlanId && (v.steps || v.ccps)) {
      ctx.addIssue({
        code: "custom",
        path: ["fromPlanId"],
        message: "Copy a plan or give the steps and CCPs, not both",
      });
      return;
    }
    refineStepRefs({ steps: v.steps ?? [], ccps: v.ccps ?? [] }, ctx);
  });
export type HaccpPlanTemplateCreateInput = z.infer<typeof haccpPlanTemplateCreateSchema>;

export const haccpPlanTemplateListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  ...paging,
});
export type HaccpPlanTemplateListQuery = z.infer<typeof haccpPlanTemplateListQuerySchema>;

export const haccpPlanListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** Default: active plans only. */
  status: z.enum([...haccpPlanStatuses, "all"]).default("active"),
  ...paging,
});
export type HaccpPlanListQuery = z.infer<typeof haccpPlanListQuerySchema>;

/** Immediate action and analysis given with an out-of-limit reading (all optional). */
const correctiveActionFields = {
  /** What was done straight away (e.g. "Product held; re-cooked to 75 °C"). */
  actionTaken: optionalText(4000),
  rootCause: optionalText(4000),
  preventiveAction: optionalText(4000),
};

const readingFields = {
  /** For a measured range. */
  value: measurement.optional(),
  /** For a pass/fail criterion. */
  passed: z.boolean().optional(),
};
const oneReading = (v: { value?: number | undefined; passed?: boolean | undefined }) =>
  (v.value === undefined) !== (v.passed === undefined);
const oneReadingMessage = { message: "Give either a value or passed, not both", path: ["value"] };

/**
 * A CCP check. The CCP must belong to its plan's current approved version. An out-of-limit reading
 * opens a corrective action in the same write; `correctiveAction` fills in what was done.
 */
export const ccpLogCreateSchema = z
  .object({
    id: z.uuid().optional(),
    ccpId: z.uuid(),
    ...readingFields,
    /** The production batch checked, if any. It must be in progress or completed. */
    batchId: z.uuid().nullable().optional(),
    /** When the check was made. Default: now. Not in the future. */
    checkedAt: isoDateTime.optional(),
    note: optionalText(1000).optional(),
    correctiveAction: z.object(correctiveActionFields).partial().optional(),
  })
  .refine(oneReading, oneReadingMessage);
export type CcpLogCreateInput = z.infer<typeof ccpLogCreateSchema>;

/** A correction: a new log with the right reading that points at the wrong one (with a reason). */
export const ccpLogCorrectSchema = z
  .object({ ...readingFields, reason: requiredText(500), note: optionalText(1000).optional() })
  .refine(oneReading, oneReadingMessage);
export type CcpLogCorrectInput = z.infer<typeof ccpLogCorrectSchema>;

export const ccpLogListQuerySchema = z
  .object({
    planId: z.uuid().optional(),
    /** Follows a CCP across plan versions. Needs `planId`. */
    ccpCode: z.string().trim().max(20).optional(),
    batchId: z.uuid().optional(),
    /** Inclusive dates (`YYYY-MM-DD`) of the check. */
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Only readings outside (`true`) or within (`false`) their limits. */
    outOfLimits: booleanQuery.optional(),
    source: z.enum(haccpSources).optional(),
    /** Only readings awaiting review, approved or rejected. */
    review: z.enum(ccpLogReviewStatuses).optional(),
    /** Include readings that a later correction replaced (default: shown, marked). */
    includeCorrected: booleanQuery.default(true),
    ...paging,
  })
  .refine((v) => !v.ccpCode || !!v.planId, { path: ["ccpCode"], message: "ccpCode needs planId" })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type CcpLogListQuery = z.infer<typeof ccpLogListQuerySchema>;

const reviewFields = {
  decision: z.enum(ccpLogReviewDecisions),
  /** Why: required to reject (what was wrong with the reading). */
  note: optionalText(1000).optional(),
};
const noteToReject = (v: { decision: CcpLogReviewDecision; note?: string | null | undefined }) =>
  v.decision === "approve" || !!v.note;
const noteToRejectMessage = { path: ["note"], message: "Say why the reading is rejected" };

/** A person with `manage` approves or rejects a pending reading, once. */
export const ccpLogReviewSchema = z.object(reviewFields).refine(noteToReject, noteToRejectMessage);
export type CcpLogReviewInput = z.infer<typeof ccpLogReviewSchema>;

/** The same decision for several pending readings: all of them, or none. */
export const ccpLogBulkReviewSchema = z
  .object({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, "The same reading is listed twice"),
    ...reviewFields,
  })
  .refine(noteToReject, noteToRejectMessage);
export type CcpLogBulkReviewInput = z.infer<typeof ccpLogBulkReviewSchema>;

export const deviationListQuerySchema = z.object({
  /** `open`: a corrective action is still open. Default: open. */
  status: z.enum(["open", "closed", "all"]).default("open"),
  batchId: z.uuid().optional(),
  planId: z.uuid().optional(),
  ...paging,
});
export type DeviationListQuery = z.infer<typeof deviationListQuerySchema>;

/**
 * A corrective action. Out-of-limit readings and failed calibrations open one automatically; this
 * is for anything else, or for an agent proposing one. Links are optional: the deviation (a log),
 * a failed calibration, a batch, a stock lot (quarantining a lot is a stock action; link the lot).
 */
export const correctiveActionCreateSchema = z.object({
  id: z.uuid().optional(),
  title: requiredText(200),
  logId: z.uuid().nullable().optional(),
  calibrationId: z.uuid().nullable().optional(),
  batchId: z.uuid().nullable().optional(),
  lotId: z.uuid().nullable().optional(),
  actionTaken: correctiveActionFields.actionTaken.optional(),
  rootCause: correctiveActionFields.rootCause.optional(),
  preventiveAction: correctiveActionFields.preventiveAction.optional(),
});
export type CorrectiveActionCreateInput = z.infer<typeof correctiveActionCreateSchema>;

/** Changes an open corrective action. Closed ones never change. */
export const correctiveActionUpdateSchema = z
  .object({
    title: requiredText(200),
    batchId: z.uuid().nullable(),
    lotId: z.uuid().nullable(),
    ...correctiveActionFields,
  })
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Nothing to update");
export type CorrectiveActionUpdateInput = z.infer<typeof correctiveActionUpdateSchema>;

/** The sign-off: a person with `manage` closes it once action, root cause and prevention are recorded. */
export const correctiveActionCloseSchema = z.object({ note: optionalText(2000).optional() });
export type CorrectiveActionCloseInput = z.infer<typeof correctiveActionCloseSchema>;

export const correctiveActionListQuerySchema = z.object({
  status: z.enum([...correctiveActionStatuses, "all"]).default("all"),
  batchId: z.uuid().optional(),
  logId: z.uuid().optional(),
  ...paging,
});
export type CorrectiveActionListQuery = z.infer<typeof correctiveActionListQuerySchema>;

/**
 * An asset's place in the cleaning and calibration schedule. The asset itself (kind, code, name,
 * location, status) is kept in the asset register (`assets` module); this is HACCP's part of it.
 * `null` takes the asset out of that schedule. Only equipment is calibrated (checked against the
 * asset's kind by the server).
 */
export const haccpAssetScheduleSchema = z
  .object({
    cleaningFrequency: scheduleFrequencySchema.nullable(),
    calibrationFrequency: scheduleFrequencySchema.nullable(),
    /** How far a calibration reading may be from the reference and still pass (e.g. 0.5). */
    calibrationTolerance: measurement.min(0).nullable(),
    /** The unit calibration readings are in, e.g. `°C`, `g`. */
    measurementUnit: optionalText(20),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Nothing to update");
export type HaccpAssetScheduleInput = z.infer<typeof haccpAssetScheduleSchema>;

export const haccpAssetListQuerySchema = z.object({
  kind: z.enum(haccpAssetKinds).optional(),
  status: z.enum([...haccpAssetStatuses, "all"]).default("active"),
});
export type HaccpAssetListQuery = z.infer<typeof haccpAssetListQuerySchema>;

/** A cleaning done. `doneBy` defaults to the person recording it. */
export const cleaningRecordCreateSchema = z.object({
  id: z.uuid().optional(),
  assetId: z.uuid(),
  /** Default: now. Not in the future. */
  cleanedAt: isoDateTime.optional(),
  /** A member of the workspace. */
  doneBy: z.uuid().optional(),
  note: optionalText(1000).optional(),
});
export type CleaningRecordCreateInput = z.infer<typeof cleaningRecordCreateSchema>;

/** Verification of a cleaning by a second person (not whoever did it). */
export const cleaningVerifySchema = z.object({ note: optionalText(1000).optional() });
export type CleaningVerifyInput = z.infer<typeof cleaningVerifySchema>;

/**
 * A calibration check: the instrument's reading against a reference. Passes when within the
 * equipment's tolerance; without a tolerance, `passed` says. The next due date defaults to the
 * check plus the equipment's calibration frequency. A failure opens a corrective action.
 */
export const calibrationRecordCreateSchema = z.object({
  id: z.uuid().optional(),
  assetId: z.uuid(),
  calibratedAt: isoDateTime.optional(),
  referenceReading: measurement,
  actualReading: measurement,
  /** Only when the equipment has no tolerance. */
  passed: z.boolean().optional(),
  /** e.g. "Ice water and boiling water", "Certified reference thermometer". */
  method: optionalText(500).optional(),
  nextDueOn: isoDate.optional(),
  note: optionalText(1000).optional(),
});
export type CalibrationRecordCreateInput = z.infer<typeof calibrationRecordCreateSchema>;

export const haccpRecordListQuerySchema = z
  .object({
    assetId: z.uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...paging,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type HaccpRecordListQuery = z.infer<typeof haccpRecordListQuerySchema>;

export const haccpDueQuerySchema = z.object({
  /** `due` (default): overdue and due. `all`: every scheduled check, with its state. */
  include: z.enum(["due", "all"]).default("due"),
  kind: z.enum(["ccp", "cleaning", "calibration"]).optional(),
});
export type HaccpDueQuery = z.infer<typeof haccpDueQuerySchema>;

// ─── Corrections of cleaning and calibration records ─────────────────────────

/**
 * A correction of a cleaning record: a new record that points at the one it corrects and says why.
 * What isn't given is copied from the original. The original stays, struck through on prints; the
 * correction is not verified yet, whatever the original was.
 */
export const cleaningCorrectSchema = z.object({
  reason: requiredText(500),
  assetId: z.uuid().optional(),
  cleanedAt: isoDateTime.optional(),
  doneBy: z.uuid().optional(),
  note: optionalText(1000).optional(),
});
export type CleaningCorrectInput = z.infer<typeof cleaningCorrectSchema>;

/**
 * A correction of a calibration record: the right readings, judged against the tolerance the
 * original was judged against. What isn't given is copied from the original.
 */
export const calibrationCorrectSchema = z.object({
  reason: requiredText(500),
  calibratedAt: isoDateTime.optional(),
  referenceReading: measurement.optional(),
  actualReading: measurement.optional(),
  /** Only when the original had no tolerance. */
  passed: z.boolean().optional(),
  method: optionalText(500).optional(),
  nextDueOn: isoDate.optional(),
  note: optionalText(1000).optional(),
});
export type CalibrationCorrectInput = z.infer<typeof calibrationCorrectSchema>;

// ─── The supervisor's sign-off of a day ──────────────────────────────────────

/**
 * A supervisor signs off a plan's monitoring records for a day (a calendar day in the workspace's
 * time zone): they looked at every check of that plan that day, the deviations and what was done.
 * One per plan per day, append-only. It stores how many checks and deviations it covered, so a
 * reading entered for that day afterwards shows on the audit print as added after sign-off.
 */
export const haccpDaySignoffSchema = z.object({
  planId: z.uuid(),
  /** Not in the future. */
  day: isoDate,
  note: optionalText(1000).optional(),
});
export type HaccpDaySignoffInput = z.infer<typeof haccpDaySignoffSchema>;

/**
 * One sign-off for a day over several plans (`planIds`) or the whole site (`wholeSite`: every active
 * plan with a version in force that day). All or nothing: if any plan can't be signed off, none is.
 */
export const haccpBulkSignoffSchema = z
  .object({
    planIds: z.array(z.uuid()).min(1).max(100).optional(),
    wholeSite: z.boolean().optional(),
    /** Not in the future. */
    day: isoDate,
    note: optionalText(1000).optional(),
  })
  .refine((v) => (v.planIds !== undefined) !== (v.wholeSite === true), {
    path: ["planIds"],
    message: "Give planIds or wholeSite: true, not both",
  });
export type HaccpBulkSignoffInput = z.infer<typeof haccpBulkSignoffSchema>;

export const haccpSignoffListQuerySchema = z
  .object({
    planId: z.uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    ...paging,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "`to` is before `from`" });
export type HaccpSignoffListQuery = z.infer<typeof haccpSignoffListQuerySchema>;

// ─── CCP checks overdue: the manager's digest ────────────────────────────────

/**
 * CCP checks come round too often to notify one by one, so managers get one digest a day of the
 * checks that are overdue by more than one interval: a check every 2 hours that is more than 2
 * hours past due, a daily check more than a day past due, and so on. A check just missed shows on
 * the check sheet and "what's due"; the digest is for ones that have been left.
 */
export function overdueByMoreThanInterval(input: {
  frequency: { every: number; unit: ScheduleFrequencyUnit };
  state: DueState;
  dueOn: string | null;
  dueAt: string | null;
  now: Date;
  timeZone: string;
}): boolean {
  if (input.state !== "overdue") return false;
  if (input.frequency.unit === "hour") {
    if (!input.dueAt) return false;
    return Date.parse(input.dueAt) + input.frequency.every * 3_600_000 < input.now.getTime();
  }
  if (!input.dueOn) return false;
  return addFrequencyToDate(input.dueOn, input.frequency) < dateInZone(input.now, input.timeZone);
}
