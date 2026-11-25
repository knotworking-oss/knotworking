import {
  changeoverAllergenRisk,
  checkOutcome,
  checkSignOffLabels,
  checkAwaitsSignOff,
  describeFrequency,
  endOfDayInZone,
  startOfDayInZone,
  siteCheckDueState,
  type CheckSignOffInput,
  type ChecklistCheckCorrectInput,
  type ChecklistCheckCreateInput,
  type ChecklistCheckListQuery,
  type ChecklistTemplateCreateInput,
  type ChecklistTemplateListQuery,
  type ChecklistTemplateUpdateInput,
  type AllergenRollup,
  type ChangeoverRiskQuery,
  type ChecklistKind,
  type ChecklistActionListQuery,
  type SiteDueItem,
  type SiteFrequency,
} from "@knotworking/core";
import {
  lockWorkspaceLog,
  checklistActions,
  productionBatches,
  recipeVersions,
  recordChanges,
  siteChecklistCheckItems,
  siteChecklistChecks,
  siteChecklistItems,
  siteChecklistTemplates,
  siteGlassBreakages,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { assertArea } from "./ports/assets";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceTimeZone } from "./time-zone";
import { findBatch, userNames } from "./ports/production";

import {
  strip,
  stripSoft,
  change,
  nameOf,
  frequencyOf,
  momentOf,
  page,
  areasById,
  areaOf,
} from "./operation-records";

type TemplateRow = typeof siteChecklistTemplates.$inferSelect;
type TemplateItemRow = typeof siteChecklistItems.$inferSelect;
type CheckRow = typeof siteChecklistChecks.$inferSelect;
type CheckItemRow = typeof siteChecklistCheckItems.$inferSelect;

export type ChecklistScope = "general" | "site";

const matchesScope = (
  column: typeof siteChecklistTemplates.kind | typeof siteChecklistChecks.kind,
  scope: ChecklistScope,
) => (scope === "general" ? eq(column, "general") : ne(column, "general"));

function assertKind(scope: ChecklistScope, kind: ChecklistKind) {
  if ((kind === "general") !== (scope === "general"))
    throw badRequest("Invalid checklist kind for this programme");
}

function checklistEntities(scope: ChecklistScope) {
  return scope === "general"
    ? ({
        template: "checklist_template",
        item: "checklist_item",
        check: "checklist_check",
        result: "checklist_check_item",
      } as const)
    : ({
        template: "site_checklist_template",
        item: "site_checklist_item",
        check: "site_checklist_check",
        result: "site_checklist_check_item",
      } as const);
}

// ─── Pre-start and allergen changeover checks ────────────────────────────────

async function findTemplate(db: Executor, workspaceId: string, id: string, scope: ChecklistScope) {
  const [row] = await db
    .select()
    .from(siteChecklistTemplates)
    .where(
      and(
        eq(siteChecklistTemplates.id, id),
        matchesScope(siteChecklistTemplates.kind, scope),
        eq(siteChecklistTemplates.workspaceId, workspaceId),
        isNull(siteChecklistTemplates.deletedAt),
      ),
    );
  if (!row) throw notFound("Checklist");
  return row;
}

const liveItemsOf = (db: Executor, templateIds: string[]) =>
  templateIds.length
    ? db
        .select()
        .from(siteChecklistItems)
        .where(and(inArray(siteChecklistItems.templateId, templateIds), isNull(siteChecklistItems.deletedAt)))
        .orderBy(asc(siteChecklistItems.sortOrder), asc(siteChecklistItems.id))
    : Promise.resolve([] as TemplateItemRow[]);

const notCorrectedCheck = sql`not exists (select 1 from ${siteChecklistChecks} c where c.corrects_check_id = ${siteChecklistChecks.id})`;
/** A check that counts as done for what's due: replaced by nothing, not held, and passed. */
const countsAsDoneCheck = and(
  notCorrectedCheck,
  ne(siteChecklistChecks.signOffStatus, "rejected"),
  eq(siteChecklistChecks.outcome, "passed"),
);

