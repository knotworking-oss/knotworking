import { z } from "zod";
import {
  checkDueState,
  dateDueState,
  evaluateReading,
  addFrequencyToDate,
  scheduleFrequencySchema,
  ccpLogReviewDecisions,
  ccpLogReviewStatuses,
  type CcpLogReviewDecision,
  type DeviationReason,
  type DueResult,
  type DueState,
  type ScheduleFrequencyUnit,
} from "./haccp";
import { allergens, roundQuantity, sortAllergens, type AllergenCode } from "./items";
import type { AllergenRollup } from "./recipes";

/**
 * Site programmes module (`site`): the prerequisite programmes BRCGS treats apart from the HACCP
 * plan: pest control, the glass and brittle plastics register, planned maintenance, storage
 * temperature logging, and pre-start and allergen changeover checks.
 *
 * Shared vocabulary, validation schemas and the pure rules: when each programme's next item is due
 * (reusing HACCP's `checkDueState` and `dateDueState`), whether a storage reading is within its
 * limits (HACCP's `evaluateReading`), the outcome of a checklist. No DOM or Node APIs.
 *
 * Records are append-only: a correction is a new row that points at the one it corrects. Sign-offs
 * (reviewing a storage reading an API token recorded, signing off a check before production starts,
 * releasing an area after a breakage, clearing an area after maintenance, closing a corrective
 * action) are a person's acts with `manage`; agents may enter data and draft.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** Where a record came from: a person in the app (`manual`) or an API token (`api`). */
export type SiteSource = "manual" | "api";

/** How often an item is checked or serviced: every N hours, days, weeks or months. */
export type SiteFrequency = { every: number; unit: ScheduleFrequencyUnit };

/** Pest control: the contractor's devices (bait points, traps, fly killers). */
export const pestDeviceKinds = [
  "rodent_bait_station",
  "rodent_trap",
  "insect_electric_fly_killer",
  "pheromone_trap",
  "other",
] as const;
export type PestDeviceKind = (typeof pestDeviceKinds)[number];
export const pestDeviceKindLabels: Record<PestDeviceKind, string> = {
  rodent_bait_station: "Rodent bait station",
  rodent_trap: "Rodent trap",
  insect_electric_fly_killer: "Insect electric fly killer",
  pheromone_trap: "Pheromone trap",
  other: "Other device",
};

export const siteStatuses = ["active", "archived"] as const;
export type SiteStatus = (typeof siteStatuses)[number];

/** Activity found at a device or location on a visit, lowest first. */
export const pestActivityLevels = ["none", "low", "moderate", "high"] as const;
export type PestActivity = (typeof pestActivityLevels)[number];
export const pestActivityLabels: Record<PestActivity, string> = {
  none: "No activity",
  low: "Low activity",
  moderate: "Moderate activity",
  high: "High activity",
};
const activityRank: Record<PestActivity, number> = { none: 0, low: 1, moderate: 2, high: 3 };

/** Moderate and high activity call for an action (and are what the due view warns about). */
export const activityNeedsAction = (activity: PestActivity) => activityRank[activity] >= 2;

/** The most serious activity among findings (`none` when there are none). */
export function highestActivity(findings: readonly { activity: PestActivity }[]): PestActivity {
  let best: PestActivity = "none";
  for (const f of findings) if (activityRank[f.activity] > activityRank[best]) best = f.activity;
  return best;
}

/** Glass, hard (brittle) plastic and similar items in the register. */
export const glassItemKinds = ["glass", "brittle_plastic", "ceramic", "other"] as const;
export type GlassItemKind = (typeof glassItemKinds)[number];
export const glassItemKindLabels: Record<GlassItemKind, string> = {
  glass: "Glass",
  brittle_plastic: "Brittle plastic",
  ceramic: "Ceramic",
  other: "Other brittle item",
};
/** An item stays in the register (`active`), or was replaced or taken out (`removed`, never deleted). */
export const glassItemStatuses = ["active", "removed"] as const;
export type GlassItemStatus = (typeof glassItemStatuses)[number];

export const glassConditions = ["intact", "damaged", "missing"] as const;
export type GlassCondition = (typeof glassConditions)[number];
export const glassConditionLabels: Record<GlassCondition, string> = {
  intact: "Intact",
  damaged: "Damaged",
  missing: "Missing",
};
/** Damaged or missing glass is a breakage risk (or a foreign body in the product). */
export const glassConditionNeedsAction = (condition: GlassCondition) => condition !== "intact";

/** A breakage stays `open` (the area is held) until a person with `manage` releases the area. */
export const breakageStatuses = ["open", "released"] as const;
export type BreakageStatus = (typeof breakageStatuses)[number];
export const breakageStatusLabels: Record<BreakageStatus, string> = {
  open: "Area held",
  released: "Released",
};

/** Storage units and what they hold. */
export const storageUnitKinds = ["chiller", "freezer", "ambient", "other"] as const;
export type StorageUnitKind = (typeof storageUnitKinds)[number];
export const storageUnitKindLabels: Record<StorageUnitKind, string> = {
  chiller: "Chiller",
  freezer: "Freezer",
  ambient: "Ambient store",
  other: "Other store",
};

/**
 * What a storage unit is monitored for. Temperature is the default; humidity (dry stores, proving
 * and maturing rooms), pressure (differential air pressure between zones) and other measures
 * (CO2, brine strength, water activity) are read the same way: a value against optional limits.
 * One unit measures one thing; a store with a temperature and a humidity limit is two units.
 */
export const storageMeasures = ["temperature", "humidity", "pressure", "other"] as const;
export type StorageMeasure = (typeof storageMeasures)[number];
export const storageMeasureLabels: Record<StorageMeasure, string> = {
  temperature: "Temperature",
  humidity: "Relative humidity",
  pressure: "Differential pressure",
  other: "Other measure",
};
/** The unit a measure starts with; `null` for `other`, where the unit has to be given. */
export const storageMeasureDefaultUnits: Record<StorageMeasure, string | null> = {
  temperature: "°C",
  humidity: "%RH",
  pressure: "Pa",
  other: null,
};
/** The unit of a storage unit given its measure: what was typed, else the measure's own. */
export const storageUnitOf = (measure: StorageMeasure, unit: string | null | undefined): string =>
  unit?.trim() || storageMeasureDefaultUnits[measure] || "";

/** Corrective actions on storage excursions (and anything else a person raises). */
export const siteActionStatuses = ["open", "closed"] as const;
export type SiteActionStatus = (typeof siteActionStatuses)[number];
export const siteActionStatusLabels: Record<SiteActionStatus, string> = { open: "Open", closed: "Closed" };

/** Checklists: before production starts (per line or area) and between products with different allergens. */
export const siteChecklistKinds = ["prestart", "allergen_changeover"] as const;
export const checklistKinds = ["general", ...siteChecklistKinds] as const;
export type ChecklistKind = (typeof checklistKinds)[number];
export const checklistKindLabels: Record<ChecklistKind, string> = {
  general: "General checklist",
  prestart: "Pre-start check",
  allergen_changeover: "Allergen changeover check",
};

