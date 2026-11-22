"use client";

import { biDashboardSpecSchema, type BiDashboardSpec } from "@knotworking/core";
import { Snowflake } from "lucide-react";
import { AnalysisView, type AnalysisForView } from "@/components/analysis-view";
import { DashboardWidget, type FrozenDefinitions, type WidgetData } from "@/components/dashboard-widgets";
import { delta, formatMeasure, type BiResult } from "@/lib/bi-format";

/** A frozen snapshot as the API returns it (header, spec and results). */
export interface FrozenSnapshot {
  id: string;
  /** `analysis`: a verified agent analysis, shown by `AnalysisView`. */
  kind?: string;
  title: string;
  asAt: string;
  takenAt: string | Date;
  catalogueVersion: number;
  dashboardVersion: number;
  spec: unknown;
  results: { widgets?: unknown[]; analysis?: AnalysisForView };
  /** The view it was taken with (period and filters). */
  view?: unknown;
  /** Every figure's definition as it read when taken, keyed `<dataset>.<measure>`. */
  definitions?: unknown;
}

const widgetsOf = (s: FrozenSnapshot) =>
  new Map(((s.results.widgets ?? []) as WidgetData[]).map((w) => [w.widgetId, w]));

/** A KPI's value in a snapshot: the first measure of its one row. */
function kpiValue(data: WidgetData | undefined): { value: unknown; result: BiResult } | null {
  if (!data || data.status !== "ok") return null;
  const measure = data.result.columns.find((c) => c.kind === "measure");
  const row = data.result.rows[0];
  return measure && row ? { value: row[measure.key], result: data.result } : null;
}

/**
 * A snapshot's figures exactly as frozen: never re-queried. With `previous` (the snapshot of the
 * same dashboard taken before it), a "since last time" table compares the KPIs both share.
 */
export function SnapshotBody({
  snapshot,
  previous,
  base,
  workspaceCurrency,
}: {
  snapshot: FrozenSnapshot;
  previous?: FrozenSnapshot | null;
  base: string;
  workspaceCurrency: string;
}) {
  if (snapshot.kind === "analysis" && snapshot.results.analysis)
    return <AnalysisView analysis={snapshot.results.analysis} base={base} />;
  const parsed = biDashboardSpecSchema.safeParse(snapshot.spec);
  if (!parsed.success)
    return <p className="text-sm text-destructive">This snapshot's layout can't be read.</p>;
  const spec = parsed.data;
  const now = widgetsOf(snapshot);
  return (
    <div className="flex flex-col gap-6">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Snowflake className="size-3.5" /> Frozen as at {snapshot.asAt}: these figures never change. Dashboard
        version {snapshot.dashboardVersion}, catalogue version {snapshot.catalogueVersion}.
      </p>
      {previous && (
        <SinceLastTime
          spec={spec}
          now={now}
          previous={previous}
          snapshotView={snapshot.view}
          currency={workspaceCurrency}
        />
      )}
      {spec.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          {section.title && <h3 className="text-sm font-medium">{section.title}</h3>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12 print:grid-cols-12">
            {section.widgets.map((widget) => (
              <DashboardWidget
                key={widget.id}
                widget={widget}
                data={now.get(widget.id)}
                definitions={snapshot.definitions as FrozenDefinitions | undefined}
                base={base}
                workspaceCurrency={workspaceCurrency}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** KPIs in both snapshots: then, now and the change. */
function SinceLastTime({
  spec,
  now,
  previous,
  snapshotView,
  currency,
}: {
  spec: BiDashboardSpec;
  now: Map<string, WidgetData>;
  previous: FrozenSnapshot;
  snapshotView: unknown;
  currency: string;
}) {
  const then = widgetsOf(previous);
  const before = biDashboardSpecSchema.safeParse(previous.spec);
  const beforeWidgets = new Map(
    (before.success ? before.data.sections.flatMap((s) => s.widgets) : []).map((w) => [w.id, w]),
  );
  // Like for like only: the same query and the same view (period and filters) in both snapshots.
  const sameView = JSON.stringify(previous.view ?? {}) === JSON.stringify(snapshotView ?? {});
  const rows = spec.sections
    .flatMap((s) => s.widgets)
    .filter((w) => w.type === "kpi")
    .flatMap((w) => {
      const old = beforeWidgets.get(w.id);
      if (!sameView || !old || old.type !== "kpi" || JSON.stringify(old.query) !== JSON.stringify(w.query))
        return [];
      const a = kpiValue(then.get(w.id));
      const b = kpiValue(now.get(w.id));
      if (!a || !b) return [];
      const unit = b.result.columns.find((c) => c.kind === "measure")?.unit;
      const unitBefore = a.result.columns.find((c) => c.kind === "measure")?.unit;
      if (unit !== unitBefore || (a.result.currency ?? currency) !== (b.result.currency ?? currency))
        return [];
      const points =
        unit === "percent" && typeof a.value === "number" && typeof b.value === "number"
          ? Math.round((b.value - a.value) * 10) / 10
          : null;
      return [
        {
          id: w.id,
          title: w.title,
          then: a,
          now: b,
          unit,
          change:
            points !== null
              ? `${points > 0 ? "+" : ""}${points} pts`
              : (() => {
                  const d = delta(b.value as never, a.value as never);
                  return d === null ? "–" : `${d > 0 ? "+" : ""}${Math.round(d * 1000) / 10}%`;
                })(),
        },
      ];
    });
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="px-3 pt-2 text-left text-xs text-muted-foreground">
          Since the snapshot of {previous.asAt}
        </caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Figure</th>
            <th className="px-3 py-2 text-right font-medium">{previous.asAt}</th>
            <th className="px-3 py-2 text-right font-medium">This snapshot</th>
            <th className="px-3 py-2 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0">
              <td className="px-3 py-2">{r.title}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatMeasure(r.unit, r.then.value as never, r.then.result.currency ?? currency)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatMeasure(r.unit, r.now.value as never, r.now.result.currency ?? currency)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.change}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
