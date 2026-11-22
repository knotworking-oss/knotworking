"use client";

import { addDays } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { ChevronLeft, ChevronRight, Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DowntimeDialog, VoidDialog, type VoidTarget } from "@/components/performance-dialogs";
import type { ProductionDowntimeList, ProductionPerformance } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-store";

const dayHead = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 1000) / 10}%`);
const ALL = "all";

/**
 * Production → Performance: OEE per line per day by written definitions, downtime and rejects by
 * reason, standard against actual labour and, for costing readers, line hours at absorption rates.
 */
export function PerformanceView({
  slug,
  today,
  from,
  lineId,
  lines,
  performance,
  downtime,
}: {
  slug: string;
  today: string;
  from: string;
  lineId: string | null;
  lines: { id: string; name: string; active: boolean }[];
  performance: ProductionPerformance;
  downtime: ProductionDowntimeList;
}) {
  const router = useRouter();
  const canWrite = useWorkspace().can("production", "write");
  const base = `/${slug}/production`;
  const href = (f: string, l: string | null) => `${base}/performance?from=${f}${l ? `&line=${l}` : ""}`;
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<VoidTarget | null>(null);
  const defs = performance.definitions;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" asChild aria-label="Previous week">
            <Link href={href(addDays(from, -7), lineId)}>
              <ChevronLeft />
            </Link>
          </Button>
          <Button variant="outline" size="icon" asChild aria-label="Next week">
            <Link href={href(addDays(from, 7), lineId)}>
              <ChevronRight />
            </Link>
          </Button>
          <h2 className="text-lg font-semibold tracking-tight">
            {dayHead(from)} to {dayHead(addDays(from, 6))}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={lineId ?? ALL} onValueChange={(v) => router.push(href(from, v === ALL ? null : v))}>
            <SelectTrigger aria-label="Line" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All lines</SelectItem>
                {lines.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                    {!l.active && " (inactive)"}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {canWrite && lines.some((l) => l.active) && (
            <Button onClick={() => setRecording(true)}>
              <Plus data-icon="inline-start" /> Record downtime
            </Button>
          )}
        </div>
      </div>

      {performance.lines.length === 0 && (
        <p className="text-sm text-muted-foreground">No production lines yet.</p>
      )}

      {!lineId && performance.lines.length > 1 && (
        <Card>
          <CardContent className="text-sm">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
              <Stat label="Site OEE" value={pct(performance.site.oee)} strong />
              <Stat
                label="Planned production"
                value={`${Math.round((performance.site.plannedProductionMinutes / 60) * 10) / 10} h across every line`}
              />
            </dl>
          </CardContent>
        </Card>
      )}

      {performance.lines.map((line) => (
        <Card key={line.id}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {line.name}
              {!line.active && <Badge variant="outline">Inactive</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 text-sm">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 lg:grid-cols-6">
              <Stat label="OEE" value={pct(line.totals.oee)} strong />
              <Stat label="Availability" value={pct(line.totals.availability)} />
              <Stat label="Performance" value={pct(line.totals.performance)} />
              <Stat label="Quality" value={pct(line.totals.quality)} />
              <Stat
                label="Run time"
                value={`${Math.round((line.totals.runMinutes / 60) * 10) / 10} h of ${Math.round((line.totals.plannedProductionMinutes / 60) * 10) / 10} h planned`}
              />
              <Stat
                label="Labour"
                value={`${line.totals.labour.actualPersonHours} of ${line.totals.labour.standardPersonHours} standard person-h`}
              />
            </dl>
            {line.totals.warnings.length > 0 && (
              <ul className="flex flex-col gap-1 text-destructive">
                {line.totals.warnings.map((w) => (
                  <li key={w} className="flex items-center gap-2">
                    <TriangleAlert className="size-4 shrink-0" />
                    {w}
                  </li>
                ))}
              </ul>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] border-collapse tabular-nums">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Day</th>
                    <th className="px-2 py-2 text-right font-medium">Planned</th>
                    <th className="px-2 py-2 text-right font-medium">Planned down</th>
                    <th className="px-2 py-2 text-right font-medium">Unplanned down</th>
                    <th className="px-2 py-2 text-right font-medium">Availability</th>
                    <th className="px-2 py-2 text-right font-medium">Performance</th>
                    <th className="px-2 py-2 text-right font-medium">Quality</th>
                    <th className="px-2 py-2 text-right font-medium">OEE</th>
                    <th className="py-2 pl-2 text-right font-medium">Labour (actual / std)</th>
                  </tr>
                </thead>
                <tbody>
                  {line.days.map((d) => (
                    <tr
                      key={d.date}
                      className={`border-b last:border-b-0 ${d.date === today ? "font-medium" : ""}`}
                    >
                      <td className="py-1.5 pr-3">
                        <Link
                          href={`${base}/schedule/day?line=${line.id}&date=${d.date}`}
                          className="hover:underline"
                        >
                          {dayHead(d.date)}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {d.scheduled ? (
                          `${d.plannedProductionMinutes} min`
                        ) : (
                          <span className="text-muted-foreground">Not scheduled</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">{d.plannedDowntimeMinutes || ""}</td>
                      <td className="px-2 py-1.5 text-right">
                        {d.unplannedDowntimeMinutes || ""}
                        {d.unscheduledDowntimeMinutes > 0 && (
                          <span
                            className="text-muted-foreground"
                            title="Logged on a day with nothing scheduled: not counted in OEE"
                          >
                            {d.unscheduledDowntimeMinutes} unscheduled
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">{pct(d.availability)}</td>
                      <td className="px-2 py-1.5 text-right">{pct(d.performance)}</td>
                      <td className="px-2 py-1.5 text-right">{pct(d.quality)}</td>
                      <td className="px-2 py-1.5 text-right font-medium">{pct(d.oee)}</td>
                      <td className="py-1.5 pl-2 text-right">
                        {d.labour.actualPersonHours || d.labour.standardPersonHours
                          ? `${d.labour.actualPersonHours} / ${d.labour.standardPersonHours}`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <section className="flex flex-col gap-1">
                <h3 className="font-medium">Downtime by reason</h3>
                {line.downtimeByReason.length === 0 ? (
                  <p className="text-muted-foreground">None recorded.</p>
                ) : (
                  <ul className="flex flex-col divide-y">
                    {line.downtimeByReason.map((r) => (
                      <li key={r.reason} className="flex justify-between gap-2 py-1.5">
                        <span>
                          {r.label} <span className="text-muted-foreground">({r.category})</span>
                        </span>
                        <span className="tabular-nums">
                          {r.minutes} min · {r.events} {r.events === 1 ? "stop" : "stops"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="flex flex-col gap-1">
                <h3 className="font-medium">Rejects by reason</h3>
                {line.rejectsByReason.length === 0 ? (
                  <p className="text-muted-foreground">None recorded.</p>
                ) : (
                  <ul className="flex flex-col divide-y">
                    {line.rejectsByReason.map((r) => (
                      <li key={r.reason} className="flex justify-between gap-2 py-1.5">
                        <span>{r.label}</span>
                        <span className="tabular-nums">
                          {r.idealMinutes} min of output · {r.records}{" "}
                          {r.records === 1 ? "record" : "records"}
                          {r.unrated > 0 && ` (${r.unrated} without a rate)`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {line.cost && (
              <section className="flex flex-col gap-1">
                <h3 className="font-medium">Line hours at absorption rates</h3>
                <p className="tabular-nums">
                  Standard {line.cost.standardHours} h = {line.cost.standardCost.toFixed(2)}; actual{" "}
                  {line.cost.actualHours} h = {line.cost.actualCost.toFixed(2)};{" "}
                  <span className={line.cost.variance > 0 ? "text-destructive" : ""}>
                    variance {line.cost.variance > 0 ? "+" : ""}
                    {line.cost.variance.toFixed(2)}
                  </span>
                  {line.cost.batchesLeftOut > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({line.cost.batchesLeftOut} batch{line.cost.batchesLeftOut === 1 ? "" : "es"} not
                      costed: no rate, not completed or no absorption rate)
                    </span>
                  )}
                </p>
              </section>
            )}
          </CardContent>
        </Card>
      ))}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Downtime this week</h3>
        {downtime.downtime.length === 0 ? (
          <p className="text-sm text-muted-foreground">None recorded.</p>
        ) : (
          <Card className="py-0">
            <ul className="divide-y text-sm">
              {downtime.downtime.map((d) => (
                <li
                  key={d.id}
                  className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2 ${d.voidedAt ? "opacity-60" : ""}`}
                >
                  <span className="flex flex-col">
                    <span className={d.voidedAt ? "line-through" : ""}>
                      {dayHead(d.occurredOn)} · {d.lineName} · {d.minutes} min · {d.reasonLabel}{" "}
                      <Badge variant="outline">{d.category === "planned" ? "Planned" : "Unplanned"}</Badge>
                      {d.note && <span className="text-muted-foreground"> · {d.note}</span>}
                    </span>
                    {d.voidedAt && (
                      <span className="text-xs text-muted-foreground">
                        Voided{d.voidedByName ? ` by ${d.voidedByName}` : ""}: {d.voidReason}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {d.recordedByName}
                    {canWrite && !d.voidedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setVoiding({ kind: "downtime", id: d.id, label: `${d.minutes} min of downtime` })
                        }
                      >
                        Void
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">
          How these figures are worked out ({defs.version})
        </summary>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
          <Def term="Planned production time" text={defs.plannedProductionTime} />
          <Def term="Run time" text={defs.runTime} />
          <Def term="Availability" text={defs.availability} />
          <Def term="Performance" text={defs.performance} />
          <Def term="Quality" text={defs.quality} />
          <Def term="OEE" text={defs.oee} />
          <Def term="Good output" text={defs.goodOutput} />
          {performance.costBasis && <Def term="Line cost" text={performance.costBasis} />}
        </dl>
      </details>

      {recording && (
        <DowntimeDialog
          slug={slug}
          lines={lines.filter((l) => l.active)}
          lineId={lines.some((l) => l.id === lineId && l.active) ? lineId! : undefined}
          date={today >= from && today <= addDays(from, 6) ? today : from}
          onClose={() => setRecording(false)}
        />
      )}
      {voiding && <VoidDialog slug={slug} target={voiding} onClose={() => setVoiding(null)} />}
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${strong ? "text-lg font-semibold" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

function Def({ term, text }: { term: string; text: string }) {
  return (
    <>
      <dt className="font-medium">{term}</dt>
      <dd className="text-muted-foreground">{text}</dd>
    </>
  );
}
