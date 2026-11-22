import { z } from "zod";
import { isModuleId, type ModuleId } from "../modules";
import { biDataset, type BiDataset } from "./catalogue";
import {
  biFilterSchema,
  biPeriodSchema,
  biQuerySpecSchema,
  checkBiQuery,
  nearest,
  type BiFilter,
  type BiIssue,
  type BiPeriod,
  type BiQuerySpec,
} from "./query";

/**
 * Dashboards: a validated JSON spec of sections and widgets. Every data widget carries a query
 * spec the server runs as the viewer; a widget never holds figures of its own. Text widgets hold
 * commentary and cannot supply chart values. See the Dashboards section in docs/modules.md.
 */

export const biWidgetTypes = [
  "kpi",
  "line",
  "bar",
  "stacked_bar",
  "donut",
  "table",
  "pivot",
  "text",
] as const;
export type BiWidgetType = (typeof biWidgetTypes)[number];
export const biDataWidgetTypes = biWidgetTypes.filter((t) => t !== "text") as Exclude<BiWidgetType, "text">[];

export const biDashboardStatuses = ["draft", "published"] as const;
export type BiDashboardStatus = (typeof biDashboardStatuses)[number];

/** Who may open a published dashboard: everyone who can read dashboards, or named members. */
export const biAudiences = ["workspace", "members"] as const;
export type BiAudience = (typeof biAudiences)[number];

/** Limits enforced on every save, so one dashboard can't turn into a heavy page. */
export const BI_LIMITS = {
  sections: 12,
  widgets: 40,
  /** Rows a widget's query may ask for. */
  widgetRows: 1000,
  textLength: 4000,
  params: 6,
} as const;

const widgetId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "Use 1-40 letters, digits, - or _");
const title = z.string().trim().max(120);

/** Display options; all optional, so the viewer picks sensible defaults. */
export const biWidgetDisplaySchema = z
  .object({
    /** Which grouped dimension runs along the x axis (line, bar) or the rows (pivot). */
    x: z.string().max(64).optional(),
    /** Which grouped dimension becomes series (stacked bars, multi-line) or the pivot columns. */
    series: z.string().max(64).optional(),
    /** KPI: whether up is good (green delta) or bad (a complaint count). */
    goodDirection: z.enum(["up", "down"]).optional(),
    /** Grid width out of 12 columns. */
    width: z.number().int().min(3).max(12).optional(),
  })
  .strict();
export type BiWidgetDisplay = z.infer<typeof biWidgetDisplaySchema>;

export const biDataWidgetSchema = z.object({
  id: widgetId,
  type: z.enum(biDataWidgetTypes as [Exclude<BiWidgetType, "text">, ...Exclude<BiWidgetType, "text">[]]),
  title,
  description: z.string().trim().max(500).optional(),
  query: biQuerySpecSchema,
  /** Keep the widget's own period even when the dashboard's period parameter changes. */
  pinPeriod: z.boolean().optional(),
  display: biWidgetDisplaySchema.optional(),
});

export const biTextWidgetSchema = z.object({
  id: widgetId,
  type: z.literal("text"),
  title: title.optional(),
  /** Commentary. Plain text with line breaks; it is labelled as commentary and holds no figures of record. */
  text: z.string().max(BI_LIMITS.textLength),
  display: biWidgetDisplaySchema.optional(),
});

export const biWidgetSchema = z.discriminatedUnion("type", [
  biTextWidgetSchema,
  biDataWidgetSchema.extend({ type: z.literal("kpi") }),
  biDataWidgetSchema.extend({ type: z.literal("line") }),
  biDataWidgetSchema.extend({ type: z.literal("bar") }),
  biDataWidgetSchema.extend({ type: z.literal("stacked_bar") }),
  biDataWidgetSchema.extend({ type: z.literal("donut") }),
  biDataWidgetSchema.extend({ type: z.literal("table") }),
  biDataWidgetSchema.extend({ type: z.literal("pivot") }),
]);
export type BiWidget = z.infer<typeof biWidgetSchema>;
export type BiDataWidget = Exclude<BiWidget, { type: "text" }>;

