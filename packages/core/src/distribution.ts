import { z } from "zod";
import { unitCodes, type UnitCode } from "./items";
const note = z.string().trim().min(1).max(4000);
const optionalText = (n: number) =>
  z
    .string()
    .trim()
    .max(n)
    .transform((s) => s || null)
    .nullable()
    .optional();
export const deliverySiteSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(2000),
  contactName: optionalText(200),
  email: z.email().max(320).nullable().optional(),
  phone: optionalText(100),
  status: z.enum(["active", "archived"]).default("active"),
});
export const despatchAllocationSchema = z.object({
  commandId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
  note,
});
export const despatchUnallocateSchema = z.object({
  commandId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
  note,
});
/** GS1 modulo-10 checksum. SSCCs must be assigned under the operator's licensed prefix. */
export function validSscc(value: string): boolean {
  if (!/^\d{18}$/.test(value)) return false;
  const sum = [...value.slice(0, 17)].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(value[17]);
}
const content = z.object({
  lineId: z.uuid(),
  quantity: z.number().positive().finite().max(1e9),
  unit: z.enum(unitCodes),
});
export const despatchPackSchema = z
  .object({
    commandId: z.uuid(),
    expectedUpdatedAt: z.iso.datetime(),
    note,
    packages: z
      .array(
        z.object({
          reference: z.string().trim().min(1).max(100),
          sscc: z
            .string()
            .trim()
            .refine(validSscc, "Enter an 18-digit SSCC with a valid GS1 check digit")
            .optional(),
          contents: z.array(content).min(1).max(100),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((v, c) => {
    if (new Set(v.packages.map((p) => p.reference.toLowerCase())).size !== v.packages.length)
      c.addIssue({ code: "custom", message: "Package references must be distinct" });
    const ids = v.packages.flatMap((p) => (p.sscc ? [p.sscc] : []));
    if (new Set(ids).size !== ids.length)
      c.addIssue({ code: "custom", message: "An SSCC may only identify one handling unit" });
  });
export const despatchLoadSchema = z
  .object({
    commandId: z.uuid(),
    expectedUpdatedAt: z.iso.datetime(),
    vehicle: z.string().trim().min(1).max(100),
    carrier: z.string().trim().min(1).max(200),
    clean: z.enum(["pass", "fail"]),
    secure: z.enum(["pass", "fail"]),
    segregation: z.enum(["pass", "fail"]),
    temperatureMode: z.enum(["ambient", "controlled"]),
    temperatureC: z.number().finite().min(-100).max(100).optional(),
    minC: z.number().finite().min(-100).max(100).optional(),
    maxC: z.number().finite().min(-100).max(100).optional(),
    temperatureBasis: note,
    note,
  })
  .superRefine((v, c) => {
    if (
      v.temperatureMode === "controlled" &&
      (v.temperatureC === undefined || v.minC === undefined || v.maxC === undefined || v.minC > v.maxC)
    )
      c.addIssue({
        code: "custom",
        message: "Controlled loads need a measured temperature and valid minimum/maximum limits",
      });
  });
export function loadCheckPassed(v: DespatchLoadInput): boolean {
  return (
    v.clean === "pass" &&
    v.secure === "pass" &&
    v.segregation === "pass" &&
    (v.temperatureMode === "ambient" || (v.temperatureC! >= v.minC! && v.temperatureC! <= v.maxC!))
  );
}
export const despatchProofSchema = z
  .object({
    commandId: z.uuid(),
    deliveredAt: z.iso.datetime(),
    receivedBy: z.string().trim().min(1).max(200),
    evidenceReference: note,
    note,
    supersedesId: z.uuid().optional(),
    correctionReason: note.optional(),
    lines: z
      .array(
        z.object({
          lineId: z.uuid(),
          deliveredQuantity: z.number().nonnegative().finite().max(1e9),
          refusedQuantity: z.number().nonnegative().finite().max(1e9),
          unit: z.enum(unitCodes),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    (v) => !v.supersedesId || !!v.correctionReason,
    "Explain why the previous delivery evidence is being replaced",
  );
export const despatchReturnSchema = z.object({
  commandId: z.uuid(),
  lineId: z.uuid(),
  quantity: z.number().positive().finite().max(1e9),
  unit: z.enum(unitCodes),
  locationId: z.uuid(),
  receivedOn: z.iso.date(),
  reason: note,
  condition: note,
  incidentId: z.uuid().optional(),
});
export const despatchReturnVoidSchema = z.object({ commandId: z.uuid(), reason: note });
export type DeliverySiteInput = z.infer<typeof deliverySiteSchema>;
export type DespatchAllocationInput = z.infer<typeof despatchAllocationSchema>;
export type DespatchUnallocateInput = z.infer<typeof despatchUnallocateSchema>;
export type DespatchPackInput = z.infer<typeof despatchPackSchema>;
export type DespatchLoadInput = z.infer<typeof despatchLoadSchema>;
export type DespatchProofInput = z.infer<typeof despatchProofSchema>;
export type DespatchReturnInput = z.infer<typeof despatchReturnSchema>;
export type DespatchReturnVoidInput = z.infer<typeof despatchReturnVoidSchema>;
export interface DeliverySite {
  id: string;
  customerId: string;
  code: string;
  name: string;
  address: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  status: "active" | "archived";
}
export interface DespatchReturnView {
  id: string;
  lineId: string;
  lotId: string;
  originalLotId: string;
  lotCode: string;
  receivedOn: string;
  quantity: number;
  unit: UnitCode;
  reason: string;
  condition: string;
  createdAt: string;
  createdBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  incidentId: string | null;
}
export interface DespatchOperations {
  packages: {
    id: string;
    reference: string;
    sscc: string | null;
    contents: { lineId: string; quantity: number }[];
    supersededAt: string | null;
  }[];
  events: {
    id: string;
    kind: string;
    data: Record<string, unknown>;
    createdAt: string;
    actorId: string | null;
  }[];
  proofs: { id: string; data: DespatchProofInput; createdAt: string; actorId: string | null }[];
  returns: DespatchReturnView[];
}
