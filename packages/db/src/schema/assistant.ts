/**
 * Assistant module: each member's provider API keys and settings, and their chat conversations.
 * All of it is personal: written directly, never in the sync log or bootstrap.
 * See docs/assistant.md and `@knotworking/core` assistant.ts.
 */
import type {
  AssistantContext,
  AssistantMessageStatus,
  AssistantPart,
  AssistantProvider,
} from "@knotworking/core";
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";

/**
 * A member's API key for one provider, encrypted with a key derived from the server secret
 * (`apps/server/src/services/assistant-keys.ts`). Only `last4` is ever shown. `model` is the model
 * new chats on this provider use.
 */
export const assistantProviderKeys = pgTable(
  "assistant_provider_keys",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<AssistantProvider>().notNull(),
    ciphertext: text("ciphertext").notNull(),
    last4: text("last4").notNull(),
    model: text("model"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("assistant_provider_keys_user_provider_key").on(t.userId, t.provider)],
);

/** A member's assistant preferences. A missing row means the defaults (read-only, no default provider). */
export const assistantSettings = pgTable("assistant_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** What the agent's temporary API token may do. */
  scope: text("scope").$type<"read" | "write">().notNull().default("read"),
  defaultProvider: text("default_provider").$type<AssistantProvider>(),
  /** Modules whose MCP tools the assistant is given; null = `ASSISTANT_DEFAULT_MODULES`. */
  modules: jsonb("modules").$type<string[]>(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** One chat thread. Belongs to a person in a workspace; nobody else can see it. */
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    provider: text("provider").$type<AssistantProvider>().notNull().default("claude"),
    /** The model id this chat uses; null means the member's saved model for the provider. */
    model: text("model"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("assistant_conversations_owner_idx").on(t.workspaceId, t.userId, t.updatedAt)],
);

/** A message: the person's prompt (`user`) or the agent's reply (`assistant`, built from events). */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: pk(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    /** The prompt (user messages). */
    text: text("text"),
    /** The reply (assistant messages). */
    parts: jsonb("parts").$type<AssistantPart[]>().notNull().default([]),
    status: text("status").$type<AssistantMessageStatus>().notNull().default("done"),
    error: text("error"),
    context: jsonb("context").$type<AssistantContext>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("assistant_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);
