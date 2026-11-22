"use client";

import { BI_METRICS_DATASET, biCertifiedMetric, biDataset, type BiWidget } from "@knotworking/core";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knotworking/ui/components/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@knotworking/ui/components/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { cn } from "@knotworking/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@knotworking/ui/components/tooltip";
import {
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  ExternalLink,
  Info,
  Lock,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ExportCsvButton } from "@/components/export-csv-button";
import {
  chartData,
  DATASET_PAGES,
  delta,
  donutData,
  formatAxis,
  formatDimension,
  formatMeasure,
  pivotData,
  REFERENCE_PAGES,
  resultCsv,
  rowCurrency,
  type BiResult,
} from "@/lib/bi-format";

/** What the data route returns for one widget. */
export type WidgetData =
  | { widgetId: string; status: "ok"; result: BiResult }
  | { widgetId: string; status: "no_access"; message: string }
  | { widgetId: string; status: "error"; code: string; message: string };

/**
 * One dashboard widget: a card with its title and the right view for its type. Data widgets show
 * figures computed by the server for the viewer; text widgets are labelled commentary. Empty,
 * loading, "no access" and error states have their own tile, so one failing widget never breaks
 * the page.
 */
export function DashboardWidget({
  widget,
  data,
  base,
  workspaceCurrency,
  loading = false,
  definitions,
}: {
  /** A snapshot's definitions as they read when it was taken (else the live catalogue's). */
  definitions?: FrozenDefinitions;
  widget: BiWidget;
  /** The widget's outcome; absent for text widgets and while loading. */
  data?: WidgetData;
  /** `/<workspace>`, for drill-through links. */
  base: string;
  workspaceCurrency: string;
  loading?: boolean;
}) {
  const span = widget.display?.width ?? (widget.type === "kpi" ? 3 : widget.type === "text" ? 6 : 6);
  const result = data?.status === "ok" ? data.result : undefined;
  // Certified metrics open the module page that shows the same figure.
  const page =
    widget.type === "text"
      ? undefined
      : widget.query.dataset === BI_METRICS_DATASET
        ? biCertifiedMetric(widget.query.measures[0] ?? "")?.page
        : DATASET_PAGES[widget.query.dataset];
  return (
    <Card
      className="min-w-0 break-inside-avoid gap-3 py-4 print:shadow-none"
      style={{ gridColumn: `span ${span} / span ${span}` }}
      data-widget={widget.id}
    >
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-1 text-sm">
          {widget.title || (widget.type === "text" ? "Commentary" : "")}
          {widget.type !== "text" && (
            <MeasureDefinitions
              dataset={widget.query.dataset}
              measures={widget.query.measures}
              frozen={definitions}
            />
          )}
        </CardTitle>
        {widget.type !== "text" && widget.description && (
          <CardDescription>{widget.description}</CardDescription>
        )}
        {result && widget.type !== "text" && (
          <CardAction className="flex items-center gap-1 print:hidden">
            {page && (
              <Link
                href={`${base}/${page}`}
                className="p-1 text-muted-foreground hover:text-foreground"
                aria-label="Open the records behind this widget"
                title="Open the records"
              >
                <ExternalLink className="size-3.5" />
              </Link>
            )}
            <ExportCsvButton
              name={widget.title || widget.id}
              rows={() => Promise.resolve(resultCsv(result))}
              label="CSV"
            />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-4">
        {widget.type === "text" ? (
          <p className="text-sm whitespace-pre-wrap">{widget.text}</p>
        ) : loading ? (
          <div className="h-24 animate-pulse rounded-md bg-muted" aria-label="Loading" />
        ) : !data ? null : data.status === "no_access" ? (
          <Tile icon={<Lock className="size-4" />}>No access: this widget uses data you can't read.</Tile>
        ) : data.status === "error" ? (
          <Tile icon={<TriangleAlert className="size-4 text-destructive" />}>
            This widget could not be loaded. {data.message}
          </Tile>
        ) : !result ? null : result.rows.length === 0 ? (
          <Tile>No data for this period.</Tile>
        ) : (
          <WidgetBody widget={widget} result={result} base={base} workspaceCurrency={workspaceCurrency} />
        )}
        {result?.truncated && (
          <p className="mt-2 text-xs text-muted-foreground">Showing the first {result.rows.length} rows.</p>
        )}
        {result?.compareTruncated && (
          <p className="mt-1 text-xs text-muted-foreground">
            Some comparison values are missing: too many groups.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-16 items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function WidgetBody({
  widget,
  result,
  base,
  workspaceCurrency,
}: {
  widget: Exclude<BiWidget, { type: "text" }>;
  result: BiResult;
  base: string;
  workspaceCurrency: string;
}) {
  switch (widget.type) {
    case "kpi":
      return <Kpi widget={widget} result={result} workspaceCurrency={workspaceCurrency} />;
    case "line":
    case "bar":
    case "stacked_bar":
      return <SeriesChart widget={widget} result={result} workspaceCurrency={workspaceCurrency} />;
    case "donut":
      return <Donut result={result} workspaceCurrency={workspaceCurrency} />;
    case "pivot": {
      const pivot = pivotData(result);
      return pivot ? (
        <Pivot pivot={pivot} result={result} workspaceCurrency={workspaceCurrency} />
      ) : (
        <ResultTable result={result} base={base} workspaceCurrency={workspaceCurrency} />
      );
    }
    case "table":
      return <ResultTable result={result} base={base} workspaceCurrency={workspaceCurrency} />;
  }
}

function Kpi({
  widget,
  result,
  workspaceCurrency,
}: {
  widget: Exclude<BiWidget, { type: "text" }>;
  result: BiResult;
  workspaceCurrency: string;
}) {
  const measure = result.columns.find((c) => c.kind === "measure")!;
  const row = result.rows[0]!;
  const value = row[measure.key] ?? null;
  const change = measure.compareKey ? delta(value, row[measure.compareKey] ?? null) : null;
  const good = widget.display?.goodDirection ?? "up";
  const better = change !== null && change !== 0 && change > 0 === (good === "up");
  return (
    <div className="flex flex-col gap-1">
      <div className="text-3xl font-semibold tabular-nums">
        {formatMeasure(measure.unit, value, rowCurrency(result, row, workspaceCurrency))}
      </div>
      {measure.compareKey && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {change === null ? (
            <span>
              {typeof row[measure.compareKey] === "number"
                ? `vs ${formatMeasure(measure.unit, row[measure.compareKey] ?? null, rowCurrency(result, row, workspaceCurrency))} before`
                : "No comparison"}
            </span>
          ) : (
            <>
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium",
                  change === 0 || better ? "text-foreground" : "text-destructive",
                )}
              >
                {change > 0 ? (
                  <ArrowUpRight className="size-3.5" />
                ) : change < 0 ? (
                  <ArrowDownRight className="size-3.5" />
                ) : null}
                {change > 0 ? "+" : ""}
                {(change * 100).toFixed(1)}%
              </span>
              <span>
                vs{" "}
                {formatMeasure(
                  measure.unit,
                  row[measure.compareKey] ?? null,
                  rowCurrency(result, row, workspaceCurrency),
                )}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SeriesChart({
  widget,
  result,
  workspaceCurrency,
}: {
  widget: Exclude<BiWidget, { type: "text" }>;
  result: BiResult;
  workspaceCurrency: string;
}) {
  const data = chartData(result, widget.display);
  const config: ChartConfig = Object.fromEntries(
    data.series.map((s) => [s.key, { label: s.label, color: s.color }]),
  );
  const currency = result.currency ?? workspaceCurrency;
  const format = (v: number) => formatMeasure(data.measure.unit, v, currency);
  const axis = (v: number) => formatAxis(data.measure.unit, v, currency);
  const showLegend = data.series.length > 1;
  const stacked = widget.type === "stacked_bar";
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      {widget.type === "line" ? (
        <LineChart accessibilityLayer data={data.points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={axis}
            allowDecimals={data.measure.unit !== "count"}
          />
          <ChartTooltip content={<ChartTooltipContent valueFormatter={format} />} />
          {showLegend && <ChartLegend content={<ChartLegendContent />} />}
          {data.series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              dot={data.points.length <= 24 ? { r: 3 } : false}
              connectNulls
            />
          ))}
        </LineChart>
      ) : (
        <BarChart
          accessibilityLayer
          data={data.points}
          barGap={2}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={8} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={axis}
            allowDecimals={data.measure.unit !== "count"}
          />
          <ChartTooltip content={<ChartTooltipContent valueFormatter={format} />} />
          {showLegend && <ChartLegend content={<ChartLegendContent />} />}
          {data.series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={`var(--color-${s.key})`}
              stackId={stacked ? "stack" : undefined}
              radius={stacked ? (i === data.series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]}
              stroke={stacked ? "var(--card)" : undefined}
              strokeWidth={stacked ? 1 : 0}
            />
          ))}
        </BarChart>
      )}
    </ChartContainer>
  );
}

function Donut({ result, workspaceCurrency }: { result: BiResult; workspaceCurrency: string }) {
  const { slices, measure } = donutData(result);
  const config: ChartConfig = Object.fromEntries(
    slices.map((s) => [s.key, { label: s.name, color: s.color }]),
  );
  const currency = result.currency ?? workspaceCurrency;
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <ChartContainer config={config} className="aspect-square h-44">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                nameKey="key"
                valueFormatter={(v: number) => formatMeasure(measure.unit, v, currency)}
                hideLabel
              />
            }
          />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="key"
            innerRadius="55%"
            strokeWidth={2}
            stroke="var(--card)"
          >
            {slices.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="flex flex-col gap-1 text-sm">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span>{s.name}</span>
            <span className="text-muted-foreground tabular-nums">
              {formatMeasure(measure.unit, s.value, currency)} (
              {total ? Math.round((s.value / total) * 100) : 0}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultTable({
  result,
  base,
  workspaceCurrency,
}: {
  result: BiResult;
  base: string;
  workspaceCurrency: string;
}) {
  return (
    <div className="max-h-96 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {result.columns.map((c) => (
              <TableHead key={c.key} className={c.kind === "measure" ? "text-right" : undefined}>
                {c.label}
              </TableHead>
            ))}
            {result.columns
              .filter((c) => c.compareKey)
              .map((c) => (
                <TableHead key={c.compareKey} className="text-right">
                  {c.label} (before)
                </TableHead>
              ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((row, i) => (
            <TableRow key={i}>
              {result.columns.map((c) => {
                if (c.kind === "measure") {
                  return (
                    <TableCell key={c.key} className="text-right tabular-nums">
                      {formatMeasure(c.unit, row[c.key] ?? null, rowCurrency(result, row, workspaceCurrency))}
                    </TableCell>
                  );
                }
                const label = formatDimension(c, row[c.key] ?? null);
                const id = c.idKey ? row[c.idKey] : null;
                const page = REFERENCE_PAGES[c.key];
                return (
                  <TableCell key={c.key}>
                    {page && typeof id === "string" ? (
                      <Link href={`${base}/${page}/${id}`} className="hover:underline">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </TableCell>
                );
              })}
              {result.columns
                .filter((c) => c.compareKey)
                .map((c) => (
                  <TableCell key={c.compareKey} className="text-right text-muted-foreground tabular-nums">
                    {formatMeasure(
                      c.unit,
                      row[c.compareKey!] ?? null,
                      rowCurrency(result, row, workspaceCurrency),
                    )}
                  </TableCell>
                ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Pivot({
  pivot,
  result,
  workspaceCurrency,
}: {
  pivot: NonNullable<ReturnType<typeof pivotData>>;
  result: BiResult;
  workspaceCurrency: string;
}) {
  const currency = result.currency ?? workspaceCurrency;
  return (
    <div className="max-h-96 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              {pivot.rowDim.label} / {pivot.colDim.label}
            </TableHead>
            {pivot.colLabels.map((c) => (
              <TableHead key={c} className="text-right">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pivot.rowLabels.map((r) => (
            <TableRow key={r}>
              <TableCell>{r}</TableCell>
              {pivot.colLabels.map((c) => (
                <TableCell key={c} className="text-right tabular-nums">
                  {formatMeasure(pivot.measure.unit, pivot.cell(r, c), currency)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * How each figure on a widget is defined, on hover or focus: the catalogue's definition of every
 * measure, and for certified metrics their version.
 */
export type FrozenDefinitions = Record<string, { label: string; definition: string; version?: string }>;

function MeasureDefinitions({
  dataset,
  measures,
  frozen,
}: {
  dataset: string;
  measures: readonly string[];
  frozen?: FrozenDefinitions;
}) {
  const declared = frozen
    ? measures.flatMap((id) => {
        const d = frozen[`${dataset}.${id}`];
        return d
          ? [
              {
                id,
                label: d.label,
                description: d.definition,
                certified: d.version ? { version: d.version } : undefined,
              },
            ]
          : [];
      })
    : (biDataset(dataset)?.measures.filter((m) => measures.includes(m.id)) ?? []);
  if (declared.length === 0) return null;
  const certified = declared.some((m) => m.certified);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground print:hidden"
          aria-label={certified ? "Certified metric: how it is defined" : "How this is defined"}
        >
          {certified ? <BadgeCheck className="size-3.5" /> : <Info className="size-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <dl className="flex flex-col gap-2">
          {declared.map((m) => (
            <div key={m.id}>
              <dt className="font-medium">
                {m.label}
                {m.certified && ` · certified, ${m.certified.version}`}
              </dt>
              <dd>{m.description}</dd>
            </div>
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}
