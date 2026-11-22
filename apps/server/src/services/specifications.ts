import {
  canApproveSpecification,
  diffSpecifications,
  itemDiscrepancies,
  itemTypesOfKind,
  specificationApprovalBlockers,
  specificationDueSoonCutoff,
  specificationKindOf,
  specificationPartyOf,
  specificationReviewState,
  type ModuleId,
  type SpecificationContent,
  type SpecificationCreateInput,
  type SpecificationDraftInput,
  type SpecificationListQuery,
  type SpecificationParameter,
  type SpecificationUpdateInput,
} from "@knotworking/core";
import {
  items,
  lockWorkspaceLog,
  productionBatches,
  productLabels,
  recipeLines,
  recipes,
  recipeVersions,
  recordChanges,
  specificationParameters,
  specifications,
  specificationVersions,
  suppliers,
  users,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, badRequest, notFound } from "../errors";
import { audience, memberAccess } from "./notifications";

/**
 * Specifications module: controlled, versioned specifications for items.
 *
 * Document control as recipes: at most one draft and one approved version per specification;
 * approving (a person with `manage`, four-eyes) supersedes the previous approved version, which is
 * kept unchanged. The sync log carries metadata only; content and parameters are read here.
 *
 * Nothing here rewrites the item, a recipe or a label. The item cross-check and the change impact
 * report say where they disagree with a specification and leave the decision to a person.
 */

type SpecRow = typeof specifications.$inferSelect;
type VersionRow = typeof specificationVersions.$inferSelect;
type ParamRow = typeof specificationParameters.$inferSelect;
type ItemRow = typeof items.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

/** How far the impact report follows an ingredient through recipes making work in progress. */
export const SPECIFICATION_IMPACT_MAX_DEPTH = 10;
/** The most recipes, labels or batches the impact report lists before saying it stopped. */
export const SPECIFICATION_IMPACT_MAX_ROWS = 500;

// ─── Serialising ─────────────────────────────────────────────────────────────

const specChange = (row: SpecRow): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "specification", entityId: row.id, action: "upsert", data };
};

/** A version's metadata: what the sync log and version lists carry (never its content). */
const versionMeta = (row: VersionRow) => ({
  id: row.id,
  specificationId: row.specificationId,
  versionNumber: row.versionNumber,
  status: row.status,
  reviewDueOn: row.reviewDueOn,
  agreedOn: row.agreedOn,
  changeNote: row.changeNote,
  lastEditedBy: row.lastEditedBy,
  approvedAt: row.approvedAt,
  approvedBy: row.approvedBy,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const versionChange = (row: VersionRow): ChangeInput => ({
  entity: "specification_version",
  entityId: row.id,
  action: "upsert",
  data: versionMeta(row),
});

const parameterOut = (row: ParamRow) => ({
  id: row.id,
  category: row.category,
  name: row.name,
  unit: row.unit,
  min: row.min,
  target: row.target,
  max: row.max,
  limitText: row.limitText,
  method: row.method,
  note: row.note,
});

const contentOf = (version: VersionRow, params: readonly SpecificationParameter[]): SpecificationContent => ({
  description: version.description,
  storage: version.storage,
  storageInstructions: version.storageInstructions,
  shelfLifeDays: version.shelfLifeDays,
  minimumLifeOnReceiptDays: version.minimumLifeOnReceiptDays,
  allergens: version.allergens,
  mayContain: version.mayContain,
  countryOfOrigin: version.countryOfOrigin,
  provenance: version.provenance,
  claims: version.claims,
  packagingDetails: version.packagingDetails,
  parameters: params,
});

const itemSummary = (item: ItemRow) => ({
  id: item.id,
  code: item.code,
  name: item.name,
  type: item.type,
  status: item.status,
  unit: item.unit,
  allergens: item.allergens,
  mayContain: item.mayContain,
  storage: item.storage,
  shelfLifeDays: item.shelfLifeDays,
  deleted: item.deletedAt !== null,
});

async function userNames(db: Executor, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.name]));
}

