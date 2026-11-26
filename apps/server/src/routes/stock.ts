import { ledgerInput } from "../middleware/ledger-command";
import {
  hasModuleLevel,
  lotReleaseExceptionApproveSchema,
  lotReleaseExceptionRejectSchema,
  lotReleaseExceptionRequestSchema,
  lotReleaseRuleInputSchema,
  lotStatusChangeSchema,
  stockAdjustmentSchema,
  stockLevelsQuerySchema,
  stockLocationCreateSchema,
  stockLocationListQuerySchema,
  stockLocationUpdateSchema,
  stockLotListQuerySchema,
  stockMovementListQuerySchema,
  stockMovementReverseSchema,
  stockPickQuerySchema,
  stockReceiptSchema,
  stocktakeSchema,
  stockTransferSchema,
  stockWasteSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { requireModuleLevel } from "../middleware/modules";
import { personOrToken } from "../middleware/token-actions";
import {
  adjustStock,
  createLocation,
  getLot,
  listLocations,
  listLots,
  listMovements,
  listStockLevels,
  postStocktake,
  receiveStock,
  reverseMovement,
  setLotStatus,
  suggestPick,
  transferStock,
  updateLocation,
  wasteStock,
} from "../services/stock";
import {
  deleteReleaseRule,
  getReleaseCheck,
  listLotReleases,
  listReleaseRules,
  setReleaseRule,
} from "../services/lot-release";
import {
  approveReleaseException,
  listReleaseExceptions,
  rejectReleaseException,
  requestReleaseException,
} from "../services/lot-release-exceptions";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const exceptionParam = z.object({ id: z.uuid(), requestId: z.uuid() });
const itemIdParam = z.object({ itemId: z.uuid() });

/**
 * Stock module (`stock`): locations, lots and the movement ledger. Mounted at
 * `/v1/workspaces/:slug`; the module guard has already required `read` for safe methods and
 * `write` for the rest.
 *
 * There is deliberately no route that updates or deletes a movement: the ledger is append-only.
 * Waste and adjustments destroy or invent stock, and lot status, stocktakes and reversals are
 * sign-offs, so those need a signed-in person (`forbidTokens`); all but waste also need `manage`.
 * Waste, adjustments and stocktakes are operations an owner or admin may open to API tokens under
 * Settings → API access (`personOrToken`); lot status and reversals never are.
 */
export const stockRoutes = new Hono<WorkspaceEnv>()
  // ── Locations ──
  .get("/stock/locations", validate("query", stockLocationListQuerySchema), async (c) =>
    c.json({ locations: await listLocations(c.var.db, c.var.workspace.id, c.req.valid("query")) }),
  )
  .post("/stock/locations", validate("json", stockLocationCreateSchema), async (c) =>
    c.json(await createLocation(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/stock/locations/:id",
    validate("param", idParam),
    validate("json", stockLocationUpdateSchema),
    async (c) =>
      c.json(
        await updateLocation(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Reading ──
  .get("/stock/levels", validate("query", stockLevelsQuerySchema), async (c) =>
    c.json(await listStockLevels(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/stock/lots", validate("query", stockLotListQuerySchema), async (c) =>
    c.json(await listLots(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/stock/lots/:id", validate("param", idParam), async (c) =>
    c.json(await getLot(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .get("/stock/movements", validate("query", stockMovementListQuerySchema), async (c) =>
    c.json(await listMovements(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  // A read-only FEFO suggestion: it reserves nothing.
  .get(
    "/stock/items/:itemId/pick",
    validate("param", itemIdParam),
    validate("query", stockPickQuerySchema),
    async (c) =>
      c.json(
        await suggestPick(c.var.db, c.var.workspace.id, c.req.valid("param").itemId, c.req.valid("query")),
      ),
  )

  // ── Ordinary writes (`write`; tokens allowed) ──
  .post("/stock/receipts", validate("json", stockReceiptSchema), async (c) =>
    c.json(
      await receiveStock(c.var.db, c.var.workspace.id, c.var.user.id, ledgerInput(c, c.req.valid("json")), {
        canManage: hasModuleLevel(c.var.workspace.modules.stock, "manage"),
        foodItems: c.var.activeModules.includes("food_items"),
      }),
      201,
    ),
  )
  .post("/stock/transfers", validate("json", stockTransferSchema), async (c) =>
    c.json(await transferStock(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )

  // ── A signed-in person (waste, adjustments and stocktakes: or a token where allowed, `personOrToken`) ──
  .post("/stock/waste", personOrToken("stock.waste"), validate("json", stockWasteSchema), async (c) =>
    c.json(await wasteStock(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post(
    "/stock/adjustments",
    personOrToken("stock.adjust"),
    requireModuleLevel("stock", "manage"),
    validate("json", stockAdjustmentSchema),
    async (c) =>
      c.json(await adjustStock(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  // QA uses installation modules for evidence. Workspace access only controls what the viewer sees.
  .post(
    "/stock/lots/:id/status",
    forbidTokens,
    requireModuleLevel("stock", "manage"),
    validate("param", idParam),
    validate("json", lotStatusChangeSchema),
    async (c) =>
      c.json(
        await setLotStatus(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          { active: c.var.workspace.availableModules, access: c.var.workspace.modules },
        ),
      ),
  )
  // What a release of the lot would be checked against, as it stands now.
  .get("/stock/lots/:id/release-check", validate("param", idParam), async (c) =>
    c.json(
      await getReleaseCheck(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        c.var.workspace.availableModules,
        c.var.workspace.modules,
      ),
    ),
  )
  .get("/stock/lots/:id/releases", validate("param", idParam), async (c) =>
    c.json(
      await listLotReleases(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.var.workspace.modules),
    ),
  )
  // Releasing a blocked lot as an exception: one manager requests, another approves (a person each).
  .get("/stock/lots/:id/release-exceptions", validate("param", idParam), async (c) =>
    c.json(
      await listReleaseExceptions(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        c.var.workspace.modules,
      ),
    ),
  )
  .post(
    "/stock/lots/:id/release-exceptions",
    forbidTokens,
    requireModuleLevel("stock", "manage"),
    validate("param", idParam),
    validate("json", lotReleaseExceptionRequestSchema),
    async (c) =>
      c.json(
        await requestReleaseException(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          { active: c.var.workspace.availableModules, access: c.var.workspace.modules },
        ),
        201,
      ),
  )
  .post(
    "/stock/lots/:id/release-exceptions/:requestId/approve",
    forbidTokens,
    requireModuleLevel("stock", "manage"),
    validate("param", exceptionParam),
    validate("json", lotReleaseExceptionApproveSchema),
    async (c) =>
      c.json(
        await approveReleaseException(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").requestId,
          c.req.valid("json"),
          { active: c.var.workspace.availableModules },
        ),
      ),
  )
  .post(
    "/stock/lots/:id/release-exceptions/:requestId/reject",
    forbidTokens,
    requireModuleLevel("stock", "manage"),
    validate("param", exceptionParam),
    validate("json", lotReleaseExceptionRejectSchema),
    async (c) =>
      c.json(
        await rejectReleaseException(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("param").requestId,
          c.req.valid("json"),
          c.var.workspace.modules,
        ),
      ),
  )
  .get("/stock/release-rules", async (c) => c.json(await listReleaseRules(c.var.db, c.var.workspace.id)))
  // Release rules are part of the QA control: a person with `manage`, never an API token.
  .put(
    "/stock/release-rules/:itemId",
    forbidTokens,
    requireModuleLevel("stock", "manage"),
    validate("param", z.object({ itemId: z.uuid() })),
    validate("json", lotReleaseRuleInputSchema),
    async (c) =>
      c.json(
        await setReleaseRule(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").itemId,
          c.req.valid("json"),
        ),
      ),
  )
  .delete(
    "/stock/release-rules/:itemId",
    forbidTokens,
    requireModuleLevel("stock", "manage"),
    validate("param", z.object({ itemId: z.uuid() })),
    async (c) => {
      await deleteReleaseRule(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").itemId);
      return c.body(null, 204);
    },
  )
  .post(
    "/stock/stocktakes",
    personOrToken("stock.stocktake"),
    requireModuleLevel("stock", "manage"),
    validate("json", stocktakeSchema),
    async (c) =>
      c.json(await postStocktake(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .post(
    "/stock/movements/:id/reverse",
    forbidTokens,
    requireModuleLevel("stock", "manage"),
    validate("param", idParam),
    validate("json", stockMovementReverseSchema),
    async (c) =>
      c.json(
        await reverseMovement(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
        201,
      ),
  );
