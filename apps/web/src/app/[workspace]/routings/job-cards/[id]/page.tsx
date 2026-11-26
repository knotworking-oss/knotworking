import { jobCardExceptionKindLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import Link from "next/link";
import { formatCost } from "@/components/costing-badges";
import { JobCardStatusBadge } from "@/components/job-card-status-badge";
import { PageHeader } from "@/components/page-header";
import { WorkspaceDateTime } from "@/components/workspace-date-time";
import {
  canReadModule,
  getJobCard,
  getProductionBatch,
  getProductionBatchPick,
  getStockLocations,
  getWorkspaceCurrency,
} from "@/lib/api";
import { JobCardActions, ResolveException, VoidEntry, type PickLine } from "./job-card-actions";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  const card = await getJobCard(workspace, id);
  return { title: `${card.batch.batchCode} · ${card.position}. ${card.name}` };
}

/** One job card: its place in the sequence, what it expects, the work recorded on it. */
export default async function JobCardPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const [card, currency, canStock] = await Promise.all([
    getJobCard(slug, id),
    getWorkspaceCurrency(slug),
    canReadModule(slug, "stock"),
  ]);
  const batchRunning = card.batch.status === "in_progress";
  const open = card.status === "pending" || card.status === "in_progress";
  const pick: PickLine[] =
    open && batchRunning && canStock
      ? (await getProductionBatchPick(slug, card.batchId)).materials.flatMap((m) =>
          m.allocations.map((a) => ({
            lotId: a.lotId,
            lotCode: a.lotCode,
            locationId: a.locationId,
            locationName: a.locationName,
            itemName: m.item.name,
            display: a.amount.display,
            displayUnit: a.amount.displayUnit,
          })),
        )
      : [];
  // Where the last operation's output goes: the batch's output location, or one chosen when posting.
  const output =
    open && batchRunning && canStock && card.sequence.isLast && (await canReadModule(slug, "production"))
      ? await Promise.all([getProductionBatch(slug, card.batchId), getStockLocations(slug)]).then(
          ([batch, { locations }]) => ({
            locationId: batch.outputLocation?.id ?? null,
            locations: locations.map((l) => ({ id: l.id, name: l.name })),
          }),
        )
      : null;
  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/routings/job-cards`}>Job cards</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>
                {card.batch.batchCode} · {card.position}. {card.name}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h1 className="flex flex-wrap items-center gap-2 text-lg font-medium">
                {card.position}. {card.name} <JobCardStatusBadge status={card.status} />
              </h1>
              <p className="text-sm text-muted-foreground">
                Batch{" "}
                <Link className="underline" href={`/${slug}/production/batches/${card.batchId}`}>
                  {card.batch.batchCode}
                </Link>{" "}
                · {card.outputItem.code} {card.outputItem.name} · at {card.workCentre?.code ?? "—"}{" "}
                {card.workCentre?.name}
              </p>
              {card.instructions && <p className="text-sm whitespace-pre-wrap">{card.instructions}</p>}
            </div>
            <JobCardActions slug={slug} card={card} batchRunning={batchRunning} pick={pick} output={output} />
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-3">
              <dt className="text-muted-foreground">Planned</dt>
              <dd className="font-medium tabular-nums">
                {card.plannedQuantity.display} {card.plannedQuantity.displayUnit}
              </dd>
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-muted-foreground">Good / scrap</dt>
              <dd className="font-medium tabular-nums">
                {card.good.display} / {card.scrap.display} {card.good.displayUnit}
              </dd>
              {card.sequence.remaining && (
                <dd className="text-xs text-muted-foreground">
                  Up to {card.sequence.remaining.display} more from operation{" "}
                  {card.sequence.previous?.position}
                </dd>
              )}
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-muted-foreground">Minutes (actual / expected)</dt>
              <dd className="font-medium tabular-nums">
                {card.actualMinutes} / {card.expected.totalMinutes}
              </dd>
              <dd className="text-xs text-muted-foreground">
                Setup {card.expected.setupMinutes}, run {card.expected.runMinutes}
                {card.runningTimers > 0 && ` · ${card.runningTimers} timer(s) running`}
              </dd>
            </div>
            <div className="rounded-lg border p-3">
              <dt className="text-muted-foreground">Cost (actual / expected)</dt>
              <dd className="font-medium tabular-nums">
                {formatCost(card.actualCost, currency)} / {formatCost(card.expectedCost, currency)}
              </dd>
              <dd className="text-xs text-muted-foreground">
                At {formatCost(card.costPerHour, currency)} an hour
              </dd>
            </div>
          </dl>

          {card.sequence.blockedBy && open && (
            <p className="rounded-lg border border-dashed p-3 text-sm">
              Operation {card.sequence.blockedBy.position} must be completed before this one.
            </p>
          )}

          <section className="space-y-2">
            <h2 className="font-medium">Exceptions</h2>
            {card.exceptions.length ? (
              <ul className="divide-y rounded-lg border text-sm">
                {card.exceptions.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
                    <span>
                      <span className="flex items-center gap-2 font-medium">
                        {jobCardExceptionKindLabels[e.kind]}
                        <Badge variant={e.status === "open" ? "destructive" : "outline"}>
                          {e.status === "open" ? "Open" : "Resolved"}
                        </Badge>
                      </span>
                      <span className="block">{e.description}</span>
                      <span className="block text-xs text-muted-foreground">
                        {e.raisedBy?.name ?? "—"} · <WorkspaceDateTime value={e.createdAt} />
                        {e.resolution && ` · resolved: ${e.resolution}`}
                      </span>
                    </span>
                    {e.status === "open" && (
                      <ResolveException slug={slug} cardId={card.id} exceptionId={e.id} />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None raised.</p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-medium">Good and scrap</h2>
            {card.quantities.length ? (
              <ul className="divide-y rounded-lg border text-sm">
                {card.quantities.map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <span className={q.voidedAt ? "text-muted-foreground line-through" : undefined}>
                      {q.good.display} good, {q.scrap.display} scrap {q.good.displayUnit}
                      {q.scrapReason && ` (${q.scrapReason})`} · {q.recordedBy?.name ?? "—"} ·{" "}
                      <WorkspaceDateTime value={q.createdAt} />
                    </span>
                    {q.voidedAt ? (
                      <span className="text-xs text-muted-foreground">Voided: {q.voidReason}</span>
                    ) : (
                      open && <VoidEntry slug={slug} cardId={card.id} kind="quantity" entryId={q.id} />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing reported yet.</p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-medium">Time</h2>
            {card.timeLogs.length ? (
              <ul className="divide-y rounded-lg border text-sm">
                {card.timeLogs.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <span className={l.voidedAt ? "text-muted-foreground line-through" : undefined}>
                      {l.user?.name ?? "—"} · <WorkspaceDateTime value={l.startedAt} /> →{" "}
                      {l.running ? "running" : <WorkspaceDateTime value={l.endedAt} />}
                      {l.minutes !== null && ` · ${l.minutes} min`}
                      {l.note && ` · ${l.note}`}
                    </span>
                    {l.voidedAt ? (
                      <span className="text-xs text-muted-foreground">Voided: {l.voidReason}</span>
                    ) : (
                      open && <VoidEntry slug={slug} cardId={card.id} kind="time" entryId={l.id} />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No time logged yet.</p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-medium">Batch records from this operation</h2>
            {card.records.length ? (
              <ul className="divide-y rounded-lg border text-sm">
                {card.records.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <span>
                      {r.kind === "output" ? "Made" : "Used"} {r.quantity.display} {r.quantity.displayUnit} of{" "}
                      {r.item.code} {r.item.name} · lot{" "}
                      <Link className="font-mono underline" href={`/${slug}/stock/lots/${r.lotId}`}>
                        {r.lotCode}
                      </Link>
                    </span>
                    {r.reversed && <Badge variant="outline">Reversed</Badge>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                None. Materials used and output made here are posted to the batch and listed here.
              </p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
