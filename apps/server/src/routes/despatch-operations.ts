import {
  despatchAllocationSchema,
  despatchUnallocateSchema,
  despatchPackSchema,
  despatchLoadSchema,
  despatchProofSchema,
  despatchReturnSchema,
  despatchReturnVoidSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel, assertModule } from "../middleware/modules";
import { validate } from "../validate";
import {
  getDespatchOperations,
  allocateDespatch,
  unallocateDespatch,
  packDespatch,
  checkDespatchLoad,
  recordDespatchProof,
  receiveDespatchReturn,
  voidDespatchReturn,
} from "../services/despatch-operations";
const idParam = z.object({ id: z.uuid() });
export const despatchOperationRoutes = new Hono<WorkspaceEnv>()
  .get("/despatch/:id/operations", validate("param", idParam), async (c) =>
    c.json(await getDespatchOperations(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/despatch/:id/allocate",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchAllocationSchema),
    async (c) =>
      c.json(
        await allocateDespatch(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/despatch/:id/unallocate",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchUnallocateSchema),
    async (c) =>
      c.json(
        await unallocateDespatch(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/despatch/:id/pack",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchPackSchema),
    async (c) =>
      c.json(
        await packDespatch(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/despatch/:id/load-check",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchLoadSchema),
    async (c) =>
      c.json(
        await checkDespatchLoad(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/despatch/:id/proof",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchProofSchema),
    async (c) =>
      c.json(
        await recordDespatchProof(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/despatch/:id/returns",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", idParam),
    validate("json", despatchReturnSchema),
    async (c) => {
      if (c.req.valid("json").incidentId) {
        assertModule(c, "quality", "read");
        assertModule(c, "production", "read");
      }
      return c.json(
        await receiveDespatchReturn(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          c.var.activeModules.includes("food_items"),
        ),
        201,
      );
    },
  )
  .post(
    "/despatch/:id/returns/:returnId/void",
    forbidTokens,
    requireModuleLevel("despatch", "manage"),
    validate("param", z.object({ id: z.uuid(), returnId: z.uuid() })),
    validate("json", despatchReturnVoidSchema),
    async (c) =>
      c.json(
        await voidDespatchReturn(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").returnId,
          c.req.valid("json"),
        ),
      ),
  );
