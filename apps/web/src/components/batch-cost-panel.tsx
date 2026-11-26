import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Coins } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CostSourceBadge,
  EstimatedBadge,
  formatCost,
  formatUnitCost,
  IncompleteCostBadge,
  ProvisionalBadge,
  VarianceValue,
} from "@/components/costing-badges";
import { stackedTable } from "@/components/stacked-table";
import { formatAmount } from "@/components/stock-badges";
import type { BatchCostDetail } from "@/lib/api";
import { recipeTerms } from "@/lib/recipe-terms";

function Figure({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{children}</span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/**
 * A batch's actual cost (costing module): the headline figures, the variances against the recipe
 * version's standard and, unless `compact`, each consumed lot with its source and the materials
 * against the plan. `compact` is the production batch page's summary, linking to the full page.
 */
export function BatchCostPanel({
  slug,
  currency,
  cost,
  compact = false,
  foodItems = true,
}: {
  slug: string;
  /** The workspace's currency. */
  currency: string;
  cost: BatchCostDetail;
  compact?: boolean;
  /** Food items readable: recipe and ingredient wording, else bill of materials and material. */
  foodItems?: boolean;
}) {
  const terms = recipeTerms(foodItems);
  const unit = cost.outputUnit;
  const { variance } = cost;
  return (
    <Card className="py-0">
      <CardHeader className="pt-4">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Coins className="size-4" /> Cost
          {cost.provisional && <ProvisionalBadge />}
          <EstimatedBadge percent={cost.estimatedPercent} />
          {!cost.costComplete && <IncompleteCostBadge codes={cost.missingItemCodes} />}
        </CardTitle>
        {compact && (
          <CardDescription>
            <Link className="underline" href={`/${slug}/costing/batches/${cost.batch.id}`}>
              Cost breakdown
            </Link>
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 pb-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Figure
            label="Actual cost"
            note={
              cost.estimatedCost > 0
                ? `${formatCost(cost.estimatedCost, currency)} at standard cost`
                : "All at prices paid"
            }
          >
            {formatCost(cost.actualCost, currency)}
          </Figure>
          <Figure
            label="Cost per unit"
            note={`Standard ${formatUnitCost(cost.standard.costPerUnit, unit, currency)}`}
          >
            {formatUnitCost(cost.costPerUnit, unit, currency)}
          </Figure>
          <Figure
            label="Yield"
            note={`${formatAmount(cost.produced)} of ${formatAmount(cost.planned)} planned`}
          >
            {cost.yield.percent === null
              ? "—"
              : `${cost.yield.percent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`}
          </Figure>
          <Figure
            label="Against standard"
            note={
              cost.standard.producedCost === null
                ? cost.standard.missingItemCodes.length
                  ? `No standard cost: ${cost.standard.missingItemCodes.join(", ")}`
                  : "No standard to compare"
                : `Standard ${formatCost(cost.standard.producedCost, currency)} for what was made`
            }
          >
            <VarianceValue value={variance.total} percent={cost.variancePercent} currency={currency} />
          </Figure>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          {(
            [
              ["Price", variance.price, "Prices paid against standard prices, for what was used"],
              ["Usage", variance.usage, "Inputs used against what the plan needed, at standard prices"],
              ["Yield", variance.yield, "Output short of (or over) the plan, at the standard cost per unit"],
              ["Total", variance.total, "Actual cost against the standard cost of what was made"],
            ] as const
          ).map(([label, value, hint]) => (
            <div key={label} className="flex items-baseline justify-between gap-2" title={hint}>
              <dt className="text-muted-foreground">{label} variance</dt>
              <dd>
                <VarianceValue value={value} currency={currency} />
              </dd>
            </div>
          ))}
        </dl>

        {cost.operations && (
          <div className="flex flex-col gap-2 border-t pt-3 text-sm">
            <p>
              <span className="font-medium">Work-centre time</span>{" "}
              <span className="tabular-nums">
                {formatCost(cost.operations.actualCost, currency)} for {cost.operations.actualMinutes} min
              </span>{" "}
              <span className="text-muted-foreground">
                (expected {formatCost(cost.operations.expectedCost, currency)} for{" "}
                {cost.operations.expectedMinutes} min) · total with conversion{" "}
                {formatCost(cost.totalCost, currency)}
              </span>
            </p>
            {cost.conversion.total > 0 && cost.operations.actualCost > 0 && (
              <p className="text-muted-foreground">
                The total adds work-centre time to the absorbed labour and overhead: work-centre rates should
                cover only what the absorption rates don&apos;t.
              </p>
            )}
            {!compact && (
              <ol className="divide-y rounded-lg border">
                {cost.operations.operations.map((op) => (
                  <li key={op.jobCardId} className="flex flex-wrap justify-between gap-2 p-2">
                    <Link className="hover:underline" href={`/${slug}/routings/job-cards/${op.jobCardId}`}>
                      {op.position}. {op.name}
                      {op.workCentre && (
                        <span className="text-muted-foreground"> · {op.workCentre.code}</span>
                      )}
                    </Link>
                    <span className="tabular-nums">
                      {op.actualMinutes} min at {formatCost(op.costPerHour, currency)}/h ·{" "}
                      {formatCost(op.actualCost, currency)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {!compact && (
          <>
            <div className="-mx-4 overflow-x-auto border-t">
              <Table className={stackedTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Lot consumed</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Standard</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="pr-4">Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cost.lines.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                        Nothing consumed yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {cost.lines.map((line) => (
                    <TableRow key={line.lotId}>
                      <TableCell className="pl-4" data-primary>
                        <Link
                          href={`/${slug}/stock/lots/${line.lotId}`}
                          className="font-medium hover:underline"
                        >
                          {line.lotCode ?? "—"}
                        </Link>
                      </TableCell>
                      <TableCell data-label="Item">
                        {line.item.code} <span className="text-muted-foreground">{line.item.name}</span>
                      </TableCell>
                      <TableCell data-label="Quantity" className="text-right tabular-nums">
                        {formatAmount(line.quantity)}
                      </TableCell>
                      <TableCell data-label="Unit cost" className="text-right tabular-nums">
                        {formatUnitCost(line.unitCost, line.unit, currency)}
                      </TableCell>
                      <TableCell
                        data-label="Standard"
                        className="text-right text-muted-foreground tabular-nums"
                      >
                        {formatUnitCost(line.standardUnitCost, line.unit, currency)}
                      </TableCell>
                      <TableCell data-label="Cost" className="text-right tabular-nums">
                        {line.cost === null ? "—" : formatCost(line.cost, currency)}
                      </TableCell>
                      <TableCell className="pr-4" data-label="Source">
                        <span className="flex flex-wrap items-center gap-1">
                          <CostSourceBadge
                            source={line.source}
                            reason={line.reason}
                            estimatedPercent={line.estimatedPercent}
                          />
                          {line.sourceBatch && (
                            <Link
                              href={`/${slug}/costing/batches/${line.sourceBatch.id}`}
                              className="text-xs text-muted-foreground hover:underline"
                            >
                              {line.sourceBatch.batchCode}
                            </Link>
                          )}
                          {line.provisional && <ProvisionalBadge />}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="-mx-4 overflow-x-auto border-t">
              <Table className={stackedTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{terms.lineTitle}</TableHead>
                    <TableHead className="text-right">Plan needed</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead className="text-right">Actual cost</TableHead>
                    <TableHead className="text-right">Price variance</TableHead>
                    <TableHead className="pr-4 text-right">Usage variance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cost.materials.map((m) => (
                    <TableRow key={m.itemId}>
                      <TableCell className="pl-4" data-primary>
                        <span className="font-medium">{m.item.code}</span>{" "}
                        <span className="text-muted-foreground">{m.item.name}</span>
                        {!m.inRecipe && (
                          <span className="ml-1 text-xs text-label-orange">Not in {terms.singular}</span>
                        )}
                      </TableCell>
                      <TableCell data-label="Plan needed" className="text-right tabular-nums">
                        {m.required ? formatAmount(m.required) : "—"}
                      </TableCell>
                      <TableCell data-label="Used" className="text-right tabular-nums">
                        {formatAmount(m.consumed)}
                      </TableCell>
                      <TableCell data-label="Actual cost" className="text-right tabular-nums">
                        {m.actualCost === null ? "—" : formatCost(m.actualCost, currency)}
                      </TableCell>
                      <TableCell data-label="Price variance" className="text-right">
                        <VarianceValue value={m.priceVariance} currency={currency} />
                      </TableCell>
                      <TableCell data-label="Usage variance" className="pr-4 text-right">
                        <VarianceValue value={m.usageVariance} currency={currency} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
