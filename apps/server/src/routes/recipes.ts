import {
  recipeCreateSchema,
  recipeDraftSchema,
  recipeListQuerySchema,
  recipeScaleQuerySchema,
  recipeUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, canRead, requireModuleLevel } from "../middleware/modules";
import {
  approveRecipeDraft,
  createRecipe,
  deleteRecipe,
  discardRecipeDraft,
  getRecipe,
  getRecipeVersion,
  listRecipes,
  saveRecipeDraft,
  updateRecipe,
} from "../services/recipes";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const versionParam = z.object({ id: z.uuid(), versionId: z.uuid() });

/**
 * Recipes module (`recipes`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest.
 */
export const recipeRoutes = new Hono<WorkspaceEnv>()
  .get("/", validate("query", recipeListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    if (query.allergenDrift !== undefined) assertModule(c, "food_items", "read");
    return c.json(await listRecipes(c.var.db, c.var.workspace.id, query, canRead(c, "food_items")));
  })
  .get("/:id", validate("param", idParam), async (c) =>
    c.json(await getRecipe(c.var.db, c.var.workspace.id, c.req.valid("param").id, canRead(c, "food_items"))),
  )
  .get(
    "/:id/versions/:versionId",
    validate("param", versionParam),
    validate("query", recipeScaleQuerySchema),
    async (c) => {
      const { id, versionId } = c.req.valid("param");
      return c.json(
        await getRecipeVersion(
          c.var.db,
          c.var.workspace.id,
          id,
          versionId,
          canRead(c, "food_items"),
          c.req.valid("query"),
        ),
      );
    },
  )
  .post("/", validate("json", recipeCreateSchema), async (c) =>
    c.json(
      await createRecipe(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("json"),
        canRead(c, "food_items"),
      ),
      201,
    ),
  )
  .patch("/:id", validate("param", idParam), validate("json", recipeUpdateSchema), async (c) =>
    c.json(
      await updateRecipe(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
        canRead(c, "food_items"),
      ),
    ),
  )
  .put("/:id/draft", validate("param", idParam), validate("json", recipeDraftSchema), async (c) =>
    c.json(
      await saveRecipeDraft(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
        canRead(c, "food_items"),
      ),
    ),
  )
  .delete("/:id/draft", validate("param", idParam), async (c) => {
    await discardRecipeDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  // Approval is a document-control sign-off: a person with `manage`, never an API token.
  .post(
    "/:id/draft/approve",
    forbidTokens,
    requireModuleLevel("recipes", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await approveRecipeDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, {
          active: c.var.activeModules.includes("food_items"),
          readable: canRead(c, "food_items"),
        }),
      ),
  )
  .delete("/:id", validate("param", idParam), async (c) => {
    await deleteRecipe(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
