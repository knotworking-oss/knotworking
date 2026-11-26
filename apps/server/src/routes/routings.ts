import {
  jobCardCompleteSchema,
  jobCardConsumptionSchema,
  jobCardExceptionResolveSchema,
  jobCardExceptionSchema,
  jobCardListQuerySchema,
  jobCardOutputSchema,
  jobCardQuantitySchema,
  jobCardTimeEntrySchema,
  jobCardTimerStartSchema,
  jobCardVoidSchema,
  routingCreateSchema,
  routingDraftSchema,
  routingListQuerySchema,
  routingUpdateSchema,
  workCentreCreateSchema,
  workCentreListQuerySchema,
  workCentreUpdateSchema,
} from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { forbidTokens } from "../middleware/auth";
import { ledgerInput } from "../middleware/ledger-command";
import { requireModuleLevel } from "../middleware/modules";
import {
  addJobCardTime,
  approveRoutingDraft,
  cancelJobCards,
  completeJobCard,
  consumeOnJobCard,
  createJobCards,
  createRouting,
  createWorkCentre,
  deleteRouting,
  discardRoutingDraft,
  getJobCard,
  getRouting,
  getWorkCentre,
  listBatchJobCards,
  listJobCards,
  listRoutings,
  listWorkCentres,
  outputFromJobCard,
  raiseJobCardException,
  recordJobCardQuantity,
  resolveJobCardException,
  saveRoutingDraft,
  startJobCardTimer,
  stopJobCardTimer,
  updateRouting,
  updateWorkCentre,
  voidJobCardQuantity,
  voidJobCardTime,
} from "../services/routings";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });
const batchParam = z.object({ batchId: z.uuid() });
const logParam = z.object({ id: z.uuid(), logId: z.uuid() });
const entryParam = z.object({ id: z.uuid(), entryId: z.uuid() });
const exceptionParam = z.object({ id: z.uuid(), exceptionId: z.uuid() });

/**
 * Routings module (`routings`), under `/routings`. The module guard has required `read` for safe
 * methods and `write` for the rest. Approving a routing version is a person's sign-off (`manage`);
 * voiding job card time or quantities is a person's correction. Posting materials or output from a
 * job card is batch recording, so it also needs `write` on Production.
 */