export const checkItemResults = ["pass", "fail", "na"] as const;
export type CheckItemResult = (typeof checkItemResults)[number];
export const checkItemResultLabels: Record<CheckItemResult, string> = {
  pass: "Pass",
  fail: "Fail",
  na: "Not applicable",
};

/** A check passes when no item failed. */
export const checkOutcomes = ["passed", "failed"] as const;
export type CheckOutcome = (typeof checkOutcomes)[number];
export const checkOutcomeLabels: Record<CheckOutcome, string> = { passed: "Passed", failed: "Failed" };

/** Where a check stands before production starts. A person signs it off; a failed check can only be held. */
export const siteCheckSignOffStatuses = ["pending", "approved", "rejected"] as const;
export const checkSignOffStatuses = [...siteCheckSignOffStatuses, "not_required"] as const;
export type CheckSignOffStatus = (typeof checkSignOffStatuses)[number];
export const checkSignOffLabels: Record<CheckSignOffStatus, string> = {
  pending: "Awaiting sign-off",
  approved: "Signed off",
  rejected: "Held",
  not_required: "No sign-off required",
};

/**
 * Breakdown and work-order requests for maintained equipment. A `breakdown` is something that has
 * stopped working; a `request` is other work that is wanted (a repair, a modification, a task
 * outside the plan). Both go requested, in progress, then completed or cancelled.
 */
export const workOrderKinds = ["breakdown", "request"] as const;
export type WorkOrderKind = (typeof workOrderKinds)[number];
export const workOrderKindLabels: Record<WorkOrderKind, string> = {
  breakdown: "Breakdown",
  request: "Work request",
};
export const workOrderPriorities = ["low", "medium", "high", "urgent"] as const;
export type WorkOrderPriority = (typeof workOrderPriorities)[number];
export const workOrderPriorityLabels: Record<WorkOrderPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
export const workOrderStatuses = ["requested", "in_progress", "completed", "cancelled"] as const;
export type WorkOrderStatus = (typeof workOrderStatuses)[number];
export const workOrderStatusLabels: Record<WorkOrderStatus, string> = {
  requested: "Requested",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};
/** A work order is open until it is completed or cancelled; after that it never changes. */
export const workOrderIsOpen = (status: WorkOrderStatus) =>
  status === "requested" || status === "in_progress";

/** Which programme a due or overdue item belongs to. */
export const siteProgrammes = ["pest", "glass", "maintenance", "storage", "checklist"] as const;
export type SiteProgramme = (typeof siteProgrammes)[number];
export const siteProgrammeLabels: Record<SiteProgramme, string> = {
  pest: "Pest control",
  glass: "Glass and brittle plastics",
  maintenance: "Planned maintenance",
  storage: "Storage temperatures",
  checklist: "Pre-start and changeover checks",
};

/** Storage and calibration-style values are `numeric(14,4)`. */
export const SITE_VALUE_DECIMALS = 4;

// ─── Pure rules ──────────────────────────────────────────────────────────────

export interface StorageLimits {
  limitMin: number | null;
  limitMax: number | null;
}

/**
 * Whether a storage reading is within the unit's limits (inclusive), with the reason when not.
 * Reuses HACCP's `evaluateReading`, so a chiller at exactly its maximum is within limits.
 */
export function evaluateStorageReading(
  limits: StorageLimits,
  value: number,
): { withinLimits: true; reason: null } | { withinLimits: false; reason: DeviationReason } {
  const result = evaluateReading(
    {
      limitType: "range",
      limitMin: limits.limitMin,
      limitMax: limits.limitMax,
      limitUnit: null,
      passCriterion: null,
    },
    { value },
  );
  // A finite value always evaluates for a range limit.
  return result ?? { withinLimits: false, reason: "failed" };
}

/** "≤ 5 °C", "-25 – -18 °C": a unit's limits as text. */
export function describeStorageLimits(limits: StorageLimits, unit: string | null): string {
  const { limitMin: min, limitMax: max } = limits;
  const suffix = unit ? ` ${unit}` : "";
  if (min !== null && max !== null) return `${min} to ${max}${suffix}`;
  if (min !== null) return `≥ ${min}${suffix}`;
  if (max !== null) return `≤ ${max}${suffix}`;
  return "No limit set";
}

/** A reading as text: "4.5 °C". */
export const describeStorageReading = (value: number, unit: string | null) =>
  unit ? `${value} ${unit}` : String(value);

/** The outcome of a check from its item results: it fails if any item failed. */
export function checkOutcome(results: readonly { result: CheckItemResult }[]): CheckOutcome {
  return results.some((r) => r.result === "fail") ? "failed" : "passed";
}

/**
 * Whether a check counts as done for what's due: a pending one does (nothing is entered twice
 * while it waits for sign-off); one a person held doesn't, so the check is due again. A check
 * that failed doesn't either: it has to be done again.
 */
export const checkCountsAsDone = (check: { signOffStatus: CheckSignOffStatus; outcome: CheckOutcome }) =>
  check.signOffStatus !== "rejected" && check.outcome === "passed";

/** Whether a check waits for a person's sign-off: pending and not replaced by a correction. */
export const checkAwaitsSignOff = (check: {
  signOffStatus: CheckSignOffStatus;
  correctedByCheckId?: string | null | undefined;
}) => check.signOffStatus === "pending" && !check.correctedByCheckId;

/**
 * Four-eyes on a site sign-off that releases something (an area after a glass breakage, an area
 * after maintenance): the person who signs must not be one of the people who reported or recorded
 * it (`recordedBy`), unless they are the only member with `manage` on the module (the same
 * exemption as approving an SOP or a label, so a one-manager site isn't locked out).
 */
export function canSignOffSiteRecord(input: {
  recordedBy: readonly (string | null | undefined)[];
  deciderId: string;
  managerIds: readonly string[];
}): boolean {
  if (!input.recordedBy.includes(input.deciderId)) return true;
  return input.managerIds.every((id) => id === input.deciderId);
}

/**
 * What an allergen changeover check is for: the line was running one product and will run another,
 * so what the first contains can end up in the second. `review` when the batch before contains
 * allergens the batch after does not (the clean has to remove them), `none` when it doesn't, and
 * `unknown` when a batch isn't named or has no allergen data. It only ever warns: it never blocks
 * recording or signing off a check, because the clean-down is the control, not this comparison.
 */
export const changeoverRiskStatuses = ["none", "review", "unknown"] as const;
export type ChangeoverRiskStatus = (typeof changeoverRiskStatuses)[number];

export interface ChangeoverAllergenRisk {
  status: ChangeoverRiskStatus;
  /** Allergens of the batch before (and after), `null` when the batch isn't named or has none recorded. */
  previous: AllergenRollup | null;
  next: AllergenRollup | null;
  /** In the batch before and not contained by the batch after: what the clean has to remove. */
  carriedOver: AllergenCode[];
  /** Of those, the ones the batch after doesn't even declare as "may contain". */
  notDeclaredAfter: AllergenCode[];
  /** Plain-language warnings for the person recording or signing off. */
  warnings: string[];
}

