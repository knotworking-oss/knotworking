import { z } from "zod";
import { toCsv } from "./csv";
import type { UnitCode } from "./items";
import type { ProductionBatchStatus } from "./production";
import type { LotStatus, StockAmount } from "./stock";

export const impactLimits = { lots: 2000, batches: 2000, links: 10000, exportLines: 10000 } as const;
export const despatchImpactQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(20).default(10),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
});
export const despatchImpactExportQuerySchema = despatchImpactQuerySchema.pick({ depth: true });
export type DespatchImpactQuery = z.infer<typeof despatchImpactQuerySchema>;

export const impactReasonLabels = {
  depth_limit: "The selected trace depth was reached; further production or customer-return links remain.",
  lot_limit: "The affected-lot limit was reached; further lots were not included.",
  batch_limit: "The production-batch limit was reached; further batches were not included.",
  link_limit: "The production-output limit was reached; further links were not included.",
  open_batches: "Affected production is still open; additional output may be recorded later.",
  missing_output: "Affected material was consumed in a batch with no net output recorded.",
  missing_lot: "Some recorded output lots could not be read in this workspace.",
} as const;
export type ImpactReason = keyof typeof impactReasonLabels;

export interface ImpactLot {
  id: string;
  lotCode: string;
  depth: number;
  item: { id: string; code: string; name: string; unit: UnitCode };
  status: LotStatus;
  expiresOn: string | null;
  onHand: StockAmount;
  despatched: StockAmount;
}
export interface ImpactBatch {
  id: string;
  batchCode: string;
  status: ProductionBatchStatus;
  depth: number;
  outputLinks: number;
}
export interface ImpactDelivery {
  lineId: string;
  despatchId: string;
  reference: string;
  despatchedOn: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  customerAddress: string;
  deliveryAddress: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  externalReference: string | null;
  lotId: string;
  lotCode: string;
  itemCode: string;
  itemName: string;
  amount: StockAmount;
}
export interface DespatchImpactReport {
  rootLotId: string;
  returnLinks?: { id: string; originalLotId: string; lotId: string; lotCode: string }[];
  generatedAt: string;
  scope: "forward_production_and_despatch";
  coverage: {
    status: "complete" | "partial";
    reasons: ImpactReason[];
    depth: number;
    limits: { lots: number; batches: number; links: number };
  };
  lots: ImpactLot[];
  batches: ImpactBatch[];
  summary: { lots: number; batches: number; despatches: number; customers: number; deliveryLines: number };
  deliveries: { lines: ImpactDelivery[]; total: number; limit: number; offset: number };
}

/** Audit spreadsheet: coverage precedes the contact list, including when no deliveries exist. */
export function despatchImpactCsv(report: DespatchImpactReport): string {
  const root = report.lots.find((l) => l.id === report.rootLotId);
  return toCsv([
    ["Forward distribution impact", root?.lotCode ?? report.rootLotId],
    ["Generated at", report.generatedAt],
    ["Recorded physical customer return links", report.returnLinks?.length ?? 0],
    ["Recorded trace coverage", report.coverage.status],
    ["Coverage notes", report.coverage.reasons.map((r) => impactReasonLabels[r]).join(" ")],
    [
      "Scope",
      "All recorded outputs of affected batches; quantities are whole affected lots/deliveries, not an estimated ingredient fraction.",
    ],
    ["Trace depth (production / returns)", report.coverage.depth],
    [
      "Limits (lots / batches / output links)",
      `${report.coverage.limits.lots} / ${report.coverage.limits.batches} / ${report.coverage.limits.links}`,
    ],
    [
      "Delivery lines included / known total",
      `${report.deliveries.lines.length} / ${report.deliveries.total}`,
    ],
    [
      "Important",
      "Coverage describes recorded traceability only. Check unrecorded movements and unresolved production before making recall decisions.",
    ],
    [],
    [
      "Despatch",
      "Date",
      "Customer code",
      "Customer",
      "Business address",
      "Delivery address",
      "Contact",
      "Email",
      "Phone",
      "Order reference",
      "Product code",
      "Product",
      "Lot",
      "Quantity",
      "Unit",
      "Delivery line ID",
    ],
    ...report.deliveries.lines.map((d) => [
      d.reference,
      d.despatchedOn,
      d.customerCode,
      d.customerName,
      d.customerAddress,
      d.deliveryAddress,
      d.contactName,
      d.email,
      d.phone,
      d.externalReference,
      d.itemCode,
      d.itemName,
      d.lotCode,
      d.amount.display,
      d.amount.displayUnit,
      d.lineId,
    ]),
  ]);
}
