import { ApiError } from "./errors";
import {
  applyAssistantEvent,
  ASSISTANT_MAX_CONCURRENT_TURNS,
  endAssistantReply,
  isFinalAssistantEvent,
  newId,
  type AssistantEvent,
  type AssistantStreamMessage,
} from "@knotworking/core";
import {
  apiTokens,
  assistantClaims,
  assistantMessages,
  assistantRuntimeEvents,
  assistantTurns,
  type Database,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, eq, gt, isNull, lt, max, sql } from "drizzle-orm";

type Turn = typeof assistantTurns.$inferSelect;
interface TurnInput {
  turnId: string;
  conversationId: string;
  userId: string;
  workspaceId: string;
  messageId: string;
  claimToken?: string;
}
type ReleaseClaim = (() => Promise<void>) & { token: string };
type Listener = { pump: () => Promise<void>; close: () => void };
export interface AssistantHubOptions {
  /** A running turn that has not been touched for this long is ended (its server stopped). */
  staleMs?: number;
  sweepMs?: number;
}

/** Turn state is persisted: claims, replies and the browser's event log live in Postgres, so any
 * API instance can serve a browser and a restart loses nothing but the reply being generated.
 * The process running a turn touches it about once a second; the sweep ends turns that stop
 * being touched. Only the wakeups of local listeners are process-local.
 */