/** The latest check of each template that counts as done. */
async function lastDoneChecks(db: Executor, workspaceId: string, templateIds: string[]) {
  if (templateIds.length === 0) return new Map<string, CheckRow>();
  const rows = await db
    .selectDistinctOn([siteChecklistChecks.templateId])
    .from(siteChecklistChecks)
    .where(
      and(
        eq(siteChecklistChecks.workspaceId, workspaceId),
        inArray(siteChecklistChecks.templateId, templateIds),
        countsAsDoneCheck,
      ),
    )
    .orderBy(
      siteChecklistChecks.templateId,
      desc(siteChecklistChecks.performedAt),
      desc(siteChecklistChecks.createdAt),
      desc(siteChecklistChecks.id),
    );
  return new Map(rows.map((r) => [r.templateId, r]));
}

const templateFrequency = (t: TemplateRow) => frequencyOf(t.frequencyEvery, t.frequencyUnit);

/** Whether any production batch is in progress (checks made only during production are idle otherwise). */
async function isProducing(db: Executor, workspaceId: string) {
  const [row] = await db
    .select({ id: productionBatches.id })
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.workspaceId, workspaceId),
        isNull(productionBatches.deletedAt),
        eq(productionBatches.status, "in_progress"),
      ),
    )
    .limit(1);
  return !!row;
}

async function describeTemplates(
  db: Executor,
  workspaceId: string,
  rows: TemplateRow[],
  withProduction: boolean,
) {
  if (rows.length === 0) return [];
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const ids = rows.map((r) => r.id);
  const [items, areas, last, producing] = await Promise.all([
    liveItemsOf(db, ids),
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    lastDoneChecks(db, workspaceId, ids),
    withProduction && rows.some((row) => row.duringProduction) ? isProducing(db, workspaceId) : false,
  ]);
  return rows.map((row) => {
    const frequency = templateFrequency(row);
    const lastCheck = last.get(row.id) ?? null;
    return {
      ...stripSoft(row),
      frequency,
      frequencyText: frequency ? describeFrequency(frequency) : null,
      area: areaOf(areas, row.areaId),
      items: items
        .filter((i) => i.templateId === row.id)
        .map((i) => ({ id: i.id, sortOrder: i.sortOrder, prompt: i.prompt, guidance: i.guidance })),
      lastCheck: lastCheck
        ? { id: lastCheck.id, performedAt: lastCheck.performedAt, signOffStatus: lastCheck.signOffStatus }
        : null,
      due:
        row.status === "active" && frequency
          ? siteCheckDueState({
              frequency,
              lastAt: lastCheck?.performedAt ?? null,
              timeZone,
              duringProduction: row.duringProduction,
              producing,
            })
          : null,
    };
  });
}

export async function listChecklistTemplates(
  db: Database,
  workspaceId: string,
  query: ChecklistTemplateListQuery,
  scope: ChecklistScope,
  withProduction = false,
) {
  const where: (SQL | undefined)[] = [
    eq(siteChecklistTemplates.workspaceId, workspaceId),
    matchesScope(siteChecklistTemplates.kind, scope),
    isNull(siteChecklistTemplates.deletedAt),
  ];
  if (query.kind) where.push(eq(siteChecklistTemplates.kind, query.kind));
  if (query.status !== "all") where.push(eq(siteChecklistTemplates.status, query.status));
  const rows = await db
    .select()
    .from(siteChecklistTemplates)
    .where(and(...where))
    .orderBy(asc(siteChecklistTemplates.name), asc(siteChecklistTemplates.id));
  return { templates: await describeTemplates(db, workspaceId, rows, withProduction) };
}

export async function getChecklistTemplate(
  db: Executor,
  workspaceId: string,
  id: string,
  scope: ChecklistScope,
  withProduction = false,
) {
  return (
    await describeTemplates(db, workspaceId, [await findTemplate(db, workspaceId, id, scope)], withProduction)
  )[0]!;
}

const templateFrequencyColumns = (f: SiteFrequency | null | undefined) =>
  f === undefined ? {} : { frequencyEvery: f?.every ?? null, frequencyUnit: f?.unit ?? null };

