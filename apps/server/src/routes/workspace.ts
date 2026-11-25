import {
  searchQuerySchema,
  sniffImageType,
  summarizeModules,
  SYNC_NUDGE_EVENT,
  syncQuerySchema,
  type SyncChange,
  type SyncNudge,
  WORKSPACE_AVATAR_SIZE,
  workspaceModuleSettingsSchema,
  workspaceSettingsUpdateSchema,
} from "@knotworking/core";
import { getChangesAfter, getLatestCursor, type Executor } from "@knotworking/db";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { canRead } from "../middleware/modules";
import { createNudgeWaiter } from "../nudge-wait";
import { attachmentRoutes } from "./attachments";
import { filterChangesByModule, redactChanges, redactMeeting } from "../services/redact";
import { search } from "../services/search";
import { isApiTokenValid } from "../services/api-tokens";
import { memberModuleLevels } from "../services/module-access";
import {
  bootstrap,
  getWorkspaceSettings,
  hasWorkspaceAccess,
  updateWorkspaceSettings,
} from "../services/workspace";
import {
  getActiveWorkspaceModules,
  getWorkspaceModuleSettings,
  setWorkspaceModuleSettings,
} from "../services/workspace-modules";
import { requireSessionCredential } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { validate } from "../validate";

/** Comment line that keeps idle connections (and proxies) from timing out. */
const HEARTBEAT_MS = 25_000;
/** Streams end after this long; clients reconnect, which re-checks the session. */
const MAX_STREAM_MS = 10 * 60_000;
/**
 * How often an open stream re-checks that its credential and workspace membership still hold
 * (`AppOptions.streamRevalidateMs` overrides it, for tests). A revoked or expired API token, a
 * removed member or a deactivated owner therefore loses the stream within about this long, not
 * after `MAX_STREAM_MS`.
 */
export const DEFAULT_STREAM_REVALIDATE_MS = 30_000;

const replicaRead = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** Read module scope in the same snapshot as the cursor and data it filters. */
async function replicaAccess(db: Executor, c: Context<WorkspaceEnv>) {
  const { workspace, user, credential } = c.var;
  const active = await getActiveWorkspaceModules(db, workspace.id, workspace.availableModules);
  return memberModuleLevels(
    db,
    workspace.id,
    { role: workspace.role, userId: user.id },
    active,
    credential.kind === "token" ? credential.modules : null,
  );
}

/**
 * Guests (outside collaborators) don't get the team's email addresses or its org chart (titles,
 * departments, reporting lines): the same rule as the bootstrap and the members list.
 */
function hideEmails(change: SyncChange): SyncChange {
  if (!change.data) return change;
  let data = change.data;
  if ("email" in data) data = { ...data, email: "" };
  if ("reportsToUserId" in data) data = { ...data, title: null, department: null, reportsToUserId: null };
  return data === change.data ? change : { ...change, data };
}

/**
 * Platform routes scoped to one workspace: bootstrap, sync, the event stream, modules, search and
 * attachments. Mounted at `/v1/workspaces/:slug`. Each module has its own routes file
 * (`taskRoutes`, `docRoutes`, `timeRoutes`, `meetingRoutes`, …), mounted beside this one in app.ts.
 * `GET /tasks/:id/attachments` lives in `attachmentRoutes` but is gated as the `tasks` module
 * (modules/routes.ts).
 */
