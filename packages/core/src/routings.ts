import { z } from "zod";
import { roundQuantity, unitCodes } from "./items";
import { productionConsumptionSchema, productionOutputSchema } from "./production";

/**
 * Routings module (`routings`): discrete manufacturing on top of Production. Pure rules and
 * validation schemas; no DOM or Node APIs.
 *
 * - **Work centres**: where an operation is done (a cell, a machine, a bench), with its capacity
 *   (hours a day, stations working at once) and what an hour there costs.
 * - **Routings**: the ordered operations that make a bill of materials (a recipe), versioned like
 *   the bill itself: one editable draft, one approved version, earlier ones superseded. Each
 *   operation names its work centre and expected setup and run minutes. Run minutes are per batch
 *   of the bill's yield, so a batch of three yields expects three times the run.
 * - **Job cards**: one per operation of a production batch, made from the approved routing
 *   version. Each records time (a running timer or entered minutes), good and scrap quantities,
 *   exceptions and completion. Operation N+1 can never report more than operation N passed as good.
 *
 * Production keeps the ledger: materials consumed and output produced from a job card are ordinary
 * batch records (linked to the card), so lot tracing, QA release and costing read them unchanged.
 * Work-centre time is costed at the rate frozen on the card when it was made.
 */

export const routingStatuses = ["active", "archived"] as const;
export type RoutingStatus = (typeof routingStatuses)[number];

export const routingVersionStatuses = ["draft", "approved", "superseded"] as const;
export type RoutingVersionStatus = (typeof routingVersionStatuses)[number];
export const routingVersionStatusLabels: Record<RoutingVersionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

export const workCentreStatuses = ["active", "archived"] as const;
export type WorkCentreStatus = (typeof workCentreStatuses)[number];

export const jobCardStatuses = ["pending", "in_progress", "completed", "cancelled"] as const;
export type JobCardStatus = (typeof jobCardStatuses)[number];
export const jobCardStatusLabels: Record<JobCardStatus, string> = {
  pending: "Not started",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};
/** Statuses where time, quantities and exceptions may still be recorded. */
export const openJobCardStatuses: readonly JobCardStatus[] = ["pending", "in_progress"];

export const jobCardExceptionKinds = ["machine", "material", "quality", "labour", "delay", "other"] as const;
export type JobCardExceptionKind = (typeof jobCardExceptionKinds)[number];
export const jobCardExceptionKindLabels: Record<JobCardExceptionKind, string> = {
  machine: "Machine or tooling",
  material: "Material shortage or defect",
  quality: "Quality problem",
  labour: "Labour",
  delay: "Delay",
  other: "Other",
};

export const jobCardExceptionStatuses = ["open", "resolved"] as const;
export type JobCardExceptionStatus = (typeof jobCardExceptionStatuses)[number];

/** Most operations one routing version may have. */
export const ROUTING_MAX_OPERATIONS = 50;
/** Most minutes one entered time log may cover (a day). */
export const JOB_CARD_MAX_LOG_MINUTES = 1440;

// ─── Arithmetic ──────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Minutes an operation is expected to take for a batch of `factor` yields of the bill: its setup
 * once, its run per yield.
 */
export function expectedOperationMinutes(
  operation: { setupMinutes: number; runMinutes: number },
  factor: number,
): { setup: number; run: number; total: number } {
  const setup = round2(operation.setupMinutes);
  const run = round2(operation.runMinutes * Math.max(factor, 0));
  return { setup, run, total: round2(setup + run) };
}

/** What `minutes` at a work centre cost at `costPerHour`, to the cent. */
export const workCentreCost = (minutes: number, costPerHour: number): number =>
  round2((minutes / 60) * costPerHour);