export class AssistantHub {
  private readonly staleMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<Listener>();
  private lastTouch = new Map<string, number>();
  constructor(
    private readonly db: Database,
    options: AssistantHubOptions = {},
  ) {
    this.staleMs = options.staleMs ?? 45_000;
    const interval = options.sweepMs ?? 10_000;
    if (interval) {
      this.timer = setInterval(
        () => void this.sweep().catch((err) => console.error("assistant sweep failed", err)),
        interval,
      );
      this.timer.unref?.();
    }
  }
  private shutdownHooks = new Set<() => Promise<void>>();
  /** Registers work to do before the process exits (the turn runner ends its running replies). */
  addShutdownHook(hook: () => Promise<void>) {
    this.shutdownHooks.add(hook);
  }
  /** Runs the shutdown hooks, waiting at most `ms` for them. */
  async drain(ms = 5_000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.shutdownHooks].map((hook) => hook().catch(() => {}))),
      new Promise((resolve) => (timer = setTimeout(resolve, ms))),
    ]);
    clearTimeout(timer);
  }
  stop() {
    clearInterval(this.timer);
    for (const l of this.listeners) l.close();
    this.listeners.clear();
  }

  /** Expiring, fenced conversation claims prevent concurrent prompts across all API instances. */
  async reserve(conversationId: string): Promise<ReleaseClaim | null> {
    const token = newId();
    const claimed = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:${conversationId}`}, 0))`,
      );
      const [running] = await tx
        .select({ id: assistantTurns.id })
        .from(assistantTurns)
        .where(and(eq(assistantTurns.conversationId, conversationId), isNull(assistantTurns.endedAt)));
      if (running) return false;
      const [claim] = await tx
        .insert(assistantClaims)
        .values({ conversationId, token, expiresAt: new Date(Date.now() + 60_000) })
        .onConflictDoUpdate({
          target: assistantClaims.conversationId,
          set: { token, expiresAt: new Date(Date.now() + 60_000) },
          where: lt(assistantClaims.expiresAt, new Date()),
        })
        .returning();
      return !!claim;
    });
    return claimed
      ? Object.assign(
          async () => {
            await this.db
              .delete(assistantClaims)
              .where(
                and(eq(assistantClaims.conversationId, conversationId), eq(assistantClaims.token, token)),
              );
          },
          { token },
        )
      : null;
  }
  async startTurn(input: TurnInput) {
    await this.db.transaction((tx) => this.queueTurn(tx, input));
  }
  async queueTurn(tx: Transaction, input: TurnInput) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`assistant:${input.conversationId}`}, 0))`,
    );
    if (input.claimToken) {
      const [claim] = await tx
        .select()
        .from(assistantClaims)
        .where(
          and(
            eq(assistantClaims.conversationId, input.conversationId),
            eq(assistantClaims.token, input.claimToken),
            gt(assistantClaims.expiresAt, new Date()),
          ),
        );
      if (!claim)
        throw new ApiError(409, "assistant_busy", "The conversation claim expired. Send the prompt again.");
    }
    // At most a few replies per member at once, counted under a per-member lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`assistant-user:${input.userId}`}, 0))`,
    );
    const [running] = await tx
      .select({ n: count() })
      .from(assistantTurns)
      .where(and(eq(assistantTurns.userId, input.userId), isNull(assistantTurns.endedAt)));
    if ((running?.n ?? 0) >= ASSISTANT_MAX_CONCURRENT_TURNS) {
      throw new ApiError(
        429,
        "assistant_too_many",
        `You already have ${ASSISTANT_MAX_CONCURRENT_TURNS} replies running. Wait for one to finish, or stop it.`,
      );
    }
    await tx.insert(assistantTurns).values({
      id: input.turnId,
      conversationId: input.conversationId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      reply: { parts: [], status: "running" },
    });
    await tx.delete(assistantClaims).where(eq(assistantClaims.conversationId, input.conversationId));
  }
  async runningTurn(conversationId: string) {
    const [turn] = await this.db
      .select()
      .from(assistantTurns)
      .where(and(eq(assistantTurns.conversationId, conversationId), isNull(assistantTurns.endedAt)));
    return turn;
  }
  async liveReply(messageId: string) {
    const [turn] = await this.db
      .select({ reply: assistantTurns.reply })
      .from(assistantTurns)
      .where(and(eq(assistantTurns.messageId, messageId), isNull(assistantTurns.endedAt)));
    return turn?.reply;
  }
  private async append(tx: Transaction, turn: Turn, messages: AssistantStreamMessage[]) {
    if (!messages.length) return;
    // Preserve event commit order per owner even when different conversations emit concurrently.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`assistant-events:${turn.userId}`}, 0))`,
    );
    await tx.insert(assistantRuntimeEvents).values(
      messages.map((message) => ({
        userId: turn.userId,
        workspaceId: turn.workspaceId,
        conversationId: turn.conversationId,
        message,
      })),
    );
  }
  /**
   * Folds a running turn's events into its reply and queues them for the browser. Answers whether
   * the turn is still running: `false` once it ended (stopped, timed out or swept), so the process
   * generating it stops.
   */
  async ingest(turnId: string, events: AssistantEvent[]): Promise<boolean> {
    const open = await this.db.transaction(async (tx) => {
      const [turn] = await tx
        .select()
        .from(assistantTurns)
        .where(eq(assistantTurns.id, turnId))
        .for("update");
      if (!turn || turn.endedAt) return false;
      const messages: AssistantStreamMessage[] = [];
      for (const event of events) {
        turn.reply = applyAssistantEvent(turn.reply, event);
        messages.push({
          type: "event",
          conversationId: turn.conversationId,
          messageId: turn.messageId,
          event,
        });
        if (isFinalAssistantEvent(event)) {
          turn.endedAt = new Date();
          break;
        }
      }
      await tx
        .update(assistantTurns)
        .set({ reply: turn.reply, lastEventAt: new Date(), endedAt: turn.endedAt })
        .where(eq(assistantTurns.id, turnId));
      await this.storeReply(tx, turn);
      if (turn.endedAt && turn.reply.status !== "running")
        messages.push({
          type: "ended",
          conversationId: turn.conversationId,
          messageId: turn.messageId,
          status: turn.reply.status,
          ...(turn.reply.error ? { error: turn.reply.error } : {}),
        });
      await this.append(tx, turn, messages);
      return !turn.endedAt;
    });
    await this.pumpLocal();
    if (!open) this.lastTouch.delete(turnId);
    return open;
  }
  /**
   * Heartbeat from the process running a turn. Records it (at most every 10 s) and answers whether
   * the turn is still running; `false` means it was stopped or swept, so generation should stop.
   */
  async touch(turnId: string): Promise<boolean> {
    const now = Date.now();
    const [turn] = await this.db
      .select({ endedAt: assistantTurns.endedAt })
      .from(assistantTurns)
      .where(eq(assistantTurns.id, turnId));
    if (!turn || turn.endedAt) {
      this.lastTouch.delete(turnId);
      return false;
    }
    if (now - (this.lastTouch.get(turnId) ?? 0) >= 10_000) {
      this.lastTouch.set(turnId, now);
      await this.db
        .update(assistantTurns)
        .set({ lastEventAt: new Date() })
        .where(eq(assistantTurns.id, turnId));
    }
    return true;
  }
  private async storeReply(tx: Transaction, turn: Turn) {
    await tx
      .update(assistantMessages)
      .set({
        parts: turn.reply.parts,
        status: turn.reply.status,
        error: turn.reply.error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(assistantMessages.id, turn.messageId));
  }
  async cancel(conversationId: string) {
    return this.end(conversationId, "cancelled");
  }
  private async end(
    conversationId: string,
    status: "cancelled" | "error",
    error?: string,
    expiredBefore?: Date,
  ) {
    const result = await this.db.transaction(async (tx) => {
      const [turn] = await tx
        .select()
        .from(assistantTurns)
        .where(and(eq(assistantTurns.conversationId, conversationId), isNull(assistantTurns.endedAt)))
        .for("update");
      if (!turn || (expiredBefore && turn.lastEventAt > expiredBefore)) return false;
      turn.reply = endAssistantReply(turn.reply, status, error);
      await tx
        .update(assistantTurns)
        .set({ reply: turn.reply, endedAt: new Date() })
        .where(eq(assistantTurns.id, turn.id));
      await this.storeReply(tx, turn);
      await this.append(tx, turn, [
        { type: "ended", conversationId, messageId: turn.messageId, status, ...(error ? { error } : {}) },
      ]);
      return true;
    });
    await this.pumpLocal();
    return result;
  }
  async sweep() {
    const silentBefore = new Date(Date.now() - this.staleMs);
    const turns = await this.db.select().from(assistantTurns).where(isNull(assistantTurns.endedAt));
    for (const turn of turns) {
      if (turn.lastEventAt < silentBefore)
        await this.end(
          turn.conversationId,
          "error",
          "The server stopped before this reply finished. Send it again.",
          silentBefore,
        );
    }
    const old = new Date(Date.now() - 86_400_000);
    await this.db.delete(assistantRuntimeEvents).where(lt(assistantRuntimeEvents.createdAt, old));
    await this.db.delete(assistantTurns).where(lt(assistantTurns.endedAt, old));
    await this.db.delete(assistantClaims).where(lt(assistantClaims.expiresAt, new Date()));
    // Tokens made for single turns are useless once they expire; don't let them pile up.
    await this.db.delete(apiTokens).where(and(eq(apiTokens.kind, "assistant"), lt(apiTokens.createdAt, old)));
  }

  /** Durable private events are read on every API instance; reconnects recover full replies by GET. */
  async subscribe(userId: string, workspaceId: string, send: (message: AssistantStreamMessage) => void) {
    const scope = and(
      eq(assistantRuntimeEvents.userId, userId),
      eq(assistantRuntimeEvents.workspaceId, workspaceId),
    );
    const [latest] = await this.db
      .select({ id: max(assistantRuntimeEvents.id) })
      .from(assistantRuntimeEvents)
      .where(scope);
    let cursor = BigInt(latest?.id ?? 0),
      closed = false,
      running: Promise<void> | undefined;
    const pump = () =>
      (running ??= (async () => {
        let more = true;
        while (more && !closed) {
          const rows = await this.db
            .select()
            .from(assistantRuntimeEvents)
            .where(and(scope, gt(assistantRuntimeEvents.id, cursor)))
            .orderBy(asc(assistantRuntimeEvents.id))
            .limit(200);
          for (const row of rows) {
            if (closed) return;
            cursor = row.id;
            send(row.message);
          }
          more = rows.length === 200;
        }
      })().finally(() => {
        running = undefined;
      }));
    const timer = setInterval(
      () => void pump().catch((err) => console.error("assistant event poll failed", err)),
      250,
    );
    timer.unref?.();
    const listener: Listener = {
      pump,
      close: () => {
        closed = true;
        clearInterval(timer);
        this.listeners.delete(listener);
      },
    };
    this.listeners.add(listener);
    return listener.close;
  }
  private async pumpLocal() {
    await Promise.all(
      [...this.listeners].map((l) =>
        l.pump().catch((err) => console.error("assistant stream delivery failed", err)),
      ),
    );
  }
}