const allergenNames = (codes: readonly AllergenCode[]) => codes.map((c) => allergens[c]).join(", ");

export function changeoverAllergenRisk(input: {
  previous: AllergenRollup | null;
  next: AllergenRollup | null;
  previousNamed: boolean;
  nextNamed: boolean;
}): ChangeoverAllergenRisk {
  const { previous, next } = input;
  const unknown = (warning: string): ChangeoverAllergenRisk => ({
    status: "unknown",
    previous,
    next,
    carriedOver: [],
    notDeclaredAfter: [],
    warnings: [warning],
  });
  if (!input.previousNamed || !input.nextNamed) {
    return unknown(
      "Name the batch before and the batch after to see which allergens the changeover has to deal with.",
    );
  }
  if (!previous || !next) {
    return unknown(
      "A batch has no approved allergen declaration recorded, so the allergen risk can't be worked out.",
    );
  }
  const afterContains = new Set(next.contains);
  const afterMentions = new Set([...next.contains, ...next.mayContain]);
  const carriedOver = sortAllergens(previous.contains.filter((a) => !afterContains.has(a)));
  const notDeclaredAfter = carriedOver.filter((a) => !afterMentions.has(a));
  const warnings: string[] = [];
  if (carriedOver.length > 0) {
    warnings.push(
      `The batch before contains ${allergenNames(carriedOver)}, which the batch after does not. The clean has to remove ${carriedOver.length === 1 ? "it" : "them"} before production starts.`,
    );
  }
  if (notDeclaredAfter.length > 0) {
    warnings.push(
      `The batch after doesn't declare ${allergenNames(notDeclaredAfter)}, even as "may contain", so any carry-over would be undeclared.`,
    );
  }
  return {
    status: carriedOver.length > 0 ? "review" : "none",
    previous,
    next,
    carriedOver,
    notDeclaredAfter,
    warnings,
  };
}

/** Where a visit's next-visit date stands against today. */
export const nextVisitState = (nextVisitOn: string, today: string) => dateDueState(nextVisitOn, today);

/** The next due date of a maintenance task: the last record's, else the start date, else due now (`null`). */
export function maintenanceDueOn(input: {
  lastNextDueOn: string | null;
  lastCompletedOn: string | null;
  frequency: SiteFrequency;
  startOn: string | null;
}): string | null {
  if (input.lastNextDueOn) return input.lastNextDueOn;
  if (input.lastCompletedOn) return addFrequencyToDate(input.lastCompletedOn, input.frequency);
  return input.startOn;
}

/** Where a maintenance task stands: never done and no start date is due now. */
export function maintenanceDueState(input: { dueOn: string | null; hasRecord: boolean; today: string }): {
  state: Exclude<DueState, "idle">;
  dueOn: string | null;
} {
  if (input.dueOn === null) return { state: "due", dueOn: null };
  return { state: dateDueState(input.dueOn, input.today), dueOn: input.dueOn };
}

/** The default date of the next maintenance after one completed on `completedOn`. */
export const defaultNextMaintenanceOn = (completedOn: string, frequency: SiteFrequency) =>
  addFrequencyToDate(completedOn, frequency);

/** Glass checks, storage readings and pre-start checks are due by `checkDueState` (clock for hourly, calendar otherwise). */
export function siteCheckDueState(input: {
  frequency: SiteFrequency;
  lastAt: Date | string | null;
  now?: Date;
  timeZone: string;
  duringProduction?: boolean;
  producing?: boolean;
}): DueResult {
  return checkDueState(input);
}

/** One thing that is due or overdue (or an item awaiting a person), from any programme. */
export interface SiteDueItem {
  programme: SiteProgramme;
  /** Machine id of what is due (device, glass item, maintenance task, storage unit, template, visit). */
  subjectId: string;
  title: string;
  /** Where: the area or location, if known. */
  where: string | null;
  state: DueState;
  dueOn: string | null;
  dueAt: string | null;
  /** When it was last done. */
  lastAt: string | null;
  /** e.g. "Daily", "Every 3 months". */
  note: string | null;
  /**
   * Why a schedule is missing, so the item needs attention rather than dropping off the list:
   * pest control with no next visit set, or no visit recorded although devices exist.
   */
  reason?: SiteDueReason | null;
  /** This checklist is scheduled only while production is running. */
  duringProduction?: true;
}

export const siteDueReasons = ["no_next_visit", "no_visit_recorded"] as const;
export type SiteDueReason = (typeof siteDueReasons)[number];
export const siteDueReasonLabels: Record<SiteDueReason, string> = {
  no_next_visit: "No next visit set",
  no_visit_recorded: "No visit recorded",
};

/** Orders due items: most urgent first, then by date, then by title. */
export function sortSiteDueItems<T extends Pick<SiteDueItem, "state" | "dueOn" | "title">>(items: T[]): T[] {
  const rank: Record<DueState, number> = { overdue: 0, due: 1, soon: 2, ok: 3, idle: 4 };
  return [...items].sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      (a.dueOn ?? "").localeCompare(b.dueOn ?? "") ||
      a.title.localeCompare(b.title),
  );
}

// Pest trends ------------------------------------------------------------------

/** What pest sightings are grouped by in a trend. */
export const pestTrendGroupings = ["device", "area", "pest"] as const;
export type PestTrendGrouping = (typeof pestTrendGroupings)[number];
export const pestTrendGroupingLabels: Record<PestTrendGrouping, string> = {
  device: "Device",
  area: "Area",
  pest: "Pest",
};

/** One finding of a visit that no correction replaced, as the trend reads it. */
export interface PestTrendFinding {
  visitedOn: string;
  deviceId: string | null;
  deviceCode: string | null;
  deviceLocation: string | null;
  /** Where a finding with no device was. */
  location: string | null;
  areaId: string | null;
  areaName: string | null;
  pest: string | null;
  activity: PestActivity;
  count: number | null;
}

export interface PestTrendPoint {
  /** The visit date. */
  on: string;
  /** Pests found: the counts, or one for each finding of activity with no count. */
  sightings: number;
  /** Findings of any activity on that date. */
  findings: number;
  highest: PestActivity;
}

export interface PestTrendSeries {
  key: string;
  label: string;
  /** Where the device is, or the area a device group is in. */
  detail: string | null;
  points: PestTrendPoint[];
  sightings: number;
  highest: PestActivity;
  /** The last visit against the one before; `null` with fewer than two visits. */
  direction: "up" | "down" | "flat" | null;
}

/** Pests found in one finding: its count, else one when there was activity, else none. */
export const findingSightings = (f: { activity: PestActivity; count: number | null }) =>
  f.activity === "none" ? 0 : (f.count ?? 1);

/**
 * Sightings over time per device, area or pest, oldest visit first, the busiest series first. A
 * device that was checked and clear gets a point of zero, so a quiet run reads as one. Findings of
 * a place with no device are grouped by the place's name; a device with no area (or a finding at no
 * device) falls under "No area" when grouped by area. Grouping by pest leaves out findings that name
 * no pest.
 */
