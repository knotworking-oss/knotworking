import {
  canApproveOrderSend,
  purchaseOrderStatusLabels,
  renderPurchaseOrderEmail,
  sendApprovalState,
  type PurchaseOrderApproveInput,
  type PurchaseOrderEmailInput,
  type PurchaseReceiptVoidInput,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  purchaseOrderEmails,
  purchaseOrders,
  purchaseReceipts,
  recordChanges,
  stockLocations,
  type Database,
} from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import type { Mailer } from "../mailer";
import {
  findOrder,
  findSupplier,
  getOrder,
  loadOrders,
  orderChange,
  receiptChange,
  strip,
} from "./purchasing";
import { getOrderSettings } from "./purchasing-settings";
import { workspaceToday } from "./time-zone";

/**
 * Controls around a purchase order: approving it for sending when it is above the workspace's
 * threshold, emailing it to the supplier, and voiding a rejected receipt recorded in error. Every
 * write takes the workspace lock and records its changes.
 */

// ─── Approval to send ────────────────────────────────────────────────────────

/**
 * A manager other than whoever raised a draft order approves sending it, when it is above the
 * threshold. The approval covers the order's value now: it goes stale if the order grows (the
 * route has already required `manage` and a signed-in person).
 */
export async function approveOrderSend(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: PurchaseOrderApproveInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const order = await findOrder(tx, workspaceId, id);
    if (order.status !== "draft") {
      throw new ApiError(
        409,
        "not_draft",
        `${order.reference} is ${purchaseOrderStatusLabels[order.status].toLowerCase()}; only a draft needs approval to be sent`,
      );
    }
    const { sendApprovalThreshold: threshold } = await getOrderSettings(tx, workspaceId);
    const [loaded] = await loadOrders(tx, [order], today);
    const value = loaded!.summary.value;
    const state = sendApprovalState({
      threshold,
      value,
      createdBy: order.createdBy,
      approvedBy: order.sendApprovedBy,
      approvedValue: order.sendApprovedValue,
    });
    if (state === "not_required") {
      throw new ApiError(
        409,
        "approval_not_required",
        threshold === null
          ? "No approval threshold is set for purchase orders"
          : `${order.reference} is within the ${threshold} approval threshold`,
      );
    }
    if (state === "approved") {
      throw new ApiError(409, "already_approved", `${order.reference} has already been approved for sending`);
    }
    if (!canApproveOrderSend({ createdBy: order.createdBy, approverId: actorId })) {
      throw new ApiError(
        403,
        "four_eyes",
        "You raised this order, so someone else with manage access to purchasing has to approve it",
      );
    }
    const [row] = await tx
      .update(purchaseOrders)
      .set({
        sendApprovedBy: actorId,
        sendApprovedAt: new Date(),
        sendApprovedValue: value,
        sendApprovalNote: input.note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [orderChange(row!)]);
    return getOrder(tx, workspaceId, id, today);
  });
}

// ─── Emailing the order ──────────────────────────────────────────────────────

/**
 * Emails a sent order to the supplier (the supplier's email in the register, or `to`): a plain
 * text and HTML summary with no links. The attempt is logged on the order, failed ones too, and a
 * broken mail server never fails the request: the result says `emailed: false` and why, like
 * invitations. With no mail server configured nothing is sent or logged.
 */
