"use client";

import { addDays } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { ChevronLeft, ChevronRight, Factory, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { BatchStatusBadge } from "@/components/production-badges";
import { formatAmount } from "@/components/stock-badges";
import type { ProductionSchedule } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-store";

const dayHead = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * Production → Line schedule: per line and day, the hours of the batches on the line against its
 * capacity. An overloaded day is flagged, never blocked; batches are assigned from the batch page.
 */
export function LineSchedule({
  slug,
  today,
  from,
  schedule,
}: {
  slug: string;
  today: string;
  from: string;
  schedule: ProductionSchedule;
}) {
  const canManage = useWorkspace().can("production", "manage");
  const base = `/${slug}/production`;
  const overloaded = schedule.lines.reduce((t, l) => t + l.overloadedDays, 0);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" asChild aria-label="Previous week">
            <Link href={`${base}/schedule?from=${addDays(from, -7)}`}>
              <ChevronLeft />
            </Link>
          </Button>
          <Button variant="outline" size="icon" asChild aria-label="Next week">
            <Link href={`${base}/schedule?from=${addDays(from, 7)}`}>
              <ChevronRight />
            </Link>
          </Button>
          <h2 className="text-lg font-semibold tracking-tight">
            {dayHead(from)} to {dayHead(addDays(from, 6))}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`${base}?week=${from}`}>Batch schedule</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`${base}/daily-demand`}>Daily demand</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`${base}/performance?from=${from}`}>Performance</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`${base}/lines`}>
              <Factory data-icon="inline-start" /> {canManage ? "Manage lines" : "Lines"}
            </Link>
          </Button>
        </div>
      </div>

      {overloaded > 0 && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="size-4" />
          {overloaded === 1 ? "1 line day is" : `${overloaded} line days are`} planned over capacity. Batches
          are still allowed; move or resize them.
        </p>
      )}

      {schedule.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No production lines yet.{" "}
          {canManage ? "Add one under Manage lines." : "Ask someone with manage access."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <table className="w-full min-w-[56rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Line</th>
                {schedule.days.map((d) => (
                  <th key={d} className={`px-2 py-2 font-medium ${d === today ? "text-foreground" : ""}`}>
                    {dayHead(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedule.lines.map((line) => (
                <tr key={line.id} className="border-b align-top last:border-b-0">
                  <th className="px-3 py-2 text-left font-medium">
                    {line.name}
                    {!line.active && <span className="ml-1 text-xs text-muted-foreground">(inactive)</span>}
                    <span className="block text-xs font-normal text-muted-foreground tabular-nums">
                      {line.hasShifts ? "Shifts set" : `${line.hoursPerDay} h a day`}
                    </span>
                  </th>
                  {line.days.map((day) => (
                    <td key={day.date} className="px-2 py-2">
                      <div className="flex flex-col gap-1">
                        <Link
                          href={`${base}/schedule/day?line=${line.id}&date=${day.date}`}
                          title="Day plan: times, changeovers and a proposed order"
                          className={`tabular-nums hover:underline ${day.overloaded ? "font-medium text-destructive" : day.hours === 0 ? "text-muted-foreground" : ""}`}
                        >
                          {day.hours} / {day.capacityHours} h
                        </Link>
                        <div
                          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                          role="img"
                          aria-label={`${day.loadPercent}% loaded`}
                        >
                          <div
                            className={`h-full ${day.overloaded ? "bg-destructive" : "bg-primary"}`}
                            style={{ width: `${Math.min(day.loadPercent, 100)}%` }}
                          />
                        </div>
                        {day.overloaded && (
                          <Badge className="w-fit border-transparent bg-label-red-bg text-label-red">
                            Over by {Math.round((day.hours - day.capacityHours) * 100) / 100} h
                          </Badge>
                        )}
                        {day.unrated > 0 && (
                          <span className="text-xs text-muted-foreground">{day.unrated} without a rate</span>
                        )}
                        {day.batches.map((b) => (
                          <Link
                            key={b.id}
                            href={`${base}/batches/${b.id}`}
                            className="font-mono text-xs hover:underline"
                            title={`${b.recipe.name}, ${formatAmount(b.planned)}`}
                          >
                            {b.batchCode}
                            <span className="ml-1 font-sans text-muted-foreground">
                              {b.hours === null ? "? h" : `${b.hours} h`}
                            </span>
                          </Link>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Not on a line</h3>
        {schedule.unassigned.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every open batch this week is on a line.</p>
        ) : (
          <Card className="py-0">
            <ul className="divide-y text-sm">
              {schedule.unassigned.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link href={`${base}/batches/${b.id}`} className="font-mono text-xs hover:underline">
                      {b.batchCode}
                    </Link>
                    <BatchStatusBadge status={b.status} />
                    <span>{b.recipe.name}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {b.plannedOn} · {formatAmount(b.planned)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
