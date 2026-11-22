import { productionBatchStatusLabels, productionRecordKindLabels } from "@knotworking/core";
import type { Metadata } from "next";
import Link from "next/link";
import { formatCost, formatUnitCost } from "@/components/costing-badges";
import { PrintHeading, PrintNotice, PrintPage, SignatureLine } from "@/components/print-page";
import { formatAmount } from "@/components/stock-badges";
import {
  canReadModule,
  getBatchCost,
  getBootstrap,
  getHaccpBatchRecord,
  getProductionBatch,
  getWorkspaceCurrency,
} from "@/lib/api";
import { printDate, printDateTime } from "@/lib/print";

type Props = { params: Promise<{ workspace: string; id: string }> };

export const metadata: Metadata = { title: "Print batch record" };

const heading = "mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase";

/**
 * A batch record on paper: the recipe version it was made to, planned against actual quantities,
 * every lot consumed and produced with who and when, and the sign-off. The CCP checks (haccp) and
 * the cost (costing) are included only for people who can read those modules.
 */
export default async function PrintBatchPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const currency = await getWorkspaceCurrency(slug);
  const [batch, boot, canHaccp, canCosting] = await Promise.all([
    getProductionBatch(slug, id),
    getBootstrap(slug),
    canReadModule(slug, "haccp"),
    canReadModule(slug, "costing"),
  ]);
  const [haccp, cost] = await Promise.all([
    canHaccp ? getHaccpBatchRecord(slug, id) : null,
    canCosting && batch.records.length > 0 ? getBatchCost(slug, id) : null,
  ]);
  const tz = boot.workspace.timeZone;
  const open = batch.status === "planned" || batch.status === "in_progress";
  const reversedLines = batch.records.filter((r) => r.reversed || r.reversesRecordId).length;
  const consumption = batch.records.filter((r) => r.kind === "consumption");
  const output = batch.records.filter((r) => r.kind !== "consumption");
  const yieldPercent =
    batch.planned.base > 0 && batch.produced.base > 0
      ? Math.round((batch.produced.base / batch.planned.base) * 1000) / 10
      : null;

  const recordTable = (rows: typeof batch.records, empty: string) => (
    <table className="mt-1 w-full text-[12px]">
      <thead>
        <tr className="border-b-2 border-black text-left">
          <th className="py-1 pr-2">When</th>
          <th className="py-1 pr-2">Item</th>
          <th className="py-1 pr-2">Lot</th>
          <th className="py-1 pr-2">Location</th>
          <th className="py-1 pr-2 text-right">Quantity</th>
          <th className="py-1">By</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-black/30 align-top">
            <td className="py-1.5 pr-2 whitespace-nowrap">{printDateTime(r.occurredAt, tz)}</td>
            <td className={`py-1.5 pr-2 ${r.reversed ? "line-through" : ""}`}>
              {r.reversesRecordId ? "Reversal: " : ""}
              {productionRecordKindLabels[r.kind]} {r.item.name}{" "}
              <span className="font-mono text-[11px] text-muted-foreground">{r.item.code}</span>
              {r.reversed && <span className="no-underline"> (reversed)</span>}
              {r.note && <div className="text-[11px] text-muted-foreground">{r.note}</div>}
            </td>
            <td className="py-1.5 pr-2 font-mono text-[11px]">{r.lotCode}</td>
            <td className="py-1.5 pr-2">{r.locationName}</td>
            <td
              className={`py-1.5 pr-2 text-right whitespace-nowrap tabular-nums ${r.reversed ? "line-through" : ""}`}
            >
              {formatAmount(r.amount)}
            </td>
            <td className="py-1.5">{r.actorName ?? "—"}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="py-3 text-center text-muted-foreground">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <PrintPage
      crumbs={
        <>
          <Link href={`/${slug}/production`} className="text-muted-foreground hover:text-foreground">
            Production
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link
            href={`/${slug}/production/batches/${batch.id}`}
            className="font-mono text-muted-foreground hover:text-foreground"
          >
            {batch.batchCode}
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-medium">Print</h1>
        </>
      }
    >
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={tz}
        title="Batch record"
        subtitle={<span className="font-mono text-base font-semibold text-black">{batch.batchCode}</span>}
        badge={<span className="font-semibold text-black">{productionBatchStatusLabels[batch.status]}</span>}
      />

      {open && (
        <div className="mb-4">
          <PrintNotice strong>
            {batch.status === "planned" ? "Planned: not started" : "In progress: not signed off"}
          </PrintNotice>
        </div>
      )}
      {batch.status === "cancelled" && (
        <div className="mb-4">
          <PrintNotice strong>
            Cancelled
            {batch.cancelReason && <p className="text-sm font-normal normal-case">{batch.cancelReason}</p>}
          </PrintNotice>
        </div>
      )}

      <dl className="grid grid-cols-4 gap-x-4 gap-y-2 border-y border-black/40 py-2 text-[12px]">
        <div className="col-span-2">
          <dt className="text-muted-foreground">Recipe</dt>
          <dd className="font-medium">
            {batch.recipe.name} <span className="font-mono text-[11px] font-normal">{batch.recipe.code}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Recipe version</dt>
          <dd>
            {batch.recipeVersion ? `Version ${batch.recipeVersion.versionNumber}` : "—"}
            {batch.recipeVersion && batch.recipeVersion.status !== "approved" && " (since superseded)"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Makes</dt>
          <dd>{batch.outputItem.name}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Planned on</dt>
          <dd>{printDate(batch.plannedOn)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Planned quantity</dt>
          <dd className="tabular-nums">
            {batch.batches !== null && `${batch.batches} batches · `}
            {formatAmount(batch.planned)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Actual quantity</dt>
          <dd className="tabular-nums">
            {formatAmount(batch.produced)}
            {yieldPercent !== null && ` (${yieldPercent}% of plan)`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Output to</dt>
          <dd>{batch.outputLocation?.name ?? "—"}</dd>
        </div>
        {batch.notes && (
          <div className="col-span-4">
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-line">{batch.notes}</dd>
          </div>
        )}
      </dl>

      <section className="mt-4 break-inside-avoid">
        <h2 className={heading}>Materials: planned against actual</h2>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b-2 border-black text-left">
              <th className="py-1 pr-2">Ingredient</th>
              <th className="py-1 pr-2 text-right">Required</th>
              <th className="py-1 pr-2 text-right">Consumed</th>
              <th className="py-1 text-right">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {batch.materials.map((m) => (
              <tr key={m.item.id} className="border-b border-black/30">
                <td className="py-1.5 pr-2">
                  {m.item.name}{" "}
                  <span className="font-mono text-[11px] text-muted-foreground">{m.item.code}</span>
                  {!m.inRecipe && (
                    <span className="text-[11px] text-muted-foreground"> (not on this version)</span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">
                  {m.required ? formatAmount(m.required) : "—"}
                </td>
                <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">
                  {formatAmount(m.consumed)}
                </td>
                <td className="py-1.5 text-right whitespace-nowrap tabular-nums">
                  {m.outstanding ? formatAmount(m.outstanding) : "—"}
                </td>
              </tr>
            ))}
            {batch.materials.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-center text-muted-foreground">
                  No ingredients on this version.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-4">
        <h2 className={heading}>Lots consumed</h2>
        {recordTable(consumption, "Nothing consumed.")}
      </section>

      <section className="mt-4">
        <h2 className={heading}>Lots produced</h2>
        {batch.outputs.length > 0 && (
          <p className="mb-1 text-[12px]">
            {batch.outputs.map((o) => (
              <span key={o.lotId} className="mr-4 whitespace-nowrap">
                <span className="font-mono font-semibold">{o.lotCode}</span> {formatAmount(o.produced)}
                {o.expiresOn &&
                  `, ${o.expiryType === "use_by" ? "use by" : "best before"} ${printDate(o.expiresOn)}`}
                {`, ${o.status === "available" ? "released" : o.status}`}
              </span>
            ))}
          </p>
        )}
        {recordTable(output, "Nothing produced.")}
      </section>

      {reversedLines > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          The record is append-only: a reversed line stays, struck through, followed by the line that reversed
          it.
        </p>
      )}

      {haccp && (haccp.ccps.length > 0 || haccp.logs.length > 0) && (
        <section className="mt-4">
          <h2 className={heading}>CCP checks</h2>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b-2 border-black text-left">
                <th className="py-1 pr-2">Checked</th>
                <th className="py-1 pr-2">CCP</th>
                <th className="py-1 pr-2">Limit</th>
                <th className="py-1 pr-2">Reading</th>
                <th className="py-1 pr-2">Result</th>
                <th className="py-1">By</th>
              </tr>
            </thead>
            <tbody>
              {haccp.logs.map((log) => (
                <tr key={log.id} className="border-b border-black/30 align-top">
                  <td className="py-1.5 pr-2 whitespace-nowrap">{printDateTime(log.checkedAt, tz)}</td>
                  <td className="py-1.5 pr-2">
                    {log.ccpCode} {log.ccp.processStep}
                  </td>
                  <td className="py-1.5 pr-2">{log.ccp.limitText}</td>
                  <td className={`py-1.5 pr-2 ${log.correctedByLogId ? "line-through" : ""}`}>
                    {log.readingText}
                  </td>
                  <td className="py-1.5 pr-2">
                    {log.correctedByLogId
                      ? "Corrected"
                      : log.withinLimits
                        ? "Within limits"
                        : `OUT OF LIMITS${log.deviationReason ? `: ${log.deviationReason}` : ""}`}
                    {log.reviewStatus === "rejected" && " (rejected)"}
                    {log.reviewStatus === "pending" && " (awaiting review)"}
                  </td>
                  <td className="py-1.5">{log.recordedByName ?? "—"}</td>
                </tr>
              ))}
              {haccp.logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-center text-muted-foreground">
                    No checks recorded against this batch.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {haccp.openCorrectiveActions > 0 && (
            <p className="mt-1 text-[12px] font-semibold">
              {haccp.openCorrectiveActions} open corrective action
              {haccp.openCorrectiveActions === 1 ? "" : "s"} on this batch.
            </p>
          )}
        </section>
      )}

      {cost && (
        <section className="mt-4 break-inside-avoid">
          <h2 className={heading}>Cost</h2>
          <dl className="grid grid-cols-4 gap-x-4 gap-y-1 text-[12px]">
            <div>
              <dt className="text-muted-foreground">Actual cost</dt>
              <dd className="font-semibold tabular-nums">{formatCost(cost.actualCost, currency)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Cost per unit</dt>
              <dd className="tabular-nums">{formatUnitCost(cost.costPerUnit, cost.outputUnit, currency)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Yield</dt>
              <dd className="tabular-nums">
                {cost.yield.percent === null
                  ? "—"
                  : `${cost.yield.percent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Variance to standard</dt>
              <dd className="tabular-nums">
                {cost.variance.total === null ? "—" : formatCost(cost.variance.total, currency)}
              </dd>
            </div>
          </dl>
          {(!cost.costComplete || (cost.estimatedPercent ?? 0) > 0 || cost.provisional) && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {cost.provisional && "Provisional: the batch is not complete. "}
              {(cost.estimatedPercent ?? 0) > 0 &&
                `${Math.round(cost.estimatedPercent ?? 0)}% estimated at standard cost. `}
              {!cost.costComplete && `No cost for ${cost.missingItemCodes.join(", ")}.`}
            </p>
          )}
        </section>
      )}

      <section className="mt-8 flex break-inside-avoid flex-wrap gap-6">
        <SignatureLine label="Planned by" name={batch.createdByName} />
        <SignatureLine
          label="Started by"
          name={batch.startedByName}
          at={batch.startedAt ? printDateTime(batch.startedAt, tz) : undefined}
        />
        <SignatureLine
          label="Signed off by"
          name={batch.completedByName}
          at={batch.completedAt ? printDateTime(batch.completedAt, tz) : undefined}
        />
      </section>
      {batch.completionNote && (
        <p className="mt-2 text-[12px]">
          <span className="text-muted-foreground">Sign-off note: </span>
          {batch.completionNote}
        </p>
      )}
    </PrintPage>
  );
}
