import {
  accountingConnectionCreateSchema,
  accountingConnectionUpdateSchema,
  accountingInvoiceListSchema,
  accountingInvoicePrepareSchema,
  accountingMappingSchema,
  accountingQueueListSchema,
  accountingReadBackSchema,
  accountingRetrySchema,
  accountingPageSchema,
  accountingProviderCandidates,
  accountingReferencesSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { xeroRoutes } from "./xero";
import { requireAdmin } from "../middleware/roles";
import { assertModule, canRead, requireModuleLevel } from "../middleware/modules";
import { validate } from "../validate";
import {
  accountingConfigurationHistory,
  accountingReferences,
  createAccountingConnection,
  getAccountingConnection,
  listAccountingConnections,
  saveAccountingMapping,
  updateAccountingConnection,
} from "../services/accounting";
import {
  getPreparableInvoice,
  listPreparableInvoices,
  prepareInvoicePosting,
} from "../accounting/purchase-invoices";
import {
  getAccountingQueueItem,
  listAccountingQueue,
  readBackAccountingQueueItem,
  retryAccountingQueueItem,
  sendAccountingPostingNow,
} from "../accounting/queue";
const id = z.object({ id: z.uuid() });
const invoiceParam = z.object({ id: z.uuid(), invoiceId: z.uuid() });
const postingParam = z.object({ id: z.uuid(), postingId: z.uuid() });
const manage = requireModuleLevel("accounting", "manage");
/** Financial setup is administration by a signed-in person; no token or MCP configuration access. */
export const accountingRoutes = new Hono<WorkspaceEnv>()
  .use("/accounting/*", requireAdmin, manage)
  .route("/accounting/connections/:id/xero", xeroRoutes)
  .get("/accounting/connections", validate("query", accountingPageSchema), async (c) =>
    c.json({
      ...(await listAccountingConnections(c.var.db, c.var.workspace.id, c.req.valid("query").offset)),
      providers: accountingProviderCandidates,
      xeroConfigured: !!c.var.xero,
      canMapSuppliers: canRead(c, "items"),
      canMapCustomers: canRead(c, "customers"),
      canPrepareInvoices: canRead(c, "purchasing"),
    }),
  )
  .post("/accounting/connections", validate("json", accountingConnectionCreateSchema), async (c) =>
    c.json(
      await createAccountingConnection(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      201,
    ),
  )
  .get("/accounting/references", validate("query", accountingReferencesSchema), async (c) => {
    const query = c.req.valid("query");
    assertModule(c, query.kind === "supplier" ? "items" : "customers", "read");
    return c.json(await accountingReferences(c.var.db, c.var.workspace.id, query.kind, query.q));
  })
  .get("/accounting/connections/:id", validate("param", id), async (c) =>
    c.json(
      await getAccountingConnection(c.var.db, c.var.workspace.id, c.req.valid("param").id, {
        suppliers: canRead(c, "items"),
        customers: canRead(c, "customers"),
      }),
    ),
  )
  .patch(
    "/accounting/connections/:id",
    validate("param", id),
    validate("json", accountingConnectionUpdateSchema),
    async (c) =>
      c.json(
        await updateAccountingConnection(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .put(
    "/accounting/connections/:id/mappings",
    validate("param", id),
    validate("json", accountingMappingSchema),
    async (c) => {
      const input = c.req.valid("json");
      if (input.kind === "supplier" || input.kind === "customer")
        assertModule(c, input.kind === "supplier" ? "items" : "customers", "read");
      return c.json(
        await saveAccountingMapping(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          input,
        ),
      );
    },
  )
  .get(
    "/accounting/connections/:id/history",
    validate("param", id),
    validate("query", accountingPageSchema),
    async (c) =>
      c.json(
        await accountingConfigurationHistory(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query").offset,
        ),
      ),
  )
  // Preparing approved purchase invoices: the reviewer also needs to read purchasing.
  .get(
    "/accounting/connections/:id/purchase-invoices",
    validate("param", id),
    validate("query", accountingInvoiceListSchema),
    async (c) => {
      assertModule(c, "purchasing", "read");
      return c.json(
        await listPreparableInvoices(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
      );
    },
  )
  .get(
    "/accounting/connections/:id/purchase-invoices/:invoiceId",
    validate("param", invoiceParam),
    async (c) => {
      assertModule(c, "purchasing", "read");
      const { id: connectionId, invoiceId } = c.req.valid("param");
      return c.json(await getPreparableInvoice(c.var.db, c.var.workspace.id, connectionId, invoiceId));
    },
  )
  .post(
    "/accounting/connections/:id/purchase-invoices/:invoiceId/prepare",
    validate("param", invoiceParam),
    validate("json", accountingInvoicePrepareSchema),
    async (c) => {
      assertModule(c, "purchasing", "read");
      const { id: connectionId, invoiceId } = c.req.valid("param");
      return c.json(
        await prepareInvoicePosting(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          connectionId,
          invoiceId,
          c.req.valid("json"),
        ),
        201,
      );
    },
  )
  // The finance review of a connection's outbox.
  .get(
    "/accounting/connections/:id/postings",
    validate("param", id),
    validate("query", accountingQueueListSchema),
    async (c) =>
      c.json(
        await listAccountingQueue(
          c.var.db,
          c.var.workspace,
          c.req.valid("param").id,
          c.var.accountingAdapters,
          c.req.valid("query"),
        ),
      ),
  )
  .get("/accounting/connections/:id/postings/:postingId", validate("param", postingParam), async (c) => {
    const { id: connectionId, postingId } = c.req.valid("param");
    return c.json(await getAccountingQueueItem(c.var.db, c.var.workspace.id, connectionId, postingId));
  })
  .post(
    "/accounting/connections/:id/postings/:postingId/send",
    validate("param", postingParam),
    async (c) => {
      const { id: connectionId, postingId } = c.req.valid("param");
      return c.json(
        await sendAccountingPostingNow(
          c.var.db,
          c.var.workspace,
          connectionId,
          postingId,
          c.var.user.id,
          c.var.accountingAdapters,
        ),
      );
    },
  )
  .post(
    "/accounting/connections/:id/postings/:postingId/retry",
    validate("param", postingParam),
    validate("json", accountingRetrySchema),
    async (c) => {
      const { id: connectionId, postingId } = c.req.valid("param");
      return c.json(
        await retryAccountingQueueItem(
          c.var.db,
          c.var.workspace.id,
          connectionId,
          postingId,
          c.var.user.id,
          c.req.valid("json"),
        ),
      );
    },
  )
  .post(
    "/accounting/connections/:id/postings/:postingId/read-back",
    validate("param", postingParam),
    validate("json", accountingReadBackSchema),
    async (c) => {
      const { id: connectionId, postingId } = c.req.valid("param");
      return c.json(
        await readBackAccountingQueueItem(
          c.var.db,
          c.var.workspace,
          connectionId,
          postingId,
          c.var.user.id,
          c.var.accountingAdapters,
          c.req.valid("json"),
        ),
      );
    },
  );
