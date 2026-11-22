import { Hono } from "hono";
import { z } from "zod";
import {
  salesActionSchema,
  salesCommitmentsSchema,
  salesCreateSchema,
  salesExternalSchema,
  salesFulfilSchema,
  salesListSchema,
  salesPageSchema,
  salesPriceArchiveSchema,
  salesPriceSchema,
  salesSaveSchema,
  salesUnlinkSchema,
} from "@knotworking/core";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import { validate } from "../validate";
import {
  actOnSalesOrder,
  archiveSalesPrice,
  createSalesOrder,
  createSalesPrice,
  getSalesFulfilments,
  getSalesOrder,
  linkSalesFulfilment,
  listSalesOrders,
  listSalesPrices,
  listSalesReferences,
  mapSalesReference,
  salesCommitments,
  salesHistory,
  saveSalesOrder,
  unlinkSalesFulfilment,
} from "../services/sales";
const idParam = z.object({ id: z.uuid() });
const manage = requireModuleLevel("sales", "manage");
const distribution = requireModuleLevel("despatch", "read");
export const salesRoutes = new Hono<WorkspaceEnv>()
  .get("/sales/orders", validate("query", salesListSchema), async (c) =>
    c.json(await listSalesOrders(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/sales/orders", validate("json", salesCreateSchema), async (c) =>
    c.json(await createSalesOrder(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/sales/orders/:id", validate("param", idParam), async (c) =>
    c.json(await getSalesOrder(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .put("/sales/orders/:id", validate("param", idParam), validate("json", salesSaveSchema), async (c) =>
    c.json(
      await saveSalesOrder(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .get(
    "/sales/orders/:id/history",
    validate("param", idParam),
    validate("query", salesPageSchema),
    async (c) =>
      c.json(await salesHistory(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.req.valid("query"))),
  )
  .post(
    "/sales/orders/:id/amend",
    forbidTokens,
    manage,
    validate("param", idParam),
    validate("json", salesSaveSchema),
    async (c) =>
      c.json(
        await saveSalesOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          true,
        ),
      ),
  )
  .post(
    "/sales/orders/:id/confirm",
    forbidTokens,
    manage,
    validate("param", idParam),
    validate("json", salesActionSchema),
    async (c) =>
      c.json(
        await actOnSalesOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "confirm",
        ),
      ),
  )
  .post(
    "/sales/orders/:id/issue",
    forbidTokens,
    manage,
    validate("param", idParam),
    validate("json", salesActionSchema),
    async (c) =>
      c.json(
        await actOnSalesOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "issue",
        ),
      ),
  )
  .post(
    "/sales/orders/:id/cancel",
    forbidTokens,
    manage,
    validate("param", idParam),
    validate("json", salesActionSchema),
    async (c) =>
      c.json(
        await actOnSalesOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "cancel",
        ),
      ),
  )
  .post(
    "/sales/orders/:id/convert",
    forbidTokens,
    manage,
    validate("param", idParam),
    validate("json", salesActionSchema),
    async (c) =>
      c.json(
        await actOnSalesOrder(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          "convert",
        ),
      ),
  )
  .get(
    "/sales/orders/:id/fulfilments",
    distribution,
    validate("param", idParam),
    validate("query", salesPageSchema),
    async (c) =>
      c.json(
        await getSalesFulfilments(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
      ),
  )
  .post(
    "/sales/orders/:id/fulfilments",
    forbidTokens,
    manage,
    distribution,
    validate("param", idParam),
    validate("json", salesFulfilSchema),
    async (c) =>
      c.json(
        await linkSalesFulfilment(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/sales/orders/:id/fulfilments/:linkId/void",
    forbidTokens,
    manage,
    distribution,
    validate("param", idParam.extend({ linkId: z.uuid() })),
    validate("json", salesUnlinkSchema),
    async (c) =>
      c.json(
        await unlinkSalesFulfilment(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").linkId,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/sales/prices", validate("query", salesPageSchema), async (c) =>
    c.json(await listSalesPrices(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/sales/prices", forbidTokens, manage, validate("json", salesPriceSchema), async (c) =>
    c.json(await createSalesPrice(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post(
    "/sales/prices/:id/archive",
    forbidTokens,
    manage,
    validate("param", idParam),
    validate("json", salesPriceArchiveSchema),
    async (c) =>
      c.json(
        await archiveSalesPrice(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .get("/sales/commitments", validate("query", salesCommitmentsSchema), async (c) =>
    c.json(await salesCommitments(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/sales/integration", validate("query", salesPageSchema), async (c) =>
    c.json(await listSalesReferences(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/sales/integration/references", manage, validate("json", salesExternalSchema), async (c) =>
    c.json(await mapSalesReference(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  );
