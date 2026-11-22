import { notificationListQuerySchema, notificationPreferencesSchema } from "@knotworking/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkspaceEnv } from "../env";
import { canRead } from "../middleware/modules";
import { requireAdmin } from "../middleware/roles";
import { sweepDueNotifications } from "../services/notification-sweep";
import {
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  setPreferences,
  unreadCount,
} from "../services/notifications";
import { validate } from "../validate";

const idParam = z.object({ id: z.uuid() });

/** Notifications about modules the caller can no longer read (or that are inactive) are hidden, not deleted. */
const see = (c: Context<WorkspaceEnv>) => ({
  tasks: canRead(c, "tasks"),
  documents: canRead(c, "docs"),
  modules: c.var.activeModules.filter((id) => canRead(c, id)),
});

/**
 * The signed-in user's own notifications in one workspace. Mounted at
 * `/v1/workspaces/:slug`. Everything is scoped to `c.var.user`; guests may read
 * and clear their own notifications (it is personal state, not workspace data).
 */
export const notificationRoutes = new Hono<WorkspaceEnv>()
  .get("/notifications", validate("query", notificationListQuerySchema), async (c) =>
    c.json(
      await listNotifications(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("query"), see(c)),
    ),
  )
  .get("/notifications/unread-count", async (c) =>
    c.json({ unreadCount: await unreadCount(c.var.db, c.var.workspace.id, c.var.user.id, see(c)) }),
  )
  .post("/notifications/read-all", async (c) =>
    c.json(await markAllRead(c.var.db, c.var.workspace.id, c.var.user.id, see(c))),
  )
  .post("/notifications/:id/read", validate("param", idParam), async (c) =>
    c.json(await markRead(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("param").id, see(c))),
  )
  // `emailConfigured` tells clients whether the server can send email at all.
  .get("/notifications/preferences", async (c) =>
    c.json({
      ...(await getPreferences(c.var.db, c.var.workspace.id, c.var.user.id)),
      emailConfigured: c.var.mailer.configured,
    }),
  )
  .put("/notifications/preferences", validate("json", notificationPreferencesSchema), async (c) =>
    c.json({
      ...(await setPreferences(c.var.db, c.var.workspace.id, c.var.user.id, c.req.valid("json"))),
      emailConfigured: c.var.mailer.configured,
    }),
  )
  // Runs the due-date sweep for this workspace now (it also runs on a timer). Idempotent.
  .post("/notifications/sweep", requireAdmin, async (c) => {
    const { created } = await sweepDueNotifications(c.var.db, {
      activeModules: c.var.activeModules,
      workspaceId: c.var.workspace.id,
    });
    return c.json({ created: created.length });
  });
