import { z } from "zod";
import { currencySchema } from "./currency";

export const purchaseRequestStatuses = ["pending", "approved", "rejected", "withdrawn"] as const;
export type PurchaseRequestStatus = (typeof purchaseRequestStatuses)[number];
export const purchaseRequestStatusLabels = {
  pending: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
} satisfies Record<PurchaseRequestStatus, string>;

export const purchaseRequestCreateSchema = z.object({
  commandId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(3000),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,10}(\.\d{1,4})?$/, "Enter an amount with up to four decimal places")
    .transform(Number)
    .refine((amount) => amount > 0, "Enter an amount greater than zero"),
  currency: currencySchema,
  neededBy: z.iso.date().nullable(),
  approverId: z.uuid(),
});
export type PurchaseRequestCreateInput = z.infer<typeof purchaseRequestCreateSchema>;

export const purchaseRequestDecisionSchema = z
  .object({
    commandId: z.uuid(),
    status: z.enum(["approved", "rejected", "withdrawn"]),
    note: z.string().trim().max(2000).optional(),
  })
  .refine(({ status, note }) => status !== "rejected" || Boolean(note), {
    path: ["note"],
    message: "Give a reason for rejecting this request",
  });
export type PurchaseRequestDecisionInput = z.infer<typeof purchaseRequestDecisionSchema>;

export const purchaseRequestListSchema = z.object({
  before: z.uuid().optional(),
  status: z.enum(purchaseRequestStatuses).optional(),
  view: z.enum(["mine", "assigned", "all"]).default("mine"),
});
export type PurchaseRequestListQuery = z.infer<typeof purchaseRequestListSchema>;
