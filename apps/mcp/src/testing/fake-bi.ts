import {
  biAnalysisCreateSchema,
  biExpectedMatches,
  checkBiAnalysis,
  evaluateBiFormula,
  parseBiFormula,
  resolveBiPath,
  biDashboardCreateSchema,
  biDashboardSpecSchema,
  biDashboardUpdateSchema,
  biDashboardViewParamsSchema,
  type BiDashboardViewParams,
  biDataset,
  biDatasets,
  biQuerySpecSchema,
  biWidgetQuery,
  biDataWidgets,
  biZodIssues,
  checkBiDashboard,
  checkBiQuery,
  newId,
  type BiIssue,
  type BiQuerySpec,
} from "@knotworking/core";
import type { Hono } from "hono";

/**
 * In-memory stand-in for the BI routes (apps/server/src/routes/bi.ts). It validates with the same
 * core functions the server uses (catalogue, `checkBiQuery`, `checkBiDashboard`), so the agent
 * sees the server's paths and suggestions. Results are deterministic synthetic numbers, one row
 * per group: enough to check shapes, never meant as real figures.
 */
export function mountFakeBi(app: Hono, ws: string) {
  const err = (code: string, message: string, details?: unknown) => ({
    error: { code, message, ...(details ? { details } : {}) },
  });
  const invalid = (code: string, issues: BiIssue[]) =>
    err(code, `${issues[0]!.path}: ${issues[0]!.message}`, { issues });
  /** Datasets the caller may not read (tests add ids to see "no access"). */
  const hidden = new Set<string>();
  const dashboards: Record<string, any>[] = [];
  const queries: BiQuerySpec[] = [];
  /** View parameters the data route received. */
  const views: BiDashboardViewParams[] = [];

  const visible = () => biDatasets.filter((d) => !hidden.has(d.id));

  /** One synthetic row per group value: categories take their declared values, others three labels. */
  function run(spec: BiQuerySpec) {
    const dataset = biDataset(spec.dataset)!;
    const dims = spec.groupBy.map((g) => dataset.dimensions.find((d) => d.id === g.dim)!);
    let rows: Record<string, unknown>[] = [{}];
    for (const [i, dim] of dims.entries()) {
      const values =
        dim.type === "date"
          ? ["2026-09-01", "2026-10-01", "2026-11-01"]
          : dim.values?.length
            ? dim.values.slice(0, 4)
            : ["A", "B", "C"];
      rows = rows.flatMap((row) =>
        values.map((v, j) => ({
          ...row,
          [dim.id]: dim.type === "reference" ? `${dim.label} ${String(v)}` : v,
          ...(dim.type === "reference"
            ? { [`${dim.id}__id`]: `00000000-0000-4000-8000-00000000000${i}${j}` }
            : {}),
        })),
      );
    }
    rows = rows.map((row, r) => ({
      ...row,
      ...Object.fromEntries(spec.measures.map((m, k) => [m, (r + 1) * 10 + k])),
      ...(spec.compare
        ? Object.fromEntries(spec.measures.map((m, k) => [`${m}__compare`, (r + 1) * 8 + k]))
        : {}),
    }));
    const limit = spec.limit ?? 1000;
    return {
      dataset: dataset.id,
      catalogueVersion: 2,
      columns: [
        ...dims.map((d) => ({ key: d.id, label: d.label, kind: "dimension", type: d.type })),
        ...spec.measures.map((m) => ({
          key: m,
          label: dataset.measures.find((x) => x.id === m)!.label,
          kind: "measure",
          unit: dataset.measures.find((x) => x.id === m)!.unit,
        })),
      ],
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
      period: spec.period
        ? { dim: spec.period.dim ?? dataset.defaultDate, from: "2025-12-01", to: "2026-11-19" }
        : null,
      comparePeriod: spec.compare ? { from: "2024-12-01", to: "2025-11-19" } : null,
      compareTruncated: false,
      currency: dataset.currencyDimension ? null : "GBP",
    };
  }

  /** Parses and checks a query spec as the server does; returns the error body or the spec. */
  function check(input: unknown): { spec: BiQuerySpec } | { error: ReturnType<typeof err> } {
    const parsed = biQuerySpecSchema.safeParse(input);
    if (!parsed.success) return { error: invalid("invalid_query", biZodIssues(parsed.error)) };
    const dataset = biDataset(parsed.data.dataset);
    if (!dataset)
      return {
        error: invalid("invalid_query", [
          { path: "dataset", message: `unknown dataset '${parsed.data.dataset}'` },
        ]),
      };
    if (hidden.has(dataset.id))
      return { error: err("module_forbidden", `You don't have access to the ${dataset.module} module`) };
    const issues = checkBiQuery(parsed.data, dataset);
    return issues.length ? { error: invalid("invalid_query", issues) } : { spec: parsed.data };
  }

  app.get(`${ws}/bi/datasets`, (c) =>
    c.json({
      catalogueVersion: 2,
      datasets: visible().map((d) => ({
        id: d.id,
        label: d.label,
        description: d.description,
        grain: d.grain,
        module: d.module,
        defaultDate: d.defaultDate,
        currency: d.currencyDimension ? { dimension: d.currencyDimension } : "workspace",
        dimensions: d.dimensions.map((dim) => ({
          id: dim.id,
          label: dim.label,
          type: dim.type,
          ...(dim.values ? { values: dim.values } : {}),
        })),
        measures: d.measures.map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description,
          aggregate: m.agg,
          unit: m.unit,
          ...(m.splitBy ? { splitBy: m.splitBy } : {}),
        })),
      })),
    }),
  );

  app.get(`${ws}/bi/query`, (c) => {
    let input: unknown;
    try {
      input = JSON.parse(c.req.query("spec") ?? "");
    } catch {
      return c.json(err("invalid_query", "spec: not valid JSON"), 400);
    }
    const checked = check(input);
    if ("error" in checked)
      return c.json(checked.error, checked.error.error.code === "module_forbidden" ? 403 : 400);
    queries.push(checked.spec);
    return c.json(run(checked.spec));
  });

  const view = (d: Record<string, any>) => ({ ...d });
  const catalogue = () => visible();

  app.get(`${ws}/bi/dashboards`, (c) => {
    const scope = c.req.query("scope");
    const status = c.req.query("status");
    return c.json({
      dashboards: dashboards
        .filter((d) => !d.archivedAt)
        .filter((d) => !scope || d.scope === scope)
        .filter((d) => !status || d.status === status)
        .map(view),
    });
  });

  app.post(`${ws}/bi/dashboards`, async (c) => {
    const parsed = biDashboardCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(invalid("invalid_dashboard", biZodIssues(parsed.error)), 400);
    const issues = checkBiDashboard(parsed.data.spec, catalogue()).map((i) => ({
      ...i,
      path: `spec.${i.path}`,
    }));
    if (issues.length) return c.json(invalid("invalid_dashboard", issues), 400);
    const row = {
      id: newId(),
      scope: parsed.data.scope,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      spec: parsed.data.spec,
      status: "draft",
      audience: "workspace",
      audienceUserIds: [],
      version: 1,
      ownerId: "me",
      archivedAt: null,
    };
    dashboards.push(row);
    return c.json(view(row), 201);
  });

  const find = (id: string) => dashboards.find((d) => d.id === id);

  app.get(`${ws}/bi/dashboards/:id`, (c) => {
    const d = find(c.req.param("id"));
    return d
      ? c.json({ ...view(d), canEdit: d.status === "draft" })
      : c.json(err("not_found", "Dashboard not found"), 404);
  });

  app.patch(`${ws}/bi/dashboards/:id`, async (c) => {
    const d = find(c.req.param("id"));
    if (!d) return c.json(err("not_found", "Dashboard not found"), 404);
    const parsed = biDashboardUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(invalid("invalid_dashboard", biZodIssues(parsed.error)), 400);
    const patch = parsed.data;
    // As the server: a token (every MCP call) never changes a published dashboard.
    if (d.status === "published") {
      return c.json(
        err(
          "token_not_allowed",
          "API tokens can't change a published dashboard. Take it back to draft first, or duplicate it.",
        ),
        403,
      );
    }
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== d.version) {
      return c.json(
        err("dashboard_conflict", `The dashboard changed (version ${d.version}); reload it and try again`),
        409,
      );
    }
    if (patch.spec) {
      const issues = checkBiDashboard(patch.spec, catalogue()).map((i) => ({ ...i, path: `spec.${i.path}` }));
      if (issues.length) return c.json(invalid("invalid_dashboard", issues), 400);
      d.spec = patch.spec;
    }
    if (patch.title !== undefined) d.title = patch.title;
    if (patch.description !== undefined) d.description = patch.description;
    d.version += 1;
    return c.json(view(d));
  });

  app.get(`${ws}/bi/dashboards/:id/data`, (c) => {
    const d = find(c.req.param("id"));
    if (!d) return c.json(err("not_found", "Dashboard not found"), 404);
    const spec = biDashboardSpecSchema.parse(d.spec);
    let params: unknown = {};
    try {
      params = JSON.parse(c.req.query("params") ?? "{}");
    } catch {
      return c.json(err("invalid_query", "params: not valid JSON"), 400);
    }
    const viewParsed = biDashboardViewParamsSchema.safeParse(params);
    if (!viewParsed.success) return c.json(invalid("invalid_dashboard", biZodIssues(viewParsed.error)), 400);
    views.push(viewParsed.data);
    return c.json({
      dashboardId: d.id,
      version: d.version,
      widgets: biDataWidgets(spec).map(({ widget }) => {
        const query = biWidgetQuery(widget, spec, viewParsed.data);
        if (hidden.has(query.dataset))
          return { widgetId: widget.id, status: "no_access", message: "You don't have access to this data" };
        return { widgetId: widget.id, status: "ok", result: run(query) };
      }),
    });
  });

  // ── Analyses: sources are canned answers by path; verification uses the core functions. ──
  const sources: Record<string, unknown> = {};
  const analyses: Record<string, any>[] = [];
  app.get(`${ws}/bi/sources`, (c) => {
    const path = c.req.query("path") ?? "";
    if (!(path in sources)) return c.json(err("invalid_source", `${path}: no such workspace route`), 400);
    return c.json({
      path,
      query: JSON.parse(c.req.query("query") ?? "{}"),
      module: "purchasing",
      answer: sources[path],
    });
  });
  app.post(`${ws}/bi/analyses`, async (c) => {
    const parsed = biAnalysisCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(invalid("invalid_analysis", biZodIssues(parsed.error)), 400);
    const data = parsed.data;
    const issues: BiIssue[] = checkBiAnalysis(data);
    data.sources.forEach((src, i) => {
      if (!(src.path in sources))
        issues.push({ path: `sources[${i}]`, message: `${src.path}: no such workspace route` });
    });
    if (issues.length) return c.json(invalid("invalid_analysis", issues), 400);
    const answers = new Map(data.sources.map((src) => [src.id, sources[src.path]]));
    const figures = data.figures.map((figure, f) => {
      const values: Record<
        string,
        { value: number | null; formula: string; inputs: Record<string, unknown> }
      > = {};
      for (const scenario of data.scenarios) {
        const spec = figure.values[scenario.id]!;
        const at = `figures[${f}].values.${scenario.id}`;
        const inputs: Record<string, number | number[]> = {};
        let ok = true;
        for (const [name, cite] of Object.entries(spec.inputs)) {
          const found = resolveBiPath(answers.get(cite.source), cite.path);
          if ("error" in found) {
            issues.push({ path: `${at}.inputs.${name}`, message: found.error });
            ok = false;
          } else inputs[name] = found.value;
        }
        // As the server: a formula whose inputs failed isn't worked out.
        if (!ok) {
          values[scenario.id] = { value: null, formula: spec.formula, inputs: spec.inputs };
          continue;
        }
        const tree = parseBiFormula(spec.formula);
        const result = typeof tree === "string" ? { error: tree } : evaluateBiFormula(tree, inputs);
        const value = "error" in result ? null : result.value;
        if ("error" in result) issues.push({ path: `${at}.formula`, message: result.error });
        else if (spec.expected !== undefined && !biExpectedMatches(spec.expected, value))
          issues.push({
            path: `${at}.expected`,
            message: `you expected ${spec.expected}, the cited values give ${value}`,
          });
        values[scenario.id] = { value, formula: spec.formula, inputs: spec.inputs };
      }
      return { id: figure.id, label: figure.label, unit: figure.unit ?? null, description: null, values };
    });
    if (issues.length) return c.json(invalid("invalid_analysis", issues), 400);
    const analysis = {
      title: data.title,
      question: data.question,
      summary: data.summary ?? null,
      scenarios: data.scenarios,
      sources: data.sources,
      figures,
      modules: ["purchasing"],
      verifiedAt: "2026-11-18T12:00:00.000Z",
    };
    const row = {
      id: newId(),
      kind: "analysis",
      title: data.title,
      asAt: "2026-11-18",
      takenBy: "me",
      analysis,
    };
    analyses.push(row);
    return c.json({ id: row.id, kind: "analysis", title: row.title, asAt: row.asAt, analysis }, 201);
  });
  app.get(`${ws}/bi/snapshots`, (c) =>
    c.json({
      snapshots: analyses.map(({ id, kind, title, asAt, takenBy }) => ({ id, kind, title, asAt, takenBy })),
    }),
  );
  app.get(`${ws}/bi/snapshots/:id`, (c) => {
    const row = analyses.find((a) => a.id === c.req.param("id"));
    if (!row) return c.json(err("not_found", "Snapshot not found"), 404);
    return c.json({
      id: row.id,
      kind: "analysis",
      results: { analysis: { ...row.analysis, hidden: false } },
    });
  });

  return {
    sources,
    analyses,
    dashboards,
    queries,
    views,
    hidden,
    /** A person publishes in the app. */
    publish(id: string) {
      const d = find(id);
      if (d) d.status = "published";
    },
  };
}