export function pestTrendSeries(
  findings: readonly PestTrendFinding[],
  groupBy: PestTrendGrouping,
): PestTrendSeries[] {
  const groups = new Map<
    string,
    { label: string; detail: string | null; byDate: Map<string, PestTrendPoint> }
  >();
  for (const f of findings) {
    let key: string;
    let label: string;
    let detail: string | null = null;
    if (groupBy === "device") {
      key = f.deviceId ?? `place:${(f.location ?? "").toLowerCase()}`;
      label = f.deviceCode ?? f.location ?? "Site";
      detail = f.deviceId ? f.deviceLocation : "No device";
    } else if (groupBy === "area") {
      key = f.areaId ?? "none";
      label = f.areaName ?? "No area";
    } else {
      if (!f.pest) continue;
      key = f.pest.trim().toLowerCase();
      label = f.pest.trim();
    }
    const group = groups.get(key) ?? { label, detail, byDate: new Map() };
    groups.set(key, group);
    const point = group.byDate.get(f.visitedOn) ?? {
      on: f.visitedOn,
      sightings: 0,
      findings: 0,
      highest: "none" as PestActivity,
    };
    point.sightings += findingSightings(f);
    point.findings += 1;
    point.highest = highestActivity([{ activity: point.highest }, { activity: f.activity }]);
    group.byDate.set(f.visitedOn, point);
  }
  const series = [...groups].map(([key, g]): PestTrendSeries => {
    const points = [...g.byDate.values()].sort((a, b) => a.on.localeCompare(b.on));
    const last = points.at(-1);
    const before = points.at(-2);
    return {
      key,
      label: g.label,
      detail: g.detail,
      points,
      sightings: points.reduce((sum, p) => sum + p.sightings, 0),
      highest: highestActivity(points.map((p) => ({ activity: p.highest }))),
      direction:
        last && before
          ? last.sightings > before.sightings
            ? "up"
            : last.sightings < before.sightings
              ? "down"
              : "flat"
          : null,
    };
  });
  return series.sort((a, b) => b.sightings - a.sightings || a.label.localeCompare(b.label));
}

/** Rounds a storage value to the stored precision. */
export const roundStorageValue = (value: number) => roundQuantity(value, SITE_VALUE_DECIMALS);

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
const dateRange = <T extends { from?: string | undefined; to?: string | undefined }>(v: T) =>
  !v.from || !v.to || v.from <= v.to;
const dateRangeMessage = { path: ["to"], message: "`to` is before `from`" };
const nonEmptyPatch = (patch: object) => Object.values(patch).some((v) => v !== undefined);

/** Source-neutral base for lists of records. */
const recordRange = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

// Pest control ---------------------------------------------------------------

const deviceFields = {
  kind: z.enum(pestDeviceKinds),
  /** Contractor's reference, e.g. `RB-07`; unique among live devices. */
  code: requiredText(40),
  location: requiredText(200),
  /** The area (an asset of kind `area` of the asset register) the device is in. */
  areaId: z.uuid().nullable(),
};

export const pestDeviceCreateSchema = z.object({
  id: z.uuid().optional(),
  kind: deviceFields.kind,
  code: deviceFields.code,
  location: deviceFields.location,
  areaId: deviceFields.areaId.optional(),
});
export type PestDeviceCreateInput = z.infer<typeof pestDeviceCreateSchema>;

export const pestDeviceUpdateSchema = z
  .object({ ...deviceFields, status: z.enum(siteStatuses) })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update");
export type PestDeviceUpdateInput = z.infer<typeof pestDeviceUpdateSchema>;

export const pestDeviceListQuerySchema = z.object({
  status: z.enum([...siteStatuses, "all"]).default("active"),
});
export type PestDeviceListQuery = z.infer<typeof pestDeviceListQuerySchema>;

/** One finding of a visit: a device (or a place with no device) and the activity found there. */
export const pestFindingInputSchema = z
  .object({
    deviceId: z.uuid().nullable().optional(),
    /** For a finding with no device: where. */
    location: optionalText(200).optional(),
    activity: z.enum(pestActivityLevels),
    /** What was found, e.g. "mice", "flies". */
    pest: optionalText(100).optional(),
    count: z.number().int().min(0).max(100_000).nullable().optional(),
    note: optionalText(1000).optional(),
    /** What was done about it, e.g. "Rebaited; entry point proofed". */
    action: optionalText(1000).optional(),
  })
  .refine((f) => !!f.deviceId || !!f.location, {
    path: ["location"],
    message: "Give a device, or say where the finding was",
  })
  .refine((f) => f.activity === "none" || !!f.pest, { path: ["pest"], message: "Say what was found" });
export type PestFindingInput = z.infer<typeof pestFindingInputSchema>;

const visitFields = {
  /** The pest control contractor. */
  contractor: requiredText(200),
  technician: optionalText(200),
  /** Not in the future. */
  visitedOn: isoDate,
  summary: optionalText(4000),
  /** The contractor's recommendations (proofing, housekeeping, structural). */
  recommendations: optionalText(4000),
  /** What was done on the visit or since. */
  actionsTaken: optionalText(4000),
  /** The date of the next visit; not before the visit. */
  nextVisitOn: isoDate.nullable(),
  findings: z.array(pestFindingInputSchema).max(300),
};
const nextVisitAfterVisit = (v: { visitedOn: string; nextVisitOn?: string | null | undefined }) =>
  !v.nextVisitOn || v.nextVisitOn >= v.visitedOn;
const nextVisitMessage = { path: ["nextVisitOn"], message: "The next visit is before this one" };
const distinctDevices = (v: { findings: readonly { deviceId?: string | null | undefined }[] }) => {
  const ids = v.findings.map((f) => f.deviceId).filter((d): d is string => !!d);
  return new Set(ids).size === ids.length;
};
const distinctDevicesMessage = { path: ["findings"], message: "A device appears twice in the findings" };

/**
 * A contractor's visit with its findings. Recording one is data entry (API tokens allowed, so an
 * agent can enter a service report); correcting one is a person's act.
 */
export const pestVisitCreateSchema = z
  .object({
    id: z.uuid().optional(),
    contractor: visitFields.contractor,
    technician: visitFields.technician.optional(),
    visitedOn: visitFields.visitedOn,
    summary: visitFields.summary.optional(),
    recommendations: visitFields.recommendations.optional(),
    actionsTaken: visitFields.actionsTaken.optional(),
    nextVisitOn: visitFields.nextVisitOn.optional(),
    findings: visitFields.findings.default([]),
  })
  .refine(nextVisitAfterVisit, nextVisitMessage)
  .refine(distinctDevices, distinctDevicesMessage);
export type PestVisitCreateInput = z.infer<typeof pestVisitCreateSchema>;

