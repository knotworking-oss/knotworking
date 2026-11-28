"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import Link from "next/link";
import type { ProductionDailyDemand } from "@/lib/api";

const dayHead = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const qty = (n: number) => (n === 0 ? "" : String(Math.round(n * 100) / 100));

/**
 * Production → Daily demand: per product per day, confirmed sales commitments, planned output and
 * the projected stock from today. Weekly demand (forecasts and entered demand) is listed beside it
 * and never added in.
 */
export function DailyDemandView({
  slug,
  days,
  demand,
}: {
  slug: string;
  days: number;
  demand: ProductionDailyDemand;
}) {
  const base = `/${slug}/production`;
  const { basis } = demand;
  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold tracking-tight">
            {dayHead(demand.from)} to {dayHead(demand.to)}
          </h2>
        </div>
        <div className="flex gap-2">
          {[7, 14, 28].map((n) => (
            <Button key={n} variant={n === days ? "default" : "outline"} size="sm" asChild>
              <Link href={`${base}/daily-demand?days=${n}`}>{n} days</Link>
            </Button>
          ))}
        </div>
      </div>

      {(!basis.salesCommitments || !basis.stock) && (
        <p className="text-sm text-muted-foreground">
          {!basis.salesCommitments && "Sales commitments aren't shown: they need access to Sales. "}
          {!basis.stock && "No projection: it needs access to Stock."}
        </p>
      )}
      {demand.shortItems > 0 && (
        <p className="text-sm text-destructive">
          {demand.shortItems === 1 ? "1 product runs" : `${demand.shortItems} products run`} short in this
          period.
        </p>
      )}

      {demand.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commitments or planned batches in this period.</p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="sticky left-0 bg-card px-3 py-2 font-medium">Product</th>
                <th className="px-2 py-2 font-medium" />
                {demand.days.map((d) => (
                  <th key={d} className="px-2 py-2 text-right font-medium whitespace-nowrap">
                    {dayHead(d)}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">Weekly demand</th>
              </tr>
            </thead>
            <tbody>
              {demand.items.map((row) => (
                <ItemRows key={row.item.id} row={row} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ItemRows({ row }: { row: ProductionDailyDemand["items"][number] }) {
  const lines: { label: string; cell: (d: (typeof row.days)[number]) => React.ReactNode }[] = [
    { label: "Committed", cell: (d) => qty(d.committed) },
    { label: "Planned", cell: (d) => qty(d.planned) },
    ...(row.opening
      ? [
          {
            label: "Projected",
            cell: (d: (typeof row.days)[number]) => (
              <span className={d.short ? "font-medium text-destructive" : ""}>
                {d.projected === null ? "" : Math.round(d.projected * 100) / 100}
              </span>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      {lines.map((line, i) => (
        <tr
          key={line.label}
          className={i === lines.length - 1 ? "border-b align-top last:border-b-0" : "align-top"}
        >
          {i === 0 && (
            <th
              rowSpan={lines.length}
              className="sticky left-0 min-w-44 bg-card px-3 py-2 text-left font-medium"
            >
              <div className="text-sm">{row.item.name}</div>
              <div className="font-mono text-muted-foreground">{row.item.code}</div>
              <div className="font-normal text-muted-foreground">
                {row.baseUnit}
                {row.opening && ` · ${Math.round(row.opening.base * 100) / 100} in stock`}
              </div>
              {row.firstShortDate && (
                <Badge className="mt-1 border-transparent bg-label-red-bg text-label-red">
                  Short from {dayHead(row.firstShortDate)}
                </Badge>
              )}
              {row.overdueCommitted > 0 && (
                <div className="font-normal text-destructive">{row.overdueCommitted} overdue</div>
              )}
              {row.latePlanned > 0 && (
                <div className="font-normal text-muted-foreground">{row.latePlanned} from late batches</div>
              )}
            </th>
          )}
          <td className="px-2 py-1 text-muted-foreground">{line.label}</td>
          {row.days.map((d) => (
            <td key={d.date} className="px-2 py-1 text-right tabular-nums">
              {line.cell(d)}
            </td>
          ))}
          {i === 0 && (
            <td rowSpan={lines.length} className="px-3 py-2 text-muted-foreground">
              {row.weeklyDemand === null
                ? "Needs Demand access"
                : row.weeklyDemand.length === 0
                  ? "None"
                  : row.weeklyDemand.map((w) => (
                      <div key={w.periodStart} className="whitespace-nowrap tabular-nums">
                        {w.week}: {Math.round(w.quantity * 100) / 100}
                      </div>
                    ))}
            </td>
          )}
        </tr>
      ))}
    </>
  );
}
