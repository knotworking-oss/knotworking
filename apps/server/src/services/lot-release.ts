import {
  evaluateLotRelease,
  hasModuleLevel,
  type LotReleaseRule,
  type LotReleaseRuleInput,
  type ModuleAccessMap,
  type ModuleId,
  type ReleaseCheck,
  type ReleaseEvaluation,
  type ReleaseFacts,
} from "@knotworking/core";
import {
  haccpCcpLogs,
  haccpCorrectiveActions,
  items,
  lotReleaseRules,
  lotReleases,
  productionBatches,
  productionRecords,
  recordChanges,
  specifications,
  specificationVersions,
  testingResults,
  testingSamples,
  users,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { badRequest } from "../errors";
import { findLot } from "./stock-ledger";

/**
 * Evidence-based QA release (milestone 3.2.3). Gathers what other modules hold about a lot (its
 * test samples, the item's approved specification, the CCP monitoring of the batches that made
 * it) and checks it with `evaluateLotRelease`, against the item's versioned release rule.
 *
 * The check runs on every release whatever the person's own module access, because a hidden
 * blocker is still a blocker; what they can't read is shown without its references. Releases are
 * recorded in `lot_releases` with the checks and rule version used.
 */

type RuleRow = typeof lotReleaseRules.$inferSelect;

const ruleOf = (row: RuleRow | undefined): LotReleaseRule | null =>
  row
    ? {
        requirePassingTest: row.requirePassingTest,
        requiredAnalytes: row.requiredAnalytes,
        requireApprovedSpecification: row.requireApprovedSpecification,
        requireCcpReviewed: row.requireCcpReviewed,
        note: row.note,
        version: row.version,
      }
    : null;

const ruleChange = (row: RuleRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "lot_release_rule", entityId: row.id, action: "upsert", data };
};

async function liveRule(db: Executor, workspaceId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(lotReleaseRules)
    .where(
      and(
        eq(lotReleaseRules.workspaceId, workspaceId),
        eq(lotReleaseRules.itemId, itemId),
        isNull(lotReleaseRules.deletedAt),
      ),
    );
  return row;
}

