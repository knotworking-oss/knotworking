import { timeEntryCreateSchema, timeEntryUpdateSchema, timerStartSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import {
  createTimeEntry,
  deleteTimeEntry,
  listTaskTimeEntries,
  projectTimeTotals,
  startTimer,
  stopTimer,
  updateTimeEntry,
} from "../services/time-entries";
import { validate } from "../validate";
import { reportRoutes } from "./reports";

const idParam = z.object({ id: z.uuid() });

/**
 * Time tracking: entries per task, the caller's timer, and totals per task and project.
 * Entries are in the bootstrap and every write lands in the sync log. Time tracking module
 * (`time`), mounted at `/v1/workspaces/:slug`; it also mounts the time reports.
 */
export const timeRoutes = new Hono<WorkspaceEnv>()
  .get("/tasks/:id/time-entries", validate("param", idParam), async (c) =>
    c.json(await listTaskTimeEntries(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  .post(
    "/tasks/:id/time-entries",
    requireWriter,
    validate("param", idParam),
    validate("json", timeEntryCreateSchema),
    async (c) =>
      c.json(
        await createTimeEntry(
          c.var.db,
          c.var.workspace.id,
          { id: c.var.user.id, role: c.var.workspace.role },
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .patch(
    "/time-entries/:id",
    requireWriter,
    validate("param", idParam),
    validate("json", timeEntryUpdateSchema),
    async (c) =>
      c.json(
        await updateTimeEntry(
          c.var.db,
          c.var.workspace.id,
          { id: c.var.user.id, role: c.var.workspace.role },
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .delete("/time-entries/:id", requireWriter, validate("param", idParam), async (c) => {
    await deleteTimeEntry(
      c.var.db,
      c.var.workspace.id,
      { id: c.var.user.id, role: c.var.workspace.role },
      c.req.valid("param").id,
    );
    return c.body(null, 204);
  })
  .post(
    "/tasks/:id/timer",
    requireWriter,
    validate("param", idParam),
    validate("json", timerStartSchema),
    async (c) =>
      c.json(
        await startTimer(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .post("/timer/stop", requireWriter, async (c) =>
    c.json(await stopTimer(c.var.db, c.var.workspace.id, c.var.user.id)),
  )
  .get("/projects/:id/time", validate("param", idParam), async (c) =>
    c.json(await projectTimeTotals(c.var.db, c.var.workspace.id, c.req.valid("param").id)),
  )
  // ── Time reports (JSON and CSV; read-only, so tokens may use them) ──
  .route("/", reportRoutes);
