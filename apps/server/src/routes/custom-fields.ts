import {
  customFieldDefinitionCreateSchema,
  customFieldDefinitionUpdateSchema,
  customFieldTargets,
  customFieldValueSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import { requireModuleLevel } from "../middleware/modules";
import { personOrToken } from "../middleware/token-actions";
import {
  changeCustomField,
  createCustomField,
  listCustomFields,
  listCustomFieldValues,
  setCustomFieldValue,
} from "../services/custom-fields";
import { validate } from "../validate";

const id = z.uuid().toLowerCase();
const definition = z.object({ id });
const record = z.object({ target: z.enum(customFieldTargets), id });
const definitionToken = personOrToken("tasks.custom_fields");
const manageFields = requireModuleLevel("tasks", "manage");

export const customFieldRoutes = new Hono<WorkspaceEnv>()
  .get("/tasks/custom-fields", async (c) => c.json(await listCustomFields(c.var.db, c.var.workspace.id)))
  .post(
    "/tasks/custom-fields",
    definitionToken,
    manageFields,
    validate("json", customFieldDefinitionCreateSchema),
    async (c) =>
      c.json(await createCustomField(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/tasks/custom-fields/:id",
    definitionToken,
    manageFields,
    validate("param", definition),
    validate("json", customFieldDefinitionUpdateSchema),
    async (c) =>
      c.json(
        await changeCustomField(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete(
    "/tasks/custom-fields/:id",
    definitionToken,
    manageFields,
    validate("param", definition),
    async (c) => {
      await changeCustomField(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, null);
      return c.body(null, 204);
    },
  )
  .get("/tasks/custom-fields/:target/:id/values", validate("param", record), async (c) => {
    const { target, id } = c.req.valid("param");
    return c.json(await listCustomFieldValues(c.var.db, c.var.workspace.id, target, id));
  })
  .put(
    "/tasks/custom-fields/:target/:id/values/:fieldId",
    requireWriter,
    validate("param", record.extend({ fieldId: id })),
    validate("json", customFieldValueSchema),
    async (c) => {
      const { target, id, fieldId } = c.req.valid("param");
      return c.json(
        await setCustomFieldValue(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          target,
          id,
          fieldId,
          c.req.valid("json").value,
        ),
      );
    },
  );
