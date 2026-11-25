import {
  hasModuleLevel,
  purchaseRequestCreateSchema,
  purchaseRequestDecisionSchema,
  purchaseRequestListSchema,
} from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule } from "../middleware/modules";
import { emailNotifier } from "../services/notifications";
import {
  decidePurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  submitPurchaseRequest,
} from "../services/purchase-requests";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const viewerOf = (c: Context<WorkspaceEnv>) => ({
  id: c.var.user.id,
  canManage: hasModuleLevel(c.var.workspace.modules.purchase_requests, "manage"),
});

export const purchaseRequestRoutes = new Hono<WorkspaceEnv>()
  .get("/purchase-requests", validate("query", purchaseRequestListSchema), async (c) =>
    c.json(
      await listPurchaseRequests(
        c.var.db,
        c.var.workspace.id,
        c.var.activeModules,
        viewerOf(c),
        c.req.valid("query"),
      ),
    ),
  )
  .get("/purchase-requests/:id", validate("param", idParam), async (c) =>
    c.json(await getPurchaseRequest(c.var.db, c.var.workspace.id, viewerOf(c), c.req.valid("param").id)),
  )
  .post("/purchase-requests", validate("json", purchaseRequestCreateSchema), async (c) =>
    c.json(
      await submitPurchaseRequest(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.var.activeModules,
        c.var.workspace.currency,
        c.req.valid("json"),
        emailNotifier(c.var),
      ),
      201,
    ),
  )
  .post(
    "/purchase-requests/:id/decision",
    forbidTokens,
    validate("param", idParam),
    validate("json", purchaseRequestDecisionSchema),
    async (c) => {
      const decision = c.req.valid("json");
      if (decision.status !== "withdrawn") assertModule(c, "purchase_requests", "manage");
      return c.json(
        await decidePurchaseRequest(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          decision,
          emailNotifier(c.var),
        ),
      );
    },
  );
