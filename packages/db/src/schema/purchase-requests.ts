/** Internal spending requests, separate from stock and purchase orders. */
import type { PurchaseRequestStatus } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { check, date, index, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";

export const purchaseRequests = pgTable(
  "purchase_requests",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    requesterId: uuid("requester_id").references(() => users.id, { onDelete: "set null" }),
    approverId: uuid("approver_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    amount: numeric("amount", { precision: 14, scale: 4, mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    neededBy: date("needed_by"),
    status: text("status").$type<PurchaseRequestStatus>().notNull().default("pending"),
    createdAt: ts("created_at").notNull().defaultNow(),
    decidedAt: ts("decided_at"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decisionNote: text("decision_note"),
  },
  (t) => [
    index("purchase_requests_workspace_id_idx").on(t.workspaceId, t.id),
    index("purchase_requests_requester_idx").on(t.workspaceId, t.requesterId, t.id),
    index("purchase_requests_approver_idx").on(t.workspaceId, t.approverId, t.id),
    check("purchase_requests_amount_check", sql`${t.amount} > 0`),
    check(
      "purchase_requests_approver_check",
      sql`${t.approverId} is distinct from ${t.requesterId} or ${t.approverId} is null`,
    ),
    check(
      "purchase_requests_status_check",
      sql`${t.status} in ('pending', 'approved', 'rejected', 'withdrawn')`,
    ),
    check("purchase_requests_decision_check", sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
  ],
);