export async function createChecklistTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ChecklistTemplateCreateInput,
  scope: ChecklistScope,
  withProduction = false,
) {
  assertKind(scope, input.kind);
  const entities = checklistEntities(scope);
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.areaId) await assertArea(tx, workspaceId, input.areaId);
    if (input.duringProduction && !input.frequency) {
      throw badRequest("A check made only during production needs a frequency");
    }
    const { id, items: itemInputs, frequency, ...fields } = input;
    const [template] = await tx
      .insert(siteChecklistTemplates)
      .values({
        ...(id ? { id } : {}),
        ...fields,
        ...templateFrequencyColumns(frequency),
        workspaceId,
      } as typeof siteChecklistTemplates.$inferInsert)
      .returning();
    const items = await tx
      .insert(siteChecklistItems)
      .values(
        itemInputs.map((item, index) => ({
          workspaceId,
          templateId: template!.id,
          sortOrder: index,
          prompt: item.prompt,
          guidance: item.guidance ?? null,
        })),
      )
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      change(entities.template, template!),
      ...items.map((i) => change(entities.item, i)),
    ]);
    return template!.id;
  });
  return getChecklistTemplate(db, workspaceId, id, scope, withProduction);
}

/**
 * Edits a checklist. Sending `items` replaces the list: items that keep their `id` stay the same
 * item (history follows them), new ones are added and the ones left out are removed. Checks already
 * done keep the wording they were done against.
 */
export async function updateChecklistTemplate(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: ChecklistTemplateUpdateInput,
  scope: ChecklistScope,
  withProduction = false,
) {
  if (patch.kind !== undefined) assertKind(scope, patch.kind);
  const entities = checklistEntities(scope);
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const template = await findTemplate(tx, workspaceId, id, scope);
    if (patch.areaId) await assertArea(tx, workspaceId, patch.areaId);
    const frequency = patch.frequency !== undefined ? patch.frequency : templateFrequency(template);
    const during = patch.duringProduction ?? template.duringProduction;
    if (during && !frequency) throw badRequest("A check made only during production needs a frequency");
    const { items: itemInputs, frequency: freqPatch, ...fields } = patch;
    const changes: ChangeInput[] = [];
    const [updated] = await tx
      .update(siteChecklistTemplates)
      .set({ ...fields, ...templateFrequencyColumns(freqPatch), updatedAt: new Date() })
      .where(eq(siteChecklistTemplates.id, id))
      .returning();
    changes.push(change(entities.template, updated!));
    if (itemInputs) {
      const existing = (await liveItemsOf(tx, [id])).filter((i) => i.templateId === id);
      const byId = new Map(existing.map((i) => [i.id, i]));
      for (const item of itemInputs) {
        if (item.id && !byId.has(item.id)) throw badRequest("An item doesn't belong to this checklist");
      }
      const keep = new Set(itemInputs.map((i) => i.id).filter((i): i is string => !!i));
      for (const gone of existing.filter((i) => !keep.has(i.id))) {
        const [row] = await tx
          .update(siteChecklistItems)
          .set({ deletedAt: new Date() })
          .where(eq(siteChecklistItems.id, gone.id))
          .returning();
        changes.push({ entity: entities.item, entityId: row!.id, action: "delete" });
      }
      for (const [index, item] of itemInputs.entries()) {
        if (item.id) {
          const [row] = await tx
            .update(siteChecklistItems)
            .set({ sortOrder: index, prompt: item.prompt, guidance: item.guidance ?? null })
            .where(eq(siteChecklistItems.id, item.id))
            .returning();
          changes.push(change(entities.item, row!));
        } else {
          const [row] = await tx
            .insert(siteChecklistItems)
            .values({
              workspaceId,
              templateId: id,
              sortOrder: index,
              prompt: item.prompt,
              guidance: item.guidance ?? null,
            })
            .returning();
          changes.push(change(entities.item, row!));
        }
      }
    }
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getChecklistTemplate(db, workspaceId, id, scope, withProduction);
}

// Checks --------------------------------------------------------------------

/** The oldest open glass breakage in each of the areas, by area id. */
async function openBreakagesByArea(db: Executor, areaIds: (string | null)[]) {
  const ids = [...new Set(areaIds.filter((a): a is string => !!a))];
  const held = new Map<string, { id: string; description: string; occurredAt: Date }>();
  if (ids.length === 0) return held;
  const rows = await db
    .select({
      id: siteGlassBreakages.id,
      areaId: siteGlassBreakages.areaId,
      description: siteGlassBreakages.description,
      occurredAt: siteGlassBreakages.occurredAt,
    })
    .from(siteGlassBreakages)
    .where(and(inArray(siteGlassBreakages.areaId, ids), eq(siteGlassBreakages.status, "open")))
    .orderBy(asc(siteGlassBreakages.occurredAt), asc(siteGlassBreakages.id));
  for (const r of rows) if (!held.has(r.areaId)) held.set(r.areaId, r);
  return held;
}

