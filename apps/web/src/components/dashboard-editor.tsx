"use client";

import {
  biChangeWidgetType,
  biDefaultQuery,
  biFitDisplay,
  biFitQuery,
  biGrains,
  biNewWidget,
  biPeriodPresets,
  biWidgetTypes,
  BI_LIMITS,
  BI_WIDGET_GROUPINGS,
  isBiDataWidgetType,
  type BiDashboardSpec,
  type BiDataset,
  type BiDataWidget,
  type BiDimension,
  type BiFilter,
  type BiFilterOp,
  type BiIssue,
  type BiQuerySpec,
  type BiWidget,
  type BiWidgetType,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Textarea } from "@knotworking/ui/components/textarea";
import { cn } from "@knotworking/ui/lib/utils";
import {
  ChartColumn,
  ChartColumnStacked,
  ChartLine,
  ChartPie,
  Check,
  Copy,
  Gauge,
  Grid3x3,
  Plus,
  Table2,
  TextQuote,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { humanize } from "@/lib/bi-format";

/**
 * The dashboard builder's editing pieces: the widget form, filter and period
 * pickers and the read-only JSON view. They only offer fields from the catalogue they are given (the
 * viewer's own, cut by `biRestrictCatalogue`), so a person can't build a widget they couldn't read.
 * The server validates every save again.
 */

export const WIDGET_TYPE_META: Record<BiWidgetType, { label: string; icon: ReactNode }> = {
  kpi: { label: "KPI", icon: <Gauge /> },
  line: { label: "Line", icon: <ChartLine /> },
  bar: { label: "Bar", icon: <ChartColumn /> },
  stacked_bar: { label: "Stacked bar", icon: <ChartColumnStacked /> },
  donut: { label: "Donut", icon: <ChartPie /> },
  table: { label: "Table", icon: <Table2 /> },
  pivot: { label: "Pivot", icon: <Grid3x3 /> },
  text: { label: "Text", icon: <TextQuote /> },
};

export interface DimChoice {
  value: string;
  label: string;
}
/** Loads the values a dimension takes (for references and categories without a fixed list). */
export type LoadChoices = (dataset: string, dim: string) => Promise<DimChoice[]>;

const NONE = "__none";
const DASHBOARD = "__dashboard";
const WIDTHS = [3, 4, 6, 8, 12] as const;

const OPS_BY_TYPE: Record<BiDimension["type"], BiFilterOp[]> = {
  category: ["eq", "neq", "in", "not_in", "is_null", "not_null"],
  reference: ["eq", "neq", "in", "not_in", "is_null", "not_null"],
  boolean: ["eq", "is_null", "not_null"],
  date: ["eq", "gte", "lt", "between", "is_null", "not_null"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
};
const OP_LABELS: Record<BiFilterOp, string> = {
  eq: "is",
  neq: "is not",
  in: "is any of",
  not_in: "is none of",
  gt: "more than",
  gte: "from / at least",
  lt: "before / less than",
  lte: "at most",
  between: "between",
  is_null: "is empty",
  not_null: "is set",
};

/** The form for one widget. Every change goes straight to `onChange`, so the preview follows it. */
export function WidgetEditor({
  widget,
  spec,
  catalogue,
  onChange: emit,
  issues = [],
  loadChoices,
}: {
  widget: BiWidget;
  /** The dashboard, for its period (shown as the default) and to keep ids unique. */
  spec: BiDashboardSpec;
  catalogue: readonly BiDataset[];
  onChange: (widget: BiWidget) => void;
  /** Problems with this widget, paths relative to it (`query.measures[0]`). */
  issues?: readonly BiIssue[];
  loadChoices?: LoadChoices;
}) {
  const id = useId();
  const dataset = widget.type === "text" ? undefined : catalogue.find((d) => d.id === widget.query.dataset);
  // Every edit leaves the display options valid: an axis or series that is no longer grouped goes.
  const onChange = (next: BiWidget) => emit(biFitDisplay(next));

  function changeType(type: BiWidgetType) {
    if (type === widget.type) return;
    if (type === "text") {
      onChange({ id: widget.id, type: "text", title: widget.title ?? "", text: "", display: widget.display });
    } else if (widget.type === "text" || !dataset) {
      const fresh = biNewWidget(spec, type, dataset ?? catalogue[0]);
      onChange({ ...fresh, id: widget.id, ...(widget.title ? { title: widget.title } : {}) } as BiWidget);
    } else {
      onChange(biChangeWidgetType(widget, type, dataset));
    }
  }

  return (
    <FieldGroup className="gap-5">
      {issues.length > 0 && <IssueList issues={issues} />}
      <Field>
        <FieldLabel>Type</FieldLabel>
        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Widget type">
          {biWidgetTypes.map((t) => {
            const disabled = t !== "text" && catalogue.length === 0;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={widget.type === t}
                disabled={disabled}
                onClick={() => changeType(t)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs [&_svg]:size-4",
                  widget.type === t
                    ? "border-primary bg-primary/5 text-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                  disabled && "opacity-50",
                )}
              >
                {WIDGET_TYPE_META[t].icon}
                {WIDGET_TYPE_META[t].label}
              </button>
            );
          })}
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
        <Input
          id={`${id}-title`}
          value={widget.title ?? ""}
          maxLength={120}
          onChange={(e) => onChange({ ...widget, title: e.target.value } as BiWidget)}
        />
      </Field>
      {widget.type === "text" ? (
        <Field>
          <FieldLabel htmlFor={`${id}-text`}>Commentary</FieldLabel>
          <Textarea
            id={`${id}-text`}
            className="min-h-40"
            value={widget.text}
            maxLength={BI_LIMITS.textLength}
            onChange={(e) => onChange({ ...widget, text: e.target.value })}
          />
          <FieldDescription>
            Shown as commentary, never as a figure of record. Put numbers in data widgets so they are
            computed. {widget.text.length}/{BI_LIMITS.textLength}
          </FieldDescription>
        </Field>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
            <Input
              id={`${id}-description`}
              value={widget.description ?? ""}
              maxLength={500}
              placeholder="Optional: what this shows and how to read it"
              onChange={(e) =>
                onChange({ ...widget, description: e.target.value || undefined } as BiDataWidget)
              }
            />
          </Field>
          <QueryEditor
            widget={widget}
            dataset={dataset}
            catalogue={catalogue}
            spec={spec}
            onChange={onChange}
            loadChoices={loadChoices}
          />
        </>
      )}
      <DisplayEditor widget={widget} onChange={onChange} />
    </FieldGroup>
  );
}