async function parametersOf(db: Executor, versionIds: string[]) {
  if (versionIds.length === 0) return new Map<string, ParamRow[]>();
  const rows = await db
    .select()
    .from(specificationParameters)
    .where(inArray(specificationParameters.versionId, versionIds))
    .orderBy(asc(specificationParameters.sortOrder), asc(specificationParameters.id));
  const out = new Map<string, ParamRow[]>();
  for (const row of rows) out.set(row.versionId, [...(out.get(row.versionId) ?? []), row]);
  return out;
}

async function findSpec(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(specifications)
    .where(
      and(
        eq(specifications.id, id),
        eq(specifications.workspaceId, workspaceId),
        isNull(specifications.deletedAt),
      ),
    );
  if (!row) throw notFound("Specification");
  return row;
}

/** The item, including an archived or deleted one: a specification keeps showing it. */
async function itemOf(db: Executor, workspaceId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.workspaceId, workspaceId)));
  if (!row) throw notFound("Item");
  return row;
}

async function supplierSummary(db: Executor, workspaceId: string, supplierId: string | null) {
  if (!supplierId) return null;
  const [row] = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      code: suppliers.code,
      approvalStatus: suppliers.approvalStatus,
      deletedAt: suppliers.deletedAt,
    })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.workspaceId, workspaceId)));
  if (!row) return null;
  const { deletedAt, ...rest } = row;
  return { ...rest, deleted: deletedAt !== null };
}

async function versionsOf(db: Executor, specificationId: string) {
  return db
    .select()
    .from(specificationVersions)
    .where(
      and(
        eq(specificationVersions.specificationId, specificationId),
        isNull(specificationVersions.deletedAt),
      ),
    )
    .orderBy(desc(specificationVersions.versionNumber));
}

/** A version in full: content, parameters and who did what. */
function fullVersion(version: VersionRow, params: ParamRow[], names: Map<string, string>) {
  return {
    ...versionMeta(version),
    description: version.description,
    storage: version.storage,
    storageInstructions: version.storageInstructions,
    shelfLifeDays: version.shelfLifeDays,
    minimumLifeOnReceiptDays: version.minimumLifeOnReceiptDays,
    allergens: version.allergens,
    mayContain: version.mayContain,
    countryOfOrigin: version.countryOfOrigin,
    provenance: version.provenance,
    claims: version.claims,
    packagingDetails: version.packagingDetails,
    agreedBy: version.agreedBy,
    agreementReference: version.agreementReference,
    parameters: params.map(parameterOut),
    approvedByName: version.approvedBy ? (names.get(version.approvedBy) ?? null) : null,
    lastEditedByName: version.lastEditedBy ? (names.get(version.lastEditedBy) ?? null) : null,
    createdByName: version.createdBy ? (names.get(version.createdBy) ?? null) : null,
  };
}

