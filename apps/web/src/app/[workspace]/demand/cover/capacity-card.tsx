import { formatAmount } from "@/components/stock-badges";
import { Badge } from "@knotworking/ui/components/badge";
import { Card } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import Link from "next/link";
import type { DemandCapacityData } from "@/lib/api";

const statusClass = {
  ok: "text-status-done",
  tight: "text-priority-medium",
  over: "text-priority-urgent",
} as const;

/**
 * Production line capacity against the cover view's shortfall, week by week: hours the lines can
 * run, hours already booked on them, and hours needed to make what is still short. Advisory.
 * Shown to people who can read production.
 */
export function CapacityCard({ slug, capacity }: { slug: string; capacity: DemandCapacityData }) {
  if (!capacity.available) return null;
  return (
    <section className="flex flex-col gap-2 px-4 pb-6">
      <h2 className="font-medium">Line capacity</h2>
      {capacity.lineCount === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active production lines yet.{" "}
          <Link className="underline underline-offset-2" href={`/${slug}/production/lines`}>
            Set up lines
          </Link>{" "}
          to compare demand with capacity.
        </p>
      ) : (
        <>
          <Card className="overflow-x-auto py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week</TableHead>
                  <TableHead className="text-right">Capacity</TableHead>
                  <TableHead className="text-right">Booked</TableHead>
                  <TableHead className="text-right">Needed</TableHead>
                  <TableHead className="text-right">Load</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {capacity.weeks.map((w) => (
                  <TableRow key={w.periodStart}>
                    <TableCell className="font-mono text-xs">{w.week}</TableCell>
                    <TableCell className="text-right tabular-nums">{w.capacityHours} h</TableCell>
                    <TableCell className="text-right tabular-nums">{w.bookedHours} h</TableCell>
                    <TableCell className="text-right tabular-nums">{w.neededHours} h</TableCell>
                    <TableCell className={`text-right tabular-nums ${statusClass[w.status]}`}>
                      {w.loadPercent === null ? "—" : `${w.loadPercent}%`}{" "}
                      {w.status !== "ok" && (
                        <span className="text-xs">{w.status === "over" ? "over" : "tight"}</span>
                      )}
                    </TableCell>
                    <TableCell className="flex flex-wrap gap-1 text-xs">
                      {w.daysOff.length > 0 && (
                        <Badge
                          variant="outline"
                          title={w.daysOff.map((d) => `${d.date} ${d.reason ?? ""}`).join(", ")}
                        >
                          {w.daysOff.length} day{w.daysOff.length === 1 ? "" : "s"} off
                        </Badge>
                      )}
                      {w.batchesOnDaysOff.length > 0 && (
                        <Badge variant="outline" className="text-priority-medium">
                          {w.batchesOnDaysOff.map((b) => b.batchCode).join(", ")} on a day off
                        </Badge>
                      )}
                      {w.unassignedBatches > 0 && (
                        <Badge variant="outline">{w.unassignedBatches} batch(es) on no line</Badge>
                      )}
                      {w.unratedItems > 0 && (
                        <Badge variant="outline">{w.unratedItems} product(s) no line can make</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {capacity.needs.length > 0 && (
            <ul className="text-xs text-muted-foreground">
              {capacity.needs.map((n) => (
                <li key={n.item.id}>
                  {n.item.name}:{" "}
                  {n.rate
                    ? `${formatAmount(n.rate.perHour)} per hour on ${n.rate.lineName}`
                    : "no line has a rate for it"}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