/** The allergens each batch's recipe version was approved with (`null` if none were recorded). */
async function batchAllergens(db: Executor, batchIds: string[]) {
  const out = new Map<string, AllergenRollup>();
  if (batchIds.length === 0) return out;
  const rows = await db
    .select({ id: productionBatches.id, allergens: recipeVersions.approvedAllergens })
    .from(productionBatches)
    .innerJoin(recipeVersions, eq(recipeVersions.id, productionBatches.recipeVersionId))
    .where(inArray(productionBatches.id, batchIds));
  for (const r of rows) if (r.allergens) out.set(r.id, r.allergens);
  return out;
}

/** The allergen risk of running one batch after another on a line, before a check is recorded. */
export async function getChangeoverRisk(db: Database, workspaceId: string, query: ChangeoverRiskQuery) {
  for (const id of [query.previousBatchId, query.nextBatchId]) await assertBatchRef(db, workspaceId, id);
  const ids = [query.previousBatchId, query.nextBatchId].filter((b): b is string => !!b);
  const allergensOf = await batchAllergens(db, ids);
  return changeoverAllergenRisk({
    previous: query.previousBatchId ? (allergensOf.get(query.previousBatchId) ?? null) : null,
    next: query.nextBatchId ? (allergensOf.get(query.nextBatchId) ?? null) : null,
    previousNamed: !!query.previousBatchId,
    nextNamed: !!query.nextBatchId,
  });
}

async function describeChecks(db: Executor, rows: CheckRow[], withProduction: boolean) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const batchIds = withProduction
    ? [...new Set(rows.flatMap((r) => [r.previousBatchId, r.nextBatchId]).filter((b): b is string => !!b))]
    : [];
  const [items, areas, corrections, batches, names, holds] = await Promise.all([
    db
      .select()
      .from(siteChecklistCheckItems)
      .where(inArray(siteChecklistCheckItems.checkId, ids))
      .orderBy(asc(siteChecklistCheckItems.sortOrder), asc(siteChecklistCheckItems.id)),
    areasById(
      db,
      rows.map((r) => r.areaId),
    ),
    db
      .select({ id: siteChecklistChecks.id, correctsCheckId: siteChecklistChecks.correctsCheckId })
      .from(siteChecklistChecks)
      .where(inArray(siteChecklistChecks.correctsCheckId, ids)),
    batchIds.length
      ? db
          .select({ id: productionBatches.id, batchCode: productionBatches.batchCode })
          .from(productionBatches)
          .where(inArray(productionBatches.id, batchIds))
      : Promise.resolve([] as { id: string; batchCode: string }[]),
    userNames(
      db,
      rows.flatMap((r) => [r.performedBy, r.signedOffBy]),
    ),
    openBreakagesByArea(
      db,
      rows.filter((r) => r.kind !== "general" && r.signOffStatus === "pending").map((r) => r.areaId),
    ),
  ]);
  const correctedBy = new Map(corrections.map((c) => [c.correctsCheckId!, c.id]));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const allergensOf = await batchAllergens(db, batchIds);
  return rows.map((row) => {
    const correctedByCheckId = correctedBy.get(row.id) ?? null;
    const own = items.filter((i: CheckItemRow) => i.checkId === row.id);
    return {
      ...strip(row),
      /** Allergen changeovers only: what the batch before leaves behind. A warning, never a block. */
      allergenRisk:
        withProduction && row.kind === "allergen_changeover"
          ? changeoverAllergenRisk({
              previous: row.previousBatchId ? (allergensOf.get(row.previousBatchId) ?? null) : null,
              next: row.nextBatchId ? (allergensOf.get(row.nextBatchId) ?? null) : null,
              previousNamed: !!row.previousBatchId,
              nextNamed: !!row.nextBatchId,
            })
          : null,
      performedByName: nameOf(names, row.performedBy),
      signedOffByName: nameOf(names, row.signedOffBy),
      area: areaOf(areas, row.areaId),
      previousBatch: row.previousBatchId ? (batchById.get(row.previousBatchId) ?? null) : null,
      nextBatch: row.nextBatchId ? (batchById.get(row.nextBatchId) ?? null) : null,
      correctedByCheckId,
      awaitingSignOff: checkAwaitsSignOff({ signOffStatus: row.signOffStatus, correctedByCheckId }),
      /** The open glass breakage that holds this check's area, so it can't be signed off yet. */
      areaHold:
        row.signOffStatus === "pending" && !correctedByCheckId && row.areaId
          ? (holds.get(row.areaId) ?? null)
          : null,
      signOffLabel: checkSignOffLabels[row.signOffStatus],
      results: own.map(({ checkId: _c, workspaceId: _w, ...item }) => item),
      failedCount: own.filter((i) => i.result === "fail").length,
    };
  });
}

