import type {
  AssetCreateInput,
  AssetKind,
  AssetListQuery,
  AssetStatus,
  AssetUpdateInput,
} from "@knotworking/core";
import {
  assets,
  haccpAssets,
  haccpCalibrationRecords,
  haccpCleaningRecords,
  productionDevices,
  siteAssets,
  lockWorkspaceLog,
  recordChanges,
  users,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, count, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";

/**
 * Assets module (`assets`): the shared register of areas, equipment, vehicles, IT, tools and other
 * assets. HACCP (cleaning and calibration schedule) and Site (areas, maintained equipment) build
 * on it with their own extension tables keyed by the asset's id; they use the helpers exported
 * here (`findAsset`, `assertArea`, `assetSummaries`) rather than reading the table themselves.
 *
 * - Archived, never deleted. Archiving and restoring are `manage`; the routes enforce it.
 * - A code is unique (case-insensitive) among the workspace's live assets.
 * - An area stays an area: other modules point at areas (where a pest device or a glass item is),
 *   so an asset can't change between `area` and another kind.
 * - The sync log carries metadata only (kind, code, name, status, area, revision): never cost,
 *   serial number, custodian or notes.
 */

type AssetRow = typeof assets.$inferSelect;

/** What other modules show of an asset: enough to name it and say whether it is in use. */
export interface AssetSummary {
  id: string;
  kind: AssetKind;
  code: string | null;
  name: string;
  location: string | null;
  status: AssetStatus;
}

const change = (row: AssetRow): ChangeInput => ({
  entity: "asset",
  entityId: row.id,
  action: "upsert",
  data: {
    id: row.id,
    kind: row.kind,
    code: row.code,
    name: row.name,
    status: row.status,
    parentAreaId: row.parentAreaId,
    revision: row.revision,
    updatedAt: row.updatedAt,
  },
});

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

/** A live asset of this workspace (archived included), or 404. */
export async function findAsset(db: Executor, workspaceId: string, id: string, what = "Asset") {
  const [row] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt)));
  if (!row) throw notFound(what);
  return row;
}

/** An area must be a live, active asset of kind `area` in this workspace. */
export async function assertArea(db: Executor, workspaceId: string, areaId: string) {
  const [row] = await db
    .select({ id: assets.id, status: assets.status })
    .from(assets)
    .where(
      and(
        eq(assets.id, areaId),
        eq(assets.workspaceId, workspaceId),
        eq(assets.kind, "area"),
        isNull(assets.deletedAt),
      ),
    );
  if (!row) throw notFound("Area");
  if (row.status === "archived") {
    throw new ApiError(409, "area_archived", "That area is archived in the asset register");
  }
}

/** Assets by id (archived or deleted included, so old records keep their names). */
export async function assetSummaries(db: Executor, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, AssetSummary>();
  const rows = await db
    .select({
      id: assets.id,
      kind: assets.kind,
      code: assets.code,
      name: assets.name,
      location: assets.location,
      status: assets.status,
    })
    .from(assets)
    .where(inArray(assets.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Live areas, for pickers: where devices, items, assets, units and checklists are. */
export async function listAreas(db: Executor, workspaceId: string) {
  return db
    .select({
      id: assets.id,
      code: assets.code,
      name: assets.name,
      location: assets.location,
      status: assets.status,
    })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), eq(assets.kind, "area"), isNull(assets.deletedAt)))
    .orderBy(asc(assets.name), asc(assets.id));
}

