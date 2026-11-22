import { z } from "zod";
import { hseIncidentOutcomes } from "./hse";
import { addMonthsIso } from "./training";

/**
 * Restricted HSE incidents, follow-up to milestone 3.4.3 (the `hse_incidents` module): owned
 * corrective actions, structured records of the people hurt, low-barrier reporting of near misses
 * and the overview. The incident record itself (`hseIncidentBodySchema`) lives in `hse.ts`.
 *
 * - **People hurt** are restricted beyond the module: only a signed-in person with
 *   `hse_incidents` `manage` reads or records them (and the incident's free-text health details).
 *   Others with access see how many people were hurt.
 * - **Corrective actions** have an owner (a member with `hse_incidents` write access) and a due
 *   date. The owner or a manager completes one; only a manager cancels one. An incident can't close
 *   while one is open, and every change advances the incident's revision.
 * - **Reports**: anyone with HSE `write` access (or an agent) can report a near miss, unsafe
 *   condition, dangerous occurrence or environmental incident in which nobody was hurt; it becomes
 *   a restricted incident for the people who investigate.
 *
 * Pure; shared by server, web and MCP.
 */

const text = (n: number) => z.string().trim().min(1).max(n);
const day = z.iso.date();
const command = { commandId: z.uuid() };
const reviewed = { ...command, expectedRevision: z.number().int().positive() };

export const hsePersonTypes = ["employee", "agency", "contractor", "visitor", "other"] as const;
export type HsePersonType = (typeof hsePersonTypes)[number];
export const hsePersonTypeLabels: Record<HsePersonType, string> = {
  employee: "Employee",
  agency: "Agency worker",
  contractor: "Contractor",
  visitor: "Visitor",
  other: "Other",
};

export const hseTreatments = ["none", "first_aid", "gp_or_clinic", "hospital", "hospital_admitted"] as const;
export type HseTreatment = (typeof hseTreatments)[number];
export const hseTreatmentLabels: Record<HseTreatment, string> = {
  none: "None",
  first_aid: "First aid on site",
  gp_or_clinic: "GP or clinic",
  hospital: "Hospital (not admitted)",
  hospital_admitted: "Hospital (admitted)",
};

/** A person hurt or made ill. */
export const hseInjurySchema = z.object({
  /** A People record, when the person is one; otherwise just their name. */
  staffId: z.uuid().nullable().default(null),
  personName: text(200),
  personType: z.enum(hsePersonTypes),
  nature: text(500),
  bodyPart: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v || null)
    .nullable()
    .default(null),
  treatment: z.enum(hseTreatments),
  daysAbsent: z.number().int().min(0).max(3650).nullable().default(null),
});
export type HseInjuryInput = z.infer<typeof hseInjurySchema>;

/**
 * Replaces the people hurt and the worst outcome together (a signed-in manager), so a harm found
 * after the report can be recorded on the original incident in one step.
 */
export const hseInjuriesSaveSchema = z
  .object({
    ...reviewed,
    injuries: z.array(hseInjurySchema).max(30),
    outcome: z.enum(hseIncidentOutcomes),
    reason: text(2000),
  })
  .refine((v) => (v.outcome === "none") === (v.injuries.length === 0), {
    message: "People hurt need an injury outcome, and an injury outcome needs the people hurt",
    path: ["outcome"],
  });
export type HseInjuriesSave = z.infer<typeof hseInjuriesSaveSchema>;

export const hseIncidentActionStatuses = ["open", "done", "cancelled"] as const;
export type HseIncidentActionStatus = (typeof hseIncidentActionStatuses)[number];

export const hseIncidentActionCreateSchema = z.object({
  ...reviewed,
  description: text(2000),
  ownerUserId: z.uuid(),
  dueOn: day,
});
export type HseIncidentActionCreate = z.infer<typeof hseIncidentActionCreateSchema>;

export const hseIncidentActionCompleteSchema = z.object({
  ...reviewed,
  status: z.enum(["done", "cancelled"]),
  note: text(2000),
});
export type HseIncidentActionComplete = z.infer<typeof hseIncidentActionCompleteSchema>;

/** Kinds anyone with HSE write access may report without health details. */
export const hseReportableKinds = [
  "near_miss",
  "unsafe_condition",
  "dangerous_occurrence",
  "environmental",
] as const;

export const hseReportSchema = z.object({
  ...command,
  kind: z.enum(hseReportableKinds),
  occurredOn: day,
  place: text(500),
  summary: text(3000),
  immediateActions: z.string().trim().max(4000).default(""),
});
export type HseReport = z.infer<typeof hseReportSchema>;

/** An action's state on a business day. */
export function hseIncidentActionState(
  action: { status: HseIncidentActionStatus; dueOn: string },
  today: string,
): "open" | "overdue" | "done" | "cancelled" {
  if (action.status !== "open") return action.status;
  return action.dueOn < today ? "overdue" : "open";
}

/** The first day of the overview's twelve months: a year before today, clamped (29 Feb → 28 Feb). */
export const hseYearAgo = (today: string) => addMonthsIso(today, -12);

/** Whole days since the most recent lost-time or major injury, or null when there has been none. */
export function hseDaysSince(lastOn: string | null, today: string): number | null {
  if (!lastOn) return null;
  const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Math.max(0, Math.round((day(today) - day(lastOn)) / 86_400_000));
}
