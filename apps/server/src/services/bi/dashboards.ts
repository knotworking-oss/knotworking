import {
  biCanEditDashboard,
  biCanReadDashboardHistory,
  biCanViewDashboard,
  biDashboardCreateSchema,
  biDashboardPublishSchema,
  biDashboardSpecSchema,
  biDashboardUpdateSchema,
  biDashboardViewParamsSchema,
  biDataWidgets,
  biFitSpecToCatalogue,
  biScopeModule,
  biWidgetQuery,
  biZodIssues,
  checkBiDashboard,
  hasModuleLevel,
  type BiDashboardSpec,
  type BiDashboardViewer,
  type BiDashboardViewParams,
  type BiIssue,
} from "@knotworking/core";
import {
  biDashboards,
  biDashboardVersions,
  recordChanges,
  workspaceMembers,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import { ApiError, notFound } from "../../errors";
import { visibleCatalogue } from "./access";
import { runBiQuery, type BiQueryResult, type BiWorkspace } from "./query";

/**
 * Stored dashboards. A dashboard is a validated spec; its data is computed
 * per widget as the viewer when it is opened (`dashboardData`), never stored. Every write runs in a
 * transaction that records `bi_dashboard` (and `bi_dashboard_version`) changes; `redactChanges`
 * filters them by audience.
 */

type Row = typeof biDashboards.$inferSelect;
type VersionRow = typeof biDashboardVersions.$inferSelect;

export const serializeDashboard = (row: Row) => ({
  id: row.id,
  scope: row.scope,
  title: row.title,
  description: row.description,
  spec: row.spec,
  status: row.status,
  audience: row.audience,
  audienceUserIds: row.audienceUserIds,
  version: row.version,
  ownerId: row.ownerId,
  publishedAt: row.publishedAt,
  publishedBy: row.publishedBy,
  archivedAt: row.archivedAt,
  template: row.isTemplate,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
export type BiDashboardRecord = ReturnType<typeof serializeDashboard>;

/** A version as synced: with its dashboard's owner, so the log can go to the people who may edit. */
const serializeVersion = (row: VersionRow, ownerId: string | null) => ({ ...row, ownerId });

const invalid = (issues: BiIssue[]) =>
  new ApiError(400, "invalid_dashboard", `${issues[0]!.path}: ${issues[0]!.message}`, { issues });

const tokenOnPublished = () =>
  new ApiError(
    403,
    "token_not_allowed",
    "API tokens can't change a published dashboard. Take it back to draft first (a person, or a token when the workspace allows publishing dashboards), or duplicate it.",
  );

/** Parses input with a schema, refusing with BI issue paths an agent can act on. */
export function parseDashboardInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid(biZodIssues(parsed.error));
  return parsed.data;
}

/** Checks a spec against what the author may query; widgets on data they can't read are refused. */
function assertValidSpec(spec: BiDashboardSpec, viewer: BiDashboardViewer) {
  const issues = checkBiDashboard(spec, visibleCatalogue({ modules: viewer.modules, role: viewer.role }));
  // The same paths a structural error in the request body gets (`spec.sections[0]…`).
  if (issues.length) throw invalid(issues.map((i) => ({ ...i, path: `spec.${i.path}` })));
}

function assertScope(scope: string, viewer: BiDashboardViewer) {
  const module = biScopeModule(scope);
  if (module && !hasModuleLevel(viewer.modules[module], "read")) {
    throw new ApiError(
      403,
      "module_forbidden",
      `You don't have access to the ${module} module in this workspace`,
    );
  }
}

async function load(db: Executor, workspaceId: string, id: string, lock = false): Promise<Row | undefined> {
  const query = db
    .select()
    .from(biDashboards)
    .where(
      and(eq(biDashboards.workspaceId, workspaceId), eq(biDashboards.id, id), isNull(biDashboards.deletedAt)),
    );
  const [row] = await (lock ? query.for("update") : query);
  return row;
}

/** The dashboard if the viewer may open it; 404 otherwise, so ids can't be probed. */
async function loadVisible(
  db: Executor,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  lock = false,
) {
  const row = await load(db, workspaceId, id, lock);
  if (!row || !biCanViewDashboard(row, viewer)) throw notFound("Dashboard");
  return row;
}

async function record(tx: Transaction, workspaceId: string, actorId: string, row: Row, version?: VersionRow) {
  await recordChanges(tx, workspaceId, actorId, [
    { entity: "bi_dashboard", entityId: row.id, action: "upsert", data: serializeDashboard(row) },
    ...(version
      ? [
          {
            entity: "bi_dashboard_version" as const,
            entityId: version.id,
            action: "upsert" as const,
            data: serializeVersion(version, row.ownerId),
          },
        ]
      : []),
  ]);
}

async function insertVersion(tx: Transaction, row: Row, actorId: string) {
  const [version] = await tx
    .insert(biDashboardVersions)
    .values({
      workspaceId: row.workspaceId,
      dashboardId: row.id,
      version: row.version,
      title: row.title,
      description: row.description,
      scope: row.scope,
      spec: row.spec,
      createdBy: actorId,
    })
    .returning();
  return version!;
}

export interface DashboardListFilter {
  scope?: string;
  status?: "draft" | "published";
  archived?: boolean;
  /** Only dashboards saved as templates (true) or only the others (false). */
  template?: boolean;
}

export async function listDashboards(
  db: Executor,
  workspaceId: string,
  viewer: BiDashboardViewer,
  filter: DashboardListFilter = {},
) {
  const rows = await db
    .select()
    .from(biDashboards)
    .where(
      and(
        eq(biDashboards.workspaceId, workspaceId),
        isNull(biDashboards.deletedAt),
        filter.scope ? eq(biDashboards.scope, filter.scope) : undefined,
        filter.status ? eq(biDashboards.status, filter.status) : undefined,
        filter.template !== undefined ? eq(biDashboards.isTemplate, filter.template) : undefined,
      ),
    )
    .orderBy(desc(biDashboards.updatedAt));
  return (
    rows
      .filter((r) => Boolean(r.archivedAt) === Boolean(filter.archived))
      .filter((r) => biCanViewDashboard(r, viewer))
      // Templates offered to start from: your own, and published ones. Someone who may see every
      // draft (an admin, a manager) isn't offered other people's unfinished templates.
      .filter((r) => !filter.template || r.ownerId === viewer.userId || r.status === "published")
      .map(serializeDashboard)
  );
}

export async function getDashboard(db: Executor, workspaceId: string, id: string, viewer: BiDashboardViewer) {
  const row = await loadVisible(db, workspaceId, id, viewer);
  return { ...serializeDashboard(row), canEdit: biCanEditDashboard(row, viewer) };
}

/** A new draft owned by the viewer (`write` on dashboards, checked by the route). */
export async function createDashboard(
  db: Database,
  workspaceId: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  const data = parseDashboardInput(biDashboardCreateSchema, input);
  assertScope(data.scope, viewer);
  assertValidSpec(data.spec, viewer);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(biDashboards)
      .values({
        workspaceId,
        scope: data.scope,
        title: data.title,
        description: data.description ?? null,
        spec: data.spec,
        ownerId: viewer.userId,
      })
      .returning();
    const version = await insertVersion(tx, row!, viewer.userId);
    await record(tx, workspaceId, viewer.userId, row!, version);
    return serializeDashboard(row!);
  });
}

