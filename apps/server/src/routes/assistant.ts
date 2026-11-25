import {
  ASSISTANT_STREAM_EVENT,
  assistantConversationCreateSchema,
  assistantConversationUpdateSchema,
  assistantKeySaveSchema,
  assistantMessageCreateSchema,
  assistantProviderNames,
  assistantProviders,
  assistantSettingsUpdateSchema,
  hasModuleLevel,
  assistantModelIdSchema,
  newId,
  type AssistantProvider,
  type AssistantStreamMessage,
  type ModuleId,
} from "@knotworking/core";
import { workspaceMembers } from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv, WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { requireSessionCredential } from "../middleware/auth";
import {
  createConversation,
  deleteConversation,
  getConversationRow,
  listConversations,
  listMessages,
  startTurn,
  updateConversation,
  type AssistantMessageView,
} from "../services/assistant";
import {
  deleteKey,
  getProviderKey,
  getSettings,
  listKeyModels,
  listKeys,
  saveKey,
  setKeyModel,
  updateSettings,
} from "../services/assistant-keys";
import { memberModuleLevels } from "../services/module-access";
import { getActiveWorkspaceModules } from "../services/workspace-modules";
import { hasWorkspaceAccess, listMyWorkspaces } from "../services/workspace";
import { validate } from "../validate";

/**
 * The assistant (docs/assistant.md). Two groups of routes:
 *
 * - `/v1/me/assistant/*`: the signed-in person's provider API keys and preferences (sessions only:
 *   a token must never be able to read, replace or spend someone's key).
 * - `/v1/workspaces/:slug/assistant/*`: the person's own conversations (sessions only, for the same
 *   reason). The reply is generated in this process with their key (`services/assistant-turn.ts`).
 */

const idParam = z.object({ id: z.uuid() });
const providerParam = z.object({ provider: z.enum(assistantProviders) });
const MAX_STREAM_MS = 10 * 60_000;
const HEARTBEAT_MS = 20_000;

/** Keys need the assistant module in at least one of the person's workspaces. */
async function assertAssistantAccess(c: { var: AppEnv["Variables"] }) {
  for (const w of await listMyWorkspaces(c.var.db, c.var.user.id)) {
    const levels = await memberModuleLevels(
      c.var.db,
      w.id,
      { userId: c.var.user.id, role: w.role },
      await getActiveWorkspaceModules(c.var.db, w.id, c.var.activeModules),
    );
    if (hasModuleLevel(levels.assistant, "read")) return;
  }
  throw new ApiError(
    403,
    "module_forbidden",
    "You don't have the assistant. Ask an owner or admin to grant it under Members → Module access.",
  );
}

const assertActive = (activeModules: readonly string[]) => {
  if (!activeModules.includes("assistant")) {
    throw new ApiError(404, "module_inactive", "The assistant module is not enabled on this server");
  }
};

/** The module must be on and the person must have it somewhere, before a route that uses their key. */
async function requireAssistant(c: { var: AppEnv["Variables"] }) {
  assertActive(c.var.activeModules);
  await assertAssistantAccess(c);
}

/** Mounted at `/v1/me`. Keys are never returned: only the provider, the last four characters and the model. */
export const assistantKeyRoutes = new Hono<AppEnv>()
  .get("/assistant/keys", requireSessionCredential, async (c) =>
    c.json({ keys: await listKeys(c.var.db, c.var.user.id) }),
  )
  .put(
    "/assistant/keys/:provider",
    requireSessionCredential,
    validate("param", providerParam),
    validate("json", assistantKeySaveSchema),
    async (c) => {
      await requireAssistant(c);
      const { key, models } = await saveKey(
        c.var.db,
        c.var.assistantKeyKey,
        c.var.assistantProviders,
        c.var.user.id,
        c.req.valid("param").provider,
        c.req.valid("json"),
      );
      return c.json({ key, models });
    },
  )
  .patch(
    "/assistant/keys/:provider",
    requireSessionCredential,
    validate("param", providerParam),
    validate("json", z.object({ model: assistantModelIdSchema.nullable() })),
    async (c) => {
      await requireAssistant(c);
      return c.json({
        key: await setKeyModel(
          c.var.db,
          c.var.user.id,
          c.req.valid("param").provider,
          c.req.valid("json").model,
        ),
      });
    },
  )
  .delete(
    "/assistant/keys/:provider",
    requireSessionCredential,
    validate("param", providerParam),
    async (c) => {
      await deleteKey(c.var.db, c.var.user.id, c.req.valid("param").provider);
      return c.body(null, 204);
    },
  )
  .get(
    "/assistant/keys/:provider/models",
    requireSessionCredential,
    validate("param", providerParam),
    async (c) => {
      await requireAssistant(c);
      return c.json({
        models: await listKeyModels(
          c.var.db,
          c.var.assistantKeyKey,
          c.var.assistantProviders,
          c.var.user.id,
          c.req.valid("param").provider,
        ),
      });
    },
  )
  .get("/assistant/settings", requireSessionCredential, async (c) =>
    c.json({ settings: await getSettings(c.var.db, c.var.user.id) }),
  )
  .patch(
    "/assistant/settings",
    requireSessionCredential,
    validate("json", assistantSettingsUpdateSchema),
    async (c) => {
      await requireAssistant(c);
      return c.json({ settings: await updateSettings(c.var.db, c.var.user.id, c.req.valid("json")) });
    },
  );