async function assertCodeFree(db: Executor, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.workspaceId, workspaceId),
        isNull(assets.deletedAt),
        sql`lower(${assets.code}) = lower(${code})`,
        exceptId ? ne(assets.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another asset uses the code "${code}"`);
}

async function assertMember(db: Executor, workspaceId: string, userId: string) {
  const [member] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) throw badRequest("The custodian must be a member of this workspace");
}

/** The parent must be an area, and an area can't end up inside itself. */
async function assertParent(db: Executor, workspaceId: string, parentId: string, selfId?: string) {
  if (parentId === selfId) throw badRequest("An area can't be inside itself");
  await assertArea(db, workspaceId, parentId);
  if (!selfId) return;
  const [result] = await db
    .select({
      invalid: sql<boolean>`(
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_area_id FROM assets WHERE id = ${parentId} AND workspace_id = ${workspaceId}
        UNION
        SELECT a.id, a.parent_area_id FROM assets a
        JOIN ancestors p ON a.id = p.parent_id
        WHERE a.workspace_id = ${workspaceId}
      )
      SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${selfId})
        OR NOT EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL)
    )`,
    })
    .from(assets)
    .where(and(eq(assets.id, parentId), eq(assets.workspaceId, workspaceId)));
  if (result?.invalid) throw badRequest("An area can't be placed inside a cycle");
}

/** Keep equipment references valid even when the modules that own them are switched off. */
async function assertEquipmentCanChangeKind(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select({
      linked: sql<boolean>`
      EXISTS (SELECT 1 FROM ${haccpAssets} WHERE ${haccpAssets.id} = ${id}
        AND (${haccpAssets.cleaningEvery} IS NOT NULL OR ${haccpAssets.calibrationEvery} IS NOT NULL))
      OR EXISTS (SELECT 1 FROM ${haccpCleaningRecords} WHERE ${haccpCleaningRecords.assetId} = ${id})
      OR EXISTS (SELECT 1 FROM ${haccpCalibrationRecords} WHERE ${haccpCalibrationRecords.assetId} = ${id})
      OR EXISTS (SELECT 1 FROM ${siteAssets} WHERE ${siteAssets.calibrationInstrumentId} = ${id})
      OR EXISTS (SELECT 1 FROM ${productionDevices} WHERE ${productionDevices.haccpAssetId} = ${id})
    `,
    })
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.workspaceId, workspaceId)));
  if (row?.linked) {
    throw new ApiError(
      409,
      "kind_fixed",
      "This equipment has linked schedules or records and must stay equipment",
    );
  }
}

async function describe(db: Executor, rows: AssetRow[]) {
  if (rows.length === 0) return [];
  const [areas, names] = await Promise.all([
    assetSummaries(
      db,
      rows.map((r) => r.parentAreaId),
    ),
    (async () => {
      const wanted = [...new Set(rows.map((r) => r.custodianId).filter((v): v is string => !!v))];
      if (wanted.length === 0) return new Map<string, string>();
      const found = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, wanted));
      return new Map(found.map((u) => [u.id, u.name]));
    })(),
  ]);
  return rows.map(({ workspaceId: _ws, deletedAt: _d, ...row }) => {
    const area = row.parentAreaId ? (areas.get(row.parentAreaId) ?? null) : null;
    return {
      ...row,
      parentArea: area ? { id: area.id, code: area.code, name: area.name, status: area.status } : null,
      custodianName: row.custodianId ? (names.get(row.custodianId) ?? null) : null,
    };
  });
}

export async function listAssets(db: Database, workspaceId: string, query: AssetListQuery) {
  const where: (SQL | undefined)[] = [eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt)];
  if (query.kind) where.push(eq(assets.kind, query.kind));
  if (query.areaId) where.push(eq(assets.parentAreaId, query.areaId));
  if (query.status !== "all") where.push(eq(assets.status, query.status));
  if (query.q) {
    const pattern = like(query.q);
    where.push(
      or(
        ...[assets.name, assets.code, assets.serialNumber, assets.manufacturer, assets.model].map(
          (column) => sql`${column} ilike ${pattern} escape '!'`,
        ),
      ),
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(assets)
      .where(and(...where))
      .orderBy(asc(assets.name), asc(assets.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(assets)
      .where(and(...where)),
  ]);
  return { assets: await describe(db, rows), total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

export async function getAsset(db: Executor, workspaceId: string, id: string) {
  const row = await findAsset(db, workspaceId, id);
  const [described] = await describe(db, [row]);
  const [inside] = await db
    .select({ n: count() })
    .from(assets)
    .where(and(eq(assets.parentAreaId, id), isNull(assets.deletedAt)));
  return { ...described!, assetsInside: inside?.n ?? 0 };
}

export async function createAsset(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: AssetCreateInput,
) {
  const row = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    if (input.code) await assertCodeFree(tx, workspaceId, input.code);
    if (input.parentAreaId) await assertParent(tx, workspaceId, input.parentAreaId);
    if (input.custodianId) await assertMember(tx, workspaceId, input.custodianId);
    const { id, ...fields } = input;
    const [created] = await tx
      .insert(assets)
      .values({ ...(id ? { id } : {}), ...fields, workspaceId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change(created!)]);
    return created!;
  });
  return getAsset(db, workspaceId, row.id);
}

export async function updateAsset(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: AssetUpdateInput,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const asset = await findAsset(tx, workspaceId, id);
    const { expectedRevision, ...patch } = input;
    if (expectedRevision !== undefined && expectedRevision !== asset.revision) {
      throw new ApiError(
        409,
        "asset_changed",
        "This asset changed since you opened it; reload and try again",
      );
    }
    if (patch.kind && patch.kind !== asset.kind && (patch.kind === "area" || asset.kind === "area")) {
      throw new ApiError(
        409,
        "kind_fixed",
        "An area stays an area, and other assets can't become areas: other records point at areas",
      );
    }
    if (asset.kind === "equipment" && patch.kind && patch.kind !== asset.kind) {
      await assertEquipmentCanChangeKind(tx, workspaceId, id);
    }
    if (patch.code) await assertCodeFree(tx, workspaceId, patch.code, id);
    if (patch.parentAreaId) await assertParent(tx, workspaceId, patch.parentAreaId, id);
    if (patch.custodianId) await assertMember(tx, workspaceId, patch.custodianId);
    const [updated] = await tx
      .update(assets)
      .set({ ...patch, revision: asset.revision + 1 })
      .where(eq(assets.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change(updated!)]);
  });
  return getAsset(db, workspaceId, id);
}

/** Archives or restores an asset (`manage`). An archived asset keeps its history; nothing new is recorded against it. */
export async function setAssetStatus(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  status: AssetStatus,
) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const asset = await findAsset(tx, workspaceId, id);
    if (asset.status === status) return;
    const [updated] = await tx
      .update(assets)
      .set({ status, revision: asset.revision + 1 })
      .where(eq(assets.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [change(updated!)]);
  });
  return getAsset(db, workspaceId, id);
}