/** A correction replaces a visit: the whole visit again, with a reason. */
export const pestVisitCorrectSchema = z
  .object({
    reason: requiredText(500),
    contractor: visitFields.contractor,
    technician: visitFields.technician.optional(),
    visitedOn: visitFields.visitedOn,
    summary: visitFields.summary.optional(),
    recommendations: visitFields.recommendations.optional(),
    actionsTaken: visitFields.actionsTaken.optional(),
    nextVisitOn: visitFields.nextVisitOn.optional(),
    findings: visitFields.findings.default([]),
  })
  .refine(nextVisitAfterVisit, nextVisitMessage)
  .refine(distinctDevices, distinctDevicesMessage);
export type PestVisitCorrectInput = z.infer<typeof pestVisitCorrectSchema>;

export const pestVisitListQuerySchema = z
  .object({
    ...recordRange,
    deviceId: z.uuid().optional(),
    /** Only visits with moderate or high activity. */
    activity: booleanQuery.optional(),
    includeCorrected: booleanQuery.default(true),
    ...paging,
  })
  .refine(dateRange, dateRangeMessage);
export type PestVisitListQuery = z.infer<typeof pestVisitListQuerySchema>;

// Glass and brittle plastics -------------------------------------------------

const glassFrequency = scheduleFrequencySchema;

const glassItemFields = {
  areaId: z.uuid(),
  kind: z.enum(glassItemKinds),
  /** What it is, e.g. "Window, packing hall east wall". */
  description: requiredText(300),
  quantity: z.number().int().min(1).max(10_000),
  location: optionalText(200),
  checkFrequency: glassFrequency,
};

export const glassItemCreateSchema = z.object({
  id: z.uuid().optional(),
  areaId: glassItemFields.areaId,
  kind: glassItemFields.kind,
  description: glassItemFields.description,
  quantity: glassItemFields.quantity.default(1),
  location: glassItemFields.location.optional(),
  /** Default: monthly. */
  checkFrequency: glassItemFields.checkFrequency.default({ every: 1, unit: "month" }),
});
export type GlassItemCreateInput = z.infer<typeof glassItemCreateSchema>;

export const glassItemUpdateSchema = z
  .object({ ...glassItemFields, status: z.enum(glassItemStatuses) })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update");
export type GlassItemUpdateInput = z.infer<typeof glassItemUpdateSchema>;

export const glassItemListQuerySchema = z.object({
  areaId: z.uuid().optional(),
  status: z.enum([...glassItemStatuses, "all"]).default("active"),
});
export type GlassItemListQuery = z.infer<typeof glassItemListQuerySchema>;

const glassCheckLine = z
  .object({
    itemId: z.uuid(),
    condition: z.enum(glassConditions),
    note: optionalText(1000).optional(),
  })
  .refine((c) => c.condition === "intact" || !!c.note, {
    path: ["note"],
    message: "Describe the damage, or where the item went",
  });

/**
 * A round of condition checks, one or many items at once. A person's attestation (tokens refused).
 */
export const glassChecksCreateSchema = z.object({
  /** Default: now. Not in the future. */
  checkedAt: isoDateTime.optional(),
  checks: z
    .array(glassCheckLine)
    .min(1)
    .max(200)
    .refine((list) => new Set(list.map((c) => c.itemId)).size === list.length, "An item is listed twice"),
});
export type GlassChecksCreateInput = z.infer<typeof glassChecksCreateSchema>;

export const glassCheckCorrectSchema = z
  .object({
    reason: requiredText(500),
    condition: z.enum(glassConditions),
    note: optionalText(1000).optional(),
  })
  .refine((c) => c.condition === "intact" || !!c.note, {
    path: ["note"],
    message: "Describe the damage, or where the item went",
  });
export type GlassCheckCorrectInput = z.infer<typeof glassCheckCorrectSchema>;

export const glassCheckListQuerySchema = z
  .object({
    itemId: z.uuid().optional(),
    areaId: z.uuid().optional(),
    ...recordRange,
    /** Only damaged or missing results. */
    problems: booleanQuery.optional(),
    includeCorrected: booleanQuery.default(true),
    ...paging,
  })
  .refine(dateRange, dateRangeMessage);
export type GlassCheckListQuery = z.infer<typeof glassCheckListQuerySchema>;

const breakageFields = {
  /** What was broken and how, e.g. "Light diffuser cracked over line 2 conveyor". */
  description: requiredText(2000),
  /** What was quarantined: product, packaging and equipment held. */
  quarantined: requiredText(2000),
};

/**
 * A breakage incident: the area is held from the moment it is raised (an agent may raise one).
 * The clean-down is recorded while it is open; releasing the area is a person's sign-off.
 */
export const glassBreakageCreateSchema = z.object({
  id: z.uuid().optional(),
  areaId: z.uuid(),
  /** The register item that broke, if it is in the register. */
  itemId: z.uuid().nullable().optional(),
  /** Default: now. Not in the future. */
  occurredAt: isoDateTime.optional(),
  description: breakageFields.description,
  quarantined: breakageFields.quarantined,
  /** What was cleaned down, if already done. */
  cleanDown: optionalText(2000).optional(),
});
export type GlassBreakageCreateInput = z.infer<typeof glassBreakageCreateSchema>;

/** Changes an open breakage (what was quarantined, the clean-down). A released one never changes. */
export const glassBreakageUpdateSchema = z
  .object({
    description: breakageFields.description,
    quarantined: breakageFields.quarantined,
    cleanDown: requiredText(2000),
  })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update");
export type GlassBreakageUpdateInput = z.infer<typeof glassBreakageUpdateSchema>;

/** The sign-off: a person with `manage` releases the area once the clean-down is recorded. */
export const glassBreakageReleaseSchema = z.object({ note: optionalText(2000).optional() });
export type GlassBreakageReleaseInput = z.infer<typeof glassBreakageReleaseSchema>;

export const glassBreakageListQuerySchema = z
  .object({
    status: z.enum([...breakageStatuses, "all"]).default("all"),
    areaId: z.uuid().optional(),
    /** Inclusive local dates of when the breakage happened. */
    ...recordRange,
    ...paging,
  })
  .refine(dateRange, dateRangeMessage);
export type GlassBreakageListQuery = z.infer<typeof glassBreakageListQuerySchema>;

// Planned maintenance --------------------------------------------------------

/**
 * Maintenance's optional link to a HACCP calibration instrument. The asset itself is edited in
 * the asset register.
 */
export const siteAssetUpdateSchema = z.object({ calibrationInstrumentId: z.uuid().nullable() });
export type SiteAssetUpdateInput = z.infer<typeof siteAssetUpdateSchema>;

export const siteAssetListQuerySchema = z.object({
  status: z.enum([...siteStatuses, "all"]).default("active"),
});
export type SiteAssetListQuery = z.infer<typeof siteAssetListQuerySchema>;

const taskFields = {
  assetId: z.uuid(),
  title: requiredText(200),
  description: optionalText(2000),
  frequency: scheduleFrequencySchema,
  /** The first due date for a task never done. Without one a task never done is due now. */
  startOn: isoDate.nullable(),
  /** Require clearance before the asset returns to use. */
  clearanceRequired: z.boolean(),
};

