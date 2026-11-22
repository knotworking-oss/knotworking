import { deliverySiteSchema } from "@knotworking/core";
import { listDeliverySites, saveDeliverySite } from "../services/customer-sites";
import { customerCreateSchema, customerListQuerySchema, customerUpdateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { createCustomer, getCustomer, listCustomers, updateCustomer } from "../services/customers";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
export const customerRoutes = new Hono<WorkspaceEnv>()
  .get("/customers/:id/sites", validate("param", idParam), async (c) =>
    c.json(await listDeliverySites(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/customers/:id/sites", validate("param", idParam), validate("json", deliverySiteSchema), async (c) =>
    c.json(
      await saveDeliverySite(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
      201,
    ),
  )
  .put(
    "/customers/:id/sites/:siteId",
    validate("param", z.object({ id: z.uuid(), siteId: z.uuid() })),
    validate("json", deliverySiteSchema),
    async (c) =>
      c.json(
        await saveDeliverySite(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          c.req.valid("param").siteId,
        ),
      ),
  )
  .get("/customers", validate("query", customerListQuerySchema), async (c) =>
    c.json(await listCustomers(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/customers", validate("json", customerCreateSchema), async (c) =>
    c.json(await createCustomer(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/customers/:id", validate("param", idParam), async (c) =>
    c.json(await getCustomer(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .patch("/customers/:id", validate("param", idParam), validate("json", customerUpdateSchema), async (c) =>
    c.json(
      await updateCustomer(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  );
