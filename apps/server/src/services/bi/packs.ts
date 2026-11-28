import {
  BI_CATALOGUE_VERSION,
  biBoardPackCreateSchema,
  biBoardPackIssueSchema,
  biBoardPackUpdateSchema,
  biCanManagePacks,
  biCanViewPack,
  biCertifiedMetric,
  biInPackAudience,
  biDashboardSpecSchema,
  biDataset,
  biDataWidgets,
  biSnapshotCreateSchema,
  hasModuleLevel,
  type BiAnalysisResult,
  type BiBoardPackItem,
  type ModuleId,
  type BiDashboardSpec,
  type BiDashboardViewer,
} from "@knotworking/core";
import {
  biBoardPacks,
  biSnapshots,
  recordChanges,
  workspaceMembers,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { ApiError, notFound } from "../../errors";
import { visibleDataset } from "./access";
import { dashboardData, getDashboard, parseDashboardInput } from "./dashboards";
import type { BiWorkspace } from "./query";

/**
 * Board snapshots and packs (access rules in `@knotworking/core` bi/packs.ts).
 *
 * A snapshot freezes a dashboard as its taker sees it today: the spec, every widget's results, the
 * view, the catalogue version and every figure's definition. It is append-only and never
 * re-queried. Writes record a header-only change (`bi_snapshot`, `bi_board_pack`): figures never
 * enter the sync log (Decisions 1).
 */

type SnapshotRow = typeof biSnapshots.$inferSelect;
type PackRow = typeof biBoardPacks.$inferSelect;

const forbidden = (message: string) => new ApiError(403, "bi_pack_forbidden", message);

/** What the sync log and lists carry: no spec, results or definitions. */
const snapshotHeader = (row: SnapshotRow) => ({
  id: row.id,
  kind: row.kind,
  dashboardId: row.dashboardId,
  dashboardVersion: row.dashboardVersion,
  title: row.title,
  asAt: row.asAt,
  catalogueVersion: row.catalogueVersion,
  takenBy: row.takenBy,
  takenAt: row.takenAt,
});

const packView = (row: PackRow) => ({
  id: row.id,
  title: row.title,
  asAt: row.asAt,
  cover: row.cover,
  items: row.items,
  status: row.status,
  audience: row.audience,
  audienceUserIds: row.audienceUserIds,
  version: row.version,
  createdBy: row.createdBy,
  issuedAt: row.issuedAt,
  issuedBy: row.issuedBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** A pack header for the sync log: its readers, and how many items, never commentary or figures. */
const packHeader = (row: PackRow) => {
  const { cover: _cover, items, ...rest } = packView(row);
  return { ...rest, itemCount: items.length };
};

const recordSnapshot = (tx: Transaction, ws: string, actor: string, row: SnapshotRow) =>
  recordChanges(tx, ws, actor, [
    { entity: "bi_snapshot", entityId: row.id, action: "upsert", data: snapshotHeader(row) },
  ]);
const recordPack = (tx: Transaction, ws: string, actor: string, row: PackRow, deleted = false) =>
  recordChanges(tx, ws, actor, [
    deleted
      ? { entity: "bi_board_pack", entityId: row.id, action: "delete", data: null }
      : { entity: "bi_board_pack", entityId: row.id, action: "upsert", data: packHeader(row) },
  ]);

function assertManager(viewer: BiDashboardViewer) {
  if (!biCanManagePacks(viewer))
    throw forbidden("Board snapshots and packs need manage access to dashboards");
}

/** Every figure's definition on a spec, keyed `<dataset>.<measure>`, as it reads today. */
function definitionsOf(spec: BiDashboardSpec) {
  const out: Record<string, { label: string; definition: string; unit: string; version?: string }> = {};
  for (const { widget } of biDataWidgets(spec)) {
    const dataset = biDataset(widget.query.dataset);
    for (const id of widget.query.measures) {
      const m = dataset?.measures.find((x) => x.id === id);
      if (!m) continue;
      out[`${widget.query.dataset}.${id}`] = {
        label: m.label,
        definition: m.description,
        unit: m.unit,
        ...(biCertifiedMetric(id) && m.certified ? { version: m.certified.version } : {}),
      };
    }
  }
  return out;
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

/**
 * Freezes a dashboard as at today, as the taker sees it with the view given. Widgets on data the
 * taker can't read are frozen as "no access", like any view.
 */
export async function takeSnapshot(
  db: Database,
  workspace: BiWorkspace,
  dashboardId: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  const prepared = await prepareDashboardSnapshot(db, workspace, dashboardId, viewer, input);
  return db.transaction((tx) => saveDashboardSnapshot(tx, prepared));
}

export async function prepareDashboardSnapshot(
  db: Database,
  workspace: BiWorkspace,
  dashboardId: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  assertManager(viewer);
  const data = parseDashboardInput(biSnapshotCreateSchema, input ?? {});
  const dashboard = await getDashboard(db, workspace.id, dashboardId, viewer);
  const view = data.params ?? { filters: {} };
  const results = await dashboardData(db, workspace, dashboardId, viewer, view);
  if (results.version !== dashboard.version) {
    throw new ApiError(
      409,
      "dashboard_conflict",
      "The dashboard changed while the snapshot was taken; try again",
    );
  }
  const spec = biDashboardSpecSchema.parse(dashboard.spec);
  return {
    description: dashboard.description,
    values: {
      workspaceId: workspace.id,
      dashboardId,
      dashboardVersion: results.version,
      title: data.title ?? `${dashboard.title}, as at ${workspace.today}`,
      asAt: workspace.today,
      spec,
      results: { widgets: results.widgets },
      catalogueVersion: BI_CATALOGUE_VERSION,
      definitions: definitionsOf(spec),
      view: results.view,
      takenBy: viewer.userId,
    },
  };
}

export async function saveDashboardSnapshot(
  tx: Transaction,
  { description, values }: Awaited<ReturnType<typeof prepareDashboardSnapshot>>,
) {
  const [row] = await tx.insert(biSnapshots).values(values).returning();
  await recordSnapshot(tx, values.workspaceId, values.takenBy, row!);
  return { ...snapshotHeader(row!), description };
}

export async function listSnapshots(
  db: Executor,
  workspaceId: string,
  viewer: BiDashboardViewer,
  filter: { dashboardId?: string; kind?: "dashboard" | "analysis" } = {},
) {
  // Managers list every snapshot; anyone else only the analyses they made.
  const manager = biCanManagePacks(viewer);
  if (!manager && filter.kind !== "analysis") assertManager(viewer);
  const rows = await db
    .select()
    .from(biSnapshots)
    .where(
      and(
        eq(biSnapshots.workspaceId, workspaceId),
        filter.dashboardId ? eq(biSnapshots.dashboardId, filter.dashboardId) : undefined,
        filter.kind ? eq(biSnapshots.kind, filter.kind) : undefined,
        manager ? undefined : eq(biSnapshots.takenBy, viewer.userId),
      ),
    )
    .orderBy(desc(biSnapshots.takenAt))
    .limit(500);
  return rows.map(snapshotHeader);
}

/**
 * Snapshot ids shared with the viewer as a member of an issued pack's audience (the pack's own
 * snapshots and the earlier ones frozen with them for comparison). Being a dashboard manager is not
 * being in an audience: managers open every snapshot, but see only the figures their access allows.
 */
async function sharedSnapshotIds(db: Executor, workspaceId: string, viewer: BiDashboardViewer) {
  const packs = await db
    .select()
    .from(biBoardPacks)
    .where(
      and(
        eq(biBoardPacks.workspaceId, workspaceId),
        eq(biBoardPacks.status, "issued"),
        isNull(biBoardPacks.deletedAt),
      ),
    );
  return new Set(
    packs
      .filter((p) => biInPackAudience(p, viewer))
      .flatMap((p) =>
        p.items.flatMap((i) => [i.snapshotId, ...(i.previousSnapshotId ? [i.previousSnapshotId] : [])]),
      ),
  );
}

/** What a viewer may do with one snapshot: open it, and whether they see every figure in it. */
interface SnapshotAccess {
  manager: boolean;
  shared: Set<string>;
}
const canOpen = (a: SnapshotAccess, id: string) => a.manager || a.shared.has(id);

/**
 * A snapshot's figures for this viewer. People named in an issued pack's audience see what the
 * issuer shared, as frozen. Everyone else (managers, and every API token, whose module allowlist
 * always applies) sees only widgets on data they may read themselves; the rest are "no access".
 */
function presentSnapshot(row: SnapshotRow, viewer: BiDashboardViewer, access: SnapshotAccess) {
  if (row.kind === "analysis") return presentAnalysis(row, viewer, access);
  const full = !viewer.viaToken && access.shared.has(row.id);
  const results = row.results as { widgets: Array<{ widgetId: string }> };
  if (full) return snapshotBody(row, results.widgets);
  const spec = biDashboardSpecSchema.safeParse(row.spec);
  const allowed = new Set<string>();
  if (spec.success) {
    for (const { widget } of biDataWidgets(spec.data)) {
      const dataset = biDataset(widget.query.dataset);
      const visible = dataset
        ? visibleDataset(dataset, { modules: viewer.modules, role: viewer.role })
        : null;
      if (!visible) continue;
      const fields = new Set([...visible.dimensions, ...visible.measures].map((f) => f.id));
      const used = [
        ...widget.query.measures,
        ...widget.query.groupBy.map((g) => g.dim),
        ...widget.query.filters.map((f) => f.dim),
        ...(widget.query.period?.dim ? [widget.query.period.dim] : []),
      ];
      if (used.every((f) => fields.has(f))) allowed.add(widget.id);
    }
  }
  return snapshotBody(
    row,
    results.widgets.map((w) =>
      allowed.has(w.widgetId)
        ? w
        : {
            widgetId: w.widgetId,
            status: "no_access" as const,
            message: "You don't have access to this data",
          },
    ),
  );
}

const snapshotBody = (row: SnapshotRow, widgets: unknown[]) => ({
  ...snapshotHeader(row),
  spec: row.spec,
  results: { widgets },
  definitions: row.definitions,
  view: row.view,
});

async function snapshotAccess(db: Executor, workspaceId: string, viewer: BiDashboardViewer) {
  return {
    manager: biCanManagePacks(viewer),
    shared: await sharedSnapshotIds(db, workspaceId, viewer),
  };
}

/**
 * An analysis for this viewer. Its figures come from sources of several modules; a reader sees them
 * if they may read every one of those modules, or (in person) took it or were issued it in a pack.
 * Otherwise the labels, scenarios and assumptions show, and every value and cited input is hidden.
 */
function presentAnalysis(row: SnapshotRow, viewer: BiDashboardViewer, access: SnapshotAccess) {
  const analysis = (row.results as { analysis: BiAnalysisResult }).analysis;
  const person = !viewer.viaToken;
  const readsAll = analysis.modules.every((m) => hasModuleLevel(viewer.modules[m as ModuleId], "read"));
  const full = readsAll || (person && (access.shared.has(row.id) || row.takenBy === viewer.userId));
  const shown: BiAnalysisResult & { hidden: boolean } = full
    ? { ...analysis, hidden: false }
    : {
        ...analysis,
        hidden: true,
        // The summary and formulas can carry figures, and source paths and notes name records.
        summary: null,
        sources: analysis.sources.map((src) => ({ id: src.id, path: "", query: {}, readAt: src.readAt })),
        figures: analysis.figures.map((f) => ({
          ...f,
          values: Object.fromEntries(
            Object.entries(f.values).map(([k]) => [k, { value: null, formula: "", inputs: {} }]),
          ),
        })),
      };
  return { ...snapshotHeader(row), results: { analysis: shown } };
}

/**
 * A snapshot with its figures (as the viewer may see them), and the snapshot of the same dashboard
 * taken just before it when they may open that one, for comparison. 404 when they may not open it.
 */
export async function getSnapshot(db: Executor, workspaceId: string, id: string, viewer: BiDashboardViewer) {
  const [row] = await db
    .select()
    .from(biSnapshots)
    .where(and(eq(biSnapshots.workspaceId, workspaceId), eq(biSnapshots.id, id)));
  const access = await snapshotAccess(db, workspaceId, viewer);
  // An analysis is also open to whoever made it (a member, or their agent).
  const own = row?.kind === "analysis" && row.takenBy === viewer.userId;
  if (!row || !viewer.modules.bi || viewer.modules.bi === "none" || !(own || canOpen(access, id)))
    throw notFound("Snapshot");
  const previous = await latestEarlier(db, workspaceId, row, (candidate) => canOpen(access, candidate));
  return {
    ...presentSnapshot(row, viewer, access),
    previous: previous ? presentSnapshot(previous, viewer, access) : null,
  };
}

/** The latest snapshot of the same dashboard taken before `row` that passes `allowed`. */
async function latestEarlier(
  db: Executor,
  workspaceId: string,
  row: SnapshotRow,
  allowed: (id: string) => boolean = () => true,
) {
  if (!row.dashboardId) return null;
  const earlier = await db
    .select()
    .from(biSnapshots)
    .where(
      and(
        eq(biSnapshots.workspaceId, workspaceId),
        eq(biSnapshots.dashboardId, row.dashboardId),
        lt(biSnapshots.takenAt, row.takenAt),
      ),
    )
    .orderBy(desc(biSnapshots.takenAt));
  return earlier.find((candidate) => allowed(candidate.id)) ?? null;
}

// ─── Packs ──────────────────────────────────────────────────────────────────

async function loadPack(
  db: Executor,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  lock = false,
) {
  const query = db
    .select()
    .from(biBoardPacks)
    .where(
      and(eq(biBoardPacks.workspaceId, workspaceId), eq(biBoardPacks.id, id), isNull(biBoardPacks.deletedAt)),
    );
  const [row] = await (lock ? query.for("update") : query);
  if (!row || !biCanViewPack(row, viewer)) throw notFound("Board pack");
  return row;
}

/** Every snapshot id must be a snapshot of this workspace. */
async function assertSnapshots(db: Executor, workspaceId: string, items: readonly BiBoardPackItem[]) {
  const ids = [...new Set(items.map((i) => i.snapshotId))];
  if (ids.length !== items.length) {
    throw new ApiError(400, "invalid_pack", "items: a snapshot is listed twice", {
      issues: [{ path: "items", message: "a snapshot is listed twice" }],
    });
  }
  if (!ids.length) return;
  const found = await db
    .select({ id: biSnapshots.id })
    .from(biSnapshots)
    .where(and(eq(biSnapshots.workspaceId, workspaceId), inArray(biSnapshots.id, ids)));
  const known = new Set(found.map((f) => f.id));
  const missing = items.findIndex((i) => !known.has(i.snapshotId));
  if (missing >= 0) {
    throw new ApiError(400, "invalid_pack", `items[${missing}].snapshotId: no such snapshot`, {
      issues: [{ path: `items[${missing}].snapshotId`, message: "no such snapshot" }],
    });
  }
}

export async function listPacks(db: Executor, workspaceId: string, viewer: BiDashboardViewer) {
  const rows = await db
    .select()
    .from(biBoardPacks)
    .where(and(eq(biBoardPacks.workspaceId, workspaceId), isNull(biBoardPacks.deletedAt)))
    .orderBy(desc(biBoardPacks.asAt), desc(biBoardPacks.updatedAt));
  return rows.filter((r) => biCanViewPack(r, viewer)).map(packView);
}

/**
 * A pack with every snapshot's figures in order, each with the earlier snapshot of its dashboard
 * the viewer may read (for "since last time"), and every definition used.
 */
export async function getPack(db: Executor, workspaceId: string, id: string, viewer: BiDashboardViewer) {
  const pack = await loadPack(db, workspaceId, id, viewer);
  const ids = pack.items.map((i) => i.snapshotId);
  const rows = ids.length
    ? await db
        .select()
        .from(biSnapshots)
        .where(and(eq(biSnapshots.workspaceId, workspaceId), inArray(biSnapshots.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const access = await snapshotAccess(db, workspaceId, viewer);
  // An issued pack compares with the snapshot frozen with it at issue; a draft with the latest
  // earlier one (only managers see drafts).
  const frozenPrevious = pack.items.flatMap((i) => (i.previousSnapshotId ? [i.previousSnapshotId] : []));
  const previousRows = frozenPrevious.length
    ? await db
        .select()
        .from(biSnapshots)
        .where(and(eq(biSnapshots.workspaceId, workspaceId), inArray(biSnapshots.id, frozenPrevious)))
    : [];
  const previousById = new Map(previousRows.map((r) => [r.id, r]));
  const items = [];
  for (const item of pack.items) {
    const row = byId.get(item.snapshotId);
    if (!row) continue;
    const previous =
      pack.status === "issued"
        ? item.previousSnapshotId
          ? (previousById.get(item.previousSnapshotId) ?? null)
          : null
        : await latestEarlier(db, workspaceId, row);
    items.push({
      commentary: item.commentary ?? null,
      snapshot: presentSnapshot(row, viewer, access),
      previous: previous ? presentSnapshot(previous, viewer, { ...access, shared: access.shared }) : null,
    });
  }
  const definitions = Object.assign({}, ...rows.map((r) => r.definitions)) as Record<string, unknown>;
  return {
    ...packView(pack),
    canEdit: biCanManagePacks(viewer) && pack.status === "draft",
    items,
    definitions,
  };
}

export async function createPack(
  db: Database,
  workspaceId: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  assertManager(viewer);
  const data = parseDashboardInput(biBoardPackCreateSchema, input);
  await assertSnapshots(db, workspaceId, data.items);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(biBoardPacks)
      .values({
        workspaceId,
        title: data.title,
        asAt: data.asAt,
        cover: data.cover ?? null,
        items: data.items,
        createdBy: viewer.userId,
      })
      .returning();
    await recordPack(tx, workspaceId, viewer.userId, row!);
    return packView(row!);
  });
}

function assertDraft(row: PackRow, expectedVersion?: number) {
  if (row.status !== "draft")
    throw new ApiError(409, "pack_issued", "An issued pack never changes: make a new pack instead");
  if (expectedVersion !== undefined && expectedVersion !== row.version) {
    throw new ApiError(
      409,
      "pack_conflict",
      `The pack changed (version ${row.version}); reload it and try again`,
      {
        version: row.version,
      },
    );
  }
}

export async function updatePack(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  assertManager(viewer);
  const patch = parseDashboardInput(biBoardPackUpdateSchema, input);
  if (patch.items) await assertSnapshots(db, workspaceId, patch.items);
  return db.transaction(async (tx) => {
    const row = await loadPack(tx, workspaceId, id, viewer, true);
    assertDraft(row, patch.expectedVersion);
    const [updated] = await tx
      .update(biBoardPacks)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.asAt !== undefined ? { asAt: patch.asAt } : {}),
        ...(patch.cover !== undefined ? { cover: patch.cover } : {}),
        ...(patch.items !== undefined ? { items: patch.items } : {}),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(biBoardPacks.id, row.id))
      .returning();
    await recordPack(tx, workspaceId, viewer.userId, updated!);
    return packView(updated!);
  });
}

/** Issues a draft pack to an audience: from then on it never changes. */
export async function issuePack(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  assertManager(viewer);
  const data = parseDashboardInput(biBoardPackIssueSchema, input ?? {});
  return db.transaction(async (tx) => {
    const row = await loadPack(tx, workspaceId, id, viewer, true);
    assertDraft(row, data.expectedVersion);
    if (row.items.length === 0)
      throw new ApiError(400, "invalid_pack", "items: add at least one snapshot before issuing", {
        issues: [{ path: "items", message: "add at least one snapshot before issuing" }],
      });
    const memberIds = [...new Set(data.audience === "members" ? data.memberIds : [])];
    if (memberIds.length) {
      const found = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            inArray(workspaceMembers.userId, memberIds),
            isNull(workspaceMembers.deletedAt),
          ),
        );
      const known = new Set(found.map((f) => f.userId));
      const missing = memberIds.findIndex((m) => !known.has(m));
      if (missing >= 0) {
        throw new ApiError(400, "invalid_pack", `memberIds[${missing}]: not a member of this workspace`, {
          issues: [{ path: `memberIds[${missing}]`, message: "not a member of this workspace" }],
        });
      }
    }
    // Freeze each snapshot's comparison: the pack shows the same "since last time" for good.
    const snapshotRows = await tx
      .select()
      .from(biSnapshots)
      .where(
        and(
          eq(biSnapshots.workspaceId, workspaceId),
          inArray(
            biSnapshots.id,
            row.items.map((i) => i.snapshotId),
          ),
        ),
      );
    const items: BiBoardPackItem[] = [];
    for (const item of row.items) {
      const snapshot = snapshotRows.find((r) => r.id === item.snapshotId);
      const previous = snapshot ? await latestEarlier(tx, workspaceId, snapshot) : null;
      items.push({ ...item, previousSnapshotId: previous?.id ?? null });
    }
    const [updated] = await tx
      .update(biBoardPacks)
      .set({
        items,
        status: "issued",
        audience: data.audience,
        audienceUserIds: memberIds,
        issuedAt: new Date(),
        issuedBy: viewer.userId,
        updatedAt: new Date(),
      })
      .where(eq(biBoardPacks.id, row.id))
      .returning();
    await recordPack(tx, workspaceId, viewer.userId, updated!);
    return packView(updated!);
  });
}

/** Deletes a draft pack (its snapshots stay). An issued pack is a record and is kept. */
export async function deletePack(db: Database, workspaceId: string, id: string, viewer: BiDashboardViewer) {
  assertManager(viewer);
  return db.transaction(async (tx) => {
    const row = await loadPack(tx, workspaceId, id, viewer, true);
    assertDraft(row);
    const [deleted] = await tx
      .update(biBoardPacks)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(biBoardPacks.id, row.id))
      .returning();
    await recordPack(tx, workspaceId, viewer.userId, deleted!, true);
    return { ok: true as const };
  });
}