async function findCheck(db: Executor, workspaceId: string, id: string, scope: ChecklistScope) {
  const [row] = await db
    .select()
    .from(siteChecklistChecks)
    .where(
      and(
        eq(siteChecklistChecks.id, id),
        eq(siteChecklistChecks.workspaceId, workspaceId),
        matchesScope(siteChecklistChecks.kind, scope),
      ),
    );
  if (!row) throw notFound("Check");
  return row;
}

export async function getChecklistCheck(
  db: Executor,
  workspaceId: string,
  id: string,
  scope: ChecklistScope,
  withProduction = false,
) {
  const row = await findCheck(db, workspaceId, id, scope);
  return (await describeChecks(db, [row], withProduction))[0]!;
}

/** Checks, newest first. */
export async function listChecklistChecks(
  db: Database,
  workspaceId: string,
  query: ChecklistCheckListQuery,
  scope: ChecklistScope,
  withProduction = false,
) {
  const where: (SQL | undefined)[] = [
    eq(siteChecklistChecks.workspaceId, workspaceId),
    matchesScope(siteChecklistChecks.kind, scope),
  ];
  if (query.templateId) where.push(eq(siteChecklistChecks.templateId, query.templateId));
  if (query.kind) where.push(eq(siteChecklistChecks.kind, query.kind));
  // `from` and `to` are inclusive local dates in the workspace's time zone.
  const zone = query.from || query.to ? await workspaceTimeZone(db, workspaceId) : null;
  if (query.from) where.push(gte(siteChecklistChecks.performedAt, startOfDayInZone(query.from, zone!)));
  if (query.to) where.push(lt(siteChecklistChecks.performedAt, endOfDayInZone(query.to, zone!)));
  if (query.outcome) where.push(eq(siteChecklistChecks.outcome, query.outcome));
  if (query.signOff) where.push(eq(siteChecklistChecks.signOffStatus, query.signOff));
  if (query.batchId) {
    where.push(
      or(
        eq(siteChecklistChecks.previousBatchId, query.batchId),
        eq(siteChecklistChecks.nextBatchId, query.batchId),
      ),
    );
  }
  if (!query.includeCorrected) where.push(notCorrectedCheck);
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(siteChecklistChecks)
      .where(and(...where))
      .orderBy(
        desc(siteChecklistChecks.performedAt),
        desc(siteChecklistChecks.createdAt),
        desc(siteChecklistChecks.id),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(siteChecklistChecks)
      .where(and(...where)),
  ]);
  const p = page(await describeChecks(db, rows, withProduction), total?.n, query);
  return { checks: p.rows, total: p.total, limit: p.limit, offset: p.offset };
}

/** One result per item, no more and no fewer: `expected` are the item ids the check must cover. */
function assertCovers(expected: string[], results: { itemId: string }[]) {
  const given = new Set(results.map((r) => r.itemId));
  const missing = expected.filter((id) => !given.has(id));
  const unknown = results.filter((r) => !expected.includes(r.itemId));
  if (unknown.length) throw badRequest("A result is for an item that isn't on this checklist");
  if (missing.length) {
    throw new ApiError(400, "invalid_input", "Every item on the checklist needs a result", { missing });
  }
}

async function assertBatchRef(tx: Executor, workspaceId: string, id: string | null | undefined) {
  if (id) await findBatch(tx, workspaceId, id);
}

/**
 * Records a completed check against a checklist: one result per item (the wording is copied, so a
 * later edit doesn't rewrite it). A person's attestation (the route refuses tokens). It starts
 * `pending`; a person with `manage` signs it off before production starts.
 */
