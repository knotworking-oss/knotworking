import { createHash, randomBytes } from "node:crypto";
import {
  ASSISTANT_TOKEN_MINUTES,
  isModuleId,
  isTokenActionId,
  type ApiTokenCreateInput,
  type ApiTokenScope,
  type ApiTokenUpdateInput,
  type ModuleId,
  type TokenActionId,
} from "@knotworking/core";
import { apiTokens, hasActiveMembership, users, type Database } from "@knotworking/db";
import { and, count, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { ApiError, notFound } from "../errors";

/** Every personal API token starts with this, so it can be told apart from a Better Auth session token. */
export const API_TOKEN_PREFIX = "knw_";
/** Characters of the plaintext kept for display ("knw_AbCd"). */
const DISPLAY_PREFIX_LENGTH = 8;
/** A token with no explicit `expiresInDays` lasts this long: a leaked one shouldn't work forever. */
const DEFAULT_EXPIRY_DAYS = 90;
/** `lastUsedAt` is refreshed at most this often, so a busy agent doesn't write on every request. */
const LAST_USED_GRANULARITY_MS = 5 * 60_000;

/** A user may hold at most this many active (not revoked, not expired) tokens. */
export const MAX_ACTIVE_API_TOKENS = 25;
/** Revoked or expired tokens are deleted this long after they stopped working. */
const DEAD_TOKEN_RETENTION_MS = 30 * 86_400_000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const isApiToken = (value: string) => value.startsWith(API_TOKEN_PREFIX);

const publicColumns = {
  id: apiTokens.id,
  name: apiTokens.name,
  scope: apiTokens.scope,
  modules: apiTokens.modules,
  tokenActions: apiTokens.tokenActions,
  maxOrderValue: apiTokens.maxOrderValue,
  prefix: apiTokens.prefix,
  createdAt: apiTokens.createdAt,
  expiresAt: apiTokens.expiresAt,
  lastUsedAt: apiTokens.lastUsedAt,
};

/**
 * Creates a token. The plaintext is returned here and never again; only its SHA-256 hash is stored.
 * Refuses a 26th active token (`too_many_tokens`), and tidies up: the user's tokens that were revoked
 * or expired more than 30 days ago are deleted.
 */
export async function createApiToken(db: Database, userId: string, input: ApiTokenCreateInput) {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const apiToken = await db.transaction(async (tx) => {
    // Serialise this user's creations so concurrent requests can't slip past the cap.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`knotworking:api-tokens:${userId}`}))`);
    const now = Date.now();
    const cutoff = new Date(now - DEAD_TOKEN_RETENTION_MS);
    await tx
      .delete(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, userId),
          or(lt(apiTokens.revokedAt, cutoff), lt(apiTokens.expiresAt, cutoff)),
        ),
      );
    const [active] = await tx
      .select({ n: count() })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, userId),
          eq(apiTokens.kind, "personal"),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date(now))),
        ),
      );
    if ((active?.n ?? 0) >= MAX_ACTIVE_API_TOKENS) {
      throw new ApiError(
        400,
        "too_many_tokens",
        `You can have at most ${MAX_ACTIVE_API_TOKENS} active API tokens. Revoke one you no longer use, then try again.`,
      );
    }
    const [row] = await tx
      .insert(apiTokens)
      .values({
        userId,
        name: input.name,
        scope: input.scope,
        modules: input.modules ? [...new Set(input.modules)] : null,
        // Least privilege: a new token may use no person-only action until it is given some.
        tokenActions: input.tokenActions ?? [],
        maxOrderValue: input.maxOrderValue ?? null,
        tokenHash: hashToken(token),
        prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
        expiresAt: new Date(now + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 86_400_000),
      })
      .returning(publicColumns);
    return row!;
  });
  return { token, apiToken };
}

/**
 * A token for one assistant turn: the member's own permissions at the scope they chose, valid for
 * {@link ASSISTANT_TOKEN_MINUTES} minutes, never listed and not counted toward the member's limit.
 * Like any token it may use no person-only action. The turn revokes it when it ends.
 */
export async function createAssistantToken(
  db: Database,
  userId: string,
  scope: ApiTokenScope,
  modules: readonly ModuleId[] | null = null,
) {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      name: "Assistant",
      kind: "assistant",
      scope,
      // The member's choice of modules limits what the token may reach at the API, not just the tool list.
      modules: modules ? [...new Set(modules)] : null,
      tokenActions: [],
      tokenHash: hashToken(token),
      prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      expiresAt: new Date(Date.now() + ASSISTANT_TOKEN_MINUTES * 60_000),
    })
    .returning({ id: apiTokens.id });
  return { token, id: row!.id };
}

