import { ledgerInput } from "../middleware/ledger-command";
import {
  hasModuleLevel,
  purchaseOrderApproveSchema,
  purchaseOrderCancelSchema,
  purchaseOrderCloseSchema,
  purchaseOrderCreateSchema,
  purchaseOrderEmailSchema,
  purchaseOrderListQuerySchema,
  purchaseOrderSendSchema,
  purchaseOrderSettingsUpdateSchema,
  purchaseOrderUpdateSchema,
  purchaseReceiptVoidSchema,
  purchaseReceiveSchema,
  purchaseSuggestionsCreateSchema,
  purchaseSuggestionsQuerySchema,
  purchaseSuggestionsRange,
  supplierPerformanceQuerySchema,
  supplierPriceCreateSchema,
  supplierPriceListQuerySchema,
  supplierPriceUpdateSchema,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { ApiError, badRequest } from "../errors";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import { personOrToken } from "../middleware/token-actions";
import {
  cancelOrder,
  closeOrder,
  createOrder,
  createSuggestedOrders,
  deleteOrder,
  getOrder,
  getSuggestions,
  getSupplierPerformance,
  listOrders,
  receiveOrder,
  sendOrder,
  updateOrder,
} from "../services/purchasing";
import { approveOrderSend, emailOrder, voidRejectedReceipt } from "../services/purchasing-controls";
import {
  createSupplierPrice,
  deleteSupplierPrice,
  getOrderSettings,
  listSupplierPrices,
  updateOrderSettings,
  updateSupplierPrice,
} from "../services/purchasing-settings";
import { supplierQualityFlags } from "../services/quality-extras";
import { todayIn } from "../middleware/workspace";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const receiptParam = z.object({ id: z.uuid(), receiptId: z.uuid() });

/**
 * Quality's open non-conformances per supplier, for the warning beside a supplier. Only where
 * quality is active and the caller can read it; never a block, only information.
 */
async function qualityFlags(c: Context<WorkspaceEnv>, supplierIds: string[]) {
  if (!c.var.activeModules.includes("quality") || !canRead(c, "quality")) return null;
  return supplierQualityFlags(c.var.db, c.var.workspace.id, supplierIds, todayIn(c));
}

/**
 * Suggestions read production's material requirements: production must be on and readable by the
 * caller (purchasing doesn't depend on production, so this is checked here).
 */
function assertProductionReadable(c: Context<WorkspaceEnv>) {
  if (!c.var.activeModules.includes("production") || !canRead(c, "production")) {
    throw new ApiError(
      409,
      "production_unavailable",
      c.var.activeModules.includes("production")
        ? "Suggestions come from production's material shortfall, and you don't have access to the production module"
        : "Suggestions come from production's material shortfall, and the production module is not enabled",
    );
  }
}

/**
 * Purchasing module (`purchasing`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest.
 *
 * - `write` (API tokens allowed): draft and edit orders, delete drafts, record deliveries (like
 *   stock goods-in), create drafts from suggestions.
 * - `manage` and a signed-in person: send an order (a commitment to buy).
 * - `write` and a signed-in person: close and cancel an order.
 *
 * Send, close and cancel refuse API tokens unless an owner or admin allows them under Settings →
 * API access (`personOrToken`); the token's owner still needs the level.
 */
export const purchasingRoutes = new Hono<WorkspaceEnv>()
  // ── Orders ──
  .get("/purchasing/orders", validate("query", purchaseOrderListQuerySchema), async (c) =>
    c.json(await listOrders(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/purchasing/orders/:id", validate("param", idParam), async (c) => {
    const order = await getOrder(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    const flags = await qualityFlags(c, [order.supplier.id]);
    // Null when quality is off or unreadable; otherwise the supplier's open non-conformances.
    return c.json({
      ...order,
      supplierQuality: flags
        ? (flags.get(order.supplier.id) ?? {
            open: 0,
            critical: 0,
            major: 0,
            overdue: 0,
            suggest: false,
            reasons: [] as string[],
          })
        : null,
    });
  })
  .post("/purchasing/orders", validate("json", purchaseOrderCreateSchema), async (c) =>
    c.json(await createOrder(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/purchasing/orders/:id",
    validate("param", idParam),
    validate("json", purchaseOrderUpdateSchema),
    async (c) =>
      c.json(
        await updateOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/purchasing/orders/:id", validate("param", idParam), async (c) => {
    await deleteOrder(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  // Goods-in against the order: agents may record deliveries, as with stock goods-in.
  .post(
    "/purchasing/orders/:id/receipts",
    validate("param", idParam),
    validate("json", purchaseReceiveSchema),
    async (c) =>
      c.json(
        await receiveOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
        ),
        201,
      ),
  )

  // ── A signed-in person, always (`forbidTokens`) ──
  // Approving an order above the threshold for sending: a manager other than whoever raised it.
  .post(
    "/purchasing/orders/:id/approve",
    forbidTokens,
    requireModuleLevel("purchasing", "manage"),
    validate("param", idParam),
    validate("json", purchaseOrderApproveSchema),
    async (c) =>
      c.json(
        await approveOrderSend(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // A refusal recorded in error is voided; it stays on the order and counts nowhere.
  .post(
    "/purchasing/orders/:id/receipts/:receiptId/void",
    forbidTokens,
    requireModuleLevel("purchasing", "manage"),
    validate("param", receiptParam),
    validate("json", purchaseReceiptVoidSchema),
    async (c) => {
      const { id, receiptId } = c.req.valid("param");
      return c.json(
        await voidRejectedReceipt(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          id,
          receiptId,
          c.req.valid("json"),
        ),
      );
    },
  )
  .put(
    "/purchasing/settings",
    forbidTokens,
    requireModuleLevel("purchasing", "manage"),
    validate("json", purchaseOrderSettingsUpdateSchema),
    async (c) =>
      c.json(await updateOrderSettings(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )
  .get("/purchasing/settings", async (c) => c.json(await getOrderSettings(c.var.db, c.var.workspace.id)))

  // ── A signed-in person, or a token where the workspace allows it (`personOrToken`) ──
  .post(
    "/purchasing/orders/:id/send",
    personOrToken("purchasing.send"),
    requireModuleLevel("purchasing", "manage"),
    validate("param", idParam),
    validate("json", purchaseOrderSendSchema),
    async (c) =>
      c.json(
        await sendOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          undefined,
          // A token may carry a cap on the value of an order it sends.
          c.var.credential.kind === "token" ? (c.var.credential.maxOrderValue ?? null) : null,
          {
            active: c.var.activeModules,
            // Overriding supplier control issues is a food-safety judgement: a person with Items manage.
            mayOverride:
              c.var.credential.kind !== "token" && hasModuleLevel(c.var.workspace.modules.items, "manage"),
          },
        ),
      ),
  )
  // Emailing the sent order to the supplier is part of sending it: the same switch, the same level.
  .post(
    "/purchasing/orders/:id/email",
    personOrToken("purchasing.send"),
    requireModuleLevel("purchasing", "manage"),
    validate("param", idParam),
    validate("json", purchaseOrderEmailSchema),
    async (c) =>
      c.json(
        await emailOrder(
          c.var.db,
          c.var.mailer,
          c.var.workspace.id,
          c.var.workspace.name,
          { id: c.var.user.id, name: c.var.user.name },
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/purchasing/orders/:id/close",
    personOrToken("purchasing.close"),
    validate("param", idParam),
    validate("json", purchaseOrderCloseSchema),
    async (c) =>
      c.json(
        await closeOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/purchasing/orders/:id/cancel",
    personOrToken("purchasing.cancel"),
    validate("param", idParam),
    validate("json", purchaseOrderCancelSchema),
    async (c) =>
      c.json(
        await cancelOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Suggestions from production's shortfall (computed on read) ──
  .get("/purchasing/suggestions", validate("query", purchaseSuggestionsQuerySchema), async (c) => {
    assertProductionReadable(c);
    const range = purchaseSuggestionsRange(c.req.valid("query"), todayIn(c));
    if (range.error) throw badRequest(range.error);
    return c.json(await getSuggestions(c.var.db, c.var.workspace.id, { from: range.from, to: range.to }));
  })
  // Draft orders from a chosen proposal, all or nothing, each as `POST /purchasing/orders`.
  .post("/purchasing/suggestions", validate("json", purchaseSuggestionsCreateSchema), async (c) =>
    c.json(
      await createSuggestedOrders(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )

  // ── Supplier price lists (`write`; tokens allowed: they only set the default price of new lines) ──
  .get("/purchasing/prices", validate("query", supplierPriceListQuerySchema), async (c) =>
    c.json(await listSupplierPrices(c.var.db, c.var.workspace.id, c.req.valid("query"), todayIn(c))),
  )
  .post("/purchasing/prices", validate("json", supplierPriceCreateSchema), async (c) =>
    c.json(await createSupplierPrice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/purchasing/prices/:id",
    validate("param", idParam),
    validate("json", supplierPriceUpdateSchema),
    async (c) =>
      c.json(
        await updateSupplierPrice(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/purchasing/prices/:id", validate("param", idParam), async (c) => {
    await deleteSupplierPrice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── Supplier performance ──
  .get("/purchasing/supplier-performance", validate("query", supplierPerformanceQuerySchema), async (c) => {
    const performance = await getSupplierPerformance(c.var.db, c.var.workspace.id, c.req.valid("query"));
    const flags = await qualityFlags(
      c,
      performance.suppliers.map((s) => s.supplier.id),
    );
    // `qualityFlag` is null where quality is off or unreadable, or the supplier has nothing open.
    return c.json({
      ...performance,
      suppliers: performance.suppliers.map((s) => ({
        ...s,
        qualityFlag: flags ? (flags.get(s.supplier.id) ?? null) : null,
      })),
    });
  });
