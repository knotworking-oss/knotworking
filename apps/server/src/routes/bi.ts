import { zValidator } from "@hono/zod-validator";
import {
  biAnalysisCreateSchema,
  biAnalysisSourceSchema,
  biBoardPackCreateSchema,
  biBoardPackIssueSchema,
  biBoardPackUpdateSchema,
  biSnapshotCreateSchema,
  biDashboardCreateSchema,
  biDashboardPublishSchema,
  biDashboardScopeSchema,
  biDashboardUpdateSchema,
  biZodIssues,
  type BiDashboardViewer,
} from "@knotworking/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z, type ZodType } from "zod";
import type { WorkspaceEnv } from "../env";
import { ApiError } from "../errors";
import { requireModuleLevel } from "../middleware/modules";
import { personOrToken } from "../middleware/token-actions";
import { todayIn } from "../middleware/workspace";
import {
  createDashboard,
  dashboardData,
  duplicateDashboard,
  getDashboard,
  listDashboards,
  listDashboardVersions,
  publishDashboard,
  setDashboardArchived,
  unpublishDashboard,
  updateDashboard,
} from "../services/bi/dashboards";
import {
  createPack,
  deletePack,
  getPack,
  getSnapshot,
  issuePack,
  listPacks,
  listSnapshots,
  takeSnapshot,
  updatePack,
} from "../services/bi/packs";
import { createAnalysis, readSource, type SourceReader } from "../services/bi/analysis";
import { describeCatalogue, runBiQuery, type BiWorkspace } from "../services/bi/query";
import { getWorkspaceSettings } from "../services/workspace";
import { validate } from "../validate";

/**
 * Business intelligence, module `bi`.
 *
 * Reads (`GET`) are open to read-scope tokens: the catalogue, queries (the spec travels as JSON in
 * `?spec=`), dashboards and their data. Every query is checked against the caller's own module
 * access (a token's allowlist included) when it runs. Saving drafts needs `write`; publishing and
 * taking back to draft need `manage` and a person, unless the workspace allows `bi.publish`.
 */
const querySchema = z.object({ spec: z.string().min(2).max(20_000) });
const idParam = z.object({ id: z.uuid() });
const listQuery = z.object({
  scope: z.string().max(80).optional(),
  status: z.enum(["draft", "published"]).optional(),
  archived: z.enum(["true", "false"]).optional(),
  template: z.enum(["true", "false"]).optional(),
});
const dataQuery = z.object({ params: z.string().max(10_000).optional() });
const snapshotListQuery = z.object({
  dashboardId: z.uuid().optional(),
  kind: z.enum(["dashboard", "analysis"]).optional(),
});
const sourceQuery = z.object({ path: z.string().max(300), query: z.string().max(5000).optional() });
const duplicateBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  scope: biDashboardScopeSchema.optional(),
});

/** JSON body validation whose errors carry BI issue paths (`spec.sections[0]…`) an agent can act on. */
const biJson = <S extends ZodType>(schema: S) =>
  zValidator("json", schema, (result) => {
    if (!result.success) {
      const issues = biZodIssues(result.error);
      throw new ApiError(400, "invalid_dashboard", `${issues[0]!.path}: ${issues[0]!.message}`, { issues });
    }
  });

const parseJsonParam = (value: string | undefined, name: string): unknown => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new ApiError(400, "invalid_query", `${name}: not valid JSON`, {
      issues: [{ path: name, message: "not valid JSON" }],
    });
  }
};

const viewer = (c: Context<WorkspaceEnv>): BiDashboardViewer => ({
  userId: c.var.user.id,
  role: c.var.workspace.role,
  modules: c.var.workspace.modules,
  viaToken: c.var.credential.kind === "token",
});

/** Reads an analysis source through this app as the caller (their cookie or token). */
const sourceReader = (c: Context<WorkspaceEnv>): SourceReader => ({
  slug: c.var.workspace.slug,
  headers: c.req.raw.headers,
  fetch: c.var.internalFetch,
});