/**
 * A dashboard filter the viewer sets once for every widget that has the dimension (a site, a
 * supplier, a product group). Widgets whose dataset lacks `dim` ignore it.
 */
export const biDashboardFilterParamSchema = z.object({
  id: widgetId,
  label: z.string().trim().min(1).max(60),
  dim: z.string().trim().min(1).max(64),
});
export type BiDashboardFilterParam = z.infer<typeof biDashboardFilterParamSchema>;

export const biDashboardSpecSchema = z.object({
  params: z
    .object({
      /** The dashboard period: applied to every data widget that doesn't pin its own. */
      period: biPeriodSchema.optional(),
      filters: z.array(biDashboardFilterParamSchema).max(BI_LIMITS.params).default([]),
    })
    .default({ filters: [] }),
  sections: z
    .array(
      z.object({
        id: widgetId,
        title: z.string().trim().max(120).default(""),
        widgets: z.array(biWidgetSchema).max(BI_LIMITS.widgets),
      }),
    )
    .min(1)
    .max(BI_LIMITS.sections),
});
export type BiDashboardSpec = z.infer<typeof biDashboardSpecSchema>;
export type BiDashboardSpecInput = z.input<typeof biDashboardSpecSchema>;

/** `workspace` or `module:<id>`: a module's dashboards show on that module's pages. */
export const biDashboardScopeSchema = z
  .string()
  .refine((s) => s === "workspace" || (s.startsWith("module:") && isModuleId(s.slice(7))), {
    message: "Use workspace or module:<module id>",
  });
export const biScopeModule = (scope: string): ModuleId | null =>
  scope.startsWith("module:") && isModuleId(scope.slice(7)) ? (scope.slice(7) as ModuleId) : null;

export const biDashboardCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  scope: biDashboardScopeSchema.default("workspace"),
  spec: biDashboardSpecSchema,
});
export type BiDashboardCreateInput = z.input<typeof biDashboardCreateSchema>;

export const biDashboardUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    scope: biDashboardScopeSchema.optional(),
    spec: biDashboardSpecSchema.optional(),
    /** Offer it as a starting point under "New dashboard" ("save as template"). */
    template: z.boolean().optional(),
    /** Optimistic concurrency: the version the client last saw. A newer one refuses the save (409). */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (p) =>
      p.title !== undefined ||
      p.description !== undefined ||
      p.scope !== undefined ||
      p.spec !== undefined ||
      p.template !== undefined,
    {
      message: "Nothing to update",
    },
  );
export type BiDashboardUpdateInput = z.input<typeof biDashboardUpdateSchema>;

export const biDashboardPublishSchema = z
  .object({
    audience: z.enum(biAudiences).default("workspace"),
    /** For `members`: who may open it (they still need dashboard access and the data's modules). */
    memberIds: z.array(z.string().uuid()).max(200).default([]),
    /** The version the publisher reviewed; a newer one (the owner kept editing) refuses the publish. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine((p) => p.audience !== "members" || p.memberIds.length > 0, {
    message: "Name at least one member",
    path: ["memberIds"],
  });
export type BiDashboardPublishInput = z.input<typeof biDashboardPublishSchema>;

/** View-time parameters: the period and filter values a viewer picked (`?params=` on the data route). */
export const biDashboardViewParamsSchema = z.object({
  period: biPeriodSchema.optional(),
  /** Filter param id → value(s). */
  filters: z
    .record(z.string(), z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]))
    .default({}),
});
export type BiDashboardViewParams = z.infer<typeof biDashboardViewParamsSchema>;

