import type { PipelineEventKind } from "@knotworking/core";
import { automationPipelines, automationPipelineRuns, type Transaction } from "@knotworking/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { automationEnabledForRequest } from "./automation-events";

// Queue module events in the source write transaction. Linked reports are executed by the worker
// after the stock receipt or audit is committed.
export async function queuePipelineEvent(
  tx: Transaction,
  workspaceId: string,
  kind: PipelineEventKind,
  recordIds: readonly string[],
  date: string | (() => Promise<string>),
) {
  if (!recordIds.length || !automationEnabledForRequest()) return;
  const pipelines = await tx
    .select()
    .from(automationPipelines)
    .where(
      and(
        eq(automationPipelines.workspaceId, workspaceId),
        isNull(automationPipelines.deletedAt),
        sql`${automationPipelines.definition}->>'enabled' = 'true'`,
        sql`(${automationPipelines.definition}->'eventTriggers') ? ${kind}`,
      ),
    );
  if (!pipelines.length) return;
  const asAt = typeof date === "string" ? date : await date();
  await tx
    .insert(automationPipelineRuns)
    .values(
      pipelines.flatMap((pipeline) =>
        recordIds.map((recordId) => ({
          workspaceId,
          pipelineId: pipeline.id,
          actorId: pipeline.ownerId,
          definition: pipeline.definition,
          key: `event:${kind}:${recordId}`,
          asAt,
        })),
      ),
    )
    .onConflictDoNothing({ target: [automationPipelineRuns.pipelineId, automationPipelineRuns.key] });
}
