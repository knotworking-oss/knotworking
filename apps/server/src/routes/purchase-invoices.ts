import {
  invoiceTolerancesUpdateSchema,
  purchaseInvoiceApproveSchema,
  purchaseInvoiceCreateSchema,
  purchaseInvoiceListQuerySchema,
  purchaseInvoiceUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import {
  approveInvoice,
  createInvoice,
  deleteInvoice,
  getInvoice,
  getInvoiceTolerances,
  listInvoices,
  reviseInvoice,
  updateInvoice,
  updateInvoiceTolerances,
} from "../services/purchase-invoices";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * Supplier invoices and the three-way match (purchasing module). Mounted at
 * `/v1/workspaces/:slug`; the module guard has already required `read` for safe methods and
 * `write` for the rest (the `/purchasing` rule covers these paths).
 *
 * - `write` (API tokens allowed, so agents can draft invoices): create, edit and delete drafts,
 *   and start a revision of an approved invoice.
 * - `manage` and a signed-in person, always (`forbidTokens`): approving for payment, and changing
 *   the match tolerances that decide what needs a reason.
 */
export const purchaseInvoiceRoutes = new Hono<WorkspaceEnv>()
  .get("/purchasing/invoice-settings", async (c) =>
    c.json(await getInvoiceTolerances(c.var.db, c.var.workspace.id)),
  )
  .put(
    "/purchasing/invoice-settings",
    forbidTokens,
    requireModuleLevel("purchasing", "manage"),
    validate("json", invoiceTolerancesUpdateSchema),
    async (c) =>
      c.json(await updateInvoiceTolerances(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
  )
  .get("/purchasing/invoices", validate("query", purchaseInvoiceListQuerySchema), async (c) =>
    c.json(await listInvoices(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/purchasing/invoices/:id", validate("param", idParam), async (c) =>
    c.json(await getInvoice(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/purchasing/invoices", validate("json", purchaseInvoiceCreateSchema), async (c) =>
    c.json(await createInvoice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/purchasing/invoices/:id",
    validate("param", idParam),
    validate("json", purchaseInvoiceUpdateSchema),
    async (c) =>
      c.json(
        await updateInvoice(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/purchasing/invoices/:id", validate("param", idParam), async (c) => {
    await deleteInvoice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  .post("/purchasing/invoices/:id/revise", validate("param", idParam), async (c) =>
    c.json(await reviseInvoice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id), 201),
  )
  // ── A signed-in person, always ──
  .post(
    "/purchasing/invoices/:id/approve",
    forbidTokens,
    requireModuleLevel("purchasing", "manage"),
    validate("param", idParam),
    validate("json", purchaseInvoiceApproveSchema),
    async (c) =>
      c.json(
        await approveInvoice(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
