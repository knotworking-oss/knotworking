import { z } from "zod";
import { roundQuantity, unitCodes } from "./items";
import type { DayOff, WorkingCalendar } from "./production-calendar";
import { lineCapacityHours, MINUTES_PER_DAY, type LineShift } from "./production-scheduling";
import type { ProductionBatchStatus } from "./production";

/**
 * Production module, second slice: reserving stock for batches, and capacity scheduling on
 * production lines. Pure rules and validation schemas; no DOM or Node APIs.
 *
 * Reservations are lot-level and in the item's base unit. Available stock is on hand minus
 * reserved, per lot and never below zero. Nothing here blocks consumption.
 */

// ─── Reservations ────────────────────────────────────────────────────────────

/** `active` holds stock for the batch; `released` is history (consumed, completed, cancelled or by hand). */
export const reservationStatuses = ["active", "released"] as const;
export type ReservationStatus = (typeof reservationStatuses)[number];

/** Why a reservation was released: `consumed` (fully used by the batch) or let go. */
export const reservationReleaseReasons = ["consumed", "completed", "cancelled", "manual", "expired"] as const;
export type ReservationReleaseReason = (typeof reservationReleaseReasons)[number];
export const reservationReleaseReasonLabels: Record<ReservationReleaseReason, string> = {
  consumed: "Consumed",
  completed: "Batch completed",
  cancelled: "Batch cancelled",
  manual: "Released by hand",
  expired: "Reservation expired",
};

/** What a reservation still holds back: `quantity − fulfilled`, never below zero; nothing once released. */
export const reservationHeld = (r: {
  quantity: number;
  fulfilledQuantity: number;
  status: ReservationStatus;
}): number => (r.status === "active" ? roundQuantity(Math.max(r.quantity - r.fulfilledQuantity, 0)) : 0);

/**
 * A reservation with an expiry date holds its stock **through** that day (`expiresOn` is the last
 * day it holds); from the next day it is expired. Expired reservations are ignored by every read at
 * once and released (reason `expired`) by the next sweep or reservation write, so a late sweep never
 * keeps stock tied up.
 */
export const reservationExpired = (
  r: { status: ReservationStatus; expiresOn?: string | null },
  today: string,
): boolean => r.status === "active" && !!r.expiresOn && r.expiresOn < today;

/** What a reservation holds back on `today`: nothing once released or expired. */
export const reservationHeldOn = (
  r: { quantity: number; fulfilledQuantity: number; status: ReservationStatus; expiresOn?: string | null },
  today: string,
): number => (reservationExpired(r, today) ? 0 : reservationHeld(r));

/** Key of a lot at a location, for reservations that name one. */
export const lotLocationKey = (lotId: string, locationId: string): string => `${lotId}:${locationId}`;

/** Free stock of a lot: on hand less reserved, never below zero. */
export const freeQuantity = (onHand: number, reserved: number): number =>
  roundQuantity(Math.max(onHand - reserved, 0));

/**
 * Lot balances (per location) with the reserved quantity taken off, so FEFO and availability see
 * what is free. `reservedByLot` is lot id → everything held back for it (base unit). A reservation
 * that names a location (`reservedAtLocation`, keyed by `lotLocationKey`, a part of the same lot
 * total) comes off that location's balance first; whatever is not tied to a location, and any
 * location reservation larger than what is now there (stock was moved away), comes off the lot's
 * remaining balances in the order given (stable). Candidates with nothing left drop out.
 */
export function netOfReservations<T extends { lotId: string; locationId?: string; quantity: number }>(
  candidates: readonly T[],
  reservedByLot: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  reservedAtLocation?: ReadonlyMap<string, number>,
): T[] {
  const get = (id: string) =>
    reservedByLot instanceof Map
      ? (reservedByLot.get(id) ?? 0)
      : ((reservedByLot as Record<string, number>)[id] ?? 0);
  // Pass 1: location-bound reservations come off their own location.
  const afterLocation = candidates.map((c) => {
    const bound = c.locationId ? (reservedAtLocation?.get(lotLocationKey(c.lotId, c.locationId)) ?? 0) : 0;
    const taken = Math.min(c.quantity, bound);
    return { c, quantity: roundQuantity(c.quantity - taken), taken };
  });
  const takenByLot = new Map<string, number>();
  for (const a of afterLocation) {
    takenByLot.set(a.c.lotId, roundQuantity((takenByLot.get(a.c.lotId) ?? 0) + a.taken));
  }
  // Pass 2: the rest of each lot's reservation comes off what is left, in order.
  const left = new Map<string, number>();
  const out: T[] = [];
  for (const a of afterLocation) {
    const id = a.c.lotId;
    const remaining = left.get(id) ?? Math.max(roundQuantity(get(id) - (takenByLot.get(id) ?? 0)), 0);
    const taken = Math.min(a.quantity, remaining);
    left.set(id, roundQuantity(remaining - taken));
    const quantity = roundQuantity(a.quantity - taken);
    if (quantity > 0) out.push({ ...a.c, quantity });
  }
  return out;
}

