import { createHash } from "node:crypto";
import { ledgerCommands, lockWorkspaceLog, type Database, type Transaction } from "@knotworking/db";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../errors";

/** Stable across JSON object-key order; arrays retain their order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The command receipt and ledger entries commit together. Failed commands leave no receipt.
 * Authorization is checked by the route on every attempt, including a replay.
 */
export async function executeLedgerCommand<T>(
  db: Database,
  workspaceId: string,
  actorId: string,
  operation: string,
  input: { commandId?: string },
  payload: unknown,
  execute: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (!input.commandId) return execute(tx); // legacy clients
    const payloadHash = createHash("sha256").update(canonical(payload)).digest("hex");
    const [previous] = await tx
      .select()
      .from(ledgerCommands)
      .where(
        and(
          eq(ledgerCommands.workspaceId, workspaceId),
          eq(ledgerCommands.actorId, actorId),
          eq(ledgerCommands.commandId, input.commandId),
        ),
      );
    if (previous) {
      if (previous.operation !== operation || previous.payloadHash !== payloadHash)
        throw new ApiError(
          409,
          "command_conflict",
          "This command ID was already used for a different request",
        );
      return previous.result as T;
    }
    const result = await execute(tx);
    await tx.insert(ledgerCommands).values({
      workspaceId,
      actorId,
      commandId: input.commandId,
      operation,
      payloadHash,
      result: JSON.parse(JSON.stringify(result)),
    });
    return result;
  });
}
