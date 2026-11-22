import {
  trainingCourseCreateSchema,
  trainingCourseListQuerySchema,
  trainingCourseUpdateSchema,
  trainingDueQuerySchema,
  trainingMatrixQuerySchema,
  trainingRecordCreateSchema,
  trainingRecordListQuerySchema,
  trainingRequirementsSchema,
  trainingSignOffSchema,
  trainingVoidSchema,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { canRead, requireModuleLevel } from "../middleware/modules";
import {
  backfillCourse,
  createCourse,
  createRecords,
  deleteCourse,
  getCourse,
  listCourses,
  listRecords,
  setCourseRequirements,
  signOffRecords,
  staffTraining,
  trainingDue,
  trainingMatrix,
  updateCourse,
  voidRecord,
} from "../services/training";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const staffParam = z.object({ staffId: z.uuid() });

/** SOP codes and titles on a course are only shown to people who can read SOPs. */
const courseOptions = (c: Context<WorkspaceEnv>) => ({ includeSop: canRead(c, "sops") });

/**
 * Training module (`training`). Mounted at `/v1/workspaces/:slug`; the module guard has already
 * required `read` for safe methods and `write` for the rest.
 *
 * - `write`: record training (API tokens allowed, so an agent can log who attended).
 * - `manage`: courses and which roles need them.
 * - `manage` and a signed-in person: competency sign-off and voiding a record.
 */
export const trainingRoutes = new Hono<WorkspaceEnv>()
  // ── Courses ──
  .get("/training/courses", validate("query", trainingCourseListQuerySchema), async (c) =>
    c.json({
      courses: await listCourses(c.var.db, c.var.workspace.id, c.req.valid("query"), courseOptions(c)),
    }),
  )
  .get("/training/courses/:id", validate("param", idParam), async (c) =>
    c.json(await getCourse(c.var.db, c.var.workspace.id, c.req.valid("param").id, courseOptions(c))),
  )
  .post(
    "/training/courses",
    requireModuleLevel("training", "manage"),
    validate("json", trainingCourseCreateSchema),
    async (c) =>
      c.json(
        await createCourse(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("json"),
          courseOptions(c),
          c.var.activeModules,
        ),
        201,
      ),
  )
  .patch(
    "/training/courses/:id",
    requireModuleLevel("training", "manage"),
    validate("param", idParam),
    validate("json", trainingCourseUpdateSchema),
    async (c) =>
      c.json(
        await updateCourse(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          courseOptions(c),
          c.var.activeModules,
        ),
      ),
  )
  // Counts acknowledgements made before the course was linked (also done on linking).
  .post(
    "/training/courses/:id/backfill",
    requireModuleLevel("training", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(
        await backfillCourse(c.var.db, c.var.workspace.id, c.req.valid("param").id, c.var.activeModules),
      ),
  )
  .delete(
    "/training/courses/:id",
    requireModuleLevel("training", "manage"),
    validate("param", idParam),
    async (c) => {
      await deleteCourse(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .put(
    "/training/courses/:id/requirements",
    requireModuleLevel("training", "manage"),
    validate("param", idParam),
    validate("json", trainingRequirementsSchema),
    async (c) =>
      c.json(
        await setCourseRequirements(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
          courseOptions(c),
        ),
      ),
  )

  // ── Standing ──
  .get("/training/matrix", validate("query", trainingMatrixQuerySchema), async (c) =>
    c.json(await trainingMatrix(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/training/due", validate("query", trainingDueQuerySchema), async (c) =>
    c.json(await trainingDue(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/training/staff/:staffId", validate("param", staffParam), async (c) =>
    c.json(await staffTraining(c.var.db, c.var.workspace.id, c.req.valid("param").staffId)),
  )

  // ── Records ──
  .get("/training/records", validate("query", trainingRecordListQuerySchema), async (c) =>
    c.json(await listRecords(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/training/records", validate("json", trainingRecordCreateSchema), async (c) =>
    c.json(
      { records: await createRecords(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")) },
      201,
    ),
  )
  .post(
    "/training/records/sign-off",
    forbidTokens,
    requireModuleLevel("training", "manage"),
    validate("json", trainingSignOffSchema),
    async (c) =>
      c.json({
        records: await signOffRecords(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("json").recordIds,
        ),
      }),
  )
  .post(
    "/training/records/:id/void",
    forbidTokens,
    requireModuleLevel("training", "manage"),
    validate("param", idParam),
    validate("json", trainingVoidSchema),
    async (c) =>
      c.json(
        await voidRecord(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        ),
      ),
  );
