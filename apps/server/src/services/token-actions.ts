import {
  isTokenActionId,
  personOnlyActions,
  tokenActionList,
  tokenActions,
  tokenMayUseAction,
  type ModuleId,
  type TokenActionId,
  type TokenActionLogQuery,
  type TokenActionState,
} from "@knotworking/core";
import {
  apiTokenActionLog,
  apiTokens,
  recordChanges,
  users,
  workspaceTokenActions,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

/**
 * API access toggles (`@knotworking/core` token-actions.ts): which person-only actions a workspace
 * has opened to API tokens, and the audit of what tokens did through them.
 */

/** Whether the workspace has switched `action` on. One lookup on the (workspace_id, action) key. */
export async function isTokenActionEnabled(db: Executor, workspaceId: string, action: TokenActionId) {
  const [row] = await db
    .select({ id: workspaceTokenActions.id })
    .from(workspaceTokenActions)
    .where(and(eq(workspaceTokenActions.workspaceId, workspaceId), eq(workspaceTokenActions.action, action)));
  return Boolean(row);
}

async function enabledRows(db: Executor, workspaceId: string) {
  const rows = await db
    .select({
      action: workspaceTokenActions.action,
      enabledAt: workspaceTokenActions.enabledAt,
      enabledBy: users.name,
    })
    .from(workspaceTokenActions)
    .leftJoin(users, eq(users.id, workspaceTokenActions.enabledBy))
    .where(eq(workspaceTokenActions.workspaceId, workspaceId));
  return new Map(rows.map((r) => [r.action, r]));
}

const stateOf = (
  id: TokenActionId,
  row: { enabledAt: Date; enabledBy: string | null } | undefined,
  /** The calling token's own allowlist (`undefined`: the caller is a person, so it doesn't apply). */
  token?: { tokenActions: readonly string[] | null },
): TokenActionState => ({
  ...tokenActions[id],
  enabled: Boolean(row),
  allowedForToken: token ? tokenMayUseAction(token.tokenActions, id) : null,
  enabledBy: row?.enabledBy ?? null,
  enabledAt: row?.enabledAt.toISOString() ?? null,
});

/**
 * The toggleable actions of `modules` (the active modules the caller can read) with whether each
 * is on, and the person-only actions of the same modules.
 */
export async function listTokenActions(
  db: Database,
  workspaceId: string,
  modules: readonly ModuleId[],
  /** Set when a token is asking: its allowlist, so it (and the MCP server) can see what it may use. */
  token?: { tokenActions: readonly string[] | null },
) {
  const enabled = await enabledRows(db, workspaceId);
  return {
    actions: tokenActionList
      .filter((a) => modules.includes(a.module))
      .map((a) => stateOf(a.id, enabled.get(a.id), token)),
    personOnly: personOnlyActions.filter((a) => modules.includes(a.module)),
  };
}

/**
 * Switches one action on or off. Unknown actions are a 404 `not_found`; actions of a module that
 * is not active in this environment a 404 `module_inactive` (as their routes answer). A change is
 * recorded in the sync log as `token_action` (always an upsert, `enabled` saying which), so open
 * clients and agents refresh what tokens may do. Switching to the state it is already in changes
 * nothing (who enabled it and when are kept).
 */
export async function setTokenAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  actionParam: string,
  enabled: boolean,
): Promise<TokenActionState> {
  if (!isTokenActionId(actionParam)) throw notFound("Token action");
  const action = actionParam;
  const { module } = tokenActions[action];
  if (!active.includes(module)) {
    throw new ApiError(404, "module_inactive", `The ${module} module is not enabled on this server`);
  }
  return db.transaction(async (tx) => {
    const [row] = enabled
      ? await tx
          .insert(workspaceTokenActions)
          .values({ workspaceId, action, enabledBy: actorId })
          .onConflictDoNothing({ target: [workspaceTokenActions.workspaceId, workspaceTokenActions.action] })
          .returning({ id: workspaceTokenActions.id })
      : await tx
          .delete(workspaceTokenActions)
          .where(
            and(eq(workspaceTokenActions.workspaceId, workspaceId), eq(workspaceTokenActions.action, action)),
          )
          .returning({ id: workspaceTokenActions.id });
    const state = stateOf(action, (await enabledRows(tx, workspaceId)).get(action));
    if (row) {
      // The same shape `GET …/token-actions` gives (`enabledBy` is the person's name), so a client
      // can apply the change as it is.
      const { enabledBy, enabledAt } = state;
      await recordChanges(tx, workspaceId, actorId, [
        {
          entity: "token_action",
          entityId: row.id,
          action: "upsert",
          data: { id: row.id, action, module, enabled, enabledBy, enabledAt },
        },
      ]);
    }
    return state;
  });
}

/**
 * Appends one audit row for a request a token made through a toggle. Runs on its own, outside the
 * request's transaction, so a refused or failed call is recorded with its status too. A single
 * insert, and deliberately not in the sync log: the audit is for owners and admins only, and the
 * sync log goes to every member.
 */
export async function logTokenActionUse(
  db: Database,
  entry: {
    workspaceId: string;
    tokenId: string;
    userId: string;
    action: TokenActionId;
    method: string;
    path: string;
    status: number;
    /** Why the token's own allowlist or limit refused it (the refusal's message). */
    note?: string | null;
  },
) {
  const [row] = await db
    .insert(apiTokenActionLog)
    .values({
      ...entry,
      tokenName: sql`coalesce((select ${apiTokens.name} from ${apiTokens} where ${apiTokens.id} = ${entry.tokenId}), '')`,
    })
    .returning({ tokenName: apiTokenActionLog.tokenName });
  return row?.tokenName ?? "";
}

/** The audit, newest first, with the token's name and the name of the person it acted for. */
export async function listTokenActionLog(db: Database, workspaceId: string, query: TokenActionLogQuery) {
  const where = and(
    eq(apiTokenActionLog.workspaceId, workspaceId),
    query.tokenId ? eq(apiTokenActionLog.tokenId, query.tokenId) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: apiTokenActionLog.id,
        createdAt: apiTokenActionLog.createdAt,
        action: apiTokenActionLog.action,
        method: apiTokenActionLog.method,
        path: apiTokenActionLog.path,
        status: apiTokenActionLog.status,
        note: apiTokenActionLog.note,
        tokenId: apiTokenActionLog.tokenId,
        tokenName: apiTokenActionLog.tokenName,
        userId: apiTokenActionLog.userId,
        userName: users.name,
      })
      .from(apiTokenActionLog)
      .leftJoin(users, eq(users.id, apiTokenActionLog.userId))
      .where(where)
      .orderBy(desc(apiTokenActionLog.createdAt), desc(apiTokenActionLog.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(apiTokenActionLog).where(where),
  ]);
  return {
    entries: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      /** The action's label (`null` for an action this build no longer knows). */
      label: isTokenActionId(r.action) ? tokenActions[r.action].label : null,
    })),
    total: total?.n ?? 0,
  };
}