const itemFacts = (item: ItemRow) => ({
  allergens: item.allergens,
  mayContain: item.mayContain,
  storage: item.storage,
  shelfLifeDays: item.shelfLifeDays,
});

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listSpecifications(
  db: Database,
  workspaceId: string,
  query: SpecificationListQuery,
  today: string,
) {
  const approved = alias(specificationVersions, "approved_version");
  const draft = alias(specificationVersions, "draft_version");
  const cutoff = specificationDueSoonCutoff(today);
  const conditions: (SQL | undefined)[] = [
    eq(specifications.workspaceId, workspaceId),
    isNull(specifications.deletedAt),
    query.status === "all" ? undefined : eq(specifications.status, query.status),
    query.itemId ? eq(specifications.itemId, query.itemId) : undefined,
    query.supplierId ? eq(specifications.supplierId, query.supplierId) : undefined,
    query.kind ? inArray(items.type, [...itemTypesOfKind[query.kind]]) : undefined,
  ];
  if (query.q) {
    const pattern = like(query.q);
    conditions.push(
      or(
        sql`${specifications.code} ilike ${pattern} escape '!'`,
        sql`${specifications.title} ilike ${pattern} escape '!'`,
        sql`${items.code} ilike ${pattern} escape '!'`,
        sql`${items.name} ilike ${pattern} escape '!'`,
        sql`${suppliers.name} ilike ${pattern} escape '!'`,
        sql`${specifications.customerName} ilike ${pattern} escape '!'`,
      ),
    );
  }
  if (query.review === "overdue") conditions.push(lt(approved.reviewDueOn, today));
  else if (query.review === "due_soon") {
    conditions.push(sql`${approved.reviewDueOn} >= ${today}`, lte(approved.reviewDueOn, cutoff));
  } else if (query.review === "attention") {
    conditions.push(or(isNull(approved.id), lte(approved.reviewDueOn, cutoff)));
  }
  const where = and(...conditions);
  const from = () =>
    db
      .select({
        spec: specifications,
        item: items,
        supplierName: suppliers.name,
        approvedId: approved.id,
        approvedNumber: approved.versionNumber,
        approvedReviewDueOn: approved.reviewDueOn,
        approvedAt: approved.approvedAt,
        draftId: draft.id,
        draftNumber: draft.versionNumber,
        draftUpdatedAt: draft.updatedAt,
      })
      .from(specifications)
      .innerJoin(items, eq(items.id, specifications.itemId))
      .leftJoin(suppliers, eq(suppliers.id, specifications.supplierId))
      .leftJoin(
        approved,
        and(
          eq(approved.specificationId, specifications.id),
          eq(approved.status, "approved"),
          isNull(approved.deletedAt),
        ),
      )
      .leftJoin(
        draft,
        and(eq(draft.specificationId, specifications.id), eq(draft.status, "draft"), isNull(draft.deletedAt)),
      );
  const [rows, [totalRow]] = await Promise.all([
    from()
      .where(where)
      .orderBy(asc(sql`lower(${specifications.code})`))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ total: count() })
      .from(specifications)
      .innerJoin(items, eq(items.id, specifications.itemId))
      .leftJoin(suppliers, eq(suppliers.id, specifications.supplierId))
      .leftJoin(
        approved,
        and(
          eq(approved.specificationId, specifications.id),
          eq(approved.status, "approved"),
          isNull(approved.deletedAt),
        ),
      )
      .where(where),
  ]);
  return {
    specifications: rows.map((r) => {
      const { workspaceId: _ws, deletedAt: _deleted, ...spec } = r.spec;
      return {
        ...spec,
        kind: specificationKindOf(r.item.type),
        party: specificationPartyOf(r.spec),
        item: { id: r.item.id, code: r.item.code, name: r.item.name, type: r.item.type },
        supplierName: r.supplierName,
        approvedVersion: r.approvedId
          ? {
              id: r.approvedId,
              versionNumber: r.approvedNumber!,
              reviewDueOn: r.approvedReviewDueOn,
              approvedAt: r.approvedAt,
            }
          : null,
        draftVersion: r.draftId
          ? { id: r.draftId, versionNumber: r.draftNumber!, updatedAt: r.draftUpdatedAt! }
          : null,
        reviewState: specificationReviewState(r.approvedReviewDueOn, today),
      };
    }),
    total: totalRow?.total ?? 0,
    today,
  };
}

/**
 * A specification with its version list, the approved and draft versions in full, what the draft
 * changes, why it can't be approved yet, and where the item record disagrees with each.
 */
export async function getSpecification(db: Database, workspaceId: string, id: string, today: string) {
  const spec = await findSpec(db, workspaceId, id);
  const [item, supplier, versions] = await Promise.all([
    itemOf(db, workspaceId, spec.itemId),
    supplierSummary(db, workspaceId, spec.supplierId),
    versionsOf(db, spec.id),
  ]);
  const approved = versions.find((v) => v.status === "approved") ?? null;
  const draft = versions.find((v) => v.status === "draft") ?? null;
  const params = await parametersOf(
    db,
    [approved?.id, draft?.id].filter((v): v is string => !!v),
  );
  const names = await userNames(
    db,
    versions.flatMap((v) => [v.approvedBy, v.lastEditedBy, v.createdBy]),
  );
  const kind = specificationKindOf(item.type);
  const party = specificationPartyOf(spec);
  const approvedContent = approved
    ? contentOf(approved, (params.get(approved.id) ?? []).map(parameterOut))
    : null;
  const draftContent = draft ? contentOf(draft, (params.get(draft.id) ?? []).map(parameterOut)) : null;
  const { workspaceId: _ws, deletedAt: _deleted, ...header } = spec;
  return {
    ...header,
    kind,
    party,
    item: itemSummary(item),
    supplier,
    versions: versions.map((v) => ({
      ...versionMeta(v),
      approvedByName: v.approvedBy ? (names.get(v.approvedBy) ?? null) : null,
    })),
    approvedVersion: approved ? fullVersion(approved, params.get(approved.id) ?? [], names) : null,
    draftVersion: draft ? fullVersion(draft, params.get(draft.id) ?? [], names) : null,
    /** What the draft changes against the approved version (everything, when none is approved). */
    draftChanges: draftContent ? diffSpecifications(approvedContent, draftContent) : null,
    draftBlockers: draft
      ? specificationApprovalBlockers({
          kind,
          party,
          content: draftContent!,
          reviewDueOn: draft.reviewDueOn,
          agreedOn: draft.agreedOn,
          today,
        })
      : [],
    /** Where the item record disagrees with the approved version. */
    discrepancies: approvedContent ? itemDiscrepancies(approvedContent, itemFacts(item)) : [],
    /** Where the item record would disagree with the draft once approved. */
    draftDiscrepancies: draftContent ? itemDiscrepancies(draftContent, itemFacts(item)) : [],
    reviewState: specificationReviewState(approved?.reviewDueOn ?? null, today),
    today,
  };
}

