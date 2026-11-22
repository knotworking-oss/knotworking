import {
  assistantTitleFrom,
  type AssistantContext,
  type AssistantProvider,
  type AssistantReply,
} from "@knotworking/core";
import { assistantConversations, assistantMessages, type Database, type Transaction } from "@knotworking/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { notFound } from "../errors";

/**
 * The assistant's conversations and messages. All personal, so writes go straight to the tables
 * and never to the sync log (like the API token audit). Provider keys are in `assistant-keys.ts`;
 * the agent loop is in `assistant-turn.ts`. See docs/assistant.md.
 */

// ─── Conversations ───────────────────────────────────────────────────────────

type ConversationRow = typeof assistantConversations.$inferSelect;
type MessageRow = typeof assistantMessages.$inferSelect;

export const conversationView = (c: ConversationRow) => ({
  id: c.id,
  title: c.title,
  provider: c.provider,
  model: c.model,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export const messageView = (m: MessageRow) => ({
  id: m.id,
  role: m.role,
  text: m.text,
  parts: m.parts,
  status: m.status,
  error: m.error,
  context: m.context,
  createdAt: m.createdAt,
});
export type AssistantMessageView = ReturnType<typeof messageView>;

export async function listConversations(db: Database, workspaceId: string, userId: string) {
  const rows = await db
    .select()
    .from(assistantConversations)
    .where(
      and(eq(assistantConversations.workspaceId, workspaceId), eq(assistantConversations.userId, userId)),
    )
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(100);
  return rows.map(conversationView);
}

/** One of the caller's own conversations; anyone else's is a 404. */
export async function getConversationRow(db: Database, workspaceId: string, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.id, id),
        eq(assistantConversations.workspaceId, workspaceId),
        eq(assistantConversations.userId, userId),
      ),
    );
  if (!row) throw notFound("Conversation");
  return row;
}

export async function listMessages(db: Database, conversationId: string) {
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id));
  return rows.map(messageView);
}

export async function createConversation(
  db: Database,
  workspaceId: string,
  userId: string,
  input: { id?: string; title?: string; provider: AssistantProvider; model?: string | null },
) {
  const [row] = await db
    .insert(assistantConversations)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId,
      userId,
      title: input.title ?? "New chat",
      provider: input.provider,
      model: input.model ?? null,
    })
    .returning();
  return conversationView(row!);
}

export async function updateConversation(
  db: Database,
  row: ConversationRow,
  input: { title?: string; provider?: AssistantProvider; model?: string | null },
) {
  const [updated] = await db
    .update(assistantConversations)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      updatedAt: new Date(),
    })
    .where(eq(assistantConversations.id, row.id))
    .returning();
  return conversationView(updated!);
}

export async function deleteConversation(db: Database, row: ConversationRow) {
  await db.delete(assistantConversations).where(eq(assistantConversations.id, row.id));
}

/** Stores a prompt and the empty reply it starts. The first prompt also titles the conversation. */
export async function startTurn(
  db: Database,
  conversation: ConversationRow,
  text: string,
  context: AssistantContext | null,
  enqueue?: (tx: Transaction, reply: AssistantMessageView) => Promise<void>,
) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [prompt] = await tx
      .insert(assistantMessages)
      .values({ conversationId: conversation.id, role: "user", text, context, createdAt: now })
      .returning();
    // A millisecond later so the reply always sorts after its prompt.
    const later = new Date(now.getTime() + 1);
    const [reply] = await tx
      .insert(assistantMessages)
      .values({ conversationId: conversation.id, role: "assistant", status: "running", createdAt: later })
      .returning();
    const untitled = conversation.title === "New chat";
    await tx
      .update(assistantConversations)
      .set({ updatedAt: later, ...(untitled ? { title: assistantTitleFrom(text) } : {}) })
      .where(eq(assistantConversations.id, conversation.id));
    if (enqueue) await enqueue(tx, messageView(reply!));
    return { prompt: messageView(prompt!), reply: messageView(reply!) };
  });
}

export async function saveReply(db: Database, messageId: string, reply: AssistantReply) {
  await db
    .update(assistantMessages)
    .set({ parts: reply.parts, status: reply.status, error: reply.error ?? null, updatedAt: new Date() })
    .where(eq(assistantMessages.id, messageId));
}
