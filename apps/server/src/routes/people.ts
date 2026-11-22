import {
  csvImportSchema,
  jobRoleCreateSchema,
  jobRoleListQuerySchema,
  jobRoleUpdateSchema,
  staffCreateSchema,
  staffListQuerySchema,
  staffPinSetSchema,
  staffUpdateSchema,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { assertModule, requireModuleLevel } from "../middleware/modules";
import { ApiError } from "../errors";
import {
  clearStaffPin,
  createJobRole,
  createStaff,
  deleteJobRole,
  deleteStaff,
  getStaff,
  listJobRoles,
  listStaff,
  setStaffPin,
  suggestStaffNumber,
  unlockStaffPin,
  updateJobRole,
  updateStaff,
} from "../services/people";
import { importStaffCsv } from "../services/people-import";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/**
 * Linking a staff record to a login decides whose clock times `/attendance/me` returns and whose
 * training counts as "your own" at sign-off, so it is a manager's act in person: `manage`, and no
 * API tokens. Everything else about a person needs only `write`.
 */
function assertCanLinkUser(c: Context<WorkspaceEnv>, body: { userId?: string | null | undefined }) {
  if (body.userId === undefined) return;
  if (c.var.credential.kind === "token") {
    throw new ApiError(403, "token_not_allowed", "API tokens can't link a staff record to a login");
  }
  assertModule(c, "people", "manage");
}

/**
 * People module (`people`): the staff register and job roles. Mounted at `/v1/workspaces/:slug`;
 * the module guard has already required `read` for safe methods and `write` for the rest. PINs
 * are a manager's act (`manage`, a signed-in person): an agent can never learn or set one.
 */
export const peopleRoutes = new Hono<WorkspaceEnv>()
  // ── Staff ──
  .get("/people/staff", validate("query", staffListQuerySchema), async (c) =>
    c.json(await listStaff(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/people/staff-number", async (c) =>
    c.json({ next: await suggestStaffNumber(c.var.db, c.var.workspace.id) }),
  )
  // CSV import of staff by staff number. Never PINs or the login link (manager-only acts).
  .post("/people/staff/import", validate("json", csvImportSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await importStaffCsv(c.var.db, c.var.workspace.id, c.var.user.id, input);
    return c.json(result, input.dryRun ? 200 : 201);
  })
  .get("/people/staff/:id", validate("param", idParam), async (c) =>
    c.json(await getStaff(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post("/people/staff", validate("json", staffCreateSchema), async (c) => {
    assertCanLinkUser(c, c.req.valid("json"));
    return c.json(await createStaff(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201);
  })
  .patch("/people/staff/:id", validate("param", idParam), validate("json", staffUpdateSchema), async (c) => {
    assertCanLinkUser(c, c.req.valid("json"));
    return c.json(
      await updateStaff(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    );
  })
  .delete("/people/staff/:id", validate("param", idParam), async (c) => {
    await deleteStaff(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  .put(
    "/people/staff/:id/pin",
    forbidTokens,
    requireModuleLevel("people", "manage"),
    validate("param", idParam),
    validate("json", staffPinSetSchema),
    async (c) =>
      c.json(
        await setStaffPin(
          c.var.db,
          c.var.staffPinKey,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").pin,
        ),
      ),
  )
  .delete(
    "/people/staff/:id/pin",
    forbidTokens,
    requireModuleLevel("people", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(await clearStaffPin(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )
  .post(
    "/people/staff/:id/unlock",
    forbidTokens,
    requireModuleLevel("people", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(await unlockStaffPin(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )

  // ── Job roles ──
  .get("/people/job-roles", validate("query", jobRoleListQuerySchema), async (c) =>
    c.json({ jobRoles: await listJobRoles(c.var.db, c.var.workspace.id, c.req.valid("query")) }),
  )
  .post("/people/job-roles", validate("json", jobRoleCreateSchema), async (c) =>
    c.json(await createJobRole(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/people/job-roles/:id",
    validate("param", idParam),
    validate("json", jobRoleUpdateSchema),
    async (c) =>
      c.json(
        await updateJobRole(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/people/job-roles/:id", validate("param", idParam), async (c) => {
    await deleteJobRole(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
