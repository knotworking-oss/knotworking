import {
  specificationCreateSchema,
  specificationDraftSchema,
  specificationListQuerySchema,
  specificationUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import {
  approveSpecificationDraft,
  createSpecification,
  deleteSpecification,
  discardSpecificationDraft,
  getSpecification,
  getSpecificationImpact,
  getSpecificationVersion,
  listSpecifications,
  saveSpecificationDraft,
  updateSpecification,
} from "../services/specifications";
import { workspaceToday } from "../services/time-zone";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const versionParam = z.object({ id: z.uuid(), versionId: z.uuid() });

/**
 * Specifications module (`specifications`). Mounted at `/v1/workspaces/:slug`; the module guard
 * has already required `read` for safe methods and `write` for the rest.
 */
export const specificationRoutes = new Hono<WorkspaceEnv>()
  .get("/specifications", validate("query", specificationListQuerySchema), async (c) =>
    c.json(
      await listSpecifications(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("query"),
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
    ),
  )
  .get("/specifications/:id", validate("param", idParam), async (c) =>
    c.json(
      await getSpecification(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
    ),
  )
  .get("/specifications/:id/versions/:versionId", validate("param", versionParam), async (c) => {
    const { id, versionId } = c.req.valid("param");
    return c.json(await getSpecificationVersion(c.var.db, c.var.workspace.id, id, versionId));
  })
  // Recipes, labels and batches are listed only for readers of those modules.
  .get("/specifications/:id/impact", validate("param", idParam), async (c) =>
    c.json(
      await getSpecificationImpact(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        {
          recipes: canRead(c, "recipes"),
          labels: canRead(c, "labels"),
          production: canRead(c, "production"),
        },
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
    ),
  )
  .post("/specifications", validate("json", specificationCreateSchema), async (c) =>
    c.json(
      await createSpecification(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
      201,
    ),
  )
  .patch(
    "/specifications/:id",
    validate("param", idParam),
    validate("json", specificationUpdateSchema),
    async (c) =>
      c.json(
        await updateSpecification(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      ),
  )
  .put(
    "/specifications/:id/draft",
    validate("param", idParam),
    validate("json", specificationDraftSchema),
    async (c) =>
      c.json(
        await saveSpecificationDraft(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      ),
  )
  .delete("/specifications/:id/draft", validate("param", idParam), async (c) => {
    await discardSpecificationDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  // Approval is a document-control sign-off: a person with `manage`, never an API token.
  .post(
    "/specifications/:id/draft/approve",
    forbidTokens,
    requireModuleLevel("specifications", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await approveSpecificationDraft(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.activeModules,
          c.req.valid("param").id,
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      ),
  )
  .delete("/specifications/:id", validate("param", idParam), async (c) => {
    await deleteSpecification(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