/**
 * Consumption fulfils the batch's reservations of that lot, oldest first: returns how much of each
 * reservation to count as used, and whether it is then used up. Consuming more than reserved just
 * uses the reservation up (the rest was free stock).
 */
export function fulfilReservations(
  reservations: readonly { id: string; quantity: number; fulfilledQuantity: number }[],
  consumed: number,
): { id: string; fulfilled: number; done: boolean }[] {
  let remaining = consumed;
  const out: { id: string; fulfilled: number; done: boolean }[] = [];
  for (const r of reservations) {
    if (remaining <= 0) break;
    const held = roundQuantity(Math.max(r.quantity - r.fulfilledQuantity, 0));
    const use = roundQuantity(Math.min(held, remaining));
    if (use <= 0) continue;
    remaining = roundQuantity(remaining - use);
    out.push({ id: r.id, fulfilled: roundQuantity(r.fulfilledQuantity + use), done: use >= held });
  }
  return out;
}

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const MAX_QUANTITY = 1_000_000_000_000;
const positiveQuantity = z.number().positive().finite().max(MAX_QUANTITY);
const isoDate = z.iso.date();

/**
 * Reserve stock for a planned or in-progress batch. A line names a lot and a quantity, or an item
 * (and optionally a quantity, otherwise everything still outstanding) to be picked first expired,
 * first out from free stock. `allOutstanding` does that for every ingredient.
 */
export const reservationLineSchema = z.union([
  z.object({
    lotId: z.uuid(),
    quantity: positiveQuantity,
    unit: z.enum(unitCodes),
    /** Reserve the lot's balance at one stock location; without it, the lot as a whole. */
    locationId: z.uuid().optional(),
    /** The last day the reservation holds (it expires the day after). Overrides the request's. */
    expiresOn: isoDate.optional(),
    note: optionalText(500).optional(),
  }),
  z
    .object({
      itemId: z.uuid(),
      quantity: positiveQuantity.optional(),
      unit: z.enum(unitCodes).optional(),
      /** Pick only from this location, and reserve at it. */
      locationId: z.uuid().optional(),
      expiresOn: isoDate.optional(),
      note: optionalText(500).optional(),
    })
    .refine((v) => (v.quantity === undefined) === (v.unit === undefined), {
      path: ["unit"],
      message: "quantity and unit go together",
    }),
]);
export type ReservationLineInput = z.infer<typeof reservationLineSchema>;

export const productionReserveSchema = z
  .object({
    lines: z.array(reservationLineSchema).max(100).optional(),
    allOutstanding: z.boolean().optional(),
    /** Default expiry (the last day it holds) for every line without its own. */
    expiresOn: isoDate.optional(),
    /** With `allOutstanding`: pick only from this location, and reserve at it. */
    locationId: z.uuid().optional(),
  })
  .refine((v) => (v.lines?.length ?? 0) > 0 || v.allOutstanding === true, {
    path: ["lines"],
    message: "Give lines to reserve, or allOutstanding",
  });
export type ProductionReserveInput = z.infer<typeof productionReserveSchema>;

/** Changes a reservation's expiry date; `null` removes it. */
export const productionReservationUpdateSchema = z.object({ expiresOn: isoDate.nullable() });
export type ProductionReservationUpdateInput = z.infer<typeof productionReservationUpdateSchema>;

export const productionReleaseSchema = z.object({ note: optionalText(500).optional() });
export type ProductionReleaseInput = z.infer<typeof productionReleaseSchema>;

const idList = z
  .string()
  .max(10_000)
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.uuid()).max(200));

export const reservationListQuerySchema = z.object({
  batchId: z.uuid().optional(),
  lotId: z.uuid().optional(),
  itemId: z.uuid().optional(),
  /** Default `active`. */
  status: z.enum([...reservationStatuses, "all"]).default("active"),
});
export type ReservationListQuery = z.infer<typeof reservationListQuerySchema>;

/** `GET /production/availability?itemIds=`: on hand, reserved and available per item. */
export const availabilityQuerySchema = z.object({ itemIds: idList });
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/** `GET /production/batches/:id/scan?code=`: resolve a scanned lot code. */
export const scanQuerySchema = z.object({ code: requiredText(120) });
export type ScanQuery = z.infer<typeof scanQuerySchema>;

// ─── Lines and capacity ──────────────────────────────────────────────────────

export const MAX_HOURS_PER_DAY = 24;
export const DEFAULT_HOURS_PER_DAY = 8;

const hours = z
  .number()
  .positive()
  .max(MAX_HOURS_PER_DAY)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "At most 2 decimal places");

export const productionLineCreateSchema = z.object({
  id: z.uuid().optional(),
  name: requiredText(80),
  hoursPerDay: hours.default(DEFAULT_HOURS_PER_DAY),
  notes: optionalText(2000).optional(),
});
export type ProductionLineCreateInput = z.infer<typeof productionLineCreateSchema>;