export async function updateDashboard(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  const patch = parseDashboardInput(biDashboardUpdateSchema, input);
  return db.transaction(async (tx) => {
    const row = await loadVisible(tx, workspaceId, id, viewer, true);
    if (!biCanEditDashboard(row, viewer)) {
      if (viewer.viaToken && row.status === "published") throw tokenOnPublished();
      throw new ApiError(
        403,
        "dashboard_forbidden",
        row.status === "published"
          ? "Published dashboards are changed by someone with manage access to dashboards. Duplicate it to make your own draft."
          : "Only the dashboard's owner or someone with manage access to dashboards can change it",
      );
    }
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== row.version) {
      throw new ApiError(
        409,
        "dashboard_conflict",
        `The dashboard changed (version ${row.version}); reload it and try again`,
        {
          version: row.version,
        },
      );
    }
    if (patch.scope !== undefined) assertScope(patch.scope, viewer);
    if (patch.spec !== undefined) assertValidSpec(patch.spec, viewer);
    const [updated] = await tx
      .update(biDashboards)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...(patch.spec !== undefined ? { spec: patch.spec } : {}),
        ...(patch.template !== undefined ? { isTemplate: patch.template } : {}),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(biDashboards.id, row.id))
      .returning();
    const version = await insertVersion(tx, updated!, viewer.userId);
    await record(tx, workspaceId, viewer.userId, updated!, version);
    return serializeDashboard(updated!);
  });
}

