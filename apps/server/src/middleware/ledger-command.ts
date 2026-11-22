import type { Context } from "hono";
import { z } from "zod";
import { badRequest } from "../errors";

/** Both body and header are supported; the same key must survive a transport retry. */
export function ledgerInput<T extends { commandId?: string }>(c: Context, input: T): T {
  const header = c.req.header("Idempotency-Key");
  if (!header) return input;
  if (!z.uuid().safeParse(header).success) throw badRequest("Idempotency-Key must be a UUID");
  if (input.commandId && input.commandId !== header) throw badRequest("Conflicting command IDs");
  return { ...input, commandId: header };
}
