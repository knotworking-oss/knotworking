import {
  serviceQuoteCreateSchema,
  serviceQuoteDecisionSchema,
  serviceQuoteListSchema,
  serviceQuoteUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, requireModuleLevel } from "../middleware/modules";
import {
  createServiceQuote,
  decideServiceQuote,
  getServiceQuote,
  listServiceQuotes,
  serviceBillingDraft,
  updateServiceQuote,
} from "../services/client-services";
import { validate } from "../validate";

const id = z.object({ id: z.uuid() });

export const clientServicesRoutes = new Hono<WorkspaceEnv>()
  .get("/client-services", validate("query", serviceQuoteListSchema), async (c) =>
    c.json(await listServiceQuotes(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/client-services", validate("json", serviceQuoteCreateSchema), async (c) =>
    c.json(await createServiceQuote(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/client-services/:id", validate("param", id), async (c) =>
    c.json(await getServiceQuote(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .patch(
    "/client-services/:id",
    validate("param", id),
    validate("json", serviceQuoteUpdateSchema),
    async (c) =>
      c.json(
        await updateServiceQuote(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/client-services/:id/decision",
    requireModuleLevel("client_services", "manage"),
    forbidTokens,
    validate("param", id),
    validate("json", serviceQuoteDecisionSchema),
    async (c) => {
      const decision = c.req.valid("json");
      if (decision.action === "accept") assertModule(c, "tasks", "write");
      return c.json(
        await decideServiceQuote(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          decision,
        ),
      );
    },
  )
  .get("/client-services/:id/billing-draft.csv", validate("param", id), async (c) => {
    const draft = await serviceBillingDraft(c.var.db, c.var.workspace.id, c.req.valid("param").id);
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${draft.filename}"`);
    return c.body(draft.csv);
  });
