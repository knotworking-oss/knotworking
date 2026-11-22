/** Private assistant coordination. Never enters workspace sync, bootstrap, or search. */
import type { AssistantReply, AssistantStreamMessage } from "@knotworking/core";
import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { assistantConversations, assistantMessages } from "./assistant";
import { ts, workspaceRef } from "./helpers";

export const assistantClaims = pgTable("assistant_claims", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => assistantConversations.id, { onDelete: "cascade" }),
  token: uuid("token").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const assistantTurns = pgTable(
  "assistant_turns",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: workspaceRef(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => assistantMessages.id, { onDelete: "cascade" }),
    reply: jsonb("reply").$type<AssistantReply>().notNull(),
    /** Heartbeat: the process running the turn touches it; a silent turn is ended by the sweep. */
    lastEventAt: ts("last_event_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [
    uniqueIndex("assistant_turns_running_key")
      .on(t.conversationId)
      .where(sql`${t.endedAt} is null`),
  ],
);

export const assistantRuntimeEvents = pgTable(
  "assistant_runtime_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: workspaceRef(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    message: jsonb("message").$type<AssistantStreamMessage>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("assistant_runtime_events_stream_idx").on(t.userId, t.workspaceId, t.id)],
);