export async function recordChecklistCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ChecklistCheckCreateInput,
  scope: ChecklistScope,
  withProduction = false,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const template = await findTemplate(tx, workspaceId, input.templateId, scope);
    if (template.status === "archived") {
      throw new ApiError(409, "checklist_archived", `${template.name} is archived`);
    }
    const items = (await liveItemsOf(tx, [template.id])).filter((i) => i.templateId === template.id);
    assertCovers(
      items.map((i) => i.id),
      input.results,
    );
    if (template.kind !== "allergen_changeover" && (input.previousBatchId || input.nextBatchId)) {
      throw badRequest("Only an allergen changeover check refers to the batches before and after it");
    }
    if (input.previousBatchId && input.previousBatchId === input.nextBatchId) {
      throw badRequest("The batch before and the batch after are the same");
    }
    await assertBatchRef(tx, workspaceId, input.previousBatchId);
    await assertBatchRef(tx, workspaceId, input.nextBatchId);
    const itemById = new Map(items.map((i) => [i.id, i]));
    return insertCheck(tx, workspaceId, actorId, {
      id: input.id,
      templateId: template.id,
      templateName: template.name,
      kind: template.kind,
      areaId: template.areaId,
      line: template.line,
      performedAt: momentOf(input.performedAt, new Date()),
      note: input.note ?? null,
      previousBatchId: input.previousBatchId ?? null,
      nextBatchId: input.nextBatchId ?? null,
      results: input.results.map((r) => ({
        itemId: r.itemId,
        prompt: itemById.get(r.itemId)!.prompt,
        sortOrder: itemById.get(r.itemId)!.sortOrder,
        result: r.result,
        note: r.note ?? null,
      })),
    });
  });
  return getChecklistCheck(db, workspaceId, id, scope, withProduction);
}

interface CheckToInsert {
  id?: string | undefined;
  templateId: string;
  templateName: string;
  kind: CheckRow["kind"];
  areaId: string | null;
  line: string | null;
  performedAt: Date;
  note: string | null;
  previousBatchId: string | null;
  nextBatchId: string | null;
  results: {
    itemId: string | null;
    prompt: string;
    sortOrder: number;
    result: CheckItemRow["result"];
    note: string | null;
  }[];
  correction?: { originalId: string; reason: string };
}

async function insertCheck(tx: Transaction, workspaceId: string, actorId: string, check: CheckToInsert) {
  const general = check.kind === "general";
  const entities = checklistEntities(general ? "general" : "site");
  const outcome = checkOutcome(check.results);
  const [row] = await tx
    .insert(siteChecklistChecks)
    .values({
      ...(check.id ? { id: check.id } : {}),
      workspaceId,
      templateId: check.templateId,
      templateName: check.templateName,
      kind: check.kind,
      areaId: check.areaId,
      line: check.line,
      performedAt: check.performedAt,
      performedBy: actorId,
      outcome,
      signOffStatus: general ? "not_required" : "pending",
      note: check.note,
      previousBatchId: check.previousBatchId,
      nextBatchId: check.nextBatchId,
      correctsCheckId: check.correction?.originalId ?? null,
      correctionReason: check.correction?.reason ?? null,
    })
    .returning();
  const results = await tx
    .insert(siteChecklistCheckItems)
    .values(check.results.map((r) => ({ workspaceId, checkId: row!.id, ...r })))
    .returning();
  const changes = [change(entities.check, row!), ...results.map((r) => change(entities.result, r))];
  if (general && check.correction) {
    const [superseded] = await tx
      .update(checklistActions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(checklistActions.workspaceId, workspaceId),
          eq(checklistActions.checkId, check.correction.originalId),
          eq(checklistActions.status, "open"),
        ),
      )
      .returning();
    if (superseded) changes.push(change("checklist_action", superseded));
  }
  if (general && outcome === "failed") {
    const [action] = await tx.insert(checklistActions).values({ workspaceId, checkId: row!.id }).returning();
    changes.push(change("checklist_action", action!));
  }
  await recordChanges(tx, workspaceId, actorId, changes);
  return row!.id;
}

/**
 * Corrects a check: the results again, as a new check pointing at the old one (same checklist,
 * time and batches). A person's act. The replaced check no longer counts and leaves the sign-off
 * queue; the new one needs its own sign-off.
 */