/**
 * A new draft owned by the viewer, copied from any dashboard they can open (a template included;
 * the copy is never itself a template). `scope` moves the copy to another module or the workspace.
 * Widgets on data the viewer can't read are left out rather than refusing the whole copy;
 * `omittedWidgets` says how many.
 */
export async function duplicateDashboard(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  options: { title?: string; scope?: string; view?: BiDashboardViewParams } = {},
) {
  const source = await loadVisible(db, workspaceId, id, viewer);
  const parsed = biDashboardSpecSchema.safeParse(source.spec);
  if (!parsed.success) throw invalid(biZodIssues(parsed.error, "spec"));
  const spec = biFitSpecToCatalogue(
    parsed.data,
    visibleCatalogue({ modules: viewer.modules, role: viewer.role }),
  );
  const count = (s: BiDashboardSpec) => s.sections.reduce((n, x) => n + x.widgets.length, 0);
  const view = options.view;
  const draftSpec = view
    ? {
        ...spec,
        params: { ...spec.params, period: view.period ?? spec.params.period },
        sections: spec.sections.map((section) => ({
          ...section,
          widgets: section.widgets.map((widget) =>
            widget.type === "text" ? widget : { ...widget, query: biWidgetQuery(widget, spec, view) },
          ),
        })),
      }
    : spec;
  const created = await createDashboard(db, workspaceId, viewer, {
    title: (options.title ?? (source.isTemplate ? source.title : `Copy of ${source.title}`)).slice(0, 120),
    description: source.description ?? undefined,
    scope: options.scope ?? source.scope,
    spec: draftSpec,
  });
  return { ...created, omittedWidgets: count(parsed.data) - count(spec) };
}

/** Archive (hide) or restore a dashboard: its owner while it is a draft, or `manage`. */
export async function setDashboardArchived(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  archived: boolean,
) {
  return db.transaction(async (tx) => {
    const row = await loadVisible(tx, workspaceId, id, viewer, true);
    // Archiving or restoring a published dashboard changes what its audience sees.
    if (viewer.viaToken && row.status === "published") throw tokenOnPublished();
    const manager = hasModuleLevel(viewer.modules.bi, "manage");
    const ownDraft = row.ownerId === viewer.userId && row.status === "draft";
    if (!manager && !ownDraft) {
      throw new ApiError(
        403,
        "dashboard_forbidden",
        "Only the owner of a draft or someone with manage access can archive it",
      );
    }
    if (Boolean(row.archivedAt) === archived) return serializeDashboard(row);
    const [updated] = await tx
      .update(biDashboards)
      .set(
        archived
          ? { archivedAt: new Date(), archivedBy: viewer.userId, updatedAt: new Date() }
          : { archivedAt: null, archivedBy: null, updatedAt: new Date() },
      )
      .where(eq(biDashboards.id, row.id))
      .returning();
    await record(tx, workspaceId, viewer.userId, updated!);
    return serializeDashboard(updated!);
  });
}

/**
 * Publish to an audience, or take back to draft (`manage`, and a person unless the workspace
 * allows tokens `bi.publish`; both checked by the route). Named members must belong to the workspace.
 */
export async function publishDashboard(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
  input: unknown,
) {
  const data = parseDashboardInput(biDashboardPublishSchema, input);
  return db.transaction(async (tx) => {
    const row = await loadVisible(tx, workspaceId, id, viewer, true);
    if (row.archivedAt)
      throw new ApiError(409, "dashboard_archived", "Restore the dashboard before publishing it");
    if (data.expectedVersion !== undefined && data.expectedVersion !== row.version) {
      throw new ApiError(
        409,
        "dashboard_conflict",
        `The dashboard changed since you reviewed it (now version ${row.version}); review it again before publishing`,
        { version: row.version },
      );
    }
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
      const missing = memberIds.filter((m) => !known.has(m));
      if (missing.length) {
        throw invalid(
          missing.map((m) => ({
            path: `memberIds[${memberIds.indexOf(m)}]`,
            message: `'${m}' is not a member of this workspace`,
          })),
        );
      }
    }
    const [updated] = await tx
      .update(biDashboards)
      .set({
        status: "published",
        audience: data.audience,
        audienceUserIds: memberIds,
        publishedAt: new Date(),
        publishedBy: viewer.userId,
        updatedAt: new Date(),
      })
      .where(eq(biDashboards.id, row.id))
      .returning();
    await record(tx, workspaceId, viewer.userId, updated!);
    return serializeDashboard(updated!);
  });
}