/** One version in full, with what it changed against the version before it. */
export async function getSpecificationVersion(
  db: Database,
  workspaceId: string,
  id: string,
  versionId: string,
) {
  const spec = await findSpec(db, workspaceId, id);
  const versions = await versionsOf(db, spec.id);
  const version = versions.find((v) => v.id === versionId);
  if (!version) throw notFound("Specification version");
  // The version this one replaced (or would replace): the latest released one before it.
  const previous =
    versions.find((v) => v.versionNumber < version.versionNumber && v.status !== "draft") ??
    (version.status === "draft" ? (versions.find((v) => v.status === "approved") ?? null) : null);
  const params = await parametersOf(
    db,
    [version.id, previous?.id].filter((v): v is string => !!v),
  );
  const names = await userNames(db, [version.approvedBy, version.lastEditedBy, version.createdBy]);
  const content = contentOf(version, (params.get(version.id) ?? []).map(parameterOut));
  const previousContent = previous
    ? contentOf(previous, (params.get(previous.id) ?? []).map(parameterOut))
    : null;
  return {
    ...fullVersion(version, params.get(version.id) ?? [], names),
    previousVersionNumber: previous?.versionNumber ?? null,
    changes: diffSpecifications(previousContent, content),
  };
}

export interface ImpactAccess {
  recipes: boolean;
  labels: boolean;
  production: boolean;
}

/**
 * What a change to this specification could affect: the recipes that use the item (followed
 * through work-in-progress recipes, up to {@link SPECIFICATION_IMPACT_MAX_DEPTH} levels) or make
 * it, their draft and approved product labels, and open production batches of those recipes.
 * Each part is listed only when the reader can read its module; otherwise it says it was hidden,
 * never that nothing is affected.
 */
