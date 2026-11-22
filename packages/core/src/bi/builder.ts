import type { BiDataset, BiDimension } from "./catalogue";
import {
  biDataWidgetTypes,
  checkBiDashboard,
  type BiDashboardSpec,
  type BiDataWidget,
  type BiWidget,
  type BiWidgetType,
} from "./dashboard";
import type { BiIssue, BiQuerySpec } from "./query";

/**
 * Pure spec edits for the dashboard builder. Each returns a new spec and
 * never mutates its input, so a client can keep an undo stack of plain values. The server still
 * validates every save (`checkBiDashboard`); these helpers only keep the builder's drafts tidy.
 */

/** Every section, widget and filter parameter id in a spec (they share one namespace). */
export function biSpecIds(spec: BiDashboardSpec): Set<string> {
  return new Set([
    ...spec.sections.flatMap((s) => [s.id, ...s.widgets.map((w) => w.id)]),
    ...spec.params.filters.map((f) => f.id),
  ]);
}

/** `base`, or `base-2`, `base-3`… : the first id the spec doesn't use yet (at most 40 characters). */
export function biUniqueId(spec: BiDashboardSpec, base: string): string {
  const ids = biSpecIds(spec);
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34) || "widget";
  if (!ids.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const id = `${clean}-${n}`;
    if (!ids.has(id)) return id;
  }
}

/** A spec with nothing in it yet: one untitled section. */
export const biEmptySpec = (): BiDashboardSpec => ({
  params: { filters: [] },
  sections: [{ id: "main", title: "", widgets: [] }],
});

/** Groupings each widget type draws: [min, max] (mirrors the shape rules in `checkBiDashboard`). */
export const BI_WIDGET_GROUPINGS: Record<Exclude<BiWidgetType, "text">, readonly [number, number]> = {
  kpi: [0, 0],
  line: [1, 2],
  bar: [1, 2],
  stacked_bar: [2, 2],
  donut: [1, 1],
  table: [0, 3],
  pivot: [2, 2],
};

/** Types that show a single measure. */
const ONE_MEASURE = new Set<BiWidgetType>(["donut", "pivot"]);

/** A category or reference dimension that isn't the money's currency: a sensible thing to group by. */
const groupable = (dataset: BiDataset) =>
  dataset.dimensions.filter(
    (d) => (d.type === "category" || d.type === "reference") && d.id !== dataset.currencyDimension,
  );

/** The next grouping to add for a widget: the default date by month on charts over time, else a category. */
function nextGrouping(
  dataset: BiDataset,
  taken: readonly string[],
  preferDate: boolean,
): BiQuerySpec["groupBy"][number] | undefined {
  const date = dataset.dimensions.find((d) => d.id === dataset.defaultDate);
  if (preferDate && date && !taken.includes(date.id)) return { dim: date.id, grain: "month" };
  const dim: BiDimension | undefined = groupable(dataset).find((d) => !taken.includes(d.id));
  if (dim) return { dim: dim.id };
  if (date && !taken.includes(date.id)) return { dim: date.id, grain: "month" };
  return undefined;
}

/**
 * The query a new widget starts with: the dataset's first count measure (counts need no currency
 * or unit split, so the draft is valid at once) and the groupings its type needs.
 */
export function biDefaultQuery(type: Exclude<BiWidgetType, "text">, dataset: BiDataset): BiQuerySpec {
  const measure = defaultMeasure(dataset);
  return biFitQuery(
    type,
    {
      dataset: dataset.id,
      measures: [measure.id],
      groupBy: [],
      filters: [],
      sort: [],
      // A certified metric over a period needs one; the dashboard's period still applies.
      ...(measure.certified?.kind === "period" ? { period: { preset: "last_12_months" as const } } : {}),
    },
    dataset,
  );
}

