import { calendarRangeSchema, meetingCreateSchema, meetingUpdateSchema } from "@knotworking/core";
import { Hono } from "hono";
import { z } from "zod";
import { activateConnection, disconnect, getOwnConnection, listConnections } from "../calendar/connections";
import { syncConnection } from "../calendar/sync";
import type { AppEnv, WorkspaceEnv } from "../env";
import { requireWriter } from "../middleware/roles";
import {
  cancelMeeting,
  createMeeting,
  createMeetingNotes,
  getCalendar,
  getMeeting,
  importEvent,
  updateMeeting,
} from "../services/meetings";
import { redactMeetingWithAttendees } from "../services/redact";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

const viewerOf = (c: { var: WorkspaceEnv["Variables"] }) => ({
  role: c.var.workspace.role,
  userId: c.var.user.id,
});

/** The signed-in user's own calendar connections. Mounted at `/v1/calendar`. */
export const calendarConnectionRoutes = new Hono<AppEnv>()
  .get("/connections", async (c) =>
    c.json({
      connections: await listConnections(c.var.db, c.var.user.id),
      available: Object.keys(c.var.calendar.providers) as ("google" | "microsoft")[],
    }),
  )
  .post(
    "/connections/activate",
    validate("json", z.object({ provider: z.enum(["google", "microsoft"]) })),
    async (c) => {
      const conn = await activateConnection(c.var.db, c.var.user.id, c.req.valid("json").provider);
      return c.json(
        await syncConnection(c.var.calendar, conn.id).then((result) => ({ id: conn.id, ...result })),
      );
    },
  )
  .post("/connections/:id/sync", validate("param", idParam), async (c) => {
    const conn = await getOwnConnection(c.var.db, c.var.user.id, c.req.valid("param").id);
    return c.json(await syncConnection(c.var.calendar, conn.id));
  })
  .delete("/connections/:id", validate("param", idParam), async (c) => {
    await disconnect(c.var.db, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });

/** Meetings and the combined calendar view. Mounted at `/v1/workspaces/:slug`. */
export const meetingRoutes = new Hono<WorkspaceEnv>()
  .get("/calendar", validate("query", calendarRangeSchema), async (c) => {
    const { from, to } = c.req.valid("query");
    const data = await getCalendar(c.var.db, c.var.workspace.id, c.var.user.id, from, to);
    const viewer = viewerOf(c);
    return c.json({ ...data, meetings: data.meetings.map((m) => redactMeetingWithAttendees(viewer, m)) });
  })
  .get("/meetings/:id", validate("param", idParam), async (c) =>
    c.json(
      redactMeetingWithAttendees(
        viewerOf(c),
        await getMeeting(c.var.db, c.var.workspace.id, c.req.valid("param").id),
      ),
    ),
  )
  .post("/meetings", requireWriter, validate("json", meetingCreateSchema), async (c) =>
    c.json(await createMeeting(c.var.calendar, c.var.workspace, c.var.user.id, c.req.valid("json")), 201),
  )
  .patch(
    "/meetings/:id",
    requireWriter,
    validate("param", idParam),
    validate("json", meetingUpdateSchema),
    async (c) =>
      c.json(
        await updateMeeting(
          c.var.calendar,
          c.var.workspace,
          c.var.user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
      ),
  )
  .post("/meetings/:id/cancel", requireWriter, validate("param", idParam), async (c) =>
    c.json(await cancelMeeting(c.var.calendar, c.var.workspace, c.var.user.id, c.req.valid("param").id)),
  )
  .post("/meetings/:id/notes", requireWriter, validate("param", idParam), async (c) =>
    c.json(await createMeetingNotes(c.var.db, c.var.workspace, c.var.user.id, c.req.valid("param").id)),
  )
  .post(
    "/meetings/import",
    requireWriter,
    validate("json", z.object({ calendarEventId: z.uuid() })),
    async (c) =>
      c.json(
        await importEvent(c.var.db, c.var.workspace, c.var.user.id, c.req.valid("json").calendarEventId),
        201,
      ),
  );