export async function getSpecificationImpact(
  db: Database,
  workspaceId: string,
  id: string,
  access: ImpactAccess,
  today: string,
) {
  const detail = await getSpecification(db, workspaceId, id, today);
  const truncated: string[] = [];

  type Affected = {
    id: string;
    code: string;
    name: string;
    status: string;
    outputItemId: string;
    relation: "makes" | "ingredient" | "indirect";
    depth: number;
  };
  const affected = new Map<string, Affected>();
  let depthLimited = false;

  if (access.recipes) {
    const recipeCols = {
      id: recipes.id,
      code: recipes.code,
      name: recipes.name,
      status: recipes.status,
      outputItemId: recipes.outputItemId,
    };
    // Recipes that make the item (a product specification).
    const makers = await db
      .select(recipeCols)
      .from(recipes)
      .where(
        and(
          eq(recipes.workspaceId, workspaceId),
          isNull(recipes.deletedAt),
          eq(recipes.outputItemId, detail.item.id),
        ),
      );
    for (const r of makers) affected.set(r.id, { ...r, relation: "makes", depth: 0 });

    // Recipes whose draft or approved version uses the item, then recipes using their outputs.
    let frontier = [detail.item.id];
    const seenItems = new Set(frontier);
    for (let depth = 1; frontier.length > 0; depth++) {
      if (depth > SPECIFICATION_IMPACT_MAX_DEPTH) {
        depthLimited = true;
        break;
      }
      const users_ = await db
        .selectDistinct(recipeCols)
        .from(recipeLines)
        .innerJoin(recipeVersions, eq(recipeVersions.id, recipeLines.versionId))
        .innerJoin(recipes, eq(recipes.id, recipeVersions.recipeId))
        .where(
          and(
            eq(recipes.workspaceId, workspaceId),
            isNull(recipes.deletedAt),
            isNull(recipeVersions.deletedAt),
            inArray(recipeVersions.status, ["draft", "approved"]),
            inArray(recipeLines.itemId, frontier),
          ),
        );
      const next: string[] = [];
      for (const r of users_) {
        if (affected.has(r.id)) continue;
        affected.set(r.id, { ...r, relation: depth === 1 ? "ingredient" : "indirect", depth });
        if (!seenItems.has(r.outputItemId)) {
          seenItems.add(r.outputItemId);
          next.push(r.outputItemId);
        }
      }
      if (affected.size > SPECIFICATION_IMPACT_MAX_ROWS) break;
      frontier = next;
    }
  }

  const recipeList = [...affected.values()]
    .sort((a, b) => a.depth - b.depth || a.code.localeCompare(b.code))
    .slice(0, SPECIFICATION_IMPACT_MAX_ROWS);
  if (affected.size > SPECIFICATION_IMPACT_MAX_ROWS) truncated.push("recipes");
  const recipeIds = recipeList.map((r) => r.id);
  const outputIds = [...new Set(recipeList.map((r) => r.outputItemId))];
  const outputs = outputIds.length
    ? await db
        .select({ id: items.id, code: items.code, name: items.name })
        .from(items)
        .where(and(eq(items.workspaceId, workspaceId), inArray(items.id, outputIds)))
    : [];
  const outputById = new Map(outputs.map((o) => [o.id, o]));
  const recipeCode = new Map(recipeList.map((r) => [r.id, r.code]));

  let labels: {
    id: string;
    recipeId: string;
    recipeCode: string;
    variant: string;
    versionNumber: number;
    status: string;
    productName: string;
  }[] = [];
  if (access.labels && recipeIds.length) {
    const rows = await db
      .select({
        id: productLabels.id,
        recipeId: productLabels.recipeId,
        variant: productLabels.variant,
        versionNumber: productLabels.versionNumber,
        status: productLabels.status,
        productName: productLabels.productName,
      })
      .from(productLabels)
      .where(
        and(
          eq(productLabels.workspaceId, workspaceId),
          isNull(productLabels.deletedAt),
          inArray(productLabels.status, ["draft", "approved"]),
          inArray(productLabels.recipeId, recipeIds),
        ),
      )
      .orderBy(asc(productLabels.productName))
      .limit(SPECIFICATION_IMPACT_MAX_ROWS + 1);
    if (rows.length > SPECIFICATION_IMPACT_MAX_ROWS) truncated.push("labels");
    labels = rows
      .slice(0, SPECIFICATION_IMPACT_MAX_ROWS)
      .map((l) => ({ ...l, recipeCode: recipeCode.get(l.recipeId) ?? "" }));
  }

  let batches: {
    id: string;
    batchCode: string;
    recipeId: string;
    recipeCode: string;
    plannedOn: string;
    status: string;
  }[] = [];
  if (access.production && recipeIds.length) {
    const rows = await db
      .select({
        id: productionBatches.id,
        batchCode: productionBatches.batchCode,
        recipeId: productionBatches.recipeId,
        plannedOn: productionBatches.plannedOn,
        status: productionBatches.status,
      })
      .from(productionBatches)
      .where(
        and(
          eq(productionBatches.workspaceId, workspaceId),
          isNull(productionBatches.deletedAt),
          inArray(productionBatches.status, ["planned", "in_progress"]),
          inArray(productionBatches.recipeId, recipeIds),
        ),
      )
      .orderBy(asc(productionBatches.plannedOn), asc(productionBatches.batchCode))
      .limit(SPECIFICATION_IMPACT_MAX_ROWS + 1);
    if (rows.length > SPECIFICATION_IMPACT_MAX_ROWS) truncated.push("batches");
    batches = rows
      .slice(0, SPECIFICATION_IMPACT_MAX_ROWS)
      .map((b) => ({ ...b, recipeCode: recipeCode.get(b.recipeId) ?? "" }));
  }

  return {
    specification: { id: detail.id, code: detail.code, title: detail.title, kind: detail.kind },
    item: detail.item,
    /** The draft's changes against the approved version; null when there is no draft. */
    changes: detail.draftChanges,
    discrepancies: detail.discrepancies,
    draftDiscrepancies: detail.draftDiscrepancies,
    recipes: access.recipes
      ? recipeList.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          status: r.status,
          relation: r.relation,
          depth: r.depth,
          outputItem: outputById.get(r.outputItemId) ?? null,
        }))
      : null,
    labels: access.labels ? labels : null,
    batches: access.production ? batches : null,
    /** Parts left out because the reader can't read their module. */
    hidden: (Object.keys(access) as (keyof ImpactAccess)[]).filter((k) => !access[k]),
    /** True when recipes beyond the depth limit may also be affected. */
    depthLimited,
    /** Parts cut off at {@link SPECIFICATION_IMPACT_MAX_ROWS}. */
    truncated,
    maxDepth: SPECIFICATION_IMPACT_MAX_DEPTH,
    today,
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

