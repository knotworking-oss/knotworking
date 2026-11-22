import { impactReasonLabels, type DespatchImpactReport } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import Link from "next/link";
import { BatchStatusBadge } from "./production-badges";
import { LotStatusBadge, formatAmount } from "./stock-badges";
import { printDate, printDateTime } from "@/lib/print";

export function DistributionImpact({
  slug,
  report,
  timeZone,
}: {
  slug: string;
  report: DespatchImpactReport;
  timeZone: string;
}) {
  const root = report.lots.find((l) => l.id === report.rootLotId);
  const partial = report.coverage.status === "partial";
  const pageHref = (offset: number) =>
    `/${slug}/despatch/impact?${new URLSearchParams({ lot: report.rootLotId, depth: String(report.coverage.depth), offset: String(offset) })}`;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">
          {root?.item.name} · {root?.lotCode}
        </h2>
        <p className="text-xs text-muted-foreground">
          Generated {printDateTime(report.generatedAt, timeZone)}
        </p>
      </div>
      <section
        role={partial ? "alert" : "status"}
        className={`rounded-md border p-4 ${partial ? "border-label-yellow" : ""}`}
      >
        <p className="font-medium">
          {partial ? "Partial recorded trace — further review needed" : "Recorded trace fully followed"}
        </p>
        {partial && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {report.coverage.reasons.map((r) => (
              <li key={r}>{impactReasonLabels[r]}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          This report follows recorded production and confirmed deliveries. It includes whole affected output
          lots and delivery quantities. Recorded customer returns are followed into their separate quarantine
          lots. Check unrecorded movements and unresolved production before making recall decisions.
        </p>
      </section>
      {!!report.returnLinks?.length && (
        <section className="rounded-md border p-3 text-sm">
          <h3 className="font-medium">Physical customer return links</h3>
          <ul className="mt-2 space-y-1">
            {report.returnLinks.map((r) => (
              <li key={r.id}>
                <Link className="underline" href={`/${slug}/stock/lots/${r.originalLotId}`}>
                  Original lot
                </Link>{" "}
                →{" "}
                <Link className="underline" href={`/${slug}/stock/lots/${r.lotId}`}>
                  {r.lotCode}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        {Object.entries({
          "Affected lots": report.summary.lots,
          "Production batches": report.summary.batches,
          "Customer accounts": report.summary.customers,
          Despatches: report.summary.despatches,
          "Delivery lines": report.summary.deliveryLines,
        }).map(([label, count]) => (
          <div key={label} className="rounded-md border p-3">
            <dt className="text-muted-foreground">
              {label}
              {partial ? " found" : ""}
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
      <section className="space-y-3">
        <h3 className="font-medium">Affected customer deliveries</h3>
        <p className="text-sm text-muted-foreground">
          Original recipient details are preserved. Draft and voided despatches are excluded. A despatch with
          several affected lots has a line for each lot.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Delivery / date</TableHead>
              <TableHead>Customer / delivery address</TableHead>
              <TableHead>Contact at despatch</TableHead>
              <TableHead>Product / lot</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.deliveries.lines.map((d) => (
              <TableRow key={d.lineId}>
                <TableCell>
                  <Link href={`/${slug}/despatch/${d.despatchId}`} className="font-mono underline">
                    {d.reference}
                  </Link>
                  <p className="mt-1 text-xs">{printDate(d.despatchedOn)}</p>
                </TableCell>
                <TableCell>
                  <p className="font-medium">
                    {d.customerName} ({d.customerCode})
                  </p>
                  <p className="text-xs whitespace-pre-line text-muted-foreground">{d.deliveryAddress}</p>
                </TableCell>
                <TableCell className="text-xs">
                  {[d.contactName, d.email, d.phone].filter(Boolean).join(" · ") || "—"}
                </TableCell>
                <TableCell>
                  <p>
                    {d.itemCode} · {d.itemName}
                  </p>
                  <Link href={`/${slug}/stock/lots/${d.lotId}`} className="font-mono text-xs underline">
                    {d.lotCode}
                  </Link>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">{formatAmount(d.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!report.deliveries.lines.length && (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {report.deliveries.total
              ? "No delivery lines on this page. Go back to the first page."
              : partial
                ? "No confirmed deliveries found within the trace so far. This does not establish that no customers are affected."
                : "No confirmed customer deliveries recorded for these affected lots at the time of this report."}
          </p>
        )}
        <nav aria-label="Impact delivery pages" className="flex gap-4 text-sm">
          <span>{report.deliveries.total} known delivery lines</span>
          {report.deliveries.offset > 0 && (
            <Link
              prefetch={false}
              href={pageHref(Math.max(0, report.deliveries.offset - report.deliveries.limit))}
            >
              Previous
            </Link>
          )}
          {report.deliveries.offset + report.deliveries.lines.length < report.deliveries.total && (
            <Link prefetch={false} href={pageHref(report.deliveries.offset + report.deliveries.limit)}>
              Next
            </Link>
          )}
        </nav>
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">Affected lots and stock still on site</h3>
        <p className="text-sm text-muted-foreground">
          Quantities stay in each product's own unit. They are not added across ingredients and finished
          products.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Lot</TableHead>
              <TableHead>Production stage</TableHead>
              <TableHead>QA status</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Net despatched</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.lots.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  {l.item.code} · {l.item.name}
                </TableCell>
                <TableCell>
                  <Link href={`/${slug}/stock/lots/${l.id}`} className="font-mono underline">
                    {l.lotCode}
                  </Link>
                  {l.id === report.rootLotId && (
                    <Badge variant="secondary" className="ml-2">
                      Selected
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{l.depth}</TableCell>
                <TableCell>
                  <LotStatusBadge status={l.status} />
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">{formatAmount(l.onHand)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">{formatAmount(l.despatched)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer font-medium">
          Production batches followed ({report.batches.length})
        </summary>
        <ul className="mt-3 space-y-2 text-sm">
          {report.batches.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2">
              <Link href={`/${slug}/production/batches/${b.id}`} className="underline">
                {b.batchCode}
              </Link>
              <BatchStatusBadge status={b.status} />
              <span className="text-muted-foreground">
                Stage {b.depth} · {b.outputLinks} recorded output links
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