/** Whole minutes between two instants (at least 1 for a stopped timer that ran at all). */
export function loggedMinutes(startedAt: Date | string, endedAt: Date | string): number {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * A timer stopped at `stoppedAt`: its end and minutes, capped at JOB_CARD_MAX_LOG_MINUTES (a day)
 * like entered time, so a timer left running is booked for a day at most, never for weeks.
 */
export function stoppedTimer(startedAt: Date | string, stoppedAt: Date | string) {
  const start = new Date(startedAt).getTime();
  const endedAt = new Date(
    Math.min(new Date(stoppedAt).getTime(), start + JOB_CARD_MAX_LOG_MINUTES * 60_000),
  );
  return { endedAt, minutes: loggedMinutes(new Date(start), endedAt) };
}

export interface JobCardProgress {
  position: number;
  status: JobCardStatus;
  /** Good and scrap so far, in the output item's base unit. */
  good: number;
  scrap: number;
}

/**
 * The most an operation may still report (good plus scrap), base unit: what the operation before
 * it passed as good, less what this one has already reported. `null`: no limit (the first
 * operation, which works from the batch's materials).
 */
export function remainingFromPrevious(cards: readonly JobCardProgress[], position: number): number | null {
  const live = cards.filter((c) => c.status !== "cancelled").sort((a, b) => a.position - b.position);
  const index = live.findIndex((c) => c.position === position);
  if (index <= 0) return null;
  const previous = live[index - 1]!;
  const self = live[index]!;
  return roundQuantity(Math.max(previous.good - self.good - self.scrap, 0));
}

/** The operation before `position` that is not yet complete, which blocks completing it. */
export function blockingPrevious(
  cards: readonly JobCardProgress[],
  position: number,
): JobCardProgress | undefined {
  const live = cards.filter((c) => c.status !== "cancelled").sort((a, b) => a.position - b.position);
  const index = live.findIndex((c) => c.position === position);
  return index > 0 && live[index - 1]!.status !== "completed" ? live[index - 1] : undefined;
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
const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const fourDecimals = (value: number) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6;
const minutes = z.number().finite().min(0).max(100_000).refine(twoDecimals, "At most 2 decimal places");
const quantity = z
  .number()
  .finite()
  .min(0)
  .max(1_000_000_000)
  .refine(fourDecimals, "At most 4 decimal places");
const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const workCentreFields = {
  /** Short reference, e.g. `CNC-1`; unique among live work centres. */
  code: requiredText(40),
  name: requiredText(200),
  description: optionalText(2000),
  /** Hours a day it can work (per station). */
  hoursPerDay: z.number().finite().min(0).max(24).refine(twoDecimals, "At most 2 decimal places"),
  /** Stations (machines, benches, people) that can work at once. */
  stations: z.number().int().min(1).max(1000),
  /** What an hour of work here costs, in the workspace currency (labour and machine). */
  costPerHour: z.number().finite().min(0).max(1_000_000).refine(fourDecimals, "At most 4 decimal places"),
  notes: optionalText(4000),
};

export const workCentreCreateSchema = z.object({
  id: z.uuid().optional(),
  code: workCentreFields.code,
  name: workCentreFields.name,
  description: workCentreFields.description.optional(),
  hoursPerDay: workCentreFields.hoursPerDay.default(8),
  stations: workCentreFields.stations.default(1),
  costPerHour: workCentreFields.costPerHour.default(0),
  notes: workCentreFields.notes.optional(),
});
export type WorkCentreCreateInput = z.infer<typeof workCentreCreateSchema>;

export const workCentreUpdateSchema = z
  .object({
    code: workCentreFields.code,
    name: workCentreFields.name,
    description: workCentreFields.description,
    hoursPerDay: workCentreFields.hoursPerDay,
    stations: workCentreFields.stations,
    costPerHour: workCentreFields.costPerHour,
    notes: workCentreFields.notes,
    status: z.enum(workCentreStatuses),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type WorkCentreUpdateInput = z.infer<typeof workCentreUpdateSchema>;

export const workCentreListQuerySchema = z.object({
  status: z.enum([...workCentreStatuses, "all"]).default("active"),
  q: z.string().trim().max(200).optional(),
});
export type WorkCentreListQuery = z.infer<typeof workCentreListQuerySchema>;

export const routingOperationInputSchema = z.object({
  name: requiredText(200),
  workCentreId: z.uuid(),
  /** Minutes to set up, once per batch. */
  setupMinutes: minutes.default(0),
  /** Minutes to run one batch of the bill's yield. */
  runMinutes: minutes.default(0),
  instructions: optionalText(4000).optional(),
});
export type RoutingOperationInput = z.infer<typeof routingOperationInputSchema>;

/** A routing draft: the operations in order (the first is done first). Replaces the whole draft. */
export const routingDraftSchema = z.object({
  changeNote: optionalText(2000).optional(),
  operations: z.array(routingOperationInputSchema).max(ROUTING_MAX_OPERATIONS),
});
export type RoutingDraftInput = z.infer<typeof routingDraftSchema>;

export const routingCreateSchema = z.object({
  id: z.uuid().optional(),
  /** Unique among live routings. */
  code: requiredText(40),
  name: requiredText(200),
  /** The bill of materials (recipe) it makes. One live routing per bill. */
  recipeId: z.uuid(),
  description: optionalText(2000).optional(),
  draft: routingDraftSchema.optional(),
});
export type RoutingCreateInput = z.infer<typeof routingCreateSchema>;

export const routingUpdateSchema = z
  .object({
    code: requiredText(40),
    name: requiredText(200),
    description: optionalText(2000),
    status: z.enum(routingStatuses),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type RoutingUpdateInput = z.infer<typeof routingUpdateSchema>;

export const routingListQuerySchema = z.object({
  status: z.enum([...routingStatuses, "all"]).default("active"),
  recipeId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  ...paging,
});
export type RoutingListQuery = z.infer<typeof routingListQuerySchema>;

export const jobCardListQuerySchema = z.object({
  status: z.enum([...jobCardStatuses, "open", "all"]).default("open"),
  batchId: z.uuid().optional(),
  workCentreId: z.uuid().optional(),
  ...paging,
});
export type JobCardListQuery = z.infer<typeof jobCardListQuerySchema>;

/** Starts the caller's timer on a job card (one running timer per person per card). */
export const jobCardTimerStartSchema = z.object({ note: optionalText(500).optional() });
export type JobCardTimerStartInput = z.infer<typeof jobCardTimerStartSchema>;

/** Time entered after the fact: so many minutes, optionally from a start time. */
export const jobCardTimeEntrySchema = z.object({
  minutes: z.number().int().min(1).max(JOB_CARD_MAX_LOG_MINUTES),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  note: optionalText(500).optional(),
});
export type JobCardTimeEntryInput = z.infer<typeof jobCardTimeEntrySchema>;

/** Good and scrap reported by an operation, in a unit of the batch's output item. */
export const jobCardQuantitySchema = z
  .object({
    commandId: z.uuid().optional(),
    good: quantity.default(0),
    scrap: quantity.default(0),
    unit: z.enum(unitCodes),
    scrapReason: optionalText(500).optional(),
    note: optionalText(500).optional(),
    /**
     * The first operation reports at most the batch's planned quantity (good plus scrap, in all)
     * unless this says more was really made: an explicit over-production, never a typo.
     */
    overPlanned: z.boolean().optional(),
  })
  .refine((v) => v.good > 0 || v.scrap > 0, { path: ["good"], message: "Enter a good or scrap quantity" })
  .refine((v) => !(v.scrap > 0) || !!v.scrapReason, {
    path: ["scrapReason"],
    message: "Say why it was scrapped",
  });
export type JobCardQuantityInput = z.infer<typeof jobCardQuantitySchema>;

export const jobCardExceptionSchema = z.object({
  kind: z.enum(jobCardExceptionKinds),
  description: requiredText(2000),
});
export type JobCardExceptionInput = z.infer<typeof jobCardExceptionSchema>;

export const jobCardExceptionResolveSchema = z.object({ resolution: requiredText(2000) });
export type JobCardExceptionResolveInput = z.infer<typeof jobCardExceptionResolveSchema>;

export const jobCardCompleteSchema = z.object({ note: optionalText(2000).optional() });
export type JobCardCompleteInput = z.infer<typeof jobCardCompleteSchema>;

export const jobCardVoidSchema = z.object({ reason: requiredText(500) });
export type JobCardVoidInput = z.infer<typeof jobCardVoidSchema>;

/** Materials used at an operation: posted as the batch's consumption, linked to the card. */
export const jobCardConsumptionSchema = productionConsumptionSchema;
/** Output of the last operation: posted as the batch's output, linked to the card. */
export const jobCardOutputSchema = productionOutputSchema;