/** Every data widget of a spec, with its path. */
export function biDataWidgets(spec: BiDashboardSpec): Array<{ widget: BiDataWidget; path: string }> {
  return spec.sections.flatMap((section, s) =>
    section.widgets.flatMap((widget, w) =>
      widget.type === "text"
        ? []
        : [{ widget: widget as BiDataWidget, path: `sections[${s}].widgets[${w}]` }],
    ),
  );
}

/**
 * The query a widget runs, with the dashboard's parameters applied: the period (unless the widget
 * pins its own) and each filter parameter whose dimension the widget's dataset has.
 */
export function biWidgetQuery(
  widget: BiDataWidget,
  spec: BiDashboardSpec,
  view: BiDashboardViewParams = { filters: {} },
): BiQuerySpec {
  const dataset = biDataset(widget.query.dataset);
  const query: BiQuerySpec = { ...widget.query, filters: [...widget.query.filters] };
  const period: BiPeriod | undefined = view.period ?? spec.params.period;
  if (period && !widget.pinPeriod && dataset) {
    // The widget's own date dimension stays; the dashboard decides the range.
    query.period = { ...period, dim: widget.query.period?.dim ?? period.dim ?? undefined };
    if (
      query.period.dim &&
      !dataset.dimensions.some((d) => d.id === query.period!.dim && d.type === "date")
    ) {
      query.period.dim = undefined;
    }
    if (query.compare && !(query.period.preset || (query.period.from && query.period.to)))
      delete query.compare;
  }
  for (const param of spec.params.filters) {
    const value = view.filters[param.id];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    if (!dataset?.dimensions.some((d) => d.id === param.dim)) continue;
    const filter: BiFilter = Array.isArray(value)
      ? { dim: param.dim, op: "in", value }
      : { dim: param.dim, op: "eq", value };
    query.filters = [...query.filters.filter((f) => f.dim !== param.dim), filter];
  }
  return query;
}

const prefix = (path: string, issues: BiIssue[]) => issues.map((i) => ({ ...i, path: `${path}.${i.path}` }));

/**
 * Checks a structurally valid dashboard spec against a catalogue (normally the author's visible
 * one): unique ids, every widget's query, limits, and the parameters. Issues carry full paths
 * (`sections[0].widgets[2].query.groupBy[0].dim`).
 */
