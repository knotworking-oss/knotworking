import { z } from "zod";
import { inclusiveDays } from "./time";
export const absenceKinds = ["annual_leave", "other_leave", "sickness"] as const;
export const absenceStates = [
  "pending",
  "approved",
  "rejected",
  "reported",
  "recorded",
  "cancelled",
] as const;
export type AbsenceKind = (typeof absenceKinds)[number];
export type AbsenceState = (typeof absenceStates)[number];
export const absenceKindLabels: Record<AbsenceKind, string> = {
  annual_leave: "Annual leave",
  other_leave: "Other leave",
  sickness: "Sickness",
};
const reason = z.string().trim().min(1).max(2000);
const dates = { startOn: z.iso.date(), endOn: z.iso.date().nullable() };
function dateRange(v: { kind: AbsenceKind; startOn: string; endOn: string | null }, ctx: z.RefinementCtx) {
  if (v.endOn && v.endOn < v.startOn)
    ctx.addIssue({ code: "custom", message: "End date must be on or after the start date" });
  if (v.kind !== "sickness" && !v.endOn) ctx.addIssue({ code: "custom", message: "Leave needs an end date" });
}
export const absenceCreateSchema = z
  .object({
    commandId: z.uuid(),
    kind: z.enum(absenceKinds),
    ...dates,
    staffNote: z.string().trim().max(2000).default(""),
  })
  .strict()
  .superRefine(dateRange);
export const absenceHrCreateSchema = z
  .object({
    commandId: z.uuid(),
    staffId: z.uuid(),
    kind: z.enum(absenceKinds),
    ...dates,
    staffNote: z.string().trim().max(2000).default(""),
    hrNote: z.string().trim().max(4000).default(""),
  })
  .strict()
  .superRefine(dateRange);
export const absenceActionSchema = z
  .object({ commandId: z.uuid(), expectedRevision: z.number().int().positive(), reason })
  .strict();
export const absenceDecisionSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    action: z.enum(["approve", "reject", "record", "cancel"]),
    reason,
    hrNote: z.string().trim().max(4000).optional(),
  })
  .strict();
export const absenceCorrectSchema = z
  .object({
    commandId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    ...dates,
    reason,
    hrNote: z.string().trim().max(4000).optional(),
  })
  .strict()
  .refine((v) => !v.endOn || v.endOn >= v.startOn, "End date must be on or after the start date");
export const absenceListSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  state: z.enum(absenceStates).optional(),
  staffId: z.uuid().optional(),
});
export const workforceAvailabilitySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .refine(
    (v) => v.to >= v.from && inclusiveDays(v.from, v.to) <= 366,
    "Choose a date window of no more than 366 days",
  );