export const maintenanceTaskCreateSchema = z.object({
  id: z.uuid().optional(),
  assetId: taskFields.assetId,
  title: taskFields.title,
  description: taskFields.description.optional(),
  frequency: taskFields.frequency,
  startOn: taskFields.startOn.optional(),
  clearanceRequired: taskFields.clearanceRequired.default(false),
});
export type MaintenanceTaskCreateInput = z.infer<typeof maintenanceTaskCreateSchema>;

export const maintenanceTaskUpdateSchema = z
  .object({ ...taskFields, status: z.enum(siteStatuses) })
  .omit({ assetId: true })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update");
export type MaintenanceTaskUpdateInput = z.infer<typeof maintenanceTaskUpdateSchema>;

export const maintenanceTaskListQuerySchema = z.object({
  assetId: z.uuid().optional(),
  status: z.enum([...siteStatuses, "all"]).default("active"),
});
export type MaintenanceTaskListQuery = z.infer<typeof maintenanceTaskListQuerySchema>;

const recordFields = {
  /** Default: now. Not in the future. */
  completedAt: isoDateTime.optional(),
  /** A member who did the work. Default: the person recording. */
  doneBy: z.uuid().optional(),
  /** An outside contractor, if one did it. */
  contractor: optionalText(200).optional(),
  workDone: optionalText(4000).optional(),
  /** Default: the completion date plus the task's interval. */
  nextDueOn: isoDate.optional(),
  note: optionalText(1000).optional(),
};

/** Completed maintenance: a person's attestation (tokens refused). */
export const maintenanceRecordCreateSchema = z.object({
  id: z.uuid().optional(),
  taskId: z.uuid(),
  ...recordFields,
});
export type MaintenanceRecordCreateInput = z.infer<typeof maintenanceRecordCreateSchema>;

export const maintenanceRecordCorrectSchema = z.object({ reason: requiredText(500), ...recordFields });
export type MaintenanceRecordCorrectInput = z.infer<typeof maintenanceRecordCorrectSchema>;

export const maintenanceRecordListQuerySchema = z
  .object({
    taskId: z.uuid().optional(),
    assetId: z.uuid().optional(),
    ...recordRange,
    /** Only records of work in a production area that still need a hygiene clearance. */
    awaitingClearance: booleanQuery.optional(),
    includeCorrected: booleanQuery.default(true),
    ...paging,
  })
  .refine(dateRange, dateRangeMessage);
export type MaintenanceRecordListQuery = z.infer<typeof maintenanceRecordListQuerySchema>;

/** The hygiene clearance: a person with `manage` says the area is safe to restart. */
export const hygieneClearanceSchema = z.object({ note: optionalText(2000).optional() });
export type HygieneClearanceInput = z.infer<typeof hygieneClearanceSchema>;

// Storage temperatures -------------------------------------------------------

const storageUnitFields = {
  code: optionalText(40),
  name: requiredText(200),
  kind: z.enum(storageUnitKinds),
  /** What is measured. Fixed once readings exist. */
  measure: z.enum(storageMeasures),
  location: optionalText(200),
  areaId: z.uuid().nullable(),
  limitMin: measurement.nullable(),
  limitMax: measurement.nullable(),
  /** e.g. `°C`, `%RH`. Default: the measure's own unit. */
  unit: requiredText(20),
  readingFrequency: scheduleFrequencySchema,
};
/** Relative humidity is a percentage: limits outside 0 to 100 are a mistake. */
const humidityInRange = (v: {
  measure?: StorageMeasure | undefined;
  limitMin?: number | null | undefined;
  limitMax?: number | null | undefined;
}) =>
  v.measure !== "humidity" ||
  ((v.limitMin == null || (v.limitMin >= 0 && v.limitMin <= 100)) &&
    (v.limitMax == null || (v.limitMax >= 0 && v.limitMax <= 100)));
const humidityMessage = { path: ["limitMax"], message: "Relative humidity limits are between 0 and 100" };
const otherNeedsUnit = (v: { measure?: StorageMeasure | undefined; unit?: string | undefined }) =>
  v.measure !== "other" || !!v.unit;
const otherNeedsUnitMessage = { path: ["unit"], message: "Give the unit this measure is read in" };
const hasLimit = (v: { limitMin?: number | null | undefined; limitMax?: number | null | undefined }) =>
  (v.limitMin ?? null) !== null || (v.limitMax ?? null) !== null;
const limitsOrdered = (v: { limitMin?: number | null | undefined; limitMax?: number | null | undefined }) =>
  v.limitMin == null || v.limitMax == null || v.limitMin <= v.limitMax;

export const storageUnitCreateSchema = z
  .object({
    id: z.uuid().optional(),
    code: storageUnitFields.code.optional(),
    name: storageUnitFields.name,
    kind: storageUnitFields.kind,
    /** Default: temperature. */
    measure: storageUnitFields.measure.default("temperature"),
    location: storageUnitFields.location.optional(),
    areaId: storageUnitFields.areaId.optional(),
    limitMin: storageUnitFields.limitMin.optional(),
    limitMax: storageUnitFields.limitMax.optional(),
    /** Default: the measure's own unit (`°C`, `%RH`, `Pa`); `other` needs one. */
    unit: storageUnitFields.unit.optional(),
    /** Default: daily. */
    readingFrequency: storageUnitFields.readingFrequency.default({ every: 1, unit: "day" }),
  })
  .refine(hasLimit, { path: ["limitMax"], message: "Give a minimum, a maximum or both" })
  .refine(limitsOrdered, { path: ["limitMax"], message: "The maximum is below the minimum" })
  .refine(humidityInRange, humidityMessage)
  .refine(otherNeedsUnit, otherNeedsUnitMessage);
export type StorageUnitCreateInput = z.infer<typeof storageUnitCreateSchema>;

export const storageUnitUpdateSchema = z
  .object({ ...storageUnitFields, status: z.enum(siteStatuses) })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update")
  .refine(limitsOrdered, { path: ["limitMax"], message: "The maximum is below the minimum" })
  .refine(humidityInRange, humidityMessage);
export type StorageUnitUpdateInput = z.infer<typeof storageUnitUpdateSchema>;

export const storageUnitListQuerySchema = z.object({
  kind: z.enum(storageUnitKinds).optional(),
  measure: z.enum(storageMeasures).optional(),
  status: z.enum([...siteStatuses, "all"]).default("active"),
});
export type StorageUnitListQuery = z.infer<typeof storageUnitListQuerySchema>;

/** Immediate action and analysis given with an out-of-limit reading (all optional). */
const siteActionFields = {
  /** What was done straight away (e.g. "Stock moved to chiller 2; product probed and held"). */
  actionTaken: optionalText(4000),
  rootCause: optionalText(4000),
  preventiveAction: optionalText(4000),
};

/**
 * A storage reading. An out-of-limit one opens a corrective action in the same write. API tokens
 * may record readings (a sensor feed or an agent): they wait for a person's review.
 */
