import { newId } from "@knotworking/core";
import {
  qualityIncidentHolds,
  qualityIncidentEvents,
  productionRecords,
  recordChanges,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import { ApiError } from "../errors";
/** Enforced even when Quality is hidden or disabled. Caller holds the workspace write lock. */
export async function assertNoIncidentHold(db: Executor, workspaceId: string, lotId: string) {
  const [hold] = await db
    .select({ id: qualityIncidentHolds.id })
    .from(qualityIncidentHolds)
    .where(
      and(
        eq(qualityIncidentHolds.workspaceId, workspaceId),
        eq(qualityIncidentHolds.lotId, lotId),
        isNull(qualityIncidentHolds.releasedAt),
      ),
    )
    .limit(1);
  if (hold)
    throw new ApiError(
      409,
      "incident_hold",
      "This lot has an active incident hold. Release every incident hold before QA release.",
    );
}

/** Open batches may produce after the incident snapshot: inherit every active input hold. */
export async function inheritIncidentHolds(
  db: Transaction,
  workspaceId: string,
  batchId: string,
  lotId: string,
  actorId: string,
) {
  const inputs = await db
    .select({ lotId: productionRecords.lotId })
    .from(productionRecords)
    .where(
      and(
        eq(productionRecords.workspaceId, workspaceId),
        eq(productionRecords.batchId, batchId),
        eq(productionRecords.kind, "consumption"),
      ),
    )
    .groupBy(productionRecords.lotId)
    .having(sql`sum(${productionRecords.quantity}) > 0`);
  if (!inputs.length) return;
  const parents = await db
    .selectDistinct({ incidentId: qualityIncidentHolds.incidentId })
    .from(qualityIncidentHolds)
    .where(
      and(
        eq(qualityIncidentHolds.workspaceId, workspaceId),
        inArray(
          qualityIncidentHolds.lotId,
          inputs.map((i) => i.lotId),
        ),
        isNull(qualityIncidentHolds.releasedAt),
      ),
    );
  for (const p of parents) {
    await db
      .insert(qualityIncidentHolds)
      .values({ workspaceId, incidentId: p.incidentId, lotId })
      .onConflictDoUpdate({
        target: [qualityIncidentHolds.incidentId, qualityIncidentHolds.lotId],
        set: { releasedAt: null, releasedBy: null, releaseNote: null },
      });
    await db.insert(qualityIncidentEvents).values({
      workspaceId,
      incidentId: p.incidentId,
      actorId,
      data: {
        commandId: newId(),
        kind: "containment",
        lotId,
        note: "Incident hold inherited by later production output. Refresh distribution scope to snapshot the new output.",
      },
    });
  }
  if (parents.length)
    await recordChanges(
      db,
      workspaceId,
      actorId,
      parents.map((p) => ({
        entity: "quality_incident" as const,
        entityId: p.incidentId,
        action: "upsert" as const,
        data: { id: p.incidentId, status: "open" },
      })),
    );
}
