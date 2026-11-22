import type { DespatchReturnView } from "./distribution";
import { z } from "zod";
import { qualitySeverities } from "./quality";
import type { DespatchImpactReport } from "./despatch-impact";

const note = z.string().trim().min(1).max(8000);
export const incidentCreateSchema = z.object({
  commandId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["incident", "withdrawal", "recall"]),
  severity: z.enum(qualitySeverities),
  ownerUserId: z.uuid(),
  assessment: note,
});
export const incidentScopeSchema = z.object({
  commandId: z.uuid(),
  lotId: z.uuid(),
  depth: z.number().int().min(1).max(20).default(20),
  note,
  acknowledgePartial: z.boolean().default(false),
});
export const incidentEventKinds = [
  "assessment",
  "decision",
  "contact",
  "recovery",
  "effectiveness",
  "correction",
] as const;
export const incidentEventSchema = z
  .object({
    commandId: z.uuid(),
    kind: z.enum(incidentEventKinds),
    note,
    party: z.enum(["customer", "regulator", "certification", "internal"]).optional(),
    contact: z.string().trim().min(1).max(1000).optional(),
    contactStatus: z.enum(["planned", "completed"]).optional(),
    dueAt: z.iso.datetime().optional(),
    requirementSource: z.string().trim().min(1).max(2000).optional(),
    deliveryLineId: z.uuid().optional(),
    disposition: z.enum(["recovered_offsite", "destroyed_offsite", "return_reported"]).optional(),
    quantity: z.number().positive().finite().max(1e9).optional(),
    correctsEventId: z.uuid().optional(),
  })
  .superRefine((v, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    if (v.kind === "contact" && (!v.party || !v.contact || !v.contactStatus))
      fail("Choose a contact party, recipient and status");
    if (v.dueAt && !v.requirementSource)
      fail("Record the applicable requirement or source for this deadline");
    if (v.kind === "recovery" && (!v.deliveryLineId || !v.disposition || !v.quantity))
      fail("Choose a delivery, disposition and quantity in its displayed unit");
    if (v.kind === "correction" && !v.correctsEventId) fail("Choose the event being corrected");
    if (v.kind !== "correction" && v.correctsEventId)
      fail("Only correction events can correct another event");
    if (v.kind !== "recovery" && (v.disposition || v.quantity !== undefined))
      fail("Quantities belong to recovery events");
  });
export const incidentReleaseSchema = z.object({ commandId: z.uuid(), lotId: z.uuid(), note });
export const incidentCloseSchema = z
  .object({
    commandId: z.uuid(),
    note,
    coverageReview: note,
    reconciliation: note,
    nonconformanceId: z.uuid().optional(),
    noCapaReason: note.optional(),
  })
  .refine(
    (v) => !!v.nonconformanceId !== !!v.noCapaReason,
    "Link a verified CAPA or explain why no CAPA is required",
  );
export type IncidentCreateInput = z.infer<typeof incidentCreateSchema>;
export type IncidentScopeInput = z.infer<typeof incidentScopeSchema>;
export type IncidentEventInput = z.infer<typeof incidentEventSchema>;
export type IncidentReleaseInput = z.infer<typeof incidentReleaseSchema>;
export type IncidentCloseInput = z.infer<typeof incidentCloseSchema>;
export type IncidentEvidence = Omit<IncidentEventInput, "kind"> & {
  kind: IncidentEventInput["kind"] | "containment" | "hold_release";
  lotId?: string;
  snapshotId?: string;
};
export interface IncidentSummary {
  id: string;
  reference: string;
  title: string;
  kind: IncidentCreateInput["kind"];
  severity: IncidentCreateInput["severity"];
  ownerUserId: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
}
export interface IncidentDetail extends IncidentSummary {
  physicalReturns?: DespatchReturnView[];
  assessment: string;
  snapshots: {
    id: string;
    createdAt: string;
    createdBy: string | null;
    note: string;
    report: DespatchImpactReport;
  }[];
  holds: {
    lotId: string;
    releasedAt: string | null;
    releasedBy: string | null;
    releaseNote: string | null;
  }[];
  events: { id: string; createdAt: string; actorId: string | null; data: IncidentEvidence }[];
  closure: IncidentCloseInput | null;
}
