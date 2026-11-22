import {
  ASSISTANT_DEFAULT_MODULES,
  assistantProviderNames,
  isModuleId,
  type ModuleId,
  type AssistantKeyView,
  type AssistantProvider,
  type AssistantSettingsUpdateInput,
} from "@knotworking/core";
import { assistantProviderKeys, assistantSettings, type Database } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { ApiError, notFound } from "../errors";
import { keyLast4, openSecret, sealSecret } from "./assistant-crypto";
import {
  ProviderKeyRejected,
  ProviderUnavailable,
  type AssistantProviderRegistry,
} from "./assistant-providers";

/**
 * A member's provider API keys and assistant preferences. Keys are sealed at rest
 * (`assistant-crypto.ts`) and only ever leave this module decrypted for one turn
 * (`getProviderKey`); every view of them shows the provider and last four characters only.
 * All personal, so writes go straight to the tables and never to the sync log.
 */

type KeyRow = typeof assistantProviderKeys.$inferSelect;

const keyView = (row: KeyRow): AssistantKeyView => ({
  provider: row.provider,
  last4: row.last4,
  model: row.model,
  updatedAt: row.updatedAt.toISOString(),
});

const sealContext = (userId: string, provider: AssistantProvider) => `${userId}:${provider}`;

export async function listKeys(db: Database, userId: string): Promise<AssistantKeyView[]> {
  const rows = await db.select().from(assistantProviderKeys).where(eq(assistantProviderKeys.userId, userId));
  return rows.map(keyView).sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Provider failures as API errors a member can act on. */
function asApiError(err: unknown): never {
  if (err instanceof ProviderKeyRejected) throw new ApiError(400, "key_rejected", err.message);
  if (err instanceof ProviderUnavailable) throw new ApiError(502, "provider_unavailable", err.message);
  throw err;
}

/**
 * Checks a pasted key with the provider (listing its models), then stores it sealed. A key the
 * provider rejects, or one it can't be asked about, is not stored. Returns the saved key's view and
 * the models it can use. The first key saved also becomes the member's default provider.
 */
export async function saveKey(
  db: Database,
  keyKey: Buffer,
  providers: AssistantProviderRegistry,
  userId: string,
  provider: AssistantProvider,
  input: { key: string; model?: string | null },
) {
  const models = await providers.listModels(provider, input.key).catch(asApiError);
  const sealed = sealSecret(keyKey, input.key, sealContext(userId, provider));
  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(assistantProviderKeys)
      .values({
        userId,
        provider,
        ciphertext: sealed,
        last4: keyLast4(input.key),
        model: input.model ?? null,
      })
      .onConflictDoUpdate({
        target: [assistantProviderKeys.userId, assistantProviderKeys.provider],
        set: {
          ciphertext: sealed,
          last4: keyLast4(input.key),
          // A model sent with the key replaces the old one; leaving it out keeps it.
          ...(input.model !== undefined ? { model: input.model } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    const [settings] = await tx.select().from(assistantSettings).where(eq(assistantSettings.userId, userId));
    if (!settings?.defaultProvider) {
      await tx
        .insert(assistantSettings)
        .values({ userId, defaultProvider: provider })
        .onConflictDoUpdate({
          target: assistantSettings.userId,
          set: { defaultProvider: provider, updatedAt: new Date() },
        });
    }
    return saved!;
  });
  return { key: keyView(row), models };
}

/** Changes the model new chats on a provider use, without touching the key. */
export async function setKeyModel(
  db: Database,
  userId: string,
  provider: AssistantProvider,
  model: string | null,
) {
  const [row] = await db
    .update(assistantProviderKeys)
    .set({ model, updatedAt: new Date() })
    .where(and(eq(assistantProviderKeys.userId, userId), eq(assistantProviderKeys.provider, provider)))
    .returning();
  if (!row) throw notFound("API key");
  return keyView(row);
}

export async function deleteKey(db: Database, userId: string, provider: AssistantProvider) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(assistantProviderKeys)
      .where(and(eq(assistantProviderKeys.userId, userId), eq(assistantProviderKeys.provider, provider)))
      .returning({ id: assistantProviderKeys.id });
    if (!row) throw notFound("API key");
    await tx
      .update(assistantSettings)
      .set({ defaultProvider: null, updatedAt: new Date() })
      .where(and(eq(assistantSettings.userId, userId), eq(assistantSettings.defaultProvider, provider)));
  });
}

/**
 * The member's decrypted key for a provider, for one turn. `null` when there is none, or it can't
 * be opened (the server secret changed): the caller asks the member to enter it again.
 */
export async function getProviderKey(
  db: Database,
  keyKey: Buffer,
  userId: string,
  provider: AssistantProvider,
): Promise<{ key: string; model: string | null } | null> {
  const [row] = await db
    .select()
    .from(assistantProviderKeys)
    .where(and(eq(assistantProviderKeys.userId, userId), eq(assistantProviderKeys.provider, provider)));
  if (!row) return null;
  const key = openSecret(keyKey, row.ciphertext, sealContext(userId, provider));
  return key === null ? null : { key, model: row.model };
}

/** The models the member's saved key for a provider can use (a live call to the provider). */
export async function listKeyModels(
  db: Database,
  keyKey: Buffer,
  providers: AssistantProviderRegistry,
  userId: string,
  provider: AssistantProvider,
) {
  const saved = await getProviderKey(db, keyKey, userId, provider);
  if (!saved) {
    throw new ApiError(
      409,
      "no_provider_key",
      `Add your ${assistantProviderNames[provider]} API key first (Settings → Assistant).`,
    );
  }
  return providers.listModels(provider, saved.key).catch(asApiError);
}

export async function getSettings(db: Database, userId: string) {
  const [row] = await db.select().from(assistantSettings).where(eq(assistantSettings.userId, userId));
  // A stored list that no longer names any known module (one was renamed or removed) falls back to
  // the starter set: an empty list would mean "every module" to the MCP server.
  const stored = row?.modules?.filter(isModuleId) ?? [];
  return {
    scope: row?.scope ?? ("read" as const),
    defaultProvider: row?.defaultProvider ?? null,
    /** Modules whose tools the assistant gets: the member's choice, else the starter set. */
    modules: (stored.length ? stored : [...ASSISTANT_DEFAULT_MODULES]) as ModuleId[],
    /** Whether `modules` is the starter set rather than the member's own choice. */
    modulesAreDefault: stored.length === 0,
  };
}

export async function updateSettings(db: Database, userId: string, input: AssistantSettingsUpdateInput) {
  if (input.defaultProvider) {
    const [key] = await db
      .select({ id: assistantProviderKeys.id })
      .from(assistantProviderKeys)
      .where(
        and(
          eq(assistantProviderKeys.userId, userId),
          eq(assistantProviderKeys.provider, input.defaultProvider),
        ),
      );
    if (!key) {
      throw new ApiError(
        400,
        "no_provider_key",
        "Save a key for that provider before making it the default.",
      );
    }
  }
  const changes = {
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.defaultProvider !== undefined ? { defaultProvider: input.defaultProvider } : {}),
    ...(input.modules !== undefined ? { modules: input.modules ? [...new Set(input.modules)] : null } : {}),
  };
  await db
    .insert(assistantSettings)
    .values({ userId, ...changes })
    .onConflictDoUpdate({ target: assistantSettings.userId, set: { ...changes, updatedAt: new Date() } });
  return getSettings(db, userId);
}