/** Revokes a token made by {@link createAssistantToken} (idempotent). */
export async function revokeAssistantToken(db: Database, id: string) {
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)));
}

/** The user's live (not revoked) tokens, newest first. Expired ones stay listed so they can be cleaned up. */
export async function listApiTokens(db: Database, userId: string) {
  return db
    .select(publicColumns)
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), eq(apiTokens.kind, "personal"), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
}

/**
 * Edits what one of the user's own tokens may do through person-only actions: its allowlist and
 * its order-value cap. Anyone else's (or an unknown or revoked) token is a 404. Sending
 * `tokenActions` replaces the list (an old token with no list becomes restricted to it).
 */
export async function updateApiToken(db: Database, userId: string, id: string, input: ApiTokenUpdateInput) {
  const [row] = await db
    .update(apiTokens)
    .set({
      ...(input.tokenActions !== undefined ? { tokenActions: input.tokenActions } : {}),
      ...(input.maxOrderValue !== undefined ? { maxOrderValue: input.maxOrderValue } : {}),
    })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning(publicColumns);
  if (!row) throw notFound("API token");
  return row;
}

/** Revokes one of the user's own tokens; anyone else's (or an unknown or already revoked one) is a 404. */
export async function revokeApiToken(db: Database, userId: string, id: string) {
  const [row] = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (!row) throw notFound("API token");
}

/**
 * Revokes every live token the user has. Used when their password is reset or changed: a leaked
 * credential may be what prompted it, so tokens minted under the old password must not survive.
 */
export async function revokeAllApiTokens(db: Database, userId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    return rows.length;
  });
}

/**
 * Whether a token that authenticated earlier is still good: not revoked or expired, its owner not
 * deactivated and still holding an active workspace membership. The same rules as
 * {@link authenticateApiToken} but keyed by id, so a long-lived connection (`/events`) can
 * re-check cheaply without the plaintext token. Does not touch `lastUsedAt`.
 */
export async function isApiTokenValid(db: Database, tokenId: string): Promise<boolean> {
  const [row] = await db
    .select({ expiresAt: apiTokens.expiresAt, userId: users.id })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt), isNull(users.deletedAt)));
  if (!row) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;
  return hasActiveMembership(db, row.userId);
}

export interface TokenIdentity {
  user: { id: string; email: string; name: string };
  tokenId: string;
  scope: ApiTokenScope;
  /** Module allowlist; null = every module the owner can use. Ids this build doesn't know are dropped. */
  modules: ModuleId[] | null;
  /** Person-only actions the token may use; null = every action the workspace allows (older tokens). */
  tokenActions: TokenActionId[] | null;
  /** Largest purchase order the token may send; null = no cap. */
  maxOrderValue: number | null;
}

/**
 * Resolves a plaintext token to its owner, or `null` when it is unknown, revoked or expired, or
 * its owner has no active workspace membership (the same rule as sign-in).
 */
export async function authenticateApiToken(db: Database, plaintext: string): Promise<TokenIdentity | null> {
  const [row] = await db
    .select({
      id: apiTokens.id,
      scope: apiTokens.scope,
      modules: apiTokens.modules,
      tokenActions: apiTokens.tokenActions,
      maxOrderValue: apiTokens.maxOrderValue,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(plaintext)),
        isNull(apiTokens.revokedAt),
        isNull(users.deletedAt),
      ),
    );
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt && row.expiresAt.getTime() <= now) return null;
  if (!(await hasActiveMembership(db, row.userId))) return null;

  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() >= LAST_USED_GRANULARITY_MS) {
    // Conditional, so concurrent requests don't all write.
    const stale = new Date(now - LAST_USED_GRANULARITY_MS);
    await db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(
        and(eq(apiTokens.id, row.id), or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, stale))),
      );
  }
  return {
    user: { id: row.userId, email: row.email, name: row.name },
    tokenId: row.id,
    scope: row.scope,
    modules: row.modules ? row.modules.filter(isModuleId) : null,
    tokenActions: row.tokenActions ? row.tokenActions.filter(isTokenActionId) : null,
    maxOrderValue: row.maxOrderValue,
  };
}