export function checkBiDashboard(spec: BiDashboardSpec, catalogue: readonly BiDataset[]): BiIssue[] {
  const issues: BiIssue[] = [];
  const datasets = new Map(catalogue.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let widgetCount = 0;
  spec.sections.forEach((section, s) => {
    if (seen.has(section.id))
      issues.push({ path: `sections[${s}].id`, message: `id '${section.id}' is used twice` });
    seen.add(section.id);
    section.widgets.forEach((widget, w) => {
      widgetCount++;
      const path = `sections[${s}].widgets[${w}]`;
      if (seen.has(widget.id))
        issues.push({ path: `${path}.id`, message: `id '${widget.id}' is used twice` });
      seen.add(widget.id);
    });
  });
  if (widgetCount > BI_LIMITS.widgets) {
    issues.push({
      path: "sections",
      message: `at most ${BI_LIMITS.widgets} widgets per dashboard (found ${widgetCount})`,
    });
  }
  const paramIds = new Set<string>();
  spec.params.filters.forEach((p, i) => {
    if (paramIds.has(p.id))
      issues.push({ path: `params.filters[${i}].id`, message: `id '${p.id}' is used twice` });
    paramIds.add(p.id);
    const known = [...new Set(catalogue.flatMap((d) => d.dimensions.map((dim) => dim.id)))];
    if (!known.includes(p.dim)) {
      const suggestion = nearest(p.dim, known);
      issues.push({
        path: `params.filters[${i}].dim`,
        message: `no dataset has a dimension '${p.dim}'${suggestion ? `; did you mean '${suggestion}'?` : ""}`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
  });

  for (const { widget, path } of biDataWidgets(spec)) {
    const dataset = datasets.get(widget.query.dataset);
    if (!dataset) {
      const suggestion = nearest(widget.query.dataset, [...datasets.keys()]);
      issues.push({
        path: `${path}.query.dataset`,
        message: `unknown dataset '${widget.query.dataset}'${suggestion ? `; did you mean '${suggestion}'?` : ""} Valid: ${[...datasets.keys()].join(", ")}`,
        ...(suggestion ? { suggestion } : {}),
      });
      continue;
    }
    if ((widget.query.limit ?? 0) > BI_LIMITS.widgetRows) {
      issues.push({
        path: `${path}.query.limit`,
        message: `a widget may show at most ${BI_LIMITS.widgetRows} rows`,
      });
    }
    // Check the query as the viewer will run it: with the dashboard period unless the widget pins
    // its own (a comparison may rely on the dashboard's period).
    const runs = spec.params.period && !widget.pinPeriod ? biWidgetQuery(widget, spec) : widget.query;
    issues.push(...prefix(`${path}.query`, checkBiQuery(runs, dataset)));
    const grouped = widget.query.groupBy.map((g) => g.dim);
    for (const key of ["x", "series"] as const) {
      const dim = widget.display?.[key];
      if (dim && !grouped.includes(dim)) {
        issues.push({
          path: `${path}.display.${key}`,
          message: `'${dim}' is not grouped by this widget's query. Grouped: ${grouped.join(", ") || "nothing"}`,
        });
      }
    }
    // How many groupings each chart can draw without silently adding rows together.
    const groupings = widget.query.groupBy.length;
    const shape: Record<string, { min: number; max: number; why: string }> = {
      kpi: { min: 0, max: 0, why: "a KPI shows one number: remove the grouping or use another widget type" },
      line: {
        min: 1,
        max: 2,
        why: "a line chart takes one grouping for the x axis, and optionally one for the series",
      },
      bar: {
        min: 1,
        max: 2,
        why: "a bar chart takes one grouping for the x axis, and optionally one for the series",
      },
      stacked_bar: {
        min: 2,
        max: 2,
        why: "a stacked bar takes exactly two groupings: the x axis and the series",
      },
      donut: { min: 1, max: 1, why: "a donut takes exactly one grouping: its slices" },
      pivot: { min: 2, max: 2, why: "a pivot takes exactly two groupings: its rows and columns" },
    };
    const rule = shape[widget.type];
    if (rule && (groupings < rule.min || groupings > rule.max)) {
      issues.push({
        path: `${path}.query.groupBy`,
        message: rule.why,
        ...(groupings < rule.min ? { suggestion: dataset.defaultDate } : {}),
      });
    }
    if ((widget.type === "donut" || widget.type === "pivot") && widget.query.measures.length !== 1) {
      issues.push({ path: `${path}.query.measures`, message: `a ${widget.type} shows one measure` });
    }
    // A chart, KPI or pivot labels every value with one currency, so money from a dataset with its
    // own currencies must be filtered to one (tables show each row's currency).
    const currencyDim = dataset.currencyDimension;
    if (currencyDim && widget.type !== "table") {
      const money = widget.query.measures.some(
        (id) => dataset.measures.find((m) => m.id === id)?.unit === "money",
      );
      const pinned = widget.query.filters.some(
        (f) =>
          f.dim === currencyDim &&
          (f.op === "eq" || (f.op === "in" && Array.isArray(f.value) && f.value.length === 1)),
      );
      if (money && !pinned) {
        issues.push({
          path: `${path}.query.filters`,
          message: `filter '${currencyDim}' to one currency (op eq): a ${widget.type} shows one currency; use a table to list several`,
          suggestion: currencyDim,
        });
      }
    }
  }
  return issues;
}

/** Zod issues as BI issues with paths (`sections[0].widgets[1].query.measures`), under an optional root. */
export function biZodIssues(
  error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> },
  root = "",
): BiIssue[] {
  return error.issues.map((issue) => {
    const rel = issue.path
      .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
      .join("")
      .replace(/^\./, "");
    const path = root ? (rel ? `${root}${rel.startsWith("[") ? "" : "."}${rel}` : root) : rel || "spec";
    return { path, message: issue.message };
  });
}

// ─── Who may see and change a dashboard ─────────────────────────────────────

/** The fields of a stored dashboard that decide who may see it. */
export interface BiDashboardAccessFields {
  ownerId: string | null;
  scope: string;
  status: BiDashboardStatus;
  audience: BiAudience;
  audienceUserIds: readonly string[];
  archivedAt: Date | string | null;
}

export interface BiDashboardViewer {
  userId: string;
  role: "owner" | "admin" | "member" | "guest";
  modules: Partial<Record<ModuleId, "none" | "read" | "write" | "manage">>;
  /**
   * The request comes from an API token (an agent). Tokens build drafts: they never change what a
   * published dashboard's audience sees, except through the audited `bi.publish` routes.
   */
  viaToken?: boolean;
}

const levelRank = { none: 0, read: 1, write: 2, manage: 3 } as const;
const atLeast = (level: keyof typeof levelRank | undefined, needed: keyof typeof levelRank) =>
  levelRank[level ?? "none"] >= levelRank[needed];

/**
 * Whether a viewer may open a dashboard record (its data is still checked per widget):
 *  - they need `read` on dashboards, and on the module of a module dashboard;
 *  - owners and admins of the workspace, `manage` on dashboards and the dashboard's owner see it
 *    in any state; archived dashboards only those;
 *  - otherwise only published ones whose audience includes them.
 */
export function biCanViewDashboard(d: BiDashboardAccessFields, viewer: BiDashboardViewer): boolean {
  if (!atLeast(viewer.modules.bi, "read")) return false;
  const module = biScopeModule(d.scope);
  if (module && !atLeast(viewer.modules[module], "read")) return false;
  const privileged =
    viewer.role === "owner" ||
    viewer.role === "admin" ||
    atLeast(viewer.modules.bi, "manage") ||
    (d.ownerId !== null && d.ownerId === viewer.userId);
  if (privileged) return true;
  if (d.archivedAt || d.status !== "published") return false;
  return d.audience === "workspace" || d.audienceUserIds.includes(viewer.userId);
}

/**
 * Whether a viewer may read a dashboard's version history (earlier titles, specs and commentary):
 * only those who may see it in any state, so drafts never leak to the audience of a later version.
 * Needs only the owner and scope, so the sync log can decide it from a version row.
 */
export function biCanReadDashboardHistory(
  d: Pick<BiDashboardAccessFields, "ownerId" | "scope">,
  viewer: BiDashboardViewer,
): boolean {
  if (!atLeast(viewer.modules.bi, "read")) return false;
  const module = biScopeModule(d.scope);
  if (module && !atLeast(viewer.modules[module], "read")) return false;
  return (
    viewer.role === "owner" ||
    viewer.role === "admin" ||
    atLeast(viewer.modules.bi, "manage") ||
    (d.ownerId !== null && d.ownerId === viewer.userId)
  );
}

/**
 * Whether a viewer may change a dashboard: `manage` may change any; `write` only their own drafts
 * (a published dashboard is changed by a manager, or duplicated into a new draft).
 */
export function biCanEditDashboard(d: BiDashboardAccessFields, viewer: BiDashboardViewer): boolean {
  if (!biCanViewDashboard(d, viewer)) return false;
  // What an audience sees changes only through a person or the audited publishing routes.
  if (viewer.viaToken && d.status === "published") return false;
  if (atLeast(viewer.modules.bi, "manage")) return true;
  return (
    atLeast(viewer.modules.bi, "write") &&
    d.ownerId === viewer.userId &&
    d.status === "draft" &&
    !d.archivedAt
  );
}
