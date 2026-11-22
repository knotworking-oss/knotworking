import {
  despatchConfirmSchema,
  despatchImpactQuerySchema,
  despatchImpactExportQuerySchema,
  despatchDraftSchema,
  despatchListQuerySchema,
  despatchLotParamSchema,
  despatchRecipientQuerySchema,
  despatchVoidSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import {
  confirmDespatch,
  getDespatch,
  listDespatches,
  lotRecipients,
  saveDespatchDraft,
  voidDespatch,
} from "../services/despatch";
import { despatchImpact, exportDespatchImpact } from "../services/despatch-impact";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
export const despatchRoutes = new Hono<WorkspaceEnv>()
  .get("/despatch", validate("query", despatchListQuerySchema), async (c) =>
    c.json(await listDespatches(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/despatch", validate("json", despatchDraftSchema), async (c) =>
    c.json(await saveDespatchDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get(
    "/despatch/lots/:lotId/recipients",
    validate("param", despatchLotParamSchema),
    validate("query", despatchRecipientQuerySchema),
    async (c) =>
      c.json(
        await lotRecipients(c.var.db, c.var.workspace.id, c.req.valid("param").lotId, c.req.valid("query")),
      ),
  )
  .get(
    "/despatch/lots/:lotId/impact",
    requireModuleLevel("production", "read"),
    validate("param", despatchLotParamSchema),
    validate("query", despatchImpactQuerySchema),
    async (c) =>
      c.json(
        await despatchImpact(c.var.db, c.var.workspace.id, c.req.valid("param").lotId, c.req.valid("query")),
      ),
  )
  .get(
    "/despatch/lots/:lotId/impact.csv",
    requireModuleLevel("production", "read"),
    validate("param", despatchLotParamSchema),
    validate("query", despatchImpactExportQuerySchema),
    async (c) => {
      const lotId = c.req.valid("param").lotId;
      const csv = await exportDespatchImpact(c.var.db, c.var.workspace.id, lotId, c.req.valid("query").depth);
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="distribution-impact-${lotId}.csv"`);
      return c.body(csv);
    },
  )
  .get("/despatch/:id", validate("param", idParam), async (c) =>
    c.json(await getDespatch(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .put("/despatch/:id", validate("param", idParam), validate("json", despatchDraftSchema), async (c) =>
    c.json(
      await saveDespatchDraft(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        c.req.valid("param").id,
      ),
    ),
  )
  .post(
    "/despatch/:id/confirm",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchConfirmSchema),
    async (c) =>
      c.json(
        await confirmDespatch(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/despatch/:id/void",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchVoidSchema),
    async (c) =>
      c.json(
        await voidDespatch(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  );