/** A count (needs no currency or unit split), or on the certified metrics the first over a period. */
const defaultMeasure = (dataset: BiDataset) =>
  (dataset.virtual
    ? dataset.measures.find((m) => m.certified?.kind === "period")
    : dataset.measures.find((m) => m.unit === "count")) ?? dataset.measures[0]!;

/**
 * Adjusts a query to what a widget type can draw: drops or adds groupings to fit its shape, keeps
 * one measure for donuts and pivots, and removes sorts on fields that are gone. Everything else
 * (filters, period, comparison) is kept.
 */
export function biFitQuery(
  type: Exclude<BiWidgetType, "text">,
  query: BiQuerySpec,
  dataset: BiDataset,
): BiQuerySpec {
  const [min, max] = BI_WIDGET_GROUPINGS[type];
  let groupBy = query.groupBy.slice(0, max);
  const overTime = type === "line" || type === "stacked_bar" || type === "pivot";
  while (groupBy.length < min) {
    // A line runs along time first; a stacked bar and a pivot take time for x and a category after.
    const next = nextGrouping(
      dataset,
      groupBy.map((g) => g.dim),
      overTime && !groupBy.some((g) => dataset.dimensions.find((d) => d.id === g.dim)?.type === "date"),
    );
    if (!next) break;
    groupBy = [...groupBy, next];
  }
  const measures = ONE_MEASURE.has(type) ? query.measures.slice(0, 1) : query.measures;
  const fields = new Set([
    ...measures,
    ...groupBy.map((g) => g.dim),
    ...(query.compare ? measures.map((m) => `${m}__compare`) : []),
  ]);
  return { ...query, measures, groupBy, sort: query.sort.filter((s) => fields.has(s.by)) };
}

/** A new widget of a type over a dataset (a text widget when `type` is `text`). */
export function biNewWidget(
  spec: BiDashboardSpec,
  type: BiWidgetType,
  dataset: BiDataset | undefined,
): BiWidget {
  if (type === "text" || !dataset) {
    return { id: biUniqueId(spec, "note"), type: "text", title: "", text: "" };
  }
  const measure = defaultMeasure(dataset);
  return {
    id: biUniqueId(spec, `${dataset.id}-${type}`),
    type,
    title: measure.label,
    query: biDefaultQuery(type, dataset),
  } as BiDataWidget;
}

/**
 * The same widget as another type. Data widgets keep their query, fitted to the new shape (and
 * display options that no longer name a grouped dimension are dropped). Text and data widgets
 * don't convert into each other: the caller makes a new one.
 */
export function biChangeWidgetType(
  widget: BiDataWidget,
  type: Exclude<BiWidgetType, "text">,
  dataset: BiDataset,
): BiDataWidget {
  const fitted = biFitDisplay({
    ...widget,
    type,
    query: biFitQuery(type, widget.query, dataset),
  } as BiDataWidget);
  if (type === "kpi" || !fitted.display?.goodDirection) return fitted;
  const { goodDirection: _drop, ...display } = fitted.display;
  return { ...fitted, display: Object.keys(display).length ? display : undefined } as BiDataWidget;
}

/**
 * Drops display options that no longer name a grouped dimension (`x`, `series`): after the
 * grouping or dataset changes they would make the widget invalid, and a single grouping hides
 * the control that sets them. Returns the widget itself when nothing changes.
 */
export function biFitDisplay<W extends BiWidget>(widget: W): W {
  if (widget.type === "text" || !widget.display) return widget;
  const grouped = widget.query.groupBy.map((g) => g.dim);
  const stale = (k: "x" | "series") =>
    widget.display![k] !== undefined && !grouped.includes(widget.display![k]!);
  if (!stale("x") && !stale("series")) return widget;
  const display = { ...widget.display };
  if (stale("x")) delete display.x;
  if (stale("series")) delete display.series;
  return { ...widget, display: Object.keys(display).length ? display : undefined };
}

export const isBiDataWidgetType = (t: string): t is Exclude<BiWidgetType, "text"> =>
  (biDataWidgetTypes as string[]).includes(t);