/** Mounted at `/v1/workspaces/:slug`; every path is under `/assistant` (module `assistant`). */
export const assistantRoutes = new Hono<WorkspaceEnv>()
  /** The person's saved keys and preferences: what the sidebar needs to know before a chat. */
  .get("/assistant/status", async (c) =>
    c.json({
      keys: await listKeys(c.var.db, c.var.user.id),
      settings: await getSettings(c.var.db, c.var.user.id),
    }),
  )
  .get("/assistant/conversations", async (c) =>
    c.json({ conversations: await listConversations(c.var.db, c.var.workspace.id, c.var.user.id) }),
  )
  .post("/assistant/conversations", validate("json", assistantConversationCreateSchema), async (c) => {
    const { db, user, workspace } = c.var;
    const input = c.req.valid("json");
    // A new chat uses the person's default provider (or the first one they have a key for).
    const keys = await listKeys(db, user.id);
    const settings = await getSettings(db, user.id);
    const provider: AssistantProvider =
      input.provider ?? settings.defaultProvider ?? keys[0]?.provider ?? "claude";
    return c.json(
      { conversation: await createConversation(db, workspace.id, user.id, { ...input, provider }) },
      201,
    );
  })
  .get("/assistant/conversations/:id", validate("param", idParam), async (c) => {
    const row = await getConversationRow(
      c.var.db,
      c.var.workspace.id,
      c.var.user.id,
      c.req.valid("param").id,
    );
    const hub = c.var.assistantHub;
    const messages = await Promise.all(
      (await listMessages(c.var.db, row.id)).map(async (m) => {
        if (m.status !== "running") return m;
        // Still running here: the live reply. Otherwise the turn was lost (the server restarted).
        const live = await hub.liveReply(m.id);
        return live
          ? { ...m, parts: live.parts }
          : { ...m, status: "error" as const, error: "This reply was interrupted." };
      }),
    );
    return c.json({
      conversation: {
        id: row.id,
        title: row.title,
        provider: row.provider,
        model: row.model,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      messages,
    });
  })
  .patch(
    "/assistant/conversations/:id",
    validate("param", idParam),
    validate("json", assistantConversationUpdateSchema),
    async (c) => {
      const row = await getConversationRow(
        c.var.db,
        c.var.workspace.id,
        c.var.user.id,
        c.req.valid("param").id,
      );
      const input = c.req.valid("json");
      // Switching provider without naming a model clears the old provider's model id.
      const model = input.model !== undefined ? input.model : input.provider ? null : undefined;
      return c.json({
        conversation: await updateConversation(c.var.db, row, {
          ...input,
          ...(model !== undefined ? { model } : {}),
        }),
      });
    },
  )
  .delete("/assistant/conversations/:id", validate("param", idParam), async (c) => {
    const row = await getConversationRow(
      c.var.db,
      c.var.workspace.id,
      c.var.user.id,
      c.req.valid("param").id,
    );
    await c.var.assistantHub.cancel(row.id);
    await deleteConversation(c.var.db, row);
    return c.body(null, 204);
  })
  /** Sends a prompt. The reply is generated here with the person's key and streams over `/assistant/stream`. */
  .post(
    "/assistant/conversations/:id/messages",
    validate("param", idParam),
    validate("json", assistantMessageCreateSchema),
    async (c) => {
      const { db, assistantHub: hub, workspace, user } = c.var;
      const row = await getConversationRow(db, workspace.id, user.id, c.req.valid("param").id);
      const { text, context } = c.req.valid("json");
      // A shared database claim prevents simultaneous prompts across API instances.
      const release = await hub.reserve(row.id);
      if (!release) {
        throw new ApiError(409, "assistant_busy", "Wait for the current reply to finish, or stop it.");
      }
      let prompt: AssistantMessageView, reply: AssistantMessageView;
      const turnId = newId();
      let scope: "read" | "write";
      let modules: ModuleId[];
      try {
        const name = assistantProviderNames[row.provider];
        const saved = await getProviderKey(db, c.var.assistantKeyKey, user.id, row.provider);
        if (!saved) {
          throw new ApiError(
            409,
            "no_provider_key",
            `Add your ${name} API key first: Settings → Assistant, or pick another provider in the chat header.`,
          );
        }
        if (!row.model && !saved.model) {
          throw new ApiError(
            409,
            "no_model",
            `Choose a ${name} model in the chat header, or set one under Settings → Assistant.`,
          );
        }
        ({ scope, modules } = await getSettings(db, user.id));
        ({ prompt, reply } = await startTurn(db, row, text, context ?? null, async (tx, reply) => {
          await hub.queueTurn(tx, {
            claimToken: release.token,
            turnId,
            conversationId: row.id,
            userId: user.id,
            workspaceId: workspace.id,
            messageId: reply.id,
          });
        }));
      } catch (err) {
        await release();
        throw err;
      }
      c.var.assistantTurns.start({
        turnId,
        conversationId: row.id,
        messageId: reply.id,
        userId: user.id,
        workspace: { slug: workspace.slug, name: workspace.name },
        user: { name: user.name },
        provider: row.provider,
        model: row.model,
        scope,
        modules,
        prompt: text,
        context: context ?? null,
      });
      return c.json({ prompt, reply }, 201);
    },
  )
  .post("/assistant/conversations/:id/cancel", validate("param", idParam), async (c) => {
    const row = await getConversationRow(
      c.var.db,
      c.var.workspace.id,
      c.var.user.id,
      c.req.valid("param").id,
    );
    return c.json({ cancelled: await c.var.assistantHub.cancel(row.id) });
  })
  /**
   * The person's live assistant events in this workspace (server-sent events): reply events
   * (`event`) and the end of each reply (`ended`), as `event: assistant` with a JSON
   * `AssistantStreamMessage`.
   */
  .get("/assistant/stream", (c) => {
    const { db, assistantHub: hub, workspace, user, streamRevalidateMs } = c.var;
    const stillAuthorized = async () => {
      const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
      if (!session || session.user.id !== user.id || !(await hasWorkspaceAccess(db, workspace.id, user.id)))
        return false;
      const [member] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace.id),
            eq(workspaceMembers.userId, user.id),
            isNull(workspaceMembers.deletedAt),
          ),
        );
      if (!member) return false;
      const access = await memberModuleLevels(
        db,
        workspace.id,
        { userId: user.id, role: member.role },
        await getActiveWorkspaceModules(db, workspace.id, workspace.availableModules),
      );
      return hasModuleLevel(access.assistant, "read");
    };
    const res = streamSSE(c, async (stream) => {
      const queue: AssistantStreamMessage[] = [];
      let wake = () => {};
      const push = (m: AssistantStreamMessage) => {
        queue.push(m);
        wake();
      };
      const unsubscribe = await hub.subscribe(user.id, workspace.id, push);
      stream.onAbort(() => wake());
      try {
        // Flush the headers now so the client knows the stream is open.
        await stream.write(": open\n\n");
        const deadline = Date.now() + MAX_STREAM_MS;
        let nextCheck = Date.now() + streamRevalidateMs;
        while (!stream.aborted && !stream.closed && Date.now() < deadline) {
          if (!queue.length) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(
                resolve,
                Math.max(0, Math.min(HEARTBEAT_MS, nextCheck - Date.now(), deadline - Date.now())),
              );
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = () => {};
          }
          if (stream.aborted) break;
          if (Date.now() >= nextCheck) {
            nextCheck = Date.now() + streamRevalidateMs;
            if (!(await stillAuthorized())) break;
          }
          if (!queue.length) {
            await stream.write(": ping\n\n");
            continue;
          }
          for (const m of queue.splice(0)) {
            await stream.writeSSE({ event: ASSISTANT_STREAM_EVENT, data: JSON.stringify(m) });
          }
        }
      } finally {
        unsubscribe();
      }
    });
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return res;
  });