/** Everything the release check needs about a lot, from the modules that are active. */
export async function gatherReleaseFacts(
  db: Executor,
  workspaceId: string,
  lot: { id: string; itemId: string; supplierId: string | null },
  active: readonly ModuleId[],
): Promise<ReleaseFacts> {
  const rule = ruleOf(await liveRule(db, workspaceId, lot.itemId));

  let samples: ReleaseFacts["samples"] = [];
  if (active.includes("testing")) {
    const rows = await db
      .select({
        id: testingSamples.id,
        reference: testingSamples.reference,
        sampledOn: testingSamples.sampledOn,
        status: testingSamples.status,
        outcome: testingSamples.outcome,
        investigationStatus: testingSamples.investigationStatus,
      })
      .from(testingSamples)
      .where(
        and(
          eq(testingSamples.workspaceId, workspaceId),
          eq(testingSamples.lotId, lot.id),
          isNull(testingSamples.deletedAt),
        ),
      )
      .orderBy(asc(testingSamples.sampledOn), asc(testingSamples.reference));
    const results = rows.length
      ? await db
          .select({
            sampleId: testingResults.sampleId,
            name: testingResults.name,
            outcome: testingResults.outcome,
          })
          .from(testingResults)
          .where(
            inArray(
              testingResults.sampleId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    samples = rows.map((r) => ({ ...r, results: results.filter((x) => x.sampleId === r.id) }));
  }

  let approvedSpecification: ReleaseFacts["approvedSpecification"] = null;
  if (active.includes("specifications")) {
    const specs = await db
      .select({
        id: specifications.id,
        code: specifications.code,
        supplierId: specifications.supplierId,
        customerName: specifications.customerName,
        versionNumber: specificationVersions.versionNumber,
      })
      .from(specifications)
      .innerJoin(
        specificationVersions,
        and(
          eq(specificationVersions.specificationId, specifications.id),
          eq(specificationVersions.status, "approved"),
          isNull(specificationVersions.deletedAt),
        ),
      )
      .where(
        and(
          eq(specifications.workspaceId, workspaceId),
          eq(specifications.itemId, lot.itemId),
          eq(specifications.status, "active"),
          isNull(specifications.deletedAt),
        ),
      )
      .orderBy(asc(specifications.code));
    // The lot's supplier's specification, else the internal one, else any approved one.
    const pick =
      (lot.supplierId ? specs.find((s) => s.supplierId === lot.supplierId) : undefined) ??
      specs.find((s) => !s.supplierId && !s.customerName) ??
      specs[0];
    if (pick) approvedSpecification = { id: pick.id, code: pick.code, versionNumber: pick.versionNumber };
  }

  let batches: ReleaseFacts["batches"] = [];
  if (active.includes("production")) {
    batches = await db
      .selectDistinct({ id: productionBatches.id, batchCode: productionBatches.batchCode })
      .from(productionRecords)
      .innerJoin(productionBatches, eq(productionBatches.id, productionRecords.batchId))
      .where(
        and(
          eq(productionRecords.workspaceId, workspaceId),
          eq(productionRecords.lotId, lot.id),
          eq(productionRecords.kind, "output"),
          // A reversed output record (or the reversal itself) didn't make this lot.
          isNull(productionRecords.reversesRecordId),
          sql`not exists (select 1 from ${productionRecords} r2 where r2.reverses_record_id = ${productionRecords.id})`,
        ),
      );
  }

  let ccpLogs: ReleaseFacts["ccpLogs"] = [];
  let openCorrectiveActions: ReleaseFacts["openCorrectiveActions"] = [];
  if (active.includes("haccp") && batches.length) {
    const batchIds = batches.map((b) => b.id);
    const codeOf = new Map(batches.map((b) => [b.id, b.batchCode]));
    const corrector = alias(haccpCcpLogs, "corrector");
    const logs = await db
      .select({
        id: haccpCcpLogs.id,
        ccpCode: haccpCcpLogs.ccpCode,
        batchId: haccpCcpLogs.batchId,
        checkedAt: haccpCcpLogs.checkedAt,
        withinLimits: haccpCcpLogs.withinLimits,
        reviewStatus: haccpCcpLogs.reviewStatus,
      })
      .from(haccpCcpLogs)
      .leftJoin(corrector, eq(corrector.correctsLogId, haccpCcpLogs.id))
      .where(
        and(
          eq(haccpCcpLogs.workspaceId, workspaceId),
          inArray(haccpCcpLogs.batchId, batchIds),
          isNull(corrector.id),
        ),
      )
      .orderBy(asc(haccpCcpLogs.checkedAt));
    ccpLogs = logs.map((l) => ({
      id: l.id,
      ccpCode: l.ccpCode,
      batchCode: codeOf.get(l.batchId!) ?? "",
      checkedAt: l.checkedAt.toISOString(),
      withinLimits: l.withinLimits,
      reviewStatus: l.reviewStatus,
    }));
    const logIds = logs.map((l) => l.id);
    const actions = await db
      .select({
        id: haccpCorrectiveActions.id,
        title: haccpCorrectiveActions.title,
        batchId: haccpCorrectiveActions.batchId,
      })
      .from(haccpCorrectiveActions)
      .where(
        and(
          eq(haccpCorrectiveActions.workspaceId, workspaceId),
          eq(haccpCorrectiveActions.status, "open"),
          logIds.length
            ? or(
                inArray(haccpCorrectiveActions.batchId, batchIds),
                inArray(haccpCorrectiveActions.logId, logIds),
              )
            : inArray(haccpCorrectiveActions.batchId, batchIds),
        ),
      );
    openCorrectiveActions = actions.map((a) => ({
      id: a.id,
      title: a.title,
      batchCode: a.batchId ? (codeOf.get(a.batchId) ?? null) : null,
    }));
  }

  return { active, rule, samples, approvedSpecification, batches, ccpLogs, openCorrectiveActions };
}

/** Hides the references of checks whose module the reader can't read. */
export const forReader = (checks: ReleaseCheck[], access: ModuleAccessMap) =>
  checks.map((c) =>
    hasModuleLevel(access[c.module], "read") ? { ...c, hidden: false } : { ...c, refs: [], hidden: true },
  );

/** The release check for a lot as it stands, for the reader. */
export async function getReleaseCheck(
  db: Database,
  workspaceId: string,
  lotId: string,
  active: readonly ModuleId[],
  access: ModuleAccessMap,
) {
  const { lot } = await findLot(db, workspaceId, lotId);
  const evaluation = evaluateLotRelease(await gatherReleaseFacts(db, workspaceId, lot, active));
  const rule = ruleOf(await liveRule(db, workspaceId, lot.itemId));
  return {
    lotId: lot.id,
    status: lot.status,
    blocked: evaluation.blocked,
    ruleVersion: evaluation.ruleVersion,
    rule,
    checks: forReader(evaluation.checks, access),
  };
}

/** Records a release with the checks and rule it was made under. Call inside the status change. */
export async function recordRelease(
  tx: Executor,
  workspaceId: string,
  actorId: string,
  input: {
    lotId: string;
    fromStatus: "quarantine" | "rejected";
    note: string;
    evaluation: ReleaseEvaluation;
    rule: LotReleaseRule | null;
    /** An approved exception request; required when the evaluation is blocked. */
    exception?: {
      requestId: string;
      requestedBy: string | null;
      reason: string;
      evidence: string;
      selfApproved: boolean;
    };
  },
) {
  const exception = input.evaluation.blocked ? input.exception : undefined;
  if (input.evaluation.blocked && !exception)
    throw new Error("A blocked release needs an approved exception");
  const [row] = await tx
    .insert(lotReleases)
    .values({
      workspaceId,
      lotId: input.lotId,
      releasedBy: actorId,
      fromStatus: input.fromStatus,
      note: input.note,
      ruleVersion: input.evaluation.ruleVersion,
      rule: input.rule,
      checks: input.evaluation.checks,
      exception: !!exception,
      exceptionReason: exception?.reason ?? null,
      exceptionEvidence: exception?.evidence ?? null,
      exceptionRequestId: exception?.requestId ?? null,
      exceptionRequestedBy: exception?.requestedBy ?? null,
      exceptionSelfApproved: exception?.selfApproved ?? false,
    })
    .returning({ id: lotReleases.id });
  return row!.id;
}

const requester = alias(users, "exception_requester");

/** A lot's releases, newest first. */
export async function listLotReleases(
  db: Database,
  workspaceId: string,
  lotId: string,
  access: ModuleAccessMap,
) {
  await findLot(db, workspaceId, lotId);
  const rows = await db
    .select({ release: lotReleases, releasedByName: users.name, exceptionRequestedByName: requester.name })
    .from(lotReleases)
    .leftJoin(users, eq(users.id, lotReleases.releasedBy))
    .leftJoin(requester, eq(requester.id, lotReleases.exceptionRequestedBy))
    .where(and(eq(lotReleases.workspaceId, workspaceId), eq(lotReleases.lotId, lotId)))
    .orderBy(desc(lotReleases.releasedAt));
  return {
    releases: rows.map(({ release, releasedByName, exceptionRequestedByName }) => {
      const { workspaceId: _ws, ...rest } = release;
      return {
        ...rest,
        checks: forReader(release.checks, access),
        releasedByName,
        exceptionRequestedByName,
      };
    }),
  };
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export async function listReleaseRules(db: Database, workspaceId: string) {
  const rows = await db
    .select({ rule: lotReleaseRules, itemCode: items.code, itemName: items.name, updatedByName: users.name })
    .from(lotReleaseRules)
    .innerJoin(items, eq(items.id, lotReleaseRules.itemId))
    .leftJoin(users, eq(users.id, lotReleaseRules.updatedBy))
    .where(and(eq(lotReleaseRules.workspaceId, workspaceId), isNull(lotReleaseRules.deletedAt)))
    .orderBy(asc(items.code));
  return {
    rules: rows.map(({ rule, itemCode, itemName, updatedByName }) => {
      const { workspaceId: _ws, deletedAt: _deleted, ...rest } = rule;
      return { ...rest, item: { id: rule.itemId, code: itemCode, name: itemName }, updatedByName };
    }),
  };
}

/** Sets an item's release rule; each change is a new version. */
export async function setReleaseRule(
  db: Database,
  workspaceId: string,
  actorId: string,
  itemId: string,
  input: LotReleaseRuleInput,
) {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
    if (!item) throw badRequest("That item doesn't exist");
    const existing = await liveRule(tx, workspaceId, itemId);
    const fields = {
      requirePassingTest: input.requirePassingTest,
      requiredAnalytes: input.requiredAnalytes,
      requireApprovedSpecification: input.requireApprovedSpecification,
      requireCcpReviewed: input.requireCcpReviewed,
      note: input.note ?? null,
      updatedBy: actorId,
    };
    const [row] = existing
      ? await tx
          .update(lotReleaseRules)
          .set({ ...fields, version: existing.version + 1 })
          .where(eq(lotReleaseRules.id, existing.id))
          .returning()
      : await tx
          .insert(lotReleaseRules)
          .values({ workspaceId, itemId, ...fields })
          .returning();
    await recordChanges(tx, workspaceId, actorId, [ruleChange(row!)]);
  });
  return (await listReleaseRules(db, workspaceId)).rules.find((r) => r.itemId === itemId)!;
}

/** Removes an item's rule: its lots then need only the checks that always apply. */
export async function deleteReleaseRule(db: Database, workspaceId: string, actorId: string, itemId: string) {
  await db.transaction(async (tx) => {
    const existing = await liveRule(tx, workspaceId, itemId);
    if (!existing) return;
    await tx
      .update(lotReleaseRules)
      .set({ deletedAt: new Date(), updatedBy: actorId })
      .where(eq(lotReleaseRules.id, existing.id));
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "lot_release_rule", entityId: existing.id, action: "delete" },
    ]);
  });
}

export { liveRule as releaseRuleRow, ruleOf as releaseRuleOf };