export async function correctChecklistCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: ChecklistCheckCorrectInput,
  scope: ChecklistScope,
  withProduction = false,
) {
  const newId = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const original = await findCheck(tx, workspaceId, id, scope);
    const [already] = await tx
      .select({ id: siteChecklistChecks.id })
      .from(siteChecklistChecks)
      .where(eq(siteChecklistChecks.correctsCheckId, id));
    if (already) throw new ApiError(409, "already_corrected", "This check has already been corrected");
    const originalItems = await tx
      .select()
      .from(siteChecklistCheckItems)
      .where(eq(siteChecklistCheckItems.checkId, id));
    const itemKey = (i: CheckItemRow) => i.itemId ?? i.id;
    assertCovers(originalItems.map(itemKey), input.results);
    const byKey = new Map(originalItems.map((i) => [itemKey(i), i]));
    return insertCheck(tx, workspaceId, actorId, {
      templateId: original.templateId,
      templateName: original.templateName,
      kind: original.kind,
      areaId: original.areaId,
      line: original.line,
      performedAt: original.performedAt,
      note: input.note ?? null,
      previousBatchId: original.previousBatchId,
      nextBatchId: original.nextBatchId,
      results: input.results.map((r) => {
        const old = byKey.get(r.itemId)!;
        return {
          itemId: old.itemId,
          prompt: old.prompt,
          sortOrder: old.sortOrder,
          result: r.result,
          note: r.note ?? null,
        };
      }),
      correction: { originalId: id, reason: input.reason },
    });
  });
  return getChecklistCheck(db, workspaceId, newId, scope, withProduction);
}

/**
 * The sign-off before production starts: a person with `manage` (checked by the route; tokens are
 * refused) signs a check off or holds it. A check with failed items can only be held: it is done
 * again once what failed is put right. A one-time stamp; a replaced (corrected) check can't be
 * signed off.
 */
export async function signOffChecklistCheck(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: CheckSignOffInput,
  withProduction = false,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const check = await findCheck(tx, workspaceId, id, "site");
    if (check.signOffStatus !== "pending") {
      throw new ApiError(409, "already_signed_off", "This check has already been signed off or held");
    }
    const [corrected] = await tx
      .select({ id: siteChecklistChecks.id })
      .from(siteChecklistChecks)
      .where(eq(siteChecklistChecks.correctsCheckId, id));
    if (corrected) {
      throw new ApiError(
        409,
        "already_corrected",
        "A correction has replaced this check; sign that one off instead",
      );
    }
    if (input.decision === "approve" && check.areaId) {
      // An open glass breakage holds its area: no production starts there until a person releases it.
      const breakage = (await openBreakagesByArea(tx, [check.areaId])).get(check.areaId);
      if (breakage) {
        throw new ApiError(
          409,
          "area_on_hold",
          `This area is on hold after a glass breakage (${breakage.description}). Release the breakage before signing off`,
        );
      }
    }
    if (input.decision === "approve" && check.outcome === "failed") {
      throw new ApiError(
        409,
        "check_failed",
        "Items failed on this check, so production can't be signed off. Hold it, put the failures right and check again",
      );
    }
    const [updated] = await tx
      .update(siteChecklistChecks)
      .set({
        signOffStatus: input.decision === "approve" ? "approved" : "rejected",
        signedOffBy: actorId,
        signedOffAt: new Date(),
        signOffNote: input.note ?? null,
      })
      .where(and(eq(siteChecklistChecks.id, id), eq(siteChecklistChecks.signOffStatus, "pending")))
      .returning();
    if (!updated) throw new ApiError(409, "already_signed_off", "Someone else signed this check off first");
    await recordChanges(tx, workspaceId, actorId, [change("site_checklist_check", updated)]);
  });
  return getChecklistCheck(db, workspaceId, id, "site", withProduction);
}

