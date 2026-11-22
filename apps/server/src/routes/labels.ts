import {
  csvImportSchema,
  itemLabelDataSchema,
  labelFactsQuerySchema,
  labellingItemListQuerySchema,
  productLabelCreateSchema,
  productLabelListQuerySchema,
  productLabelRefreshSchema,
  productLabelUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import { importNutritionCsv } from "../services/labels-import";
import {
  approveProductLabel,
  createProductLabel,
  deleteProductLabel,
  getLabellingItem,
  getProductLabel,
  getVersionFacts,
  listLabellingItems,
  listProductLabels,
  refreshProductLabel,
  setItemLabelData,
  updateProductLabel,
} from "../services/labels";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const itemParam = z.object({ itemId: z.uuid() });
const versionParam = z.object({ id: z.uuid(), versionId: z.uuid() });

/**
 * Labels and nutrition module (`labels`). Mounted at `/v1/workspaces/:slug`, under `/labelling`
 * (the workspace's `/labels` are task labels); the module guard has already required `read` for
 * safe methods and `write` for the rest.
 *
 * - `write` (API tokens allowed): items' labelling data (nutrition from specifications), and
 *   drafting, editing, refreshing and deleting draft labels.
 * - `manage` and a signed-in person, never a token: approving a label (a sign-off).
 */
export const labelRoutes = new Hono<WorkspaceEnv>()
  // ── Items' labelling data ──
  .get("/labelling/items", validate("query", labellingItemListQuerySchema), async (c) =>
    c.json(await listLabellingItems(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // CSV import of nutrition (a specification sheet, McCance and Widdowson's columns): `dryRun`
  // checks and previews; otherwise every row is written, or none.
  .post("/labelling/items/import", validate("json", csvImportSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await importNutritionCsv(c.var.db, c.var.workspace.id, c.var.user.id, input);
    return c.json(result, input.dryRun ? 200 : 201);
  })
  .get("/labelling/items/:itemId", validate("param", itemParam), async (c) =>
    c.json(await getLabellingItem(c.var.db, c.var.workspace.id, c.req.valid("param").itemId)),
  )
  .put(
    "/labelling/items/:itemId",
    validate("param", itemParam),
    validate("json", itemLabelDataSchema),
    async (c) =>
      c.json(
        await setItemLabelData(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").itemId,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Computed for any recipe version (never stored) ──
  .get(
    "/labelling/recipes/:id/versions/:versionId",
    validate("param", versionParam),
    validate("query", labelFactsQuerySchema),
    async (c) => {
      const { id, versionId } = c.req.valid("param");
      return c.json(await getVersionFacts(c.var.db, c.var.workspace.id, id, versionId, c.req.valid("query")));
    },
  )

  // ── Product labels ──
  .get("/labelling/labels", validate("query", productLabelListQuerySchema), async (c) =>
    c.json(await listProductLabels(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/labelling/labels/:id", validate("param", idParam), async (c) =>
    c.json(await getProductLabel(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/labelling/labels", validate("json", productLabelCreateSchema), async (c) =>
    c.json(await createProductLabel(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/labelling/labels/:id",
    validate("param", idParam),
    validate("json", productLabelUpdateSchema),
    async (c) =>
      c.json(
        await updateProductLabel(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/labelling/labels/:id/refresh",
    validate("param", idParam),
    validate("json", productLabelRefreshSchema),
    async (c) =>
      c.json(
        await refreshProductLabel(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  // Approval is a sign-off: a person with `manage`, never an API token.
  .post(
    "/labelling/labels/:id/approve",
    forbidTokens,
    requireModuleLevel("labels", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await approveProductLabel(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").id,
        ),
      ),
  )
  .delete("/labelling/labels/:id", validate("param", idParam), async (c) => {
    await deleteProductLabel(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