function QueryEditor({
  widget,
  dataset,
  catalogue,
  spec,
  onChange,
  loadChoices,
}: {
  widget: BiDataWidget;
  dataset: BiDataset | undefined;
  catalogue: readonly BiDataset[];
  spec: BiDashboardSpec;
  onChange: (widget: BiWidget) => void;
  loadChoices?: LoadChoices;
}) {
  const id = useId();
  const query = widget.query;
  const setQuery = (patch: Partial<BiQuerySpec>) =>
    onChange({ ...widget, query: { ...query, ...patch } } as BiDataWidget);
  const [minGroups, maxGroups] = BI_WIDGET_GROUPINGS[widget.type];
  const oneMeasure = widget.type === "donut" || widget.type === "pivot";

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-dataset`}>Data</FieldLabel>
        <Select
          value={dataset ? query.dataset : undefined}
          onValueChange={(v) => {
            const next = catalogue.find((d) => d.id === v);
            if (next) onChange({ ...widget, query: biDefaultQuery(widget.type, next) } as BiDataWidget);
          }}
        >
          <SelectTrigger id={`${id}-dataset`} className="w-full">
            <SelectValue placeholder={`Unavailable: ${query.dataset}`} />
          </SelectTrigger>
          <SelectContent>
            {catalogue.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {dataset && <FieldDescription>{dataset.description}</FieldDescription>}
      </Field>
      {dataset && (
        <>
          <FieldSet>
            <FieldLegend variant="label">{oneMeasure ? "Measure" : "Measures"}</FieldLegend>
            <div className="flex flex-col gap-2">
              {dataset.measures.map((m) => {
                const checked = query.measures.includes(m.id);
                return (
                  <label key={m.id} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={(on) => {
                        const measures = oneMeasure
                          ? [m.id]
                          : on
                            ? [...query.measures, m.id]
                            : query.measures.filter((x) => x !== m.id);
                        if (measures.length === 0) return;
                        const next = biFitQuery(widget.type, { ...query, measures }, dataset);
                        onChange({ ...widget, query: next } as BiDataWidget);
                      }}
                    />
                    <span className="flex flex-col">
                      <span>{m.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {m.description}
                        {m.splitBy?.length
                          ? ` Group or filter by ${m.splitBy.map((s) => dimLabel(dataset, s)).join(" or ")}.`
                          : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </FieldSet>
          {maxGroups > 0 && (
            <FieldSet>
              <FieldLegend variant="label">Group by</FieldLegend>
              <FieldDescription>
                {minGroups === maxGroups
                  ? `${humanize(WIDGET_TYPE_META[widget.type].label)} takes ${minGroups}.`
                  : `Up to ${maxGroups}${minGroups ? `, at least ${minGroups}` : ""}.`}
              </FieldDescription>
              <div className="flex flex-col gap-2">
                {query.groupBy.map((g, i) => {
                  const dim = dataset.dimensions.find((d) => d.id === g.dim);
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <DimSelect
                        dataset={dataset}
                        value={g.dim}
                        exclude={query.groupBy.filter((_, j) => j !== i).map((x) => x.dim)}
                        onChange={(dimId) => {
                          const next = dataset.dimensions.find((d) => d.id === dimId);
                          const groupBy = query.groupBy.map((x, j) =>
                            j === i
                              ? { dim: dimId, ...(next?.type === "date" ? { grain: "month" as const } : {}) }
                              : x,
                          );
                          setQuery({ groupBy, sort: query.sort.filter((s) => s.by !== g.dim) });
                        }}
                      />
                      {dim?.type === "date" && (
                        <Select
                          value={g.grain ?? "day"}
                          onValueChange={(grain) =>
                            setQuery({
                              groupBy: query.groupBy.map((x, j) =>
                                j === i ? { ...x, grain: grain as (typeof biGrains)[number] } : x,
                              ),
                            })
                          }
                        >
                          <SelectTrigger className="w-40" aria-label="Grain">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {biGrains.map((grain) => (
                              <SelectItem key={grain} value={grain}>
                                {humanize(grain)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Remove grouping"
                        disabled={query.groupBy.length <= minGroups}
                        onClick={() =>
                          setQuery({
                            groupBy: query.groupBy.filter((_, j) => j !== i),
                            sort: query.sort.filter((s) => s.by !== g.dim),
                          })
                        }
                      >
                        <X />
                      </Button>
                    </div>
                  );
                })}
                {query.groupBy.length < maxGroups && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    onClick={() => {
                      const free = dataset.dimensions.find((d) => !query.groupBy.some((g) => g.dim === d.id));
                      if (free)
                        setQuery({
                          groupBy: [
                            ...query.groupBy,
                            { dim: free.id, ...(free.type === "date" ? { grain: "month" as const } : {}) },
                          ],
                        });
                    }}
                  >
                    <Plus /> Add grouping
                  </Button>
                )}
              </div>
            </FieldSet>
          )}
          <FieldSet>
            <FieldLegend variant="label">Filters</FieldLegend>
            <div className="flex flex-col gap-2">
              {query.filters.map((f, i) => (
                <FilterRow
                  key={i}
                  dataset={dataset}
                  filter={f}
                  loadChoices={loadChoices}
                  onChange={(next) =>
                    setQuery({ filters: query.filters.map((x, j) => (j === i ? next : x)) })
                  }
                  onRemove={() => setQuery({ filters: query.filters.filter((_, j) => j !== i) })}
                />
              ))}
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={query.filters.length >= 20}
                onClick={() => {
                  const dim =
                    dataset.dimensions.find((d) => d.id === dataset.currencyDimension) ??
                    dataset.dimensions.find((d) => d.type === "category") ??
                    dataset.dimensions[0]!;
                  setQuery({ filters: [...query.filters, defaultFilter(dim)] });
                }}
              >
                <Plus /> Add filter
              </Button>
            </div>
          </FieldSet>
          <PeriodEditor widget={widget} dataset={dataset} spec={spec} onChange={onChange} />
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor={`${id}-sort`}>Sort by</FieldLabel>
              <Select
                value={query.sort[0] ? `${query.sort[0].by}:${query.sort[0].dir}` : NONE}
                onValueChange={(v) => {
                  if (v === NONE) return setQuery({ sort: [] });
                  const [by, dir] = v.split(":") as [string, "asc" | "desc"];
                  setQuery({ sort: [{ by, dir }] });
                }}
              >
                <SelectTrigger id={`${id}-sort`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Natural order</SelectItem>
                  {sortFields(query, dataset).flatMap((f) => [
                    <SelectItem key={`${f.id}:desc`} value={`${f.id}:desc`}>
                      {f.label}, {f.date ? "newest first" : "high to low"}
                    </SelectItem>,
                    <SelectItem key={`${f.id}:asc`} value={`${f.id}:asc`}>
                      {f.label}, {f.date ? "oldest first" : "low to high"}
                    </SelectItem>,
                  ])}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-limit`}>Rows</FieldLabel>
              <Input
                id={`${id}-limit`}
                type="number"
                min={1}
                max={BI_LIMITS.widgetRows}
                placeholder="All"
                value={query.limit ?? ""}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setQuery({
                    limit: Number.isFinite(n) && n > 0 ? Math.min(n, BI_LIMITS.widgetRows) : undefined,
                  });
                }}
              />
            </Field>
          </div>
        </>
      )}
    </>
  );
}

