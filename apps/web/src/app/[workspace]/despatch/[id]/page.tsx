import { hasModuleLevel } from "@knotworking/core";
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
import { DistributionOperationsRecord } from "@/components/distribution-operations-record";
import { ReturnReceipts } from "@/components/return-receipts";
import { OperationForms } from "./operation-forms";
import { PageHeader } from "@/components/page-header";
import {
  getDespatch,
  getDespatchOperations,
  getStockLocations,
  getWorkspaceToday,
  getBootstrap,
  getWorkspaceTimeZone,
} from "@/lib/api";
import { printDate, printDateTime } from "@/lib/print";
import { DespatchActions } from "./despatch-actions";

export default async function DespatchPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [d, timeZone, boot, operations, locations, today] = await Promise.all([
    getDespatch(slug, id),
    getWorkspaceTimeZone(slug),
    getBootstrap(slug),
    getDespatchOperations(slug, id),
    getStockLocations(slug),
    getWorkspaceToday(slug),
  ]);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/despatch`} className="text-muted-foreground">
          Despatch
        </Link>
        <span>/</span>
        <h1 className="font-medium">{d.reference}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">{d.reference}</h2>
              <p className="text-sm text-muted-foreground">
                {printDate(d.despatchedOn)} · {d.customerCode}
              </p>
            </div>
            <Badge variant="secondary">{d.status}</Badge>
          </div>
          {d.status === "confirmed" &&
            hasModuleLevel(boot.modules.find((module) => module.id === "invoicing")?.access, "write") && (
              <Link
                className="text-sm underline print:hidden"
                href={`/${slug}/invoicing/new?source=despatch&id=${id}`}
              >
                Draft customer invoice
              </Link>
            )}
          <DespatchActions slug={slug} despatch={d} />
          <Link className="text-sm underline" href={`/${slug}/despatch/${id}/pick`}>
            Print pick list and handling units
          </Link>
          <OperationForms
            key={`${d.updatedAt}:${operations.returns.filter((r) => !r.voidedAt).length}:${operations.proofs.length}`}
            slug={slug}
            despatch={d}
            operations={operations}
            locations={locations.locations}
            today={today}
          />
          <DistributionOperationsRecord
            record={d}
            operations={operations}
            lines={d.lines}
            users={boot.users}
            timeZone={timeZone}
          />
          <ReturnReceipts slug={slug} returns={operations.returns} />
          {d.status === "draft" && (
            <p className="rounded-md border p-3 text-sm">
              Draft: no stock has left the ledger. Customer contacts and lot eligibility will be checked again
              at confirmation.
            </p>
          )}
          {d.status === "voided" && (
            <p role="status" className="rounded-md border p-3 text-sm">
              Voided {d.voidedAt && printDateTime(d.voidedAt, timeZone)}: {d.voidReason}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="rounded-md border p-4">
              <h3 className="mb-2 text-sm text-muted-foreground">Customer</h3>
              <p className="font-medium">{d.customerName}</p>
              <p className="text-sm whitespace-pre-line">{d.customerAddress}</p>
              <p className="mt-2 text-sm">{[d.contactName, d.email, d.phone].filter(Boolean).join(" · ")}</p>
            </section>
            <section className="rounded-md border p-4">
              <h3 className="mb-2 text-sm text-muted-foreground">Delivery address</h3>
              {d.deliverySiteName && (
                <p className="text-sm font-medium">
                  {d.deliverySiteCode} · {d.deliverySiteName}
                </p>
              )}
              <p className="text-sm whitespace-pre-line">{d.deliveryAddress}</p>
              <p className="mt-2 text-sm">Order reference: {d.externalReference ?? "—"}</p>
            </section>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Lot</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.itemCode} · {l.itemName}
                  </TableCell>
                  <TableCell>
                    <Link href={`/${slug}/stock/lots/${l.lotId}`} className="underline">
                      {l.lotCode}
                    </Link>
                  </TableCell>
                  <TableCell>{l.locationName}</TableCell>
                  <TableCell>{l.expiresOn ? printDate(l.expiresOn) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.amount.display} {l.amount.displayUnit}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {d.notes && <p className="text-sm whitespace-pre-line">{d.notes}</p>}
          {d.confirmedAt && (
            <p className="text-xs text-muted-foreground">
              Confirmed {printDateTime(d.confirmedAt, timeZone)} · Recorded by{" "}
              {boot.users.find((u) => u.id === d.confirmedBy)?.name ?? "Former member"}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
