import { assetCreateSchema, assetListQuerySchema, assetUpdateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireModuleLevel } from "../middleware/modules";
import { createAsset, getAsset, listAssets, setAssetStatus, updateAsset } from "../services/assets";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * The asset register (`assets`). Reading needs `read`, adding and changing `write`, archiving and
 * restoring `manage`. API tokens may keep the register like a person (no sign-offs here).
 */
export const assetRoutes = new Hono<WorkspaceEnv>()
  .get("/assets", validate("query", assetListQuerySchema), async (c) =>
    c.json(await listAssets(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/assets", validate("json", assetCreateSchema), async (c) =>
    c.json(await createAsset(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/assets/:id", validate("param", idParam), async (c) =>
    c.json(await getAsset(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .patch("/assets/:id", validate("param", idParam), validate("json", assetUpdateSchema), async (c) =>
    c.json(
      await updateAsset(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .post(
    "/assets/:id/archive",
    requireModuleLevel("assets", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await setAssetStatus(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          "archived",
        ),
      ),
  )
  .post(
    "/assets/:id/restore",
    requireModuleLevel("assets", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await setAssetStatus(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, "active"),
      ),
  );