async function biWorkspace(c: Context<WorkspaceEnv>): Promise<BiWorkspace> {
  const settings = await getWorkspaceSettings(c.var.db, c.var.workspace.id);
  return {
    id: c.var.workspace.id,
    timeZone: c.var.workspace.timeZone,
    currency: c.var.workspace.currency,
    financialYearStartMonth: settings.financialYearStartMonth,
    today: todayIn(c),
  };
}

export const biRoutes = new Hono<WorkspaceEnv>()
  .get("/bi/datasets", (c) =>
    c.json(describeCatalogue({ modules: c.var.workspace.modules, role: c.var.workspace.role })),
  )
  .get("/bi/query", validate("query", querySchema), async (c) => {
    const spec = parseJsonParam(c.req.valid("query").spec, "spec");
    return c.json(
      await runBiQuery(
        c.var.db,
        await biWorkspace(c),
        { modules: c.var.workspace.modules, role: c.var.workspace.role },
        spec,
      ),
    );
  })
  // ── Dashboards ──
  .get("/bi/dashboards", validate("query", listQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json({
      dashboards: await listDashboards(c.var.db, c.var.workspace.id, viewer(c), {
        scope: q.scope,
        status: q.status,
        archived: q.archived === "true",
        ...(q.template ? { template: q.template === "true" } : {}),
      }),
    });
  })
  .post("/bi/dashboards", biJson(biDashboardCreateSchema), async (c) =>
    c.json(await createDashboard(c.var.db, c.var.workspace.id, viewer(c), c.req.valid("json")), 201),
  )
  .get("/bi/dashboards/:id", validate("param", idParam), async (c) =>
    c.json(await getDashboard(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c))),
  )
  .patch("/bi/dashboards/:id", validate("param", idParam), biJson(biDashboardUpdateSchema), async (c) =>
    c.json(
      await updateDashboard(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        viewer(c),
        c.req.valid("json"),
      ),
    ),
  )
  .get("/bi/dashboards/:id/versions", validate("param", idParam), async (c) =>
    c.json({
      versions: await listDashboardVersions(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c)),
    }),
  )
  .get("/bi/dashboards/:id/data", validate("param", idParam), validate("query", dataQuery), async (c) =>
    c.json(
      await dashboardData(
        c.var.db,
        await biWorkspace(c),
        c.req.valid("param").id,
        viewer(c),
        parseJsonParam(c.req.valid("query").params, "params"),
      ),
    ),
  )
  .post("/bi/dashboards/:id/duplicate", validate("param", idParam), biJson(duplicateBody), async (c) =>
    c.json(
      await duplicateDashboard(
        c.var.db,
        c.var.workspace.id,
        c.req.valid("param").id,
        viewer(c),
        c.req.valid("json"),
      ),
      201,
    ),
  )
  .post("/bi/dashboards/:id/archive", validate("param", idParam), async (c) =>
    c.json(
      await setDashboardArchived(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c), true),
    ),
  )
  .post("/bi/dashboards/:id/restore", validate("param", idParam), async (c) =>
    c.json(
      await setDashboardArchived(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c), false),
    ),
  )
  // ── Publishing: `manage`, and a person unless the workspace allows `bi.publish` ──
  .post(
    "/bi/dashboards/:id/publish",
    personOrToken("bi.publish"),
    requireModuleLevel("bi", "manage"),
    validate("param", idParam),
    biJson(biDashboardPublishSchema),
    async (c) =>
      c.json(
        await publishDashboard(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          viewer(c),
          c.req.valid("json"),
        ),
      ),
  )
  // ── Board snapshots and packs: `manage`, and a person unless the workspace allows `bi.board_packs` ──
  .post(
    "/bi/dashboards/:id/snapshots",
    personOrToken("bi.board_packs"),
    requireModuleLevel("bi", "manage"),
    validate("param", idParam),
    biJson(biSnapshotCreateSchema),
    async (c) =>
      c.json(
        await takeSnapshot(
          c.var.db,
          await biWorkspace(c),
          c.req.valid("param").id,
          viewer(c),
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .get("/bi/snapshots", validate("query", snapshotListQuery), async (c) =>
    c.json({
      snapshots: await listSnapshots(c.var.db, c.var.workspace.id, viewer(c), c.req.valid("query")),
    }),
  )
  .get("/bi/snapshots/:id", validate("param", idParam), async (c) =>
    c.json(await getSnapshot(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c))),
  )
  // ── Agent analyses (phase 9): sources read as the caller, verified, frozen as snapshots ──
  .get("/bi/sources", validate("query", sourceQuery), async (c) => {
    const q = c.req.valid("query");
    const parsed = biAnalysisSourceSchema.safeParse({
      id: "source",
      path: q.path,
      query: parseJsonParam(q.query, "query") ?? {},
    });
    if (!parsed.success) {
      const issues = biZodIssues(parsed.error);
      throw new ApiError(400, "invalid_analysis", `${issues[0]!.path}: ${issues[0]!.message}`, { issues });
    }
    const read = await readSource(sourceReader(c), parsed.data);
    if ("error" in read) throw new ApiError(400, "invalid_source", `${q.path}: ${read.error}`);
    return c.json({
      path: parsed.data.path,
      query: parsed.data.query,
      module: read.module,
      answer: read.answer,
    });
  })
  .post(
    "/bi/analyses",
    zValidator("json", biAnalysisCreateSchema, (result) => {
      if (!result.success) {
        const issues = biZodIssues(result.error);
        throw new ApiError(400, "invalid_analysis", `${issues[0]!.path}: ${issues[0]!.message}`, { issues });
      }
    }),
    async (c) =>
      c.json(
        await createAnalysis(c.var.db, await biWorkspace(c), viewer(c), sourceReader(c), c.req.valid("json")),
        201,
      ),
  )
  .get("/bi/packs", async (c) => c.json({ packs: await listPacks(c.var.db, c.var.workspace.id, viewer(c)) }))
  .get("/bi/packs/:id", validate("param", idParam), async (c) =>
    c.json(await getPack(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c))),
  )
  .post(
    "/bi/packs",
    personOrToken("bi.board_packs"),
    requireModuleLevel("bi", "manage"),
    biJson(biBoardPackCreateSchema),
    async (c) => c.json(await createPack(c.var.db, c.var.workspace.id, viewer(c), c.req.valid("json")), 201),
  )
  .patch(
    "/bi/packs/:id",
    personOrToken("bi.board_packs"),
    requireModuleLevel("bi", "manage"),
    validate("param", idParam),
    biJson(biBoardPackUpdateSchema),
    async (c) =>
      c.json(
        await updatePack(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          viewer(c),
          c.req.valid("json"),
        ),
      ),
  )
  .post(
    "/bi/packs/:id/issue",
    personOrToken("bi.board_packs"),
    requireModuleLevel("bi", "manage"),
    validate("param", idParam),
    biJson(biBoardPackIssueSchema),
    async (c) =>
      c.json(
        await issuePack(
          c.var.db,
          c.var.workspace.id,
          c.req.valid("param").id,
          viewer(c),
          c.req.valid("json"),
        ),
      ),
  )
  .delete(
    "/bi/packs/:id",
    personOrToken("bi.board_packs"),
    requireModuleLevel("bi", "manage"),
    validate("param", idParam),
    async (c) => c.json(await deletePack(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c))),
  )
  .post(
    "/bi/dashboards/:id/unpublish",
    personOrToken("bi.publish"),
    requireModuleLevel("bi", "manage"),
    validate("param", idParam),
    async (c) =>
      c.json(await unpublishDashboard(c.var.db, c.var.workspace.id, c.req.valid("param").id, viewer(c))),
  );