export const storageReadingCreateSchema = z.object({
  id: z.uuid().optional(),
  unitId: z.uuid(),
  value: measurement,
  /** Default: now. Not in the future. */
  checkedAt: isoDateTime.optional(),
  note: optionalText(1000).optional(),
  correctiveAction: z.object(siteActionFields).partial().optional(),
});
export type StorageReadingCreateInput = z.infer<typeof storageReadingCreateSchema>;

export const storageReadingCorrectSchema = z.object({
  value: measurement,
  reason: requiredText(500),
  note: optionalText(1000).optional(),
});
export type StorageReadingCorrectInput = z.infer<typeof storageReadingCorrectSchema>;

export const storageReadingListQuerySchema = z
  .object({
    unitId: z.uuid().optional(),
    ...recordRange,
    outOfLimits: booleanQuery.optional(),
    source: z.enum(["manual", "api"]).optional(),
    review: z.enum(ccpLogReviewStatuses).optional(),
    includeCorrected: booleanQuery.default(true),
    ...paging,
  })
  .refine(dateRange, dateRangeMessage);
export type StorageReadingListQuery = z.infer<typeof storageReadingListQuerySchema>;

const reviewFields = {
  decision: z.enum(ccpLogReviewDecisions),
  note: optionalText(1000).optional(),
};
const noteToReject = (v: { decision: CcpLogReviewDecision; note?: string | null | undefined }) =>
  v.decision === "approve" || !!v.note;
const noteToRejectMessage = { path: ["note"], message: "Say why the reading is rejected" };

export const storageReadingReviewSchema = z.object(reviewFields).refine(noteToReject, noteToRejectMessage);
export type StorageReadingReviewInput = z.infer<typeof storageReadingReviewSchema>;

export const storageReadingBulkReviewSchema = z
  .object({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, "The same reading is listed twice"),
    ...reviewFields,
  })
  .refine(noteToReject, noteToRejectMessage);
export type StorageReadingBulkReviewInput = z.infer<typeof storageReadingBulkReviewSchema>;

export const siteActionCreateSchema = z.object({
  id: z.uuid().optional(),
  title: requiredText(200),
  readingId: z.uuid().nullable().optional(),
  actionTaken: siteActionFields.actionTaken.optional(),
  rootCause: siteActionFields.rootCause.optional(),
  preventiveAction: siteActionFields.preventiveAction.optional(),
});
export type SiteActionCreateInput = z.infer<typeof siteActionCreateSchema>;

export const siteActionUpdateSchema = z
  .object({ title: requiredText(200), ...siteActionFields })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update");
export type SiteActionUpdateInput = z.infer<typeof siteActionUpdateSchema>;

/** The sign-off that closes a corrective action. */
export const siteActionCloseSchema = z.object({ note: optionalText(2000).optional() });
export type SiteActionCloseInput = z.infer<typeof siteActionCloseSchema>;

export const siteActionListQuerySchema = z.object({
  status: z.enum([...siteActionStatuses, "all"]).default("all"),
  readingId: z.uuid().optional(),
  ...paging,
});
export type SiteActionListQuery = z.infer<typeof siteActionListQuerySchema>;

// Checklists -----------------------------------------------------------------

export const checklistItemInputSchema = z.object({
  /** Keep the id of an existing item when editing, so history follows it. */
  id: z.uuid().optional(),
  prompt: requiredText(300),
  /** How to do the check; shown under the prompt. */
  guidance: optionalText(1000).optional(),
});
export type ChecklistItemInput = z.infer<typeof checklistItemInputSchema>;

const templateItems = z
  .array(checklistItemInputSchema)
  .min(1)
  .max(100)
  .refine(
    (list) => new Set(list.map((i) => i.prompt.toLowerCase())).size === list.length,
    "Two items have the same wording",
  );

const templateFields = {
  name: requiredText(200),
  kind: z.enum(checklistKinds),
  /** The area the line or check belongs to. */
  areaId: z.uuid().nullable(),
  /** The line, e.g. "Line 2", when the check is per line. */
  line: optionalText(100),
  /** How often a pre-start check is needed (e.g. daily); none for a check done when needed. */
  frequency: scheduleFrequencySchema.nullable(),
  /** Only due while something is in production (hourly or daily pre-start checks). */
  duringProduction: z.boolean(),
};

export const checklistTemplateCreateSchema = z.object({
  id: z.uuid().optional(),
  name: templateFields.name,
  kind: templateFields.kind,
  areaId: templateFields.areaId.optional(),
  line: templateFields.line.optional(),
  frequency: templateFields.frequency.optional(),
  duringProduction: templateFields.duringProduction.default(false),
  items: templateItems,
});
export const generalChecklistTemplateCreateSchema = checklistTemplateCreateSchema
  .omit({
    kind: true,
    areaId: true,
    duringProduction: true,
  })
  .strict();
export const generalChecklistTemplateUpdateSchema = z
  .object({
    name: templateFields.name,
    line: templateFields.line,
    frequency: templateFields.frequency,
    status: z.enum(siteStatuses),
    items: templateItems,
  })
  .partial()
  .strict()
  .refine(nonEmptyPatch, "Nothing to update");

export type ChecklistTemplateCreateInput = z.infer<typeof checklistTemplateCreateSchema>;

/** Editing replaces the item list when `items` is sent. Past checks keep the wording they were done against. */
export const checklistTemplateUpdateSchema = z
  .object({ ...templateFields, status: z.enum(siteStatuses), items: templateItems })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update");
export type ChecklistTemplateUpdateInput = z.infer<typeof checklistTemplateUpdateSchema>;

export const checklistTemplateListQuerySchema = z.object({
  kind: z.enum(checklistKinds).optional(),
  status: z.enum([...siteStatuses, "all"]).default("active"),
});
export type ChecklistTemplateListQuery = z.infer<typeof checklistTemplateListQuerySchema>;

const checkResultLine = z
  .object({
    itemId: z.uuid(),
    result: z.enum(checkItemResults),
    /** Required for a failed item: what was found and done. */
    note: optionalText(1000).optional(),
  })
  .refine((r) => r.result !== "fail" || !!r.note, {
    path: ["note"],
    message: "Say what was found and done about a failed item",
  });
const checkResults = z
  .array(checkResultLine)
  .min(1)
  .max(100)
  .refine((list) => new Set(list.map((r) => r.itemId)).size === list.length, "An item is listed twice");

/**
 * A completed check against a template: one result per item. For an allergen changeover the batch
 * before and the batch after may be referenced. A person's attestation (tokens refused); a person
 * with `manage` then signs it off before production starts.
 */
export const checklistCheckCreateSchema = z.object({
  id: z.uuid().optional(),
  templateId: z.uuid(),
  /** Default: now. Not in the future. */
  performedAt: isoDateTime.optional(),
  results: checkResults,
  note: optionalText(1000).optional(),
  /** Allergen changeover: the production batch that ran before, and the one that follows. */
  previousBatchId: z.uuid().nullable().optional(),
  nextBatchId: z.uuid().nullable().optional(),
});
export const generalChecklistCheckCreateSchema = checklistCheckCreateSchema
  .omit({
    previousBatchId: true,
    nextBatchId: true,
  })
  .strict();

