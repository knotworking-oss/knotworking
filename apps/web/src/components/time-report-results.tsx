import { formatMinutes } from "@knotworking/core";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@knotworking/ui/components/empty";
import { TimeReportTable, type TimeReportRow } from "@knotworking/ui/components/time-report-table";
import Link from "next/link";
import type { TimeReport } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { formatReportRange, groupByLabels } from "@/lib/time-report";

/** The report for the page's filters: a summary line, the table (or an empty state) and a note on estimates. */
export function TimeReportResults({ report, slug }: { report: TimeReport; slug: string }) {
  const rows: TimeReportRow[] = report.groups.map((g) => {
    const href =
      report.groupBy === "project" && g.key
        ? `/${slug}/projects/${g.key}`
        : report.groupBy === "task" && g.key
          ? `/${slug}/task/${g.key}`
          : null;
    const text = report.groupBy === "day" && g.key ? formatLongDate(g.key) : g.name;
    return {
      id: g.key ?? "none",
      label: href ? (
        <Link href={href} className="hover:underline">
          {text}
        </Link>
      ) : (
        text
      ),
      loggedMinutes: g.loggedMinutes,
      entryCount: g.entryCount,
      estimateMinutes: g.estimateMinutes,
      loggedOnEstimatedMinutes: g.loggedOnEstimatedMinutes,
    };
  });

  if (rows.length === 0) {
    return (
      <Empty className="mt-10">
        <EmptyHeader>
          <EmptyTitle>No time logged</EmptyTitle>
          <EmptyDescription>
            Nothing was logged between {formatReportRange(report.from, report.to)} with these filters. Running
            timers count once they are stopped.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const splitsEstimate = report.groupBy === "project" || report.groupBy === "task";
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground" data-slot="time-report-summary">
        <span className="font-medium text-foreground tabular-nums">
          {formatMinutes(report.totals.loggedMinutes)}
        </span>{" "}
        logged across {report.totals.taskCount} {report.totals.taskCount === 1 ? "task" : "tasks"} ·{" "}
        {formatReportRange(report.from, report.to)}
      </p>
      <div className="rounded-lg border">
        <TimeReportTable rows={rows} totals={report.totals} groupLabel={groupByLabels[report.groupBy]} />
      </div>
      <p className="text-xs text-muted-foreground">
        Estimates are per task and cover its whole life, while logged time is only what falls in this period;
        compare them over a period that covers the work. Time on tasks without an estimate is counted in
        Logged but not held against an estimate.
        {splitsEstimate
          ? ""
          : " Estimates can't be split between people or days, so only the total is compared."}
      </p>
    </div>
  );
}