export async function emailOrder(
  db: Database,
  mailer: Mailer,
  workspaceId: string,
  workspaceName: string,
  actor: { id: string; name: string },
  id: string,
  input: PurchaseOrderEmailInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const order = await findOrder(db, workspaceId, id);
  if (order.status !== "sent") {
    throw new ApiError(
      409,
      "order_not_sent",
      `${order.reference} is ${purchaseOrderStatusLabels[order.status].toLowerCase()}; only a sent order is emailed to the supplier`,
    );
  }
  const supplier = await findSupplier(db, workspaceId, order.supplierId);
  const to = input.to ?? supplier.email?.trim() ?? "";
  if (!to) {
    throw badRequest(`${supplier.name} has no email address in the supplier register; give one`, {
      code: "no_supplier_email",
    });
  }
  const [loaded] = await loadOrders(db, [order], today);
  const [location] = order.deliveryLocationId
    ? await db
        .select({ name: stockLocations.name, code: stockLocations.code })
        .from(stockLocations)
        .where(eq(stockLocations.id, order.deliveryLocationId))
    : [];
  const content = renderPurchaseOrderEmail({
    workspaceName,
    reference: order.reference,
    supplierName: supplier.name,
    supplierReference: order.supplierReference,
    orderedOn: order.orderedOn,
    expectedOn: order.expectedOn,
    deliveryLocation: location ? location.name : null,
    notes: order.notes,
    message: input.message ?? null,
    senderName: actor.name,
    value: loaded!.summary.value,
    complete: loaded!.summary.valueComplete,
    lines: loaded!.lines.map((l) => ({
      lineNo: l.lineNo,
      code: l.item?.code ?? null,
      name: l.kind === "non_stock" ? (l.description ?? "") : (l.item?.name ?? ""),
      quantity: l.ordered.inLineUnit ?? l.ordered.display,
      unit: l.unit ?? l.unitLabel ?? "",
      unitPrice: l.unitPrice,
      value: l.lineValue,
      expectedOn: l.effectiveExpectedOn,
    })),
  });

  let emailed = false;
  let mailError: string | undefined;
  if (!mailer.configured) {
    mailError = "Email isn't set up on this server (SMTP_URL), so nothing was sent";
  } else {
    try {
      await mailer.send({ to, subject: content.subject, text: content.text, html: content.html });
      emailed = true;
    } catch (err) {
      console.error(`[mail] couldn't send ${order.reference} to ${to}:`, err);
      mailError = `The email couldn't be sent (${err instanceof Error ? err.message : "unknown error"}).`;
    }
  }

  // Log the attempt (not when nothing could be attempted). The order may have changed meanwhile;
  // the email is a fact about what was sent, so it is logged whatever the order looks like now.
  let email: typeof purchaseOrderEmails.$inferSelect | null = null;
  if (mailer.configured) {
    email = await db.transaction(async (tx) => {
      await lockWorkspaceLog(tx, workspaceId);
      const [row] = await tx
        .insert(purchaseOrderEmails)
        .values({
          workspaceId,
          purchaseOrderId: order.id,
          toEmail: to,
          subject: content.subject,
          status: emailed ? "sent" : "failed",
          error: mailError ?? null,
          sentBy: actor.id,
        })
        .returning();
      await recordChanges(tx, workspaceId, actor.id, [
        { entity: "purchase_order_email", entityId: row!.id, action: "upsert", data: strip(row!) },
      ]);
      return row!;
    });
  }
  return {
    emailed,
    mailError,
    to,
    email: email && {
      id: email.id,
      status: email.status,
      toEmail: email.toEmail,
      createdAt: email.createdAt,
    },
    order: await getOrder(db, workspaceId, id, today),
  };
}

// ─── Voiding a rejected receipt ──────────────────────────────────────────────

/**
 * Voids a receipt recorded in error: a rejected one (a refusal that never happened, or against the
 * wrong line) or an accepted one of a non-stock line (nothing entered stock). It stays on the order,
 * struck through, and no longer counts anywhere (received quantities, invoice matching and supplier
 * performance included). The record is never edited or deleted; record the right one as a new
 * delivery. An accepted stock receipt can't be voided: its stock movement is reversed instead.
 */
export async function voidRejectedReceipt(
  db: Database,
  workspaceId: string,
  actorId: string,
  orderId: string,
  receiptId: string,
  input: PurchaseReceiptVoidInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const order = await findOrder(tx, workspaceId, orderId);
    const [receipt] = await tx
      .select()
      .from(purchaseReceipts)
      .where(
        and(
          eq(purchaseReceipts.id, receiptId),
          eq(purchaseReceipts.purchaseOrderId, order.id),
          eq(purchaseReceipts.workspaceId, workspaceId),
        ),
      );
    if (!receipt) throw notFound("Receipt");
    // An accepted stock receipt put a lot into stock: its movement is reversed instead.
    if (receipt.outcome !== "rejected" && receipt.lotId !== null) {
      throw new ApiError(
        409,
        "receipt_not_rejected",
        "Only a refused delivery line or a non-stock receipt can be voided; reverse an accepted receipt's stock movement on the lot page",
      );
    }
    if (receipt.voidedAt) throw new ApiError(409, "already_voided", "This receipt has already been voided");
    const [row] = await tx
      .update(purchaseReceipts)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: input.reason, updatedAt: new Date() })
      .where(and(eq(purchaseReceipts.id, receiptId), isNull(purchaseReceipts.voidedAt)))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [receiptChange(row!)]);
    return getOrder(tx, workspaceId, orderId, today);
  });
}