export type ChecklistCheckCreateInput = z.infer<typeof checklistCheckCreateSchema>;

export const checklistCheckCorrectSchema = z.object({
  reason: requiredText(500),
  results: checkResults,
  note: optionalText(1000).optional(),
});
export type ChecklistCheckCorrectInput = z.infer<typeof checklistCheckCorrectSchema>;

export const checklistCheckListQuerySchema = z
  .object({
    templateId: z.uuid().optional(),
    kind: z.enum(checklistKinds).optional(),
    ...recordRange,
    outcome: z.enum(checkOutcomes).optional(),
    signOff: z.enum(siteCheckSignOffStatuses).optional(),
    batchId: z.uuid().optional(),
    includeCorrected: booleanQuery.default(true),
    ...paging,
  })
  .refine(dateRange, dateRangeMessage);
export type ChecklistCheckListQuery = z.infer<typeof checklistCheckListQuerySchema>;
export const generalChecklistCheckListQuerySchema = z
  .object({
    templateId: z.uuid().optional(),
    ...recordRange,
    outcome: z.enum(checkOutcomes).optional(),
    includeCorrected: booleanQuery.default(true),
    ...paging,
  })
  .refine(dateRange, dateRangeMessage);

export const checklistActionStatuses = ["open", "resolved", "superseded"] as const;
export type ChecklistActionStatus = (typeof checklistActionStatuses)[number];
export const checklistActionListQuerySchema = z.object({
  status: z.enum([...checklistActionStatuses, "all"]).default("open"),
  ...paging,
});
export type ChecklistActionListQuery = z.infer<typeof checklistActionListQuerySchema>;
export const resolveChecklistActionSchema = z.object({ note: requiredText(2000) });

/** A person with `manage` signs a check off (production may start) or holds it (it may not). */
export const checkSignOffSchema = z
  .object({ decision: z.enum(ccpLogReviewDecisions), note: optionalText(1000).optional() })
  .refine(noteToReject, { path: ["note"], message: "Say why production is held" });
export type CheckSignOffInput = z.infer<typeof checkSignOffSchema>;

/** The batches before and after, for the allergen risk of a changeover (nothing is stored). */
export const changeoverRiskQuerySchema = z.object({
  previousBatchId: z.uuid().optional(),
  nextBatchId: z.uuid().optional(),
});
export type ChangeoverRiskQuery = z.infer<typeof changeoverRiskQuerySchema>;

// Pest trends ----------------------------------------------------------------

export const pestTrendQuerySchema = z
  .object({
    ...recordRange,
    groupBy: z.enum(pestTrendGroupings).default("device"),
  })
  .refine(dateRange, dateRangeMessage);
export type PestTrendQuery = z.infer<typeof pestTrendQuerySchema>;

// Work orders ----------------------------------------------------------------

/** Money, to the penny. */
const cost = z
  .number()
  .finite()
  .min(0)
  .max(10_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most 2 decimal places");

const workOrderCostFields = {
  /** Spare parts and materials used, in words ("2 x drive belt B52, 1 L gearbox oil"). */
  sparesUsed: optionalText(2000),
  partsCost: cost.nullable(),
  labourCost: cost.nullable(),
  contractorCost: cost.nullable(),
};

/**
 * A breakdown or work request on maintained equipment. Raising one is data entry (an agent may);
 * completing one attests that a person did the work (tokens refused).
 */
export const workOrderCreateSchema = z.object({
  id: z.uuid().optional(),
  assetId: z.uuid(),
  /** The planned task this is about, if any (it must be on the same asset). */
  taskId: z.uuid().nullable().optional(),
  /** Default: breakdown. */
  kind: z.enum(workOrderKinds).default("breakdown"),
  title: requiredText(200),
  description: optionalText(4000).optional(),
  /** Default: medium. */
  priority: z.enum(workOrderPriorities).default("medium"),
  /** The equipment (and so the line) is stopped until this is done. */
  stopsProduction: z.boolean().default(false),
  /** A member to do it. */
  assignedTo: z.uuid().nullable().optional(),
  /** An outside contractor called in. */
  contractor: optionalText(200).optional(),
});
export type WorkOrderCreateInput = z.infer<typeof workOrderCreateSchema>;

/** Changes an open work order. Starting it is `status: "in_progress"`; completing and cancelling have their own routes. */
export const workOrderUpdateSchema = z
  .object({
    title: requiredText(200),
    description: optionalText(4000),
    priority: z.enum(workOrderPriorities),
    stopsProduction: z.boolean(),
    assignedTo: z.uuid().nullable(),
    contractor: optionalText(200),
    status: z.enum(["requested", "in_progress"]),
    ...workOrderCostFields,
  })
  .partial()
  .refine(nonEmptyPatch, "Nothing to update");
export type WorkOrderUpdateInput = z.infer<typeof workOrderUpdateSchema>;

/** Completing a work order: what was done, the spares and the costs. A person's attestation. */
export const workOrderCompleteSchema = z.object({
  /** Default: now. Not in the future. */
  completedAt: isoDateTime.optional(),
  workDone: requiredText(4000),
  /** A member who did the work. Default: the person recording. */
  doneBy: z.uuid().optional(),
  /** Minutes the equipment was out of use. */
  downtimeMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
  sparesUsed: workOrderCostFields.sparesUsed.optional(),
  partsCost: workOrderCostFields.partsCost.optional(),
  labourCost: workOrderCostFields.labourCost.optional(),
  contractorCost: workOrderCostFields.contractorCost.optional(),
});
export type WorkOrderCompleteInput = z.infer<typeof workOrderCompleteSchema>;

export const workOrderCancelSchema = z.object({ reason: requiredText(1000) });
export type WorkOrderCancelInput = z.infer<typeof workOrderCancelSchema>;

export const workOrderListQuerySchema = z.object({
  /** `open` (default): requested and in progress. */
  status: z.enum(["open", ...workOrderStatuses, "all"]).default("open"),
  assetId: z.uuid().optional(),
  priority: z.enum(workOrderPriorities).optional(),
  kind: z.enum(workOrderKinds).optional(),
  ...paging,
});
export type WorkOrderListQuery = z.infer<typeof workOrderListQuerySchema>;

/** The total cost of a work order's recorded costs, `null` when none was entered. */
export function workOrderTotalCost(w: {
  partsCost: number | null;
  labourCost: number | null;
  contractorCost: number | null;
}): number | null {
  const parts = [w.partsCost, w.labourCost, w.contractorCost].filter((c): c is number => c !== null);
  return parts.length === 0 ? null : Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
}

// What is due ----------------------------------------------------------------

export const siteDueQuerySchema = z.object({
  /** `due` (default): overdue and due. `all`: every scheduled item, with its state. */
  include: z.enum(["due", "all"]).default("due"),
  programme: z.enum(siteProgrammes).optional(),
});
export type SiteDueQuery = z.infer<typeof siteDueQuerySchema>;
