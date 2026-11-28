import { z } from "zod";

export const taskLinkKinds = ["related", "duplicate_of"] as const;
export type TaskRelationKind = "blocks" | (typeof taskLinkKinds)[number];
const targetId = z.uuid().transform((id) => id.toLowerCase());
export const taskLinkCreateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("related"), targetId }),
  z.strictObject({ kind: z.literal("duplicate_of"), targetId, close: z.boolean().optional() }),
]);
export type TaskLinkCreateInput = z.infer<typeof taskLinkCreateSchema>;

/**
 * Task dependencies, as clients see them: `blockingTaskId` blocks `blockedTaskId`.
 * Pure helpers shared by every client (the server enforces the same rules).
 */
export interface TaskRelationLink {
  blockingTaskId: string;
  blockedTaskId: string;
}

/**
 * Whether adding "`blockingTaskId` blocks `blockedTaskId`" would close a cycle
 * (or link a task to itself): true when `blockedTaskId` already blocks
 * `blockingTaskId`, directly or through other tasks.
 */
export function wouldCreateBlockingCycle(
  relations: Iterable<TaskRelationLink>,
  blockingTaskId: string,
  blockedTaskId: string,
): boolean {
  if (blockingTaskId === blockedTaskId) return true;
  const blocks = new Map<string, string[]>();
  for (const r of relations)
    blocks.set(r.blockingTaskId, [...(blocks.get(r.blockingTaskId) ?? []), r.blockedTaskId]);
  const seen = new Set([blockedTaskId]);
  const stack = [blockedTaskId];
  while (stack.length) {
    for (const next of blocks.get(stack.pop()!) ?? []) {
      if (next === blockingTaskId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}