const mapSections = (
  spec: BiDashboardSpec,
  fn: (s: BiDashboardSpec["sections"][number]) => BiDashboardSpec["sections"][number],
): BiDashboardSpec => ({ ...spec, sections: spec.sections.map(fn) });

/** Adds a widget at the end of a section (the first section if the id is unknown). */
export function biAddWidget(spec: BiDashboardSpec, sectionId: string, widget: BiWidget): BiDashboardSpec {
  const target = spec.sections.some((s) => s.id === sectionId) ? sectionId : spec.sections[0]?.id;
  return mapSections(spec, (s) => (s.id === target ? { ...s, widgets: [...s.widgets, widget] } : s));
}

/** Replaces the widget with the same id. */
export const biReplaceWidget = (spec: BiDashboardSpec, widget: BiWidget): BiDashboardSpec =>
  mapSections(spec, (s) => ({ ...s, widgets: s.widgets.map((w) => (w.id === widget.id ? widget : w)) }));

export const biRemoveWidget = (spec: BiDashboardSpec, widgetId: string): BiDashboardSpec =>
  mapSections(spec, (s) => ({ ...s, widgets: s.widgets.filter((w) => w.id !== widgetId) }));

/** Where a widget is: its section id and index, or undefined. */
export function biFindWidget(
  spec: BiDashboardSpec,
  widgetId: string,
): { sectionId: string; index: number; widget: BiWidget } | undefined {
  for (const section of spec.sections) {
    const index = section.widgets.findIndex((w) => w.id === widgetId);
    if (index >= 0) return { sectionId: section.id, index, widget: section.widgets[index]! };
  }
  return undefined;
}

/**
 * Moves a widget to `index` within a section (its own or another). `index` counts positions in the
 * target section as it is before the move, so dropping onto a widget puts the moved one in its place.
 */
export function biMoveWidget(
  spec: BiDashboardSpec,
  widgetId: string,
  sectionId: string,
  index: number,
): BiDashboardSpec {
  const from = biFindWidget(spec, widgetId);
  if (!from || !spec.sections.some((s) => s.id === sectionId)) return spec;
  const without = biRemoveWidget(spec, widgetId);
  return mapSections(without, (s) => {
    if (s.id !== sectionId) return s;
    const at = Math.max(0, Math.min(index, s.widgets.length));
    return { ...s, widgets: [...s.widgets.slice(0, at), from.widget, ...s.widgets.slice(at)] };
  });
}

export function biAddSection(spec: BiDashboardSpec, title = ""): BiDashboardSpec {
  return {
    ...spec,
    sections: [...spec.sections, { id: biUniqueId(spec, title || "section"), title, widgets: [] }],
  };
}

/** Removes a section; its widgets move to the section before it (or after, for the first). Keeps at least one. */
export function biRemoveSection(spec: BiDashboardSpec, sectionId: string): BiDashboardSpec {
  const i = spec.sections.findIndex((s) => s.id === sectionId);
  if (i < 0 || spec.sections.length === 1) return spec;
  const heir = spec.sections[i === 0 ? 1 : i - 1]!;
  const moved = spec.sections[i]!.widgets;
  return {
    ...spec,
    sections: spec.sections
      .filter((s) => s.id !== sectionId)
      .map((s) =>
        s.id === heir.id
          ? { ...s, widgets: i === 0 ? [...moved, ...s.widgets] : [...s.widgets, ...moved] }
          : s,
      ),
  };
}

export function biMoveSection(spec: BiDashboardSpec, sectionId: string, delta: -1 | 1): BiDashboardSpec {
  const i = spec.sections.findIndex((s) => s.id === sectionId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= spec.sections.length) return spec;
  const sections = [...spec.sections];
  [sections[i], sections[j]] = [sections[j]!, sections[i]!];
  return { ...spec, sections };
}

