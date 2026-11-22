"use client"

import { estimateVariance, formatMinutes, formatVariance } from "@knotworking/core"
import { cn } from "@knotworking/ui/lib/utils"
import { Minus, TrendingDown, TrendingUp } from "lucide-react"
import * as React from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table"

/** One row of a time report: what the API returns per group, with the name as renderable content. */
interface TimeReportRow {
  id: string
  /** The group's name, or a link to it. */
  label: React.ReactNode
  loggedMinutes: number
  entryCount: number
  /** Time estimate of the group's tasks, or null when there is none (or it can't be split). */
  estimateMinutes: number | null
  /** Logged time on the estimated tasks only: the figure to hold against the estimate. */
  loggedOnEstimatedMinutes: number
}

interface TimeReportTotals {
  loggedMinutes: number
  entryCount: number
  estimateMinutes: number
  loggedOnEstimatedMinutes: number
}

/**
 * Logged time against the estimate: "+15m over" in the destructive colour with an up arrow,
 * "1h under" muted with a down arrow, "on estimate" muted. Nothing to compare shows a dash.
 * The words and icon carry the meaning, so it doesn't rely on colour.
 */
function EstimateVariance({
  logged,
  estimate,
  className,
}: {
  /** Logged time on the estimated tasks. */
  logged: number
  estimate: number | null
  className?: string
}) {
  if (estimate === null || estimate <= 0) {
    return (
      <span
        data-slot="estimate-variance"
        className={cn("text-muted-foreground", className)}
        aria-label="No estimate to compare"
      >
        –
      </span>
    )
  }
  const { minutes, state } = estimateVariance(logged, estimate)
  const Icon = state === "over" ? TrendingUp : state === "under" ? TrendingDown : Minus
  return (
    <span
      data-slot="estimate-variance"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        state === "over" ? "font-medium text-destructive" : "text-muted-foreground",
        className
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {formatVariance(minutes)}
    </span>
  )
}

/**
 * Time report table: per group the entries, logged time, estimate and how far over or under the
 * estimate it is, then a totals row. Presentational: the page decides what a group is.
 */
function TimeReportTable({
  rows,
  totals,
  groupLabel,
  className,
}: {
  rows: readonly TimeReportRow[]
  totals: TimeReportTotals
  /** Heading of the first column: "Project", "Person", "Task" or "Day". */
  groupLabel: string
  className?: string
}) {
  return (
    <Table data-slot="time-report-table" className={className}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{groupLabel}</TableHead>
          <TableHead className="text-right">Entries</TableHead>
          <TableHead className="text-right">Logged</TableHead>
          <TableHead className="text-right">Estimate</TableHead>
          <TableHead className="text-right">Against estimate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="max-w-72 truncate font-medium">{row.label}</TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">
              {row.entryCount}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatMinutes(row.loggedMinutes)}</TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">
              {row.estimateMinutes === null ? "–" : formatMinutes(row.estimateMinutes)}
            </TableCell>
            <TableCell className="text-right">
              <EstimateVariance logged={row.loggedOnEstimatedMinutes} estimate={row.estimateMinutes} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className="text-right tabular-nums">{totals.entryCount}</TableCell>
          <TableCell className="text-right tabular-nums">{formatMinutes(totals.loggedMinutes)}</TableCell>
          <TableCell className="text-right tabular-nums">
            {totals.estimateMinutes > 0 ? formatMinutes(totals.estimateMinutes) : "–"}
          </TableCell>
          <TableCell className="text-right">
            <EstimateVariance
              logged={totals.loggedOnEstimatedMinutes}
              estimate={totals.estimateMinutes > 0 ? totals.estimateMinutes : null}
            />
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}

export { EstimateVariance, TimeReportTable }
export type { TimeReportRow, TimeReportTotals }