export async function checklistDueItems(
  db: Database,
  workspaceId: string,
  scope: ChecklistScope,
  now: Date,
  timeZone: string,
  withProduction = false,
): Promise<SiteDueItem[]> {
  const items: SiteDueItem[] = [];
  const templates = await db
    .select()
    .from(siteChecklistTemplates)
    .where(
      and(
        eq(siteChecklistTemplates.workspaceId, workspaceId),
        matchesScope(siteChecklistTemplates.kind, scope),
        isNull(siteChecklistTemplates.deletedAt),
        eq(siteChecklistTemplates.status, "active"),
        sql`${siteChecklistTemplates.frequencyEvery} is not null`,
      ),
    );
  const [last, producing, areas] = await Promise.all([
    lastDoneChecks(
      db,
      workspaceId,
      templates.map((t) => t.id),
    ),
    withProduction && templates.some((row) => row.duringProduction) ? isProducing(db, workspaceId) : false,
    areasById(
      db,
      templates.map((t) => t.areaId),
    ),
  ]);
  for (const template of templates) {
    const frequency = templateFrequency(template)!;
    const check = last.get(template.id) ?? null;
    const due = siteCheckDueState({
      frequency,
      lastAt: check?.performedAt ?? null,
      now,
      timeZone,
      duringProduction: template.duringProduction,
      producing,
    });
    items.push({
      programme: "checklist",
      subjectId: template.id,
      title: template.name,
      where: template.line ?? areaOf(areas, template.areaId)?.name ?? null,
      state: due.state,
      dueOn: due.dueOn,
      dueAt: due.dueAt,
      lastAt: check?.performedAt.toISOString() ?? null,
      note: describeFrequency(frequency),
      ...(template.duringProduction ? { duringProduction: true as const } : {}),
    });
  }
  return items;
}

export async function pendingSiteChecks(db: Database, workspaceId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(siteChecklistChecks)
    .where(
      and(
        eq(siteChecklistChecks.workspaceId, workspaceId),
        matchesScope(siteChecklistChecks.kind, "site"),
        eq(siteChecklistChecks.signOffStatus, "pending"),
        notCorrectedCheck,
      ),
    );
  return row?.n ?? 0;
}

export async function listChecklistActions(
  db: Database,
  workspaceId: string,
  query: ChecklistActionListQuery,
) {
  const where = and(
    eq(checklistActions.workspaceId, workspaceId),
    query.status === "all" ? undefined : eq(checklistActions.status, query.status),
  );
  const [actions, [total]] = await Promise.all([
    db
      .select({
        action: checklistActions,
        templateName: siteChecklistChecks.templateName,
        performedAt: siteChecklistChecks.performedAt,
      })
      .from(checklistActions)
      .innerJoin(
        siteChecklistChecks,
        and(
          eq(siteChecklistChecks.id, checklistActions.checkId),
          eq(siteChecklistChecks.workspaceId, checklistActions.workspaceId),
        ),
      )
      .where(where)
      .orderBy(desc(checklistActions.createdAt), desc(checklistActions.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(checklistActions).where(where),
  ]);
  const checkIds = actions.map(({ action }) => action.checkId);
  const failures = checkIds.length
    ? await db
        .select({
          checkId: siteChecklistCheckItems.checkId,
          id: siteChecklistCheckItems.id,
          prompt: siteChecklistCheckItems.prompt,
          note: siteChecklistCheckItems.note,
        })
        .from(siteChecklistCheckItems)
        .where(
          and(
            eq(siteChecklistCheckItems.workspaceId, workspaceId),
            inArray(siteChecklistCheckItems.checkId, checkIds),
            eq(siteChecklistCheckItems.result, "fail"),
          ),
        )
        .orderBy(asc(siteChecklistCheckItems.sortOrder))
    : [];
  return {
    actions: actions.map(({ action, templateName, performedAt }) => ({
      ...strip(action),
      templateName,
      performedAt,
      failures: failures.filter(({ checkId }) => checkId === action.checkId),
    })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function resolveChecklistAction(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  note: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [action] = await tx
      .select()
      .from(checklistActions)
      .where(and(eq(checklistActions.workspaceId, workspaceId), eq(checklistActions.id, id)));
    if (!action) throw notFound("Checklist action");
    if (action.status !== "open")
      throw new ApiError(409, "action_not_open", "This action is already resolved or superseded");
    const [updated] = await tx
      .update(checklistActions)
      .set({ status: "resolved", resolution: note, resolvedBy: actorId, resolvedAt: new Date() })
      .where(eq(checklistActions.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change("checklist_action", updated!)]);
    return strip(updated!);
  });
}