export const biRenameSection = (spec: BiDashboardSpec, sectionId: string, title: string): BiDashboardSpec =>
  mapSections(spec, (s) => (s.id === sectionId ? { ...s, title } : s));

/**
 * The catalogue a viewer may build from: the core datasets cut to the ids, dimensions and measures
 * their `/bi/datasets` answer lists (that answer already applies module, join and column rules).
 */
export function biRestrictCatalogue(
  datasets: readonly BiDataset[],
  visible: ReadonlyArray<{
    id: string;
    dimensions: ReadonlyArray<{ id: string }>;
    measures: ReadonlyArray<{ id: string }>;
  }>,
): BiDataset[] {
  const byId = new Map(visible.map((v) => [v.id, v]));
  return datasets.flatMap((d) => {
    const v = byId.get(d.id);
    if (!v) return [];
    const dims = new Set(v.dimensions.map((x) => x.id));
    const measures = new Set(v.measures.map((x) => x.id));
    return [
      {
        ...d,
        dimensions: d.dimensions.filter((x) => dims.has(x.id)),
        measures: d.measures.filter((x) => measures.has(x.id)),
      },
    ];
  });
}

/**
 * Issues from `checkBiDashboard` (or a refused save, with or without the `spec.` prefix) grouped by
 * the widget they belong to; everything else (sections, parameters) under `""`.
 */
export function biIssuesByWidget(spec: BiDashboardSpec, issues: readonly BiIssue[]): Map<string, BiIssue[]> {
  const out = new Map<string, BiIssue[]>();
  for (const issue of issues) {
    const path = issue.path.replace(/^spec\./, "");
    const m = /^sections\[(\d+)\]\.widgets\[(\d+)\](?:\.(.*))?$/.exec(path);
    const widget = m ? spec.sections[Number(m[1])]?.widgets[Number(m[2])] : undefined;
    const key = widget?.id ?? "";
    const list = out.get(key) ?? [];
    list.push(widget ? { ...issue, path: m![3] ?? "" } : { ...issue, path });
    out.set(key, list);
  }
  return out;
}

/**
 * A spec cut to what a catalogue allows: data widgets that would be refused (a dataset or field the
 * person can't read) are left out, then sections left empty by that, keeping at least one. Used to offer a
 * shipped template to someone who reads only part of its data. Dashboard filters on fields no
 * remaining dataset has are dropped too.
 */
export function biFitSpecToCatalogue(
  spec: BiDashboardSpec,
  catalogue: readonly BiDataset[],
): BiDashboardSpec {
  const datasets = new Map(catalogue.map((d) => [d.id, d]));
  const fits = (w: BiWidget) => {
    if (w.type === "text") return true;
    const dataset = datasets.get(w.query.dataset);
    if (!dataset) return false;
    const one: BiDashboardSpec = {
      params: { ...spec.params, filters: [] },
      sections: [{ id: "s", title: "", widgets: [w] }],
    };
    return checkBiDashboard(one, catalogue).length === 0;
  };
  // Sections that lose every widget go; sections that only ever held text stay.
  const sections = spec.sections
    .map((s) => ({ before: s.widgets.length, section: { ...s, widgets: s.widgets.filter(fits) } }))
    .filter(({ before, section }) => before === 0 || section.widgets.length > 0)
    .map(({ section }) => section);
  const kept = sections.length ? sections : [{ ...spec.sections[0]!, widgets: [] }];
  const dims = new Set(
    kept.flatMap((s) =>
      s.widgets.flatMap((w) =>
        w.type === "text" ? [] : datasets.get(w.query.dataset)!.dimensions.map((d) => d.id),
      ),
    ),
  );
  return {
    params: { ...spec.params, filters: spec.params.filters.filter((f) => dims.has(f.dim)) },
    sections: kept,
  };
}

/** How many data widgets a spec has. */
export const biDataWidgetCount = (spec: BiDashboardSpec) =>
  spec.sections.reduce((n, s) => n + s.widgets.filter((w) => w.type !== "text").length, 0);