export async function unpublishDashboard(
  db: Database,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
) {
  return db.transaction(async (tx) => {
    const row = await loadVisible(tx, workspaceId, id, viewer, true);
    if (row.status === "draft") return serializeDashboard(row);
    const [updated] = await tx
      .update(biDashboards)
      .set({ status: "draft", publishedAt: null, publishedBy: null, updatedAt: new Date() })
      .where(eq(biDashboards.id, row.id))
      .returning();
    await record(tx, workspaceId, viewer.userId, updated!);
    return serializeDashboard(updated!);
  });
}

export async function listDashboardVersions(
  db: Executor,
  workspaceId: string,
  id: string,
  viewer: BiDashboardViewer,
) {
  const row = await loadVisible(db, workspaceId, id, viewer);
  // Earlier versions may hold draft content the audience never saw.
  if (!biCanReadDashboardHistory(row, viewer)) {
    throw new ApiError(403, "dashboard_forbidden", "Only people who can edit this dashboard see its history");
  }
  return db
    .select()
    .from(biDashboardVersions)
    .where(and(eq(biDashboardVersions.workspaceId, workspaceId), eq(biDashboardVersions.dashboardId, id)))
    .orderBy(desc(biDashboardVersions.version));
}

/** One widget's outcome: its rows, "no access" for data the viewer can't read, or an error tile. */
export type BiWidgetData =
  | { widgetId: string; status: "ok"; result: BiQueryResult }
  | { widgetId: string; status: "no_access"; message: string }
  | { widgetId: string; status: "error"; code: string; message: string; details?: unknown };

/** Widgets queried at once per dashboard; the analytic gate still bounds the whole process. */
const WIDGET_CONCURRENCY = 3;

/**
 * Runs every data widget as the viewer, with the view's period and filter values applied. A widget
 * that fails (no access, an invalid query after a catalogue change, a timeout) becomes its own
 * error tile; the page never fails as a whole.
 */
export async function dashboardData(
  db: Database,
  workspace: BiWorkspace,
  id: string,
  viewer: BiDashboardViewer,
  viewInput: unknown,
) {
  const view = parseDashboardInput(biDashboardViewParamsSchema, viewInput ?? {});
  const row = await loadVisible(db, workspace.id, id, viewer);
  // A stored spec that no longer parses (a schema change) shows as one error, not a crash.
  const parsed = biDashboardSpecSchema.safeParse(row.spec);
  if (!parsed.success) throw invalid(biZodIssues(parsed.error, "spec"));
  const spec = parsed.data;
  const widgets = biDataWidgets(spec);
  const out: BiWidgetData[] = new Array(widgets.length);
  let next = 0;
  const worker = async () => {
    while (next < widgets.length) {
      const i = next++;
      const { widget } = widgets[i]!;
      try {
        const result = await runBiQuery(
          db,
          workspace,
          { modules: viewer.modules, role: viewer.role },
          biWidgetQuery(widget, spec, view),
        );
        out[i] = { widgetId: widget.id, status: "ok", result };
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.code === "module_forbidden" || err.code === "bi_field_forbidden")
        ) {
          out[i] = {
            widgetId: widget.id,
            status: "no_access",
            message: "You don't have access to this data",
          };
        } else if (err instanceof ApiError) {
          out[i] = {
            widgetId: widget.id,
            status: "error",
            code: err.code,
            message: err.message,
            details: err.details,
          };
        } else {
          console.error("dashboard widget failed", err);
          out[i] = {
            widgetId: widget.id,
            status: "error",
            code: "internal",
            message: "This widget could not be loaded",
          };
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WIDGET_CONCURRENCY, widgets.length) }, worker));
  return { dashboardId: row.id, version: row.version, view, widgets: out };
}