export const productionLineUpdateSchema = z
  .object({
    name: requiredText(80).optional(),
    hoursPerDay: hours.optional(),
    active: z.boolean().optional(),
    notes: optionalText(2000).optional(),
    /** Minutes to change from one recipe to another when no changeover rule says otherwise. */
    changeoverMinutes: z.number().int().min(0).max(MINUTES_PER_DAY).optional(),
    /** Minutes an allergen clean-down takes (used when longer than the changeover). */
    allergenCleanMinutes: z.number().int().min(0).max(MINUTES_PER_DAY).optional(),
    /** People who can work the line at once; null: not limited. */
    crewAvailable: z.number().int().min(1).max(500).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");
export type ProductionLineUpdateInput = z.infer<typeof productionLineUpdateSchema>;

/** How much a line makes of a recipe per hour, in a unit of the recipe's output item. */
export const productionLineRecipeSchema = z.object({
  rate: positiveQuantity,
  unit: z.enum(unitCodes),
  /** People the line needs to make the recipe; null or omitted: not set. */
  crewSize: z.number().int().min(1).max(500).nullable().optional(),
});
export type ProductionLineRecipeInput = z.infer<typeof productionLineRecipeSchema>;

export const SCHEDULE_MAX_DAYS = 62;

export const productionScheduleQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, { path: ["to"], message: "`to` is before `from`" })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) < SCHEDULE_MAX_DAYS * 86_400_000, {
    path: ["to"],
    message: `At most ${SCHEDULE_MAX_DAYS} days at a time`,
  });
export type ProductionScheduleQuery = z.infer<typeof productionScheduleQuerySchema>;

/** Hours a batch takes on a line: planned output (base unit) ÷ the line's rate; `null` without a rate. */
export const batchHours = (plannedQuantity: number, ratePerHour: number | null | undefined): number | null =>
  ratePerHour && ratePerHour > 0 ? roundQuantity(plannedQuantity / ratePerHour, 2) : null;

export interface ScheduleLine {
  id: string;
  hoursPerDay: number;
  /** Shift windows: with any, capacity is their length on each day (see `lineCapacityHours`). */
  shifts?: readonly LineShift[];
  /** recipeId → output per hour (base unit). */
  rates: Readonly<Record<string, number>>;
}

export interface ScheduleBatch {
  id: string;
  lineId: string | null;
  recipeId: string;
  plannedOn: string;
  plannedQuantity: number;
  status: ProductionBatchStatus;
}

export interface LineDayBatch {
  batchId: string;
  /** `null`: the line has no rate for the recipe, so the load is unknown. */
  hours: number | null;
}

export interface LineDay {
  date: string;
  capacityHours: number;
  /** Hours of batches with a rate. */
  hours: number;
  /** `hours ÷ capacity` as a percentage. */
  loadPercent: number;
  /** More hours than capacity (a batch on a day off is always over): a warning, never a block. */
  overloaded: boolean;
  /** The day is not a working day for the line (see `WorkingCalendar`): its capacity is 0. */
  dayOff: DayOff | null;
  /** Batches counted in `batches` with no rate on this line. */
  unrated: number;
  batches: LineDayBatch[];
}

/**
 * Load per line per day: the hours of the batches assigned to a line on a date (cancelled ones
 * left out; completed ones count, they took the time) against the line's hours per day. A batch
 * whose recipe the line has no rate for adds no hours and is flagged `unrated`. Days with nothing
 * assigned are still returned so the view is a grid. With a `calendar`, a day off for the line (its
 * own or the workspace's) has no capacity, so a batch on it counts as overloaded. Pure; nothing is
 * stored or enforced.
 */
export function scheduleLoads(
  lines: readonly ScheduleLine[],
  batches: readonly ScheduleBatch[],
  days: readonly string[],
  calendar?: WorkingCalendar,
): Record<string, LineDay[]> {
  const byKey = new Map<string, ScheduleBatch[]>();
  for (const b of batches) {
    if (!b.lineId || b.status === "cancelled") continue;
    const key = `${b.lineId}:${b.plannedOn}`;
    byKey.set(key, [...(byKey.get(key) ?? []), b]);
  }
  const out: Record<string, LineDay[]> = {};
  for (const line of lines) {
    out[line.id] = days.map((date): LineDay => {
      const mine = byKey.get(`${line.id}:${date}`) ?? [];
      const rows = mine.map((b) => ({
        batchId: b.id,
        hours: batchHours(b.plannedQuantity, line.rates[b.recipeId]),
      }));
      const total = roundQuantity(
        rows.reduce((t, r) => t + (r.hours ?? 0), 0),
        2,
      );
      const dayOff = calendar?.dayOff(date, line.id) ?? null;
      const capacityHours = lineCapacityHours(line, date, dayOff);
      return {
        date,
        capacityHours,
        hours: total,
        loadPercent: capacityHours > 0 ? roundQuantity((total / capacityHours) * 100, 1) : 0,
        overloaded: total > capacityHours + 1e-9,
        dayOff,
        unrated: rows.filter((r) => r.hours === null).length,
        batches: rows,
      };
    });
  }
  return out;
}