async function assertCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: specifications.id })
    .from(specifications)
    .where(
      and(
        eq(specifications.workspaceId, workspaceId),
        isNull(specifications.deletedAt),
        sql`lower(${specifications.code}) = lower(${code})`,
        exceptId ? ne(specifications.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another specification already uses the code "${code}"`);
}

/**
 * A bought-in item's specification may name its supplier, and a product's its customer; never
 * both. The supplier must be live and in the workspace.
 */
async function checkParty(
  tx: Executor,
  workspaceId: string,
  item: ItemRow,
  supplierId: string | null,
  customerName: string | null,
) {
  const kind = specificationKindOf(item.type);
  if (supplierId && customerName)
    throw badRequest("A specification is agreed with a supplier or a customer, not both");
  if (supplierId) {
    if (kind === "product")
      throw badRequest("Only an ingredient or packaging specification can name a supplier");
    const [supplier] = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, supplierId),
          eq(suppliers.workspaceId, workspaceId),
          isNull(suppliers.deletedAt),
        ),
      );
    if (!supplier) throw badRequest("That supplier doesn't exist");
  }
  if (customerName && kind !== "product") {
    throw badRequest("Only a product specification can name a customer");
  }
}

async function insertParameters(
  tx: Transaction,
  workspaceId: string,
  versionId: string,
  input: SpecificationDraftInput,
) {
  if (input.parameters.length === 0) return;
  await tx.insert(specificationParameters).values(
    input.parameters.map((p, i) => ({
      workspaceId,
      versionId,
      category: p.category,
      name: p.name,
      unit: p.unit ?? null,
      min: p.min ?? null,
      target: p.target ?? null,
      max: p.max ?? null,
      limitText: p.limitText ?? null,
      method: p.method ?? null,
      note: p.note ?? null,
      sortOrder: i,
    })),
  );
}

const draftFields = (input: SpecificationDraftInput) => ({
  description: input.description ?? null,
  storage: input.storage ?? null,
  storageInstructions: input.storageInstructions ?? null,
  shelfLifeDays: input.shelfLifeDays ?? null,
  minimumLifeOnReceiptDays: input.minimumLifeOnReceiptDays ?? null,
  allergens: input.allergens,
  mayContain: input.mayContain,
  countryOfOrigin: input.countryOfOrigin ?? null,
  provenance: input.provenance ?? null,
  claims: input.claims,
  packagingDetails: input.packagingDetails ?? null,
  reviewDueOn: input.reviewDueOn ?? null,
  agreedBy: input.agreedBy ?? null,
  agreedOn: input.agreedOn ?? null,
  agreementReference: input.agreementReference ?? null,
  changeNote: input.changeNote ?? null,
});

/** Creates or replaces the specification's draft. Call inside a transaction holding the log lock. */
async function saveDraftIn(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  spec: SpecRow,
  input: SpecificationDraftInput,
): Promise<VersionRow> {
  if (spec.status === "archived") {
    throw new ApiError(
      409,
      "specification_archived",
      "This specification is archived; make it active before editing",
    );
  }
  const [existing] = await tx
    .select()
    .from(specificationVersions)
    .where(
      and(
        eq(specificationVersions.specificationId, spec.id),
        eq(specificationVersions.status, "draft"),
        isNull(specificationVersions.deletedAt),
      ),
    );
  let draft: VersionRow;
  if (existing) {
    [draft] = (await tx
      .update(specificationVersions)
      .set({ ...draftFields(input), lastEditedBy: actorId })
      .where(eq(specificationVersions.id, existing.id))
      .returning()) as [VersionRow];
    await tx.delete(specificationParameters).where(eq(specificationParameters.versionId, existing.id));
  } else {
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${specificationVersions.versionNumber}), 0)` })
      .from(specificationVersions)
      .where(eq(specificationVersions.specificationId, spec.id));
    [draft] = (await tx
      .insert(specificationVersions)
      .values({
        workspaceId,
        specificationId: spec.id,
        versionNumber: Number(last?.n ?? 0) + 1,
        status: "draft",
        ...draftFields(input),
        lastEditedBy: actorId,
        createdBy: actorId,
      })
      .returning()) as [VersionRow];
  }
  await insertParameters(tx, workspaceId, draft.id, input);
  return draft;
}