export const routingRoutes = new Hono<WorkspaceEnv>()
  // ── Work centres ──
  .get("/routings/work-centres", validate("query", workCentreListQuerySchema), async (c) =>
    c.json(await listWorkCentres(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/routings/work-centres", validate("json", workCentreCreateSchema), async (c) =>
    c.json(await createWorkCentre(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/routings/work-centres/:id", validate("param", idParam), async (c) =>
    c.json(await getWorkCentre(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .patch(
    "/routings/work-centres/:id",
    validate("param", idParam),
    validate("json", workCentreUpdateSchema),
    async (c) =>
      c.json(
        await updateWorkCentre(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )

  // ── Job cards of a batch ──
  .get("/routings/batches/:batchId/job-cards", validate("param", batchParam), async (c) =>
    c.json(await listBatchJobCards(c.var.db, c.var.workspace.id, c.req.valid("param").batchId)),
  )
  .post("/routings/batches/:batchId/job-cards", validate("param", batchParam), async (c) =>
    c.json(
      await createJobCards(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").batchId),
      201,
    ),
  )
  .delete("/routings/batches/:batchId/job-cards", validate("param", batchParam), async (c) =>
    c.json(await cancelJobCards(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").batchId)),
  )

  // ── Job cards ──
  .get("/routings/job-cards", validate("query", jobCardListQuerySchema), async (c) =>
    c.json(await listJobCards(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .get("/routings/job-cards/:id", validate("param", idParam), async (c) =>
    c.json(await getJobCard(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/routings/job-cards/:id/timer/start",
    validate("param", idParam),
    validate("json", jobCardTimerStartSchema),
    async (c) =>
      c.json(
        await startJobCardTimer(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .post("/routings/job-cards/:id/timer/stop", validate("param", idParam), async (c) =>
    c.json(await stopJobCardTimer(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )
  .post(
    "/routings/job-cards/:id/time",
    validate("param", idParam),
    validate("json", jobCardTimeEntrySchema),
    async (c) =>
      c.json(
        await addJobCardTime(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, c.req.valid("json")),
        201,
      ),
  )
  .post(
    "/routings/job-cards/:id/time/:logId/void",
    forbidTokens,
    validate("param", logParam),
    validate("json", jobCardVoidSchema),
    async (c) => {
      const { id, logId } = c.req.valid("param");
      return c.json(
        await voidJobCardTime(c.var.db, c.var.workspace.id, c.var.user.id, id, logId, c.req.valid("json").reason),
      );
    },
  )
  .post(
    "/routings/job-cards/:id/quantities",
    validate("param", idParam),
    validate("json", jobCardQuantitySchema),
    async (c) =>
      c.json(
        await recordJobCardQuantity(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
        ),
        201,
      ),
  )
  .post(
    "/routings/job-cards/:id/quantities/:entryId/void",
    forbidTokens,
    validate("param", entryParam),
    validate("json", jobCardVoidSchema),
    async (c) => {
      const { id, entryId } = c.req.valid("param");
      return c.json(
        await voidJobCardQuantity(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          id,
          entryId,
          c.req.valid("json").reason,
        ),
      );
    },
  )
  .post(
    "/routings/job-cards/:id/exceptions",
    validate("param", idParam),
    validate("json", jobCardExceptionSchema),
    async (c) =>
      c.json(
        await raiseJobCardException(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .post(
    "/routings/job-cards/:id/exceptions/:exceptionId/resolve",
    validate("param", exceptionParam),
    validate("json", jobCardExceptionResolveSchema),
    async (c) => {
      const { id, exceptionId } = c.req.valid("param");
      return c.json(
        await resolveJobCardException(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          id,
          exceptionId,
          c.req.valid("json"),
        ),
      );
    },
  )
  .post(
    "/routings/job-cards/:id/complete",
    validate("param", idParam),
    validate("json", jobCardCompleteSchema),
    async (c) =>
      c.json(
        await completeJobCard(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/routings/job-cards/:id/consumption",
    requireModuleLevel("production", "write"),
    validate("param", idParam),
    validate("json", jobCardConsumptionSchema),
    async (c) =>
      c.json(
        await consumeOnJobCard(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
        ),
        201,
      ),
  )
  .post(
    "/routings/job-cards/:id/output",
    requireModuleLevel("production", "write"),
    validate("param", idParam),
    validate("json", jobCardOutputSchema),
    async (c) =>
      c.json(
        await outputFromJobCard(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          ledgerInput(c, c.req.valid("json")),
          c.var.activeModules.includes("food_items"),
        ),
        201,
      ),
  )

  // ── Routings (after the fixed paths above, so `:id` never swallows them) ──
  .get("/routings", validate("query", routingListQuerySchema), async (c) =>
    c.json(await listRoutings(c.var.db, c.var.workspace.id, c.req.valid("query"))),
  )
  .post("/routings", validate("json", routingCreateSchema), async (c) =>
    c.json(await createRouting(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json")), 201),
  )
  .get("/routings/:id", validate("param", idParam), async (c) =>
    c.json(await getRouting(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .patch("/routings/:id", validate("param", idParam), validate("json", routingUpdateSchema), async (c) =>
    c.json(
      await updateRouting(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, c.req.valid("json")),
    ),
  )
  .put("/routings/:id/draft", validate("param", idParam), validate("json", routingDraftSchema), async (c) =>
    c.json(
      await saveRoutingDraft(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    ),
  )
  .delete("/routings/:id/draft", validate("param", idParam), async (c) => {
    await discardRoutingDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })
  // Approval is a sign-off: a person with `manage`, never an API token.
  .post(
    "/routings/:id/draft/approve",
    forbidTokens,
    requireModuleLevel("routings", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(await approveRoutingDraft(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id)),
  )
  .delete("/routings/:id", validate("param", idParam), async (c) => {
    await deleteRouting(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });
