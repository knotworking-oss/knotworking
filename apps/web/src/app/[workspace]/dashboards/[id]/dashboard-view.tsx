"use client";

import {
  biDashboardSpecSchema,
  biPeriodPresets,
  type BiDashboardSpec,
  type BiPeriodPreset,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Printer, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { DashboardWidget, type WidgetData } from "@/components/dashboard-widgets";
import { humanize } from "@/lib/bi-format";
import type { DashboardDetail } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useWorkspaceCurrency } from "@/lib/workspace-time";

export interface ViewParams {
  period?: { preset?: BiPeriodPreset; from?: string; to?: string };
  filters: Record<string, string | string[]>;
}

/** A dashboard as its viewer sees it: the parameter bar, then each section's widgets on a 12-column grid. */
export function DashboardView({
  slug,
  dashboard,
  data,
  view,
}: {
  slug: string;
  dashboard: DashboardDetail;
  data: { widgets: WidgetData[] };
  view: ViewParams;
}) {
  const currency = useWorkspaceCurrency();
  const [pending, startTransition] = useTransition();
  // Parsed once per spec, so children that depend on it (filter choices) don't refetch on every render.
  const parsed = useMemo(() => biDashboardSpecSchema.safeParse(dashboard.spec), [dashboard.spec]);
  const byId = useMemo(() => new Map(data.widgets.map((w) => [w.widgetId, w])), [data.widgets]);
  if (!parsed.success) {
    return <p className="p-6 text-sm text-destructive">This dashboard's definition can't be read.</p>;
  }
  const spec = parsed.data;
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center gap-2">
        {dashboard.description && (
          <p className="mr-auto text-sm text-muted-foreground">{dashboard.description}</p>
        )}
        <Badge variant={dashboard.status === "published" ? "secondary" : "outline"} className="print:hidden">
          {dashboard.status === "published" ? "Published" : "Draft"}
        </Badge>
        {dashboard.template && (
          <Badge variant="outline" className="print:hidden">
            Template
          </Badge>
        )}
        {dashboard.archivedAt && (
          <Badge variant="outline" className="print:hidden">
            Archived
          </Badge>
        )}
        <Button size="sm" variant="outline" className="print:hidden" onClick={() => window.print()}>
          <Printer /> Print
        </Button>
      </div>
      <ParamBar slug={slug} spec={spec} view={view} onNavigate={(fn) => startTransition(fn)} />
      {spec.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3" aria-busy={pending}>
          {section.title && <h2 className="text-sm font-medium">{section.title}</h2>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12 print:grid-cols-12">
            {section.widgets.map((widget) => (
              <DashboardWidget
                key={widget.id}
                widget={widget}
                data={byId.get(widget.id)}
                loading={pending && widget.type !== "text"}
                base={`/${slug}`}
                workspaceCurrency={currency}
              />
            ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        Figures are live: computed now from the data you can read. Version {dashboard.version}.
      </p>
    </div>
  );
}

/**
 * The dashboard's period and filter parameters, kept in the URL so the view can be shared and
 * printed as seen. Filter choices come from the catalogue: the values of that dimension in the
 * first widget's dataset that has it.
 */
function ParamBar({
  slug,
  spec,
  view,
  onNavigate,
}: {
  slug: string;
  spec: BiDashboardSpec;
  view: ViewParams;
  onNavigate: (fn: () => void) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // "Custom dates" shows the date inputs before any date is in the URL.
  const [customOpen, setCustomOpen] = useState(false);
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    onNavigate(() => router.push(`${pathname}${next.size ? `?${next}` : ""}`));
  };
  const hasPeriod =
    Boolean(spec.params.period) || spec.sections.some((s) => s.widgets.some((w) => w.type !== "text"));
  if (!hasPeriod && spec.params.filters.length === 0) return null;
  const fromView =
    view.period?.preset ?? (view.period ? "custom" : (spec.params.period?.preset ?? "default"));
  const period = customOpen && !view.period?.preset ? "custom" : fromView;
  const changed = Boolean(view.period) || Object.keys(view.filters).length > 0;
  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden" role="group" aria-label="Dashboard filters">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Period</span>
        <Select
          value={period}
          onValueChange={(v) => {
            setCustomOpen(v === "custom");
            if (v === "custom") return;
            set(
              v === "default" ? { period: null, from: null, to: null } : { period: v, from: null, to: null },
            );
          }}
        >
          <SelectTrigger className="w-48" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">
              {spec.params.period?.preset
                ? `${humanize(spec.params.period.preset)} (default)`
                : "As each widget sets"}
            </SelectItem>
            {biPeriodPresets.map((p) => (
              <SelectItem key={p} value={p}>
                {humanize(p)}
              </SelectItem>
            ))}
            <SelectItem value="custom">Custom dates</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {period === "custom" && (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">From</span>
            <Input
              type="date"
              className="h-8 w-40"
              defaultValue={view.period?.from}
              onBlur={(e) => set({ period: null, from: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Before</span>
            <Input
              type="date"
              className="h-8 w-40"
              defaultValue={view.period?.to}
              onBlur={(e) => set({ period: null, to: e.target.value })}
            />
          </label>
        </>
      )}
      {spec.params.filters.map((param) => (
        <FilterParam
          key={param.id}
          slug={slug}
          spec={spec}
          param={param}
          value={typeof view.filters[param.id] === "string" ? (view.filters[param.id] as string) : ""}
          onChange={(value) => set({ [`f.${param.id}`]: value })}
        />
      ))}
      {changed && (
        <Button size="sm" variant="ghost" onClick={() => onNavigate(() => router.push(pathname))}>
          <X /> Reset
        </Button>
      )}
    </div>
  );
}

function FilterParam({
  slug,
  spec,
  param,
  value,
  onChange,
}: {
  slug: string;
  spec: BiDashboardSpec;
  param: BiDashboardSpec["params"]["filters"][number];
  value: string;
  onChange: (value: string | null) => void;
}) {
  const [options, setOptions] = useState<Array<{ value: string; label: string }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const datasets = await unwrap(
        browserApi().v1.workspaces[":slug"].bi.datasets.$get({ param: { slug } }),
      );
      const queries = spec.sections.flatMap((s) =>
        s.widgets.flatMap((w) => (w.type === "text" ? [] : [w.query])),
      );
      // The first widget whose dataset has this dimension supplies the choices, counted with one of
      // its count measures: money or quantity measures would need a currency or unit split.
      const query = queries.find((q) =>
        datasets.datasets.find((d) => d.id === q.dataset)?.dimensions.some((d) => d.id === param.dim),
      );
      const counter = datasets.datasets
        .find((d) => d.id === query?.dataset)
        ?.measures.find((m) => m.unit === "count");
      if (!query || !counter) {
        setOptions([]);
        return;
      }
      const res = await unwrap(
        browserApi().v1.workspaces[":slug"].bi.query.$get({
          param: { slug },
          query: {
            spec: JSON.stringify({
              dataset: query.dataset,
              measures: [counter.id],
              groupBy: [{ dim: param.dim }],
              sort: [{ by: param.dim, dir: "asc" }],
              limit: 200,
            }),
          },
        }),
      ).catch(() => null);
      if (cancelled || !res) return;
      const idKey = `${param.dim}__id`;
      setOptions(
        res.rows
          .map((row) => {
            const id = row[idKey] ?? row[param.dim];
            return id === null || id === undefined
              ? null
              : { value: String(id), label: humanize(String(row[param.dim] ?? id)) };
          })
          .filter((o): o is { value: string; label: string } => o !== null),
      );
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, spec, param.dim]);

  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{param.label}</span>
      <Select
        value={value || "all"}
        onValueChange={(v) => onChange(v === "all" ? null : v)}
        disabled={!options}
      >
        <SelectTrigger className="w-48" size="sm">
          <SelectValue placeholder="All" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {options?.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
