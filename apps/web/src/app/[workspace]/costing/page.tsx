import { costingPeriodEnd, costingPeriods, hasModuleLevel, type CostingPeriod } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import type { Metadata } from "next";
import Link from "next/link";
import { EstimatedBadge, formatCost, formatUnitCost, VarianceValue } from "@/components/costing-badges";
import { CostingNav } from "@/components/costing-nav";
import { PageHeader } from "@/components/page-header";
import { stackedTable } from "@/components/stacked-table";
import { formatAmount } from "@/components/stock-badges";
import { getBootstrap, getCostingReport, getWorkspaceCurrency, getWorkspaceToday } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { PeriodCloseControls } from "./period-close-button";

export const metadata: Metadata = { title: "Standard against actual" };

const BOUND = /^(\d{4}-\d{2}(-\d{2})?|\d{4}-?W\d{1,2})$/i;

const percent = (value: number | null) =>
  value === null ? "—" : `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;

/**
 * Standard against actual by product and period (costing module): completed batches by completion
 * date, actual cost against the standard cost of what was made, with the price, usage and yield
 * variances.
 */
export default async function CostingReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const currency = await getWorkspaceCurrency(slug);
  const today = await getWorkspaceToday(slug);
  const boot = await getBootstrap(slug);
  const canManage = hasModuleLevel(boot.modules.find((m) => m.id === "costing")?.access, "manage");
  const period: CostingPeriod = costingPeriods.find((p) => p === search.period) ?? "month";
  const from = BOUND.test(search.from ?? "") ? search.from : undefined;
  const to = BOUND.test(search.to ?? "") ? search.to : undefined;
  const { data, error } = await getCostingReport(slug, {
    period,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const exportHref = (kind: string) =>
    `/api/v1/workspaces/${slug}/costing/export.csv?${new URLSearchParams({ kind, period, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`;
  const periodHref = (p: CostingPeriod) =>
    `/${slug}/costing?${new URLSearchParams({ period: p, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`;

  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Costing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <CostingNav slug={slug} />
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Standard against actual</h2>
            {data && (
              <p className="text-sm text-muted-foreground">
                {formatLongDate(data.from)} to {formatLongDate(data.to)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Button asChild variant="outline" size="sm">
              <a href={exportHref("journal")}>Export cost journal (CSV)</a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={exportHref("batches")}>Export batches (CSV)</a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={exportHref("adjustments")}>Export waste and adjustments (CSV)</a>
            </Button>
          </div>
          <form className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="period" value={period} />
            <div className="flex gap-1">
              {costingPeriods.map((p) => (
                <Button key={p} asChild size="sm" variant={p === period ? "secondary" : "ghost"}>
                  <Link href={periodHref(p)}>{p === "week" ? "Weeks" : "Months"}</Link>
                </Button>
              ))}
            </div>
            <Field className="w-44">
              <FieldLabel htmlFor="costing-from">From</FieldLabel>
              <Input id="costing-from" name="from" type="date" defaultValue={data?.from ?? ""} />
            </Field>
            <Field className="w-44">
              <FieldLabel htmlFor="costing-to">To</FieldLabel>
              <Input id="costing-to" name="to" type="date" defaultValue={data?.to ?? ""} />
            </Field>
            <Button type="submit" variant="outline">
              Show
            </Button>
          </form>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data && data.totals.batches === 0 && (
            <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              No batches were completed in this period.
            </p>
          )}
          {data && data.totals.batches > 0 && (
            <>
              <Card className="overflow-x-auto py-0">
                <Table className={stackedTable}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{period === "week" ? "Week" : "Month"}</TableHead>
                      <TableHead className="text-right">Batches</TableHead>
                      <TableHead className="text-right">Actual cost</TableHead>
                      <TableHead className="text-right">Standard</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                      <TableHead className="text-right">Labour and overhead</TableHead>
                      <TableHead className="text-right">Waste and adjustments</TableHead>
                      <TableHead className="pr-4 text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...data.periods, { periodStart: "total", period: "Total", totals: data.totals }].map(
                      (p) => (
                        <TableRow
                          key={p.periodStart}
                          className={p.periodStart === "total" ? "font-medium" : undefined}
                        >
                          <TableCell className="pl-4 tabular-nums" data-primary>
                            {p.period}
                          </TableCell>
                          <TableCell data-label="Batches" className="text-right tabular-nums">
                            {p.totals.batches}
                            {p.totals.incompleteBatches > 0 && (
                              <span
                                className="ml-1 text-xs text-label-orange"
                                title="Left out of the comparison"
                              >
                                ({p.totals.incompleteBatches} incomplete)
                              </span>
                            )}
                          </TableCell>
                          <TableCell data-label="Actual cost" className="text-right tabular-nums">
                            {p.totals.batches ? formatCost(p.totals.actualCost, currency) : "—"}
                          </TableCell>
                          <TableCell data-label="Standard" className="text-right tabular-nums">
                            {p.totals.standardCost === null
                              ? "—"
                              : formatCost(p.totals.standardCost, currency)}
                          </TableCell>
                          <TableCell data-label="Variance" className="text-right">
                            <VarianceValue
                              value={p.totals.variance.total}
                              percent={p.totals.variancePercent}
                              currency={currency}
                            />
                          </TableCell>
                          <TableCell data-label="Labour and overhead" className="text-right tabular-nums">
                            {p.totals.batches ? formatCost(p.totals.conversion.total, currency) : "—"}
                          </TableCell>
                          <TableCell data-label="Waste and adjustments" className="text-right tabular-nums">
                            {"adjustments" in p
                              ? formatCost(p.adjustments.total, currency)
                              : formatCost(data.adjustments.total, currency)}
                          </TableCell>
                          <TableCell data-label="Status" className="pr-4 text-right">
                            {"frozen" in p ? (
                              <PeriodCloseControls
                                slug={slug}
                                period={period}
                                periodStart={p.periodStart}
                                label={p.period}
                                ended={costingPeriodEnd(p.periodStart, period) < today}
                                canManage={canManage}
                                frozen={
                                  p.frozen
                                    ? {
                                        closeId: p.frozen.closeId,
                                        closedAt: p.frozen.closedAt,
                                        closedBy: p.frozen.closedBy,
                                        changedSince: p.frozen.drift.changed,
                                      }
                                    : null
                                }
                              />
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ),
                    )}
                  </TableBody>
                </Table>
              </Card>

              <Card className="overflow-x-auto py-0">
                <Table className={stackedTable}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Product</TableHead>
                      <TableHead>{period === "week" ? "Week" : "Month"}</TableHead>
                      <TableHead className="text-right">Batches</TableHead>
                      <TableHead className="text-right">Produced</TableHead>
                      <TableHead className="text-right">Yield</TableHead>
                      <TableHead className="text-right">Actual cost</TableHead>
                      <TableHead className="text-right">Per unit</TableHead>
                      <TableHead className="text-right">Standard per unit</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Usage</TableHead>
                      <TableHead
                        className="text-right"
                        title="Part of usage: other proportions than the plan's"
                      >
                        Mix
                      </TableHead>
                      <TableHead className="text-right">Yield</TableHead>
                      <TableHead className="pr-4 text-right">Total variance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => (
                      <TableRow key={`${row.itemId}:${row.periodStart}`} className="align-top">
                        <TableCell className="pl-4" data-primary>
                          <Link
                            className="font-medium hover:underline"
                            href={`/${slug}/costing/batches?product=${row.itemId}`}
                          >
                            {row.item.code}
                          </Link>{" "}
                          <span className="text-muted-foreground">{row.item.name}</span>
                        </TableCell>
                        <TableCell data-label="Period" className="tabular-nums">
                          {row.period}
                        </TableCell>
                        <TableCell data-label="Batches" className="text-right tabular-nums">
                          {row.batches}
                          {row.incompleteBatches > 0 && (
                            <span
                              className="ml-1 text-xs text-label-orange"
                              title="Left out of the comparison"
                            >
                              ({row.incompleteBatches} incomplete)
                            </span>
                          )}
                        </TableCell>
                        <TableCell data-label="Produced" className="text-right tabular-nums">
                          {formatAmount(row.produced)}
                        </TableCell>
                        <TableCell data-label="Yield" className="text-right tabular-nums">
                          {percent(row.yieldPercent)}
                        </TableCell>
                        <TableCell data-label="Actual cost" className="text-right tabular-nums">
                          <span className="inline-flex flex-col items-end gap-0.5">
                            {formatCost(row.actualCost, currency)}
                            <EstimatedBadge percent={row.estimatedPercent} />
                          </span>
                        </TableCell>
                        <TableCell data-label="Per unit" className="text-right tabular-nums">
                          {formatUnitCost(row.costPerUnit, row.item.unit, currency)}
                        </TableCell>
                        <TableCell data-label="Standard per unit" className="text-right tabular-nums">
                          {formatUnitCost(row.standardCostPerUnit, row.item.unit, currency)}
                        </TableCell>
                        <TableCell data-label="Price" className="text-right">
                          <VarianceValue value={row.variance.price} currency={currency} />
                        </TableCell>
                        <TableCell data-label="Usage" className="text-right">
                          <VarianceValue value={row.variance.usage} currency={currency} />
                        </TableCell>
                        <TableCell data-label="Mix" className="text-right">
                          <VarianceValue value={row.variance.mix} currency={currency} />
                        </TableCell>
                        <TableCell data-label="Yield variance" className="text-right">
                          <VarianceValue value={row.variance.yield} currency={currency} />
                        </TableCell>
                        <TableCell data-label="Total variance" className="pr-4 text-right">
                          <VarianceValue
                            value={row.variance.total}
                            percent={row.variancePercent}
                            currency={currency}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
