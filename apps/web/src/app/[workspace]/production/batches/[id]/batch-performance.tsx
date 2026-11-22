"use client";

import { unitCodes, units, type UnitCode } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  DowntimeDialog,
  LabourDialog,
  RejectDialog,
  VoidDialog,
  type VoidTarget,
} from "@/components/performance-dialogs";
import { formatAmount } from "@/components/stock-badges";
import type { BatchPerformance } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-store";

const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 1000) / 10}%`);
const hours = (h: number | null) => (h === null ? "–" : `${h} h`);

/**
 * A batch's performance (3.5.2): good output against rejects, run and standard hours, labour, and
 * the rejects, labour and downtime on record. Records are append-only: void with a reason.
 */
export function BatchPerformancePanel({
  slug,
  performance: p,
  lineId,
  plannedOn,
}: {
  slug: string;
  performance: BatchPerformance;
  lineId: string | null;
  plannedOn: string;
}) {
  const { can } = useWorkspace();
  const running = p.status === "in_progress";
  const completed = p.status === "completed";
  // Started batches take records with write access; signed-off ones only with manage.
  const canRecord = (running && can("production", "write")) || (completed && can("production", "manage"));
  const [dialog, setDialog] = useState<"reject" | "labour" | "downtime" | null>(null);
  const [voiding, setVoiding] = useState<VoidTarget | null>(null);
  const batch = { id: p.batchId, batchCode: p.batchCode };
  const unit = p.good.displayUnit as UnitCode;
  // The item's own unit first, so the default is never a smaller one (mg for a kg product).
  const unitChoices = [
    unit,
    ...unitCodes.filter((u) => u !== unit && units[u].dimension === units[unit].dimension),
  ];
  if (p.status === "planned" || p.status === "cancelled") return null;
  const voidButton = (target: VoidTarget, voided: boolean) =>
    canRecord && !voided ? (
      <Button size="sm" variant="ghost" onClick={() => setVoiding(target)}>
        Void
      </Button>
    ) : null;
  const voidedNote = (r: {
    voidedAt: string | Date | null;
    voidReason: string | null;
    voidedByName: string | null;
  }) =>
    r.voidedAt ? (
      <span className="text-xs text-muted-foreground">
        Voided{r.voidedByName ? ` by ${r.voidedByName}` : ""}: {r.voidReason}
      </span>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-8">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Performance</CardTitle>
          {canRecord && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialog("reject")}>
                <Plus data-icon="inline-start" /> Rejects
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDialog("labour")}>
                <Plus data-icon="inline-start" /> Labour
              </Button>
              {lineId && (
                <Button size="sm" variant="outline" onClick={() => setDialog("downtime")}>
                  <Plus data-icon="inline-start" /> Downtime
                </Button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <Stat label="Good output" value={formatAmount(p.good)} />
            <Stat label="Rejects" value={formatAmount(p.rejected)} />
            <Stat label="First-pass yield" value={pct(p.firstPassYield)} />
            <Stat label="Unplanned downtime" value={`${p.unplannedDowntimeMinutes} min`} />
            <Stat label="Run time (started to completed)" value={hours(p.runHours)} />
            <Stat label="Standard hours" value={hours(p.standardHours)} />
            <Stat
              label="Labour: standard"
              value={p.standardPersonHours === null ? "Not set" : `${p.standardPersonHours} person-h`}
            />
            <Stat label="Labour: actual" value={`${p.actualPersonHours} person-h`} />
          </dl>
          {p.actualRatePerHour && p.ratePerHour && (
            <p className="text-muted-foreground">
              Ran at {formatAmount(p.actualRatePerHour)} an hour against a line rate of{" "}
              {formatAmount(p.ratePerHour)}.
            </p>
          )}

          <Section title="Rejects" empty="No rejects recorded.">
            {p.rejects.map((r) => (
              <li
                key={r.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-2 ${r.voidedAt ? "opacity-60" : ""}`}
              >
                <span className="flex flex-col">
                  <span className={r.voidedAt ? "line-through" : ""}>
                    {formatAmount(r.quantity)} · {r.reasonLabel}
                    {r.note && <span className="text-muted-foreground"> · {r.note}</span>}
                  </span>
                  {voidedNote(r)}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {r.recordedByName}
                  {voidButton(
                    { kind: "reject", id: r.id, label: `${formatAmount(r.quantity)} of rejects` },
                    !!r.voidedAt,
                  )}
                </span>
              </li>
            ))}
          </Section>
          <Section title="Labour" empty="No labour recorded.">
            {p.labour.map((l) => (
              <li
                key={l.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-2 ${l.voidedAt ? "opacity-60" : ""}`}
              >
                <span className="flex flex-col">
                  <span className={l.voidedAt ? "line-through" : ""}>
                    {l.people} {l.people === 1 ? "person" : "people"} × {l.minutes} min = {l.personHours}{" "}
                    person-h
                    {l.note && <span className="text-muted-foreground"> · {l.note}</span>}
                  </span>
                  {voidedNote(l)}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {l.recordedByName}
                  {voidButton(
                    { kind: "labour", id: l.id, label: `${l.personHours} person-hours` },
                    !!l.voidedAt,
                  )}
                </span>
              </li>
            ))}
          </Section>
          <Section title="Downtime during this batch" empty="No downtime recorded against this batch.">
            {p.downtime.map((d) => (
              <li
                key={d.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-2 ${d.voidedAt ? "opacity-60" : ""}`}
              >
                <span className="flex flex-col">
                  <span className={d.voidedAt ? "line-through" : ""}>
                    {d.minutes} min · {d.reasonLabel}{" "}
                    <Badge variant="outline">{d.category === "planned" ? "Planned" : "Unplanned"}</Badge>
                    {d.note && <span className="text-muted-foreground"> · {d.note}</span>}
                  </span>
                  {voidedNote(d)}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {d.recordedByName}
                  {voidButton(
                    { kind: "downtime", id: d.id, label: `${d.minutes} min of downtime` },
                    !!d.voidedAt,
                  )}
                </span>
              </li>
            ))}
          </Section>
        </CardContent>
      </Card>
      {dialog === "reject" && (
        <RejectDialog slug={slug} batch={batch} unitChoices={unitChoices} onClose={() => setDialog(null)} />
      )}
      {dialog === "labour" && <LabourDialog slug={slug} batch={batch} onClose={() => setDialog(null)} />}
      {dialog === "downtime" && lineId && (
        <DowntimeDialog
          slug={slug}
          lines={[]}
          lineId={lineId}
          date={plannedOn}
          batch={batch}
          onClose={() => setDialog(null)}
        />
      )}
      {voiding && <VoidDialog slug={slug} target={voiding} onClose={() => setVoiding(null)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-medium">{title}</h3>
      {children.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y">{children}</ul>
      )}
    </section>
  );
}
