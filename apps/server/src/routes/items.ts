import {
  csvImportSchema,
  itemCreateSchema,
  hasFoodItemFields,
  itemListQuerySchema,
  itemUpdateSchema,
  supplierApprovalSchema,
  supplierControlSettingsSchema,
  supplierQuestionnaireCreateSchema,
  supplierQuestionnaireReceiveSchema,
  supplierQuestionnaireReviewSchema,
  supplierRiskAssessmentSchema,
  supplierCreateSchema,
  supplierListQuerySchema,
  supplierUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, canRead, requireModuleLevel } from "../middleware/modules";
import {
  createItem,
  createSupplier,
  deleteItem,
  deleteSupplier,
  getItem,
  getSupplier,
  listItems,
  listSuppliers,
  setSupplierApproval,
  updateItem,
  updateSupplier,
} from "../services/items";
import { importItemsCsv, importSuppliersCsv } from "../services/items-import";
import {
  assessSupplierRisk,
  createQuestionnaire,
  getSupplierControlSettings,
  getSupplierControls,
  updateSupplierControlSettings,
  listSupplierCompliance,
  receiveQuestionnaire,
  reviewQuestionnaire,
} from "../services/supplier-controls";
import { workspaceToday } from "../services/time-zone";
import { validate } from "../validate";

const questionnaireParam = z.object({ id: z.uuid(), questionnaireId: z.uuid() });

const idParam = z.object({ id: z.uuid() });

/**
 * Items module (`items`): items and suppliers. Mounted at `/v1/workspaces/:slug`; the module
 * guard has already required `read` for safe methods and `write` for the rest.
 */
export const itemRoutes = new Hono<WorkspaceEnv>()
  // ── Items ──
  .get("/items", validate("query", itemListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    if (query.allergen !== undefined) assertModule(c, "food_items", "read");
    return c.json(await listItems(c.var.db, c.var.workspace.id, query, canRead(c, "food_items")));
  })
  // CSV import: `dryRun` checks and previews; otherwise every row is written, or none.
  .post("/items/import", validate("json", csvImportSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await importItemsCsv(c.var.db, c.var.workspace.id, c.var.user.id, input, () =>
      assertModule(c, "food_items", "write"),
    );
    return c.json(result, input.dryRun ? 200 : 201);
  })
  .get("/items/:id", validate("param", idParam), async (c) =>
    c.json(await getItem(c.var.db, c.var.workspace.id, c.req.valid("param").id, canRead(c, "food_items"))),
  )
  .post("/items", validate("json", itemCreateSchema), async (c) => {
    const input = c.req.valid("json");
    if (hasFoodItemFields(input)) assertModule(c, "food_items", "write");
    return c.json(
      await createItem(c.var.db, c.var.workspace.id, c.var.user.id, input, canRead(c, "food_items")),
      201,
    );
  })
  .patch("/items/:id", validate("param", idParam), validate("json", itemUpdateSchema), async (c) => {
    const patch = c.req.valid("json");
    if (hasFoodItemFields(patch)) assertModule(c, "food_items", "write");
    return c.json(
      await updateItem(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        patch,
        canRead(c, "food_items"),
      ),
    );
  })
  .delete("/items/:id", validate("param", idParam), async (c) => {
    await deleteItem(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  // ── Suppliers ──
  .get("/suppliers", validate("query", supplierListQuerySchema), async (c) =>
    c.json({ suppliers: await listSuppliers(c.var.db, c.var.workspace.id, c.req.valid("query")) }),
  )
  // Every supplier's risk level and the control issues to act on.
  .get("/suppliers/compliance", async (c) =>
    c.json(
      await listSupplierCompliance(
        c.var.db,
        c.var.workspace.id,
        c.var.workspace.availableModules,
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
    ),
  )
  // CSV import. Approval is never imported: it is a person's sign-off (`POST /suppliers/:id/approval`).
  .post("/suppliers/import", validate("json", csvImportSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await importSuppliersCsv(c.var.db, c.var.workspace.id, c.var.user.id, input);
    return c.json(result, input.dryRun ? 200 : 201);
  })
  // Whether open supplier control issues block approval and orders: a person with Items manage.
  .get("/suppliers/control-settings", async (c) =>
    c.json(await getSupplierControlSettings(c.var.db, c.var.workspace.id)),
  )
  .put(
    "/suppliers/control-settings",
    forbidTokens,
    requireModuleLevel("items", "manage"),
    validate("json", supplierControlSettingsSchema),
    async (c) =>
      c.json(
        await updateSupplierControlSettings(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")),
      ),
  )
  .get("/suppliers/:id", validate("param", idParam), async (c) =>
    c.json(await getSupplier(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/suppliers", validate("json", supplierCreateSchema), async (c) =>
    c.json(await createSupplier(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch("/suppliers/:id", validate("param", idParam), validate("json", supplierUpdateSchema), async (c) =>
    c.json(
      await updateSupplier(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  // Supplier approval is a food-safety sign-off: a person with `manage`, never an API token.
  .post(
    "/suppliers/:id/approval",
    forbidTokens,
    requireModuleLevel("items", "manage"),
    validate("param", idParam),
    validate("json", supplierApprovalSchema),
    async (c) =>
      c.json(
        await setSupplierApproval(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          { active: c.var.workspace.availableModules },
        ),
      ),
  )
  // ── Supplier controls: risk assessments and questionnaires ──
  .get("/suppliers/:id/controls", validate("param", idParam), async (c) =>
    c.json(
      await getSupplierControls(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        c.var.workspace.availableModules,
        await workspaceToday(c.var.db, c.var.workspace.id),
      ),
    ),
  )
  // A risk assessment decides the controls a supplier is held to: a person with `manage`.
  .post(
    "/suppliers/:id/risk-assessments",
    forbidTokens,
    requireModuleLevel("items", "manage"),
    validate("param", idParam),
    validate("json", supplierRiskAssessmentSchema),
    async (c) => {
      const today = await workspaceToday(c.var.db, c.var.workspace.id);
      const id = c.req.valid("param").id;
      await assessSupplierRisk(c.var.db, c.var.workspace.id, c.var.user.id, id, c.req.valid("json"), today);
      return c.json(
        await getSupplierControls(c.var.db, c.var.workspace.id, id, c.var.workspace.availableModules, today),
        201,
      );
    },
  )
  .post(
    "/suppliers/:id/questionnaires",
    validate("param", idParam),
    validate("json", supplierQuestionnaireCreateSchema),
    async (c) =>
      c.json(
        await createQuestionnaire(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
        201,
      ),
  )
  .post(
    "/suppliers/:id/questionnaires/:questionnaireId/receive",
    validate("param", questionnaireParam),
    validate("json", supplierQuestionnaireReceiveSchema),
    async (c) => {
      const { id, questionnaireId } = c.req.valid("param");
      return c.json(
        await receiveQuestionnaire(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          id,
          questionnaireId,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      );
    },
  )
  .post(
    "/suppliers/:id/questionnaires/:questionnaireId/review",
    forbidTokens,
    requireModuleLevel("items", "manage"),
    validate("param", questionnaireParam),
    validate("json", supplierQuestionnaireReviewSchema),
    async (c) => {
      const { id, questionnaireId } = c.req.valid("param");
      return c.json(
        await reviewQuestionnaire(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          id,
          questionnaireId,
          c.req.valid("json"),
          await workspaceToday(c.var.db, c.var.workspace.id),
        ),
      );
    },
  )
  .delete("/suppliers/:id", validate("param", idParam), async (c) => {
    await deleteSupplier(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