export async function createSpecification(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: SpecificationCreateInput,
  today: string,
) {
  const id = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const [item] = await tx
      .select()
      .from(items)
      .where(and(eq(items.id, input.itemId), eq(items.workspaceId, workspaceId), isNull(items.deletedAt)));
    if (!item) throw badRequest("That item doesn't exist");
    if (item.status === "archived") throw badRequest(`${item.code} is archived`);
    await checkParty(tx, workspaceId, item, input.supplierId ?? null, input.customerName ?? null);
    await assertCodeFree(tx, workspaceId, input.code);
    const [spec] = await tx
      .insert(specifications)
      .values({
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
        code: input.code,
        title: input.title,
        itemId: item.id,
        supplierId: input.supplierId ?? null,
        customerName: input.customerName ?? null,
        createdBy: actorId,
      })
      .returning();
    const changes: ChangeInput[] = [specChange(spec!)];
    if (input.draft)
      changes.push(versionChange(await saveDraftIn(tx, workspaceId, actorId, spec!, input.draft)));
    await recordChanges(tx, workspaceId, actorId, changes);
    return spec!.id;
  });
  return getSpecification(db, workspaceId, id, today);
}

export async function updateSpecification(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: SpecificationUpdateInput,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const spec = await findSpec(tx, workspaceId, id);
    const supplierId = patch.supplierId !== undefined ? patch.supplierId : spec.supplierId;
    const customerName = patch.customerName !== undefined ? patch.customerName : spec.customerName;
    if (supplierId !== spec.supplierId || customerName !== spec.customerName) {
      // An approved version records that party's agreement: it can't be moved to another one.
      const [released] = await tx
        .select({ id: specificationVersions.id })
        .from(specificationVersions)
        .where(
          and(
            eq(specificationVersions.specificationId, id),
            inArray(specificationVersions.status, ["approved", "superseded"]),
            isNull(specificationVersions.deletedAt),
          ),
        )
        .limit(1);
      if (released) {
        throw new ApiError(
          409,
          "party_fixed",
          "This specification has been approved with its supplier or customer; start a new specification for another",
        );
      }
      await checkParty(tx, workspaceId, await itemOf(tx, workspaceId, spec.itemId), supplierId, customerName);
    }
    if (patch.code !== undefined) await assertCodeFree(tx, workspaceId, patch.code, id);
    const [updated] = await tx
      .update(specifications)
      .set({
        ...(patch.code !== undefined ? { code: patch.code } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        supplierId,
        customerName,
      })
      .where(eq(specifications.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [specChange(updated!)]);
  });
  return getSpecification(db, workspaceId, id, today);
}

export async function saveSpecificationDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: SpecificationDraftInput,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const spec = await findSpec(tx, workspaceId, id);
    const draft = await saveDraftIn(tx, workspaceId, actorId, spec, input);
    await recordChanges(tx, workspaceId, actorId, [versionChange(draft)]);
  });
  return getSpecification(db, workspaceId, id, today);
}

