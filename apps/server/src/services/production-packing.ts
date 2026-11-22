import {
  evaluatePackingCheck,
  packingCheckKinds,
  packingCheckLabels,
  packingRunGaps,
  reconciliationVariance,
  type PackingCheckInput,
  type PackingCheckKind,
  type PackingRunCloseInput,
  type PackingRunOpenInput,
  type PackingVoidInput,
} from "@knotworking/core";
import {
  productionBatches,
  productionPackingChecks,
  productionPackingRuns,
  productionRecords,
  productLabels,
  recordChanges,
  specifications,
  specificationVersions,
  stockLots,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { findBatch, userNames } from "./ports/production";

/**
 * Packing checks (3.5.3): a packing run per batch pins the approved label and specification version
 * the packs carry; checks are recorded against it and closing reconciles packaging. Rules in
 * `@knotworking/core` production-packing.ts. Checks are append-only; a closed run never changes.
 */

type RunRow = typeof productionPackingRuns.$inferSelect;
/** Whether the caller may see the labels and specifications modules' candidates. */
export type PackingViewAccess = { labels: boolean; specifications: boolean };
type CheckRow = typeof productionPackingChecks.$inferSelect;

const strip = <T extends { workspaceId: string }>(row: T) => {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
};
const runChange = (row: RunRow): ChangeInput => ({
  entity: "production_packing_run",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});
const checkChange = (row: CheckRow): ChangeInput => ({
  entity: "production_packing_check",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

async function findRun(db: Executor, ws: string, id: string) {
  const [row] = await db
    .select()
    .from(productionPackingRuns)
    .where(and(eq(productionPackingRuns.id, id), eq(productionPackingRuns.workspaceId, ws)));
  if (!row) throw notFound("Packing run");
  return row;
}

const assertOpen = (run: RunRow) => {
  if (run.status !== "open")
    throw new ApiError(409, "packing_run_closed", "This packing run is closed and can't change");
};

/** The latest live (not voided) check of each kind. */
function latestByKind(checks: readonly CheckRow[]) {
  const latest: Partial<Record<PackingCheckKind, CheckRow>> = {};
  // Ties broken by id (UUIDv7, so in order of creation), the same everywhere.
  for (const c of [...checks].sort((a, b) => +a.checkedAt - +b.checkedAt || (a.id < b.id ? -1 : 1))) {
    if (!c.voidedAt) latest[c.kind] = c;
  }
  return latest;
}

/** Approved labels drafted from the batch's own recipe version: the ones its packs may carry. */
async function labelCandidates(db: Executor, ws: string, batch: typeof productionBatches.$inferSelect) {
  return db
    .select()
    .from(productLabels)
    .where(
      and(
        eq(productLabels.workspaceId, ws),
        eq(productLabels.recipeId, batch.recipeId),
        eq(productLabels.recipeVersionId, batch.recipeVersionId),
        eq(productLabels.status, "approved"),
      ),
    )
    .orderBy(asc(productLabels.variant));
}

/** Approved specification versions of the batch's output item. */
async function specificationCandidates(
  db: Executor,
  ws: string,
  batch: typeof productionBatches.$inferSelect,
) {
  return db
    .select({ version: specificationVersions, spec: specifications })
    .from(specificationVersions)
    .innerJoin(specifications, eq(specifications.id, specificationVersions.specificationId))
    .where(
      and(
        eq(specificationVersions.workspaceId, ws),
        eq(specifications.itemId, batch.outputItemId),
        eq(specificationVersions.status, "approved"),
        eq(specifications.status, "active"),
        isNull(specifications.deletedAt),
      ),
    )
    .orderBy(asc(specifications.code));
}

async function runViews(db: Executor, ws: string, runs: RunRow[]) {
  const checks = runs.length
    ? await db
        .select()
        .from(productionPackingChecks)
        .where(
          and(
            eq(productionPackingChecks.workspaceId, ws),
            inArray(
              productionPackingChecks.runId,
              runs.map((r) => r.id),
            ),
          ),
        )
        .orderBy(asc(productionPackingChecks.checkedAt), asc(productionPackingChecks.id))
    : [];
  const names = await userNames(db, [
    ...runs.flatMap((r) => [r.openedBy, r.closedBy]),
    ...checks.flatMap((c) => [c.recordedBy, c.voidedBy]),
  ]);
  const who = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return runs.map((run) => {
    const mine = checks.filter((c) => c.runId === run.id);
    const latest = latestByKind(mine);
    const gaps = packingRunGaps(
      { detectorRequired: run.detectorRequired, nominalQuantity: run.nominalQuantity },
      Object.fromEntries(Object.entries(latest).map(([k, c]) => [k, { passed: c!.passed }])),
    );
    return {
      ...strip(run),
      openedByName: who(run.openedBy),
      closedByName: who(run.closedBy),
      /** What still stands between the run and closing (empty: it can close). */
      gaps,
      latest: Object.fromEntries(
        packingCheckKinds.map((k) => [
          k,
          latest[k]
            ? { id: latest[k]!.id, passed: latest[k]!.passed, checkedAt: latest[k]!.checkedAt }
            : null,
        ]),
      ),
      checks: mine.map((c) => ({
        ...strip(c),
        kindLabel: packingCheckLabels[c.kind],
        recordedByName: who(c.recordedBy),
        voidedByName: who(c.voidedBy),
      })),
    };
  });
}

/** A batch's packing: its runs (newest first) with checks and gaps, and what a new run may pin. */
export async function getBatchPacking(
  db: Executor,
  ws: string,
  batchId: string,
  access: { labels: boolean; specifications: boolean },
) {
  const batch = await findBatch(db, ws, batchId);
  const runs = await db
    .select()
    .from(productionPackingRuns)
    .where(and(eq(productionPackingRuns.workspaceId, ws), eq(productionPackingRuns.batchId, batchId)))
    .orderBy(desc(productionPackingRuns.openedAt));
  // The candidates are the labels and specifications modules' records: only for their readers.
  // Without labels access, `labelCount` says whether the server can pin the only approved label.
  const labelRows = await labelCandidates(db, ws, batch);
  const labels = access.labels ? labelRows : [];
  const specs = access.specifications ? await specificationCandidates(db, ws, batch) : [];
  const views = await runViews(db, ws, runs);
  return {
    batchId,
    batchCode: batch.batchCode,
    status: batch.status,
    open: views.find((r) => r.status === "open") ?? null,
    runs: views,
    candidates: {
      labels: labels.map((l) => ({
        id: l.id,
        variant: l.variant,
        versionNumber: l.versionNumber,
        productName: l.productName,
        netQuantity: l.netQuantity,
        gtin: l.gtin,
      })),
      specifications: specs.map(({ version, spec }) => ({
        id: version.id,
        code: spec.code,
        title: spec.title,
        versionNumber: version.versionNumber,
      })),
      labelsVisible: access.labels,
      /** Approved labels for the batch's recipe version: with exactly one, omitting the label pins it. */
      labelCount: labelRows.length,
      defaultLotCode: batch.batchCode,
    },
  };
}

/**
 * Opens a packing run on a started (or completed) batch. The label must be approved, of the batch's
 * recipe and drafted from the batch's own recipe version, so the allergens and declaration on the
 * pack are the ones the batch is made to. Required when the labels module is on; omitted, the only
 * approved label is pinned (so a packer without labels access can start), and a choice among
 * several is refused.
 */
export async function openPackingRun(
  db: Database,
  ws: string,
  actor: string,
  batchId: string,
  input: PackingRunOpenInput,
  access: { labelsActive: boolean } & PackingViewAccess,
) {
  await executeLedgerCommand(db, ws, actor, "openPackingRun", input, { batchId, input }, async (tx) => {
    const batch = await findBatch(tx, ws, batchId);
    if (batch.status !== "in_progress" && batch.status !== "completed")
      throw new ApiError(
        409,
        "batch_not_running",
        `Batch ${batch.batchCode} is ${batch.status}: packing needs a started or completed batch`,
      );
    const [open] = await tx
      .select({ id: productionPackingRuns.id })
      .from(productionPackingRuns)
      .where(and(eq(productionPackingRuns.batchId, batchId), eq(productionPackingRuns.status, "open")));
    if (open)
      throw new ApiError(
        409,
        "packing_run_open",
        "This batch already has an open packing run; close it first",
      );
    let labelSummary: RunRow["labelSummary"] = null;
    let labelId = input.labelId;
    if (!labelId && access.labelsActive) {
      const options = await labelCandidates(tx, ws, batch);
      if (options.length !== 1)
        throw new ApiError(
          409,
          "label_choice_needed",
          options.length
            ? `There are ${options.length} approved labels for this batch: choose the one the packs carry`
            : "No approved label for the recipe version this batch is made to: approve one first",
        );
      labelId = options[0]!.id;
    }
    if (labelId) {
      const [label] = await tx
        .select()
        .from(productLabels)
        .where(and(eq(productLabels.id, labelId), eq(productLabels.workspaceId, ws)));
      if (!label) throw notFound("Label");
      if (label.status !== "approved")
        throw new ApiError(
          409,
          "label_not_approved",
          `Label v${label.versionNumber} (${label.variant}) is ${label.status}, not approved`,
        );
      if (label.recipeId !== batch.recipeId || label.recipeVersionId !== batch.recipeVersionId)
        throw new ApiError(
          409,
          "label_not_for_batch",
          "This label wasn't drafted from the recipe version the batch is made to; approve a label for that version",
        );
      labelSummary = {
        recipeId: label.recipeId,
        recipeVersionId: label.recipeVersionId,
        variant: label.variant,
        versionNumber: label.versionNumber,
        productName: label.productName,
        gtin: label.gtin,
        netQuantity: label.netQuantity,
        allergenStatement: label.allergenStatement,
      };
    }
    let specificationSummary: RunRow["specificationSummary"] = null;
    if (input.specificationVersionId) {
      const [row] = await tx
        .select({ version: specificationVersions, spec: specifications })
        .from(specificationVersions)
        .innerJoin(specifications, eq(specifications.id, specificationVersions.specificationId))
        .where(
          and(
            eq(specificationVersions.id, input.specificationVersionId),
            eq(specificationVersions.workspaceId, ws),
            eq(specifications.status, "active"),
            isNull(specifications.deletedAt),
          ),
        );
      if (!row) throw notFound("Specification version");
      if (row.version.status !== "approved")
        throw new ApiError(
          409,
          "specification_not_approved",
          `${row.spec.code} v${row.version.versionNumber} is not approved`,
        );
      if (row.spec.itemId !== batch.outputItemId)
        throw new ApiError(
          409,
          "specification_not_for_batch",
          `${row.spec.code} doesn't specify what this batch makes`,
        );
      specificationSummary = {
        specificationId: row.spec.id,
        code: row.spec.code,
        title: row.spec.title,
        versionNumber: row.version.versionNumber,
      };
    }
    const [run] = await tx
      .insert(productionPackingRuns)
      .values({
        workspaceId: ws,
        batchId,
        labelId,
        labelSummary,
        specificationVersionId: input.specificationVersionId ?? null,
        specificationSummary,
        nominalQuantity: input.nominalQuantity ?? null,
        expectedDateCode: input.expectedDateCode,
        expectedLotCode: input.expectedLotCode ?? batch.batchCode,
        detectorRequired: input.detectorRequired,
        note: input.note || null,
        openedBy: actor,
      })
      .returning();
    await recordChanges(tx, ws, actor, [runChange(run!)]);
    return { id: run!.id };
  });
  return getBatchPacking(db, ws, batchId, access);
}

/**
 * Records a check on an open run inside the caller's transaction (after the workspace lock): the
 * rules for which checks the run takes, the evaluation, and the required action on a failure.
 * `extraDetails` is kept with what was entered (the device a weight sample came from).
 */
export async function insertPackingCheck(
  tx: Transaction,
  ws: string,
  actor: string,
  runId: string,
  input: PackingCheckInput,
  extraDetails: Record<string, unknown> = {},
) {
  const run = await findRun(tx, ws, runId);
  assertOpen(run);
  const batch = await findBatch(tx, ws, run.batchId);
  if (batch.status === "cancelled")
    throw new ApiError(409, "batch_cancelled", `Batch ${batch.batchCode} is cancelled`);
  if (input.kind === "weight_sample" && run.nominalQuantity === null)
    throw new ApiError(409, "no_nominal_quantity", "This run has no nominal quantity to weigh against");
  if (input.kind === "detector_challenge" && !run.detectorRequired)
    throw new ApiError(409, "no_detector", "This run was opened for a line without a metal detector");
  const outcome = evaluatePackingCheck(input, {
    expectedDateCode: run.expectedDateCode,
    expectedLotCode: run.expectedLotCode,
    nominalQuantity: run.nominalQuantity,
  });
  if (!outcome.passed && !input.failureAction?.trim())
    throw new ApiError(
      400,
      "failure_action_required",
      `The check failed (${outcome.reasons.join("; ")}): say what was done about it, e.g. packs since the last good check held`,
    );
  const { commandId: _c, kind, failureAction, note, ...details } = input;
  const [row] = await tx
    .insert(productionPackingChecks)
    .values({
      workspaceId: ws,
      runId,
      kind,
      details: { ...details, ...outcome.result, ...extraDetails },
      passed: outcome.passed,
      reasons: outcome.reasons,
      failureAction: outcome.passed ? null : failureAction!.trim(),
      note: note || null,
      // Stamped here, after the workspace lock, so checks order as they were committed.
      checkedAt: new Date(),
      recordedBy: actor,
    })
    .returning();
  await recordChanges(tx, ws, actor, [checkChange(row!)]);
  return { run, check: row! };
}

/** Records a check on an open run. A failure must say what was done about it. */
export async function recordPackingCheck(
  db: Database,
  ws: string,
  actor: string,
  runId: string,
  input: PackingCheckInput,
  view: PackingViewAccess,
) {
  const batchId = await executeLedgerCommand(
    db,
    ws,
    actor,
    "recordPackingCheck",
    input,
    { runId, input },
    async (tx) => (await insertPackingCheck(tx, ws, actor, runId, input)).run.batchId,
  );
  return getBatchPacking(db, ws, batchId, view);
}

export async function voidPackingCheck(
  db: Database,
  ws: string,
  actor: string,
  id: string,
  input: PackingVoidInput,
  view: PackingViewAccess,
) {
  const batchId = await executeLedgerCommand(
    db,
    ws,
    actor,
    "voidPackingCheck",
    input,
    { id, input },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(productionPackingChecks)
        .where(and(eq(productionPackingChecks.id, id), eq(productionPackingChecks.workspaceId, ws)));
      if (!row) throw notFound("Packing check");
      if (row.voidedAt) throw new ApiError(409, "already_voided", "This check has already been voided");
      const run = await findRun(tx, ws, row.runId);
      assertOpen(run);
      const [updated] = await tx
        .update(productionPackingChecks)
        .set({ voidedAt: new Date(), voidedBy: actor, voidReason: input.reason })
        .where(eq(productionPackingChecks.id, id))
        .returning();
      await recordChanges(tx, ws, actor, [checkChange(updated!)]);
      return run.batchId;
    },
  );
  return getBatchPacking(db, ws, batchId, view);
}

/**
 * Closes a run: every required check on record and the last of each kind passed, and packaging
 * reconciled (issued = used + wasted + returned, or the difference explained). A person's sign-off.
 */
export async function closePackingRun(
  db: Database,
  ws: string,
  actor: string,
  runId: string,
  input: PackingRunCloseInput,
  view: PackingViewAccess,
) {
  const batchId = await executeLedgerCommand(
    db,
    ws,
    actor,
    "closePackingRun",
    input,
    { runId, input },
    async (tx) => {
      const run = await findRun(tx, ws, runId);
      assertOpen(run);
      const checks = await tx
        .select()
        .from(productionPackingChecks)
        .where(and(eq(productionPackingChecks.workspaceId, ws), eq(productionPackingChecks.runId, runId)));
      const latest = latestByKind(checks);
      const gaps = packingRunGaps(
        { detectorRequired: run.detectorRequired, nominalQuantity: run.nominalQuantity },
        Object.fromEntries(Object.entries(latest).map(([k, c]) => [k, { passed: c!.passed }])),
      );
      if (gaps.length)
        throw new ApiError(409, "packing_checks_incomplete", `The run can't close yet: ${gaps.join("; ")}`);
      const lines = input.reconciliation.map((l) => ({
        itemId: l.itemId ?? null,
        material: l.material,
        printed: l.printed,
        issued: l.issued,
        used: l.used,
        wasted: l.wasted,
        returned: l.returned,
        variance: reconciliationVariance(l),
      }));
      if (run.labelSummary && !lines.some((l) => l.printed))
        throw new ApiError(
          400,
          "printed_packaging_required",
          "Reconcile the printed labels or film the packs carry: mark that material as printed",
        );
      const unreconciled = lines.filter((l) => l.variance !== 0);
      if (unreconciled.length && !input.varianceReason?.trim())
        throw new ApiError(
          400,
          "variance_reason_required",
          `Packaging doesn't reconcile (${unreconciled.map((l) => `${l.material}: ${l.variance > 0 ? "+" : ""}${l.variance}`).join(", ")}): explain the difference`,
        );
      const [updated] = await tx
        .update(productionPackingRuns)
        .set({
          status: "closed",
          closedBy: actor,
          closedAt: new Date(),
          packsProduced: input.packsProduced,
          reconciliation: lines,
          varianceReason: unreconciled.length ? input.varianceReason!.trim() : null,
          closeNote: input.note || null,
        })
        .where(eq(productionPackingRuns.id, runId))
        .returning();
      await recordChanges(tx, ws, actor, [runChange(updated!)]);
      return run.batchId;
    },
  );
  return getBatchPacking(db, ws, batchId, view);
}

/**
 * Which approved label and specification version a lot's packs carry: the packing runs of the
 * batches that produced the lot (net production records), each with its runs oldest first.
 */
export async function getLotPacking(db: Executor, ws: string, lotId: string) {
  const [lot] = await db
    .select()
    .from(stockLots)
    .where(and(eq(stockLots.id, lotId), eq(stockLots.workspaceId, ws)));
  if (!lot) throw notFound("Lot");
  const records = await db
    .select({ batchId: productionRecords.batchId, quantity: productionRecords.quantity })
    .from(productionRecords)
    .where(
      and(
        eq(productionRecords.workspaceId, ws),
        eq(productionRecords.lotId, lotId),
        eq(productionRecords.kind, "output"),
      ),
    );
  const net = new Map<string, number>();
  for (const r of records) net.set(r.batchId, (net.get(r.batchId) ?? 0) + r.quantity);
  const batchIds = [...net.entries()].filter(([, q]) => q > 1e-9).map(([id]) => id);
  const batches = batchIds.length
    ? await db
        .select()
        .from(productionBatches)
        .where(and(eq(productionBatches.workspaceId, ws), inArray(productionBatches.id, batchIds)))
    : [];
  const runs = batchIds.length
    ? await db
        .select()
        .from(productionPackingRuns)
        .where(
          and(eq(productionPackingRuns.workspaceId, ws), inArray(productionPackingRuns.batchId, batchIds)),
        )
        .orderBy(asc(productionPackingRuns.openedAt))
    : [];
  return {
    lotId,
    lotCode: lot.lotCode,
    batches: batches.map((b) => {
      const mine = runs.filter((r) => r.batchId === b.id);
      return {
        batchId: b.id,
        batchCode: b.batchCode,
        packingRuns: mine.map((r) => ({
          id: r.id,
          status: r.status,
          label: r.labelSummary,
          specification: r.specificationSummary,
          expectedDateCode: r.expectedDateCode,
          expectedLotCode: r.expectedLotCode,
          openedAt: r.openedAt,
          closedAt: r.closedAt,
        })),
        /** No packing run: what the packs carry wasn't recorded. */
        unrecorded: mine.length === 0,
      };
    }),
  };
}