export const workspaceRoutes = new Hono<WorkspaceEnv>()
  // ── Sync ──
  .get("/bootstrap", async (c) => {
    const viewer = { role: c.var.workspace.role, userId: c.var.user.id };
    const payload = await c.var.db.transaction(async (tx) => {
      const modules = await replicaAccess(tx, c);
      const snapshot = await bootstrap(tx, c.var.workspace.id, {
        hideEmails: viewer.role === "guest",
        modules,
      });
      return {
        ...snapshot,
        meetings: snapshot.meetings.map((m) => redactMeeting(viewer, m)),
        modules: summarizeModules(modules),
      };
    }, replicaRead);
    return c.json(payload);
  })
  .get("/sync", validate("query", syncQuerySchema), async (c) => {
    const { after, limit } = c.req.valid("query");
    const payload = await c.var.db.transaction(async (tx) => {
      const modules = await replicaAccess(tx, c);
      const viewer = { role: c.var.workspace.role, userId: c.var.user.id, modules };
      const page = await getChangesAfter(tx, c.var.workspace.id, BigInt(after), limit);
      page.changes = redactChanges(viewer, filterChangesByModule(modules, page.changes));
      if (viewer.role === "guest") page.changes = page.changes.map(hideEmails);
      return page;
    }, replicaRead);
    return c.json(payload);
  })
  /**
   * Server push. A server-sent event stream that only says "the sync log
   * advanced" (`event: sync`, data `{ cursor }`); clients then call `/sync`.
   * `ready` carries the current cursor on connect so a reconnecting client
   * catches up on anything it missed.
   *
   * The credential is checked once at connect (by `requireSession`), so a long-lived stream
   * re-checks it every `streamRevalidateMs` and ends cleanly when it stopped being valid:
   * - API tokens: revoked, expired, or the owner deactivated or without any active membership.
   * - Everyone (tokens and sessions): the user no longer belongs to this workspace.
   * Sessions are otherwise not re-validated: Better Auth session cookies are bounded by the
   * 10-minute stream lifetime, and deactivating a user deletes their sessions, so a signed-out
   * session can keep a stream for at most `MAX_STREAM_MS`. (Streams carry only cursors, never data.)
   */
  .get("/events", (c) => {
    const { db, syncHub, workspace, user, credential, streamRevalidateMs } = c.var;
    const stillAuthorized = async () =>
      (credential.kind !== "token" || (await isApiTokenValid(db, credential.tokenId))) &&
      (await hasWorkspaceAccess(db, workspace.id, user.id));
    const res = streamSSE(c, async (stream) => {
      const nudges = createNudgeWaiter();
      const unsubscribe = syncHub.subscribe(workspace.id, (cursor) => nudges.push(cursor));
      stream.onAbort(() => nudges.interrupt());
      try {
        let sent = await getLatestCursor(db, workspace.id);
        await stream.writeSSE({
          event: "ready",
          data: JSON.stringify({ cursor: sent } satisfies SyncNudge),
          retry: 3000,
        });
        const deadline = Date.now() + MAX_STREAM_MS;
        let nextCheck = Date.now() + streamRevalidateMs;
        while (!stream.aborted && !stream.closed && Date.now() < deadline) {
          const until = Math.min(deadline, nextCheck) - Date.now();
          const next = await nudges.wait(sent, Math.min(HEARTBEAT_MS, Math.max(0, until)));
          if (stream.aborted) break;
          if (Date.now() >= nextCheck) {
            nextCheck = Date.now() + streamRevalidateMs;
            if (!(await stillAuthorized())) break;
          }
          if (next !== null) {
            sent = next;
            await stream.writeSSE({
              event: SYNC_NUDGE_EVENT,
              data: JSON.stringify({ cursor: sent } satisfies SyncNudge),
            });
          } else {
            await stream.write(": ping\n\n");
          }
        }
      } finally {
        unsubscribe();
      }
    });
    // `no-transform` keeps compressing proxies (Next.js `compress`, CDNs) from buffering the stream.
    // (Set on the context: Hono merges its headers into the response, after streamSSE's defaults.)
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return res;
  })

  // ── General settings: admins can edit; the avatar can only be changed by an owner. ──
  .get("/settings", async (c) => c.json(await getWorkspaceSettings(c.var.db, c.var.workspace.id)))
  .patch(
    "/settings",
    requireSessionCredential,
    requireAdmin,
    validate("json", workspaceSettingsUpdateSchema),
    async (c) => {
      const patch = c.req.valid("json");
      if (patch.icon !== undefined && c.var.workspace.role !== "owner") {
        throw new ApiError(403, "forbidden", "Only a workspace owner can change its avatar");
      }
      if (patch.icon) {
        const encoded = patch.icon.slice("data:image/png;base64,".length);
        const image = Buffer.from(encoded, "base64");
        // PNG requires IHDR first. Its dimensions must be small even for direct API uploads.
        if (
          sniffImageType(image) !== "image/png" ||
          image.length < 45 ||
          image.readUInt32BE(8) !== 13 ||
          image.toString("ascii", 12, 16) !== "IHDR" ||
          image.readUInt32BE(16) !== WORKSPACE_AVATAR_SIZE ||
          image.readUInt32BE(20) !== WORKSPACE_AVATAR_SIZE ||
          image.toString("base64") !== encoded
        ) {
          throw new ApiError(400, "invalid_input", "Upload a valid 96 × 96 PNG workspace avatar");
        }
      }
      return c.json(await updateWorkspaceSettings(c.var.db, c.var.workspace.id, c.var.user.id, patch));
    },
  )

  // ── Modules: the active modules and the caller's level in each (tokens may read it) ──
  .get("/modules", (c) => c.json({ modules: summarizeModules(c.var.workspace.modules) }))
  .get("/module-settings", requireSessionCredential, requireAdmin, async (c) =>
    c.json(await getWorkspaceModuleSettings(c.var.db, c.var.workspace.id, c.var.workspace.availableModules)),
  )
  .patch(
    "/module-settings",
    requireSessionCredential,
    requireAdmin,
    validate("json", workspaceModuleSettingsSchema),
    async (c) =>
      c.json(
        await setWorkspaceModuleSettings(
          c.var.db,
          c.var.workspace.id,
          c.var.user.id,
          c.var.workspace.availableModules,
          c.req.valid("json").modules,
        ),
      ),
  )

  // ── Search (documents and tasks; read-only, so tokens may use it). Only modules the caller can read. ──
  .get("/search", validate("query", searchQuerySchema), async (c) =>
    c.json(
      await search(c.var.db, c.var.workspace.id, c.req.valid("query"), {
        documents: canRead(c, "docs"),
        tasks: canRead(c, "tasks"),
      }),
    ),
  )

  // ── Attachments (POST /attachments, GET/DELETE /attachments/:id, …/content, GET /tasks/:id/attachments) ──
  .route("/", attachmentRoutes);