const dimLabel = (dataset: BiDataset, id: string) =>
  dataset.dimensions.find((d) => d.id === id)?.label.toLowerCase() ?? id;

function sortFields(query: BiQuerySpec, dataset: BiDataset) {
  const measures = query.measures.map((m) => ({
    id: m,
    label: dataset.measures.find((x) => x.id === m)?.label ?? m,
    date: false,
  }));
  return [
    ...measures,
    ...(query.compare
      ? measures.map((m) => ({ ...m, id: `${m.id}__compare`, label: `${m.label} (before)` }))
      : []),
    ...query.groupBy.map((g) => {
      const dim = dataset.dimensions.find((d) => d.id === g.dim);
      return { id: g.dim, label: dim?.label ?? g.dim, date: dim?.type === "date" };
    }),
  ];
}

function DimSelect({
  dataset,
  value,
  exclude = [],
  onChange,
  types,
  className,
}: {
  dataset: BiDataset;
  value: string;
  exclude?: readonly string[];
  onChange: (dim: string) => void;
  types?: readonly BiDimension["type"][];
  className?: string;
}) {
  const dims = dataset.dimensions.filter(
    (d) => !exclude.includes(d.id) && (!types || types.includes(d.type)),
  );
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("min-w-0 flex-1", className)} aria-label="Field">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {dims.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function defaultFilter(dim: BiDimension): BiFilter {
  if (dim.type === "boolean") return { dim: dim.id, op: "eq", value: true };
  if (dim.type === "date" || dim.type === "number") return { dim: dim.id, op: "gte" };
  const first = dim.values?.[0];
  return first !== undefined ? { dim: dim.id, op: "eq", value: first } : { dim: dim.id, op: "eq" };
}

/** One filter: field, operator and a value input that suits the field (choices for categories and references). */
function FilterRow({
  dataset,
  filter,
  onChange,
  onRemove,
  loadChoices,
}: {
  dataset: BiDataset;
  filter: BiFilter;
  onChange: (filter: BiFilter) => void;
  onRemove: () => void;
  loadChoices?: LoadChoices;
}) {
  const dim = dataset.dimensions.find((d) => d.id === filter.dim);
  const ops = dim ? OPS_BY_TYPE[dim.type] : (["eq"] as BiFilterOp[]);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <DimSelect
          dataset={dataset}
          value={filter.dim}
          onChange={(id) => {
            const next = dataset.dimensions.find((d) => d.id === id);
            if (next) onChange(defaultFilter(next));
          }}
        />
        <Select
          value={filter.op}
          onValueChange={(op) => {
            const multi = op === "in" || op === "not_in";
            const wasMulti = Array.isArray(filter.value);
            const value =
              op === "is_null" || op === "not_null"
                ? undefined
                : multi && !wasMulti
                  ? filter.value === undefined
                    ? []
                    : [filter.value]
                  : !multi && wasMulti
                    ? (filter.value as unknown[])[0]
                    : op === "between"
                      ? undefined
                      : filter.value;
            onChange({
              dim: filter.dim,
              op: op as BiFilterOp,
              ...(value !== undefined ? { value } : {}),
            } as BiFilter);
          }}
        >
          <SelectTrigger className="w-40" aria-label="Operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((op) => (
              <SelectItem key={op} value={op}>
                {OP_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon-sm" variant="ghost" aria-label="Remove filter" onClick={onRemove}>
          <X />
        </Button>
      </div>
      {dim && filter.op !== "is_null" && filter.op !== "not_null" && (
        <FilterValue
          dataset={dataset}
          dim={dim}
          filter={filter}
          onChange={onChange}
          loadChoices={loadChoices}
        />
      )}
    </div>
  );
}

function FilterValue({
  dataset,
  dim,
  filter,
  onChange,
  loadChoices,
}: {
  dataset: BiDataset;
  dim: BiDimension;
  filter: BiFilter;
  onChange: (filter: BiFilter) => void;
  loadChoices?: LoadChoices;
}) {
  const choices = useDimChoices(dataset, dim, loadChoices);
  const set = (value: BiFilter["value"]) => onChange({ ...filter, value });
  if (filter.op === "between") {
    return <BetweenValue key={`${filter.dim}`} dim={dim} filter={filter} onChange={onChange} />;
  }
  if (dim.type === "boolean") {
    return (
      <Select value={String(filter.value ?? true)} onValueChange={(v) => set(v === "true")}>
        <SelectTrigger className="w-full" aria-label="Value">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (dim.type === "date" || dim.type === "number") {
    return (
      <Input
        type={dim.type}
        aria-label="Value"
        value={String(filter.value ?? "")}
        onChange={(e) => set(castValue(dim.type === "number" ? "number" : "date", e.target.value))}
      />
    );
  }
  if (filter.op === "in" || filter.op === "not_in") {
    const selected = new Set((Array.isArray(filter.value) ? filter.value : []).map(String));
    if (!choices) return <p className="text-xs text-muted-foreground">Loading choices…</p>;
    return (
      <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
        {choices.map((c) => (
          <label key={c.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.has(c.value)}
              onCheckedChange={(on) => {
                const next = new Set(selected);
                if (on) next.add(c.value);
                else next.delete(c.value);
                set([...next].slice(0, 100));
              }}
            />
            {c.label}
          </label>
        ))}
        {choices.length === 0 && <p className="text-xs text-muted-foreground">No values yet.</p>}
      </div>
    );
  }
  if (!choices || choices.length === 0) {
    return (
      <Input
        aria-label="Value"
        value={String(filter.value ?? "")}
        placeholder={choices ? "Value" : "Loading choices…"}
        onChange={(e) => set(e.target.value)}
      />
    );
  }
  return (
    <Select value={filter.value === undefined ? undefined : String(filter.value)} onValueChange={set}>
      <SelectTrigger className="w-full" aria-label="Value">
        <SelectValue placeholder="Choose…" />
      </SelectTrigger>
      <SelectContent>
        {choices.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** An input's text as a filter value: empty (or a half-typed number) is no value, never 0. */
function castValue(type: "date" | "number", v: string): string | number | undefined {
  if (v.trim() === "") return undefined;
  if (type === "date") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The two ends of a `between` filter. Each side is kept as typed here; the filter gets a value only
 * when both are set, so a missing end is reported by the checks rather than sent as 0.
 */
function BetweenValue({
  dim,
  filter,
  onChange,
}: {
  dim: BiDimension;
  filter: BiFilter;
  onChange: (filter: BiFilter) => void;
}) {
  const type = dim.type === "date" ? "date" : "number";
  const initial = Array.isArray(filter.value) ? filter.value : [];
  const [ends, setEnds] = useState<[string, string]>([String(initial[0] ?? ""), String(initial[1] ?? "")]);
  const update = (next: [string, string]) => {
    setEnds(next);
    const a = castValue(type, next[0]);
    const b = castValue(type, next[1]);
    const { value: _old, ...rest } = filter;
    onChange(a !== undefined && b !== undefined ? { ...rest, value: [a, b] } : rest);
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        type={type}
        value={ends[0]}
        onChange={(e) => update([e.target.value, ends[1]])}
        aria-label="From"
      />
      <span className="text-xs text-muted-foreground">and</span>
      <Input
        type={type}
        value={ends[1]}
        onChange={(e) => update([ends[0], e.target.value])}
        aria-label="To"
      />
    </div>
  );
}

/** A dimension's choices: its declared values, else whatever `loadChoices` finds (null while loading). */
function useDimChoices(dataset: BiDataset, dim: BiDimension, loadChoices?: LoadChoices) {
  const declared = dim.values?.map((v) => ({ value: String(v), label: humanize(String(v)) }));
  const [loaded, setLoaded] = useState<{ key: string; choices: DimChoice[] } | null>(null);
  const key = `${dataset.id}.${dim.id}`;
  useEffect(() => {
    if (declared || !loadChoices) return;
    let cancelled = false;
    loadChoices(dataset.id, dim.id)
      .catch(() => [])
      .then((choices) => !cancelled && setLoaded({ key, choices }));
    return () => {
      cancelled = true;
    };
    // `declared` is derived from `dim`; the key covers both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loadChoices]);
  if (declared) return declared;
  if (!loadChoices) return [];
  return loaded?.key === key ? loaded.choices : null;
}

/**
 * The widget's period: follow the dashboard's (the default; the widget's date field still applies),
 * or pin its own. And whether to compare with the period before or a year earlier.
 */
function PeriodEditor({
  widget,
  dataset,
  spec,
  onChange,
}: {
  widget: BiDataWidget;
  dataset: BiDataset;
  spec: BiDashboardSpec;
  onChange: (widget: BiWidget) => void;
}) {
  const id = useId();
  const query = widget.query;
  const dates = dataset.dimensions.filter((d) => d.type === "date");
  const dateDim = query.period?.dim ?? dataset.defaultDate;
  const dashboardPreset = spec.params.period?.preset;
  const pinned = Boolean(widget.pinPeriod && query.period);
  const presetValue = pinned ? (query.period?.preset ?? NONE) : DASHBOARD;

  function update(next: { dim?: string; preset?: string; compare?: BiQuerySpec["compare"] | null }) {
    const dim = next.dim ?? dateDim;
    const choice = next.preset ?? presetValue;
    const dimPart = dim !== dataset.defaultDate ? { dim } : {};
    let period: BiQuerySpec["period"];
    let pinPeriod: boolean | undefined;
    if (choice === DASHBOARD) {
      // Following the dashboard: a period is kept only to carry a non-default date field (its preset
      // is replaced by the dashboard's when the viewer opens it).
      period = dim !== dataset.defaultDate ? { dim, preset: dashboardPreset ?? "last_12_months" } : undefined;
      pinPeriod = undefined;
    } else if (choice === NONE) {
      period = undefined;
      pinPeriod = true;
    } else {
      period = { ...dimPart, preset: choice as (typeof biPeriodPresets)[number] };
      pinPeriod = true;
    }
    const compare = next.compare === null ? undefined : (next.compare ?? query.compare);
    const { pinPeriod: _drop, ...rest } = widget;
    onChange({
      ...rest,
      ...(pinPeriod ? { pinPeriod } : {}),
      query: {
        ...query,
        period,
        compare,
        sort: compare ? query.sort : query.sort.filter((s) => !s.by.endsWith("__compare")),
      },
    } as BiDataWidget);
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field>
        <FieldLabel htmlFor={`${id}-period`}>Period</FieldLabel>
        <Select value={presetValue} onValueChange={(v) => update({ preset: v })}>
          <SelectTrigger id={`${id}-period`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DASHBOARD}>
              {dashboardPreset
                ? `Dashboard's (${humanize(dashboardPreset).toLowerCase()})`
                : "Dashboard's (all time)"}
            </SelectItem>
            <SelectItem value={NONE}>All time, always</SelectItem>
            {biPeriodPresets.map((p) => (
              <SelectItem key={p} value={p}>
                {humanize(p)}, always
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-date`}>Dated by</FieldLabel>
        <Select value={dateDim} onValueChange={(v) => update({ dim: v })} disabled={dates.length < 2}>
          <SelectTrigger id={`${id}-date`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dates.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field className="col-span-2">
        <FieldLabel htmlFor={`${id}-compare`}>Compare with</FieldLabel>
        <Select
          value={query.compare ?? NONE}
          onValueChange={(v) => update({ compare: v === NONE ? null : (v as BiQuerySpec["compare"]) })}
        >
          <SelectTrigger id={`${id}-compare`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Nothing</SelectItem>
            <SelectItem value="previous_period">The period before</SelectItem>
            <SelectItem value="previous_year">The same period a year earlier</SelectItem>
          </SelectContent>
        </Select>
        {query.compare && presetValue === NONE && (
          <FieldDescription>A comparison needs a period: pick one above.</FieldDescription>
        )}
      </Field>
    </div>
  );
}

/** Width on the 12-column grid; the x axis and series for charts with two groupings; KPI direction. */
function DisplayEditor({ widget, onChange }: { widget: BiWidget; onChange: (widget: BiWidget) => void }) {
  const id = useId();
  const display = widget.display ?? {};
  const set = (patch: Partial<NonNullable<BiWidget["display"]>>) => {
    const next = { ...display, ...patch };
    for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] === undefined) delete next[k];
    onChange({ ...widget, display: Object.keys(next).length ? next : undefined } as BiWidget);
  };
  const grouped = widget.type === "text" ? [] : widget.query.groupBy.map((g) => g.dim);
  const twoGroups = isBiDataWidgetType(widget.type) && widget.type !== "table" && grouped.length === 2;
  const fallback = widget.type === "kpi" ? 3 : 6;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field>
        <FieldLabel htmlFor={`${id}-width`}>Width</FieldLabel>
        <Select value={String(display.width ?? fallback)} onValueChange={(v) => set({ width: Number(v) })}>
          <SelectTrigger id={`${id}-width`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WIDTHS.map((w) => (
              <SelectItem key={w} value={String(w)}>
                {w === 12
                  ? "Full width"
                  : w === 6
                    ? "Half"
                    : w === 3
                      ? "Quarter"
                      : w === 4
                        ? "Third"
                        : "Two thirds"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {widget.type === "kpi" && (
        <Field>
          <FieldLabel htmlFor={`${id}-good`}>Good when it goes</FieldLabel>
          <Select
            value={display.goodDirection ?? "up"}
            onValueChange={(v) => set({ goodDirection: v as "up" | "down" })}
          >
            <SelectTrigger id={`${id}-good`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="up">Up</SelectItem>
              <SelectItem value="down">Down (complaints, waste)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      {twoGroups && (
        <Field>
          <FieldLabel htmlFor={`${id}-x`}>{widget.type === "pivot" ? "Rows" : "Along the axis"}</FieldLabel>
          <Select
            value={display.x ?? grouped[0]}
            onValueChange={(x) => set({ x, series: grouped.find((g) => g !== x) })}
          >
            <SelectTrigger id={`${id}-x`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {grouped.map((g) => (
                <SelectItem key={g} value={g}>
                  {humanize(g)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    </div>
  );
}

/** Problems with a widget or the dashboard, as the server would refuse them. */
export function IssueList({ issues, className }: { issues: readonly BiIssue[]; className?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul
      className={cn(
        "flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs",
        className,
      )}
      aria-label="Problems"
    >
      {issues.map((issue, i) => (
        <li key={i} className="flex gap-1.5">
          <TriangleAlert className="mt-0.5 size-3 shrink-0 text-destructive" />
          <span>
            {issue.path && <code className="text-muted-foreground">{issue.path}: </code>}
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The spec as JSON, read-only, with a copy button: for power users and to inspect an agent's work. */
export function SpecJson({ value, className }: { value: unknown; className?: string }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(value, null, 2);
  return (
    <div className={cn("relative", className)}>
      <Button
        size="sm"
        variant="outline"
        className="absolute top-2 right-2"
        onClick={() => {
          void navigator.clipboard.writeText(json).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
      </Button>
      <pre
        className="max-h-[70vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs"
        aria-label="Dashboard spec (JSON)"
        tabIndex={0}
      >
        {json}
      </pre>
    </div>
  );
}