async function removeDraft(tx: Transaction, specificationId: string): Promise<ChangeInput[]> {
  const [draft] = await tx
    .select({ id: specificationVersions.id })
    .from(specificationVersions)
    .where(
      and(
        eq(specificationVersions.specificationId, specificationId),
        eq(specificationVersions.status, "draft"),
        isNull(specificationVersions.deletedAt),
      ),
    );
  if (!draft) return [];
  // Parameters go with it (cascade); they never reached the sync log.
  await tx.delete(specificationVersions).where(eq(specificationVersions.id, draft.id));
  return [{ entity: "specification_version", entityId: draft.id, action: "delete" }];
}

export async function discardSpecificationDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findSpec(tx, workspaceId, id);
    const changes = await removeDraft(tx, id);
    if (changes.length === 0) throw new ApiError(409, "no_draft", "This specification has no draft");
    await recordChanges(tx, workspaceId, actorId, changes);
  });
}

/**
 * Approves the draft: a document-control sign-off by a person with `manage`, not the last editor
 * (unless nobody else has `manage`). The draft must pass {@link specificationApprovalBlockers}.
 */
export async function approveSpecificationDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  today: string,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const spec = await findSpec(tx, workspaceId, id);
    if (spec.status === "archived") {
      throw new ApiError(
        409,
        "specification_archived",
        "This specification is archived; make it active before approving",
      );
    }
    const [draft] = await tx
      .select()
      .from(specificationVersions)
      .where(
        and(
          eq(specificationVersions.specificationId, id),
          eq(specificationVersions.status, "draft"),
          isNull(specificationVersions.deletedAt),
        ),
      );
    if (!draft) throw new ApiError(409, "no_draft", "This specification has no draft to approve");
    const managers = audience(await memberAccess(tx, workspaceId, active), "specifications", "manage");
    if (
      !canApproveSpecification({ lastEditedBy: draft.lastEditedBy, deciderId: actorId, managerIds: managers })
    ) {
      throw new ApiError(
        403,
        "four_eyes",
        "You made the last edit to this draft, so someone else with manage access must approve it",
      );
    }
    const item = await itemOf(tx, workspaceId, spec.itemId);
    if (item.deletedAt) throw badRequest("The specification's item no longer exists");
    const params = (await parametersOf(tx, [draft.id])).get(draft.id) ?? [];
    const blockers = specificationApprovalBlockers({
      kind: specificationKindOf(item.type),
      party: specificationPartyOf(spec),
      content: contentOf(draft, params.map(parameterOut)),
      reviewDueOn: draft.reviewDueOn,
      agreedOn: draft.agreedOn,
      today,
    });
    if (blockers.length) {
      throw new ApiError(409, "not_ready", `This draft can't be approved yet: ${blockers.join("; ")}`, {
        blockers,
      });
    }
    const changes: ChangeInput[] = [];
    const [previous] = await tx
      .update(specificationVersions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(specificationVersions.specificationId, id),
          eq(specificationVersions.status, "approved"),
          isNull(specificationVersions.deletedAt),
        ),
      )
      .returning();
    if (previous) changes.push(versionChange(previous));
    const [approved] = await tx
      .update(specificationVersions)
      .set({ status: "approved", approvedAt: new Date(), approvedBy: actorId })
      .where(eq(specificationVersions.id, draft.id))
      .returning();
    changes.push(versionChange(approved!));
    await recordChanges(tx, workspaceId, actorId, changes);
  });
  return getSpecification(db, workspaceId, id, today);
}

/** Only a specification that was never approved can be deleted; approved ones are archived. */
export async function deleteSpecification(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findSpec(tx, workspaceId, id);
    const [released] = await tx
      .select({ id: specificationVersions.id })
      .from(specificationVersions)
      .where(
        and(
          eq(specificationVersions.specificationId, id),
          inArray(specificationVersions.status, ["approved", "superseded"]),
          isNull(specificationVersions.deletedAt),
        ),
      )
      .limit(1);
    if (released) {
      throw new ApiError(
        409,
        "specification_approved",
        "This specification has an approved version and can't be deleted; archive it instead",
      );
    }
    const changes = await removeDraft(tx, id);
    await tx.update(specifications).set({ deletedAt: new Date() }).where(eq(specifications.id, id));
    await recordChanges(tx, workspaceId, actorId, [
      ...changes,
      { entity: "specification", entityId: id, action: "delete" },
    ]);
  });
}
