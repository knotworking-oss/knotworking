import { addDays, SUPPLIER_PERFORMANCE_DEFAULT_DAYS } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import type { Metadata } from "next";
import Link from "next/link";
import { SupplierApprovalBadge } from "@/components/item-badges";
import { PageHeader } from "@/components/page-header";
import { PerformancePercent } from "@/components/purchasing-badges";
import { PurchasingNav } from "@/components/purchasing-nav";
import { stackedTable } from "@/components/stacked-table";
import { getSupplierPerformance, getWorkspaceToday } from "@/lib/api";
import { formatLongDate } from "@/lib/format";

export const metadata: Metadata = { title: "Supplier performance" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function Rate({ percent, count, of }: { percent: number | null; count: number; of: number }) {
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <PerformancePercent value={percent} />
      {of > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {count} of {of}
        </span>
      )}
    </span>
  );
}

/**
 * On time, in full and OTIF per supplier for a period: lines due in the period (and by today) on
 * sent and closed orders, and the deliveries received in it.
 */
export default async function SupplierPerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const today = await getWorkspaceToday(slug);
  let to = ISO.test(search.to ?? "") ? search.to! : today;
  const from = ISO.test(search.from ?? "") ? search.from! : addDays(to, -SUPPLIER_PERFORMANCE_DEFAULT_DAYS);
  if (to < from) to = from;
  const data = await getSupplierPerformance(slug, { from, to });
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Purchasing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <PurchasingNav slug={slug} />
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Supplier performance</h2>
            <p className="text-sm text-muted-foreground">
              {formatLongDate(data.from)} to {formatLongDate(data.to)}
            </p>
          </div>
          <form className="flex flex-wrap items-end gap-3">
            <Field className="w-44">
              <FieldLabel htmlFor="perf-from">From</FieldLabel>
              <Input id="perf-from" name="from" type="date" required defaultValue={from} />
            </Field>
            <Field className="w-44">
              <FieldLabel htmlFor="perf-to">To</FieldLabel>
              <Input id="perf-to" name="to" type="date" required defaultValue={to} />
            </Field>
            <Button type="submit" variant="outline">
              Show
            </Button>
          </form>
          {data.totals.linesDue > 0 && (
            <p className="text-sm">
              All suppliers: <span className="font-medium">OTIF {data.totals.otifPercent}%</span> of{" "}
              {data.totals.linesDue} lines due (on time {data.totals.onTimePercent}%, in full{" "}
              {data.totals.inFullPercent}%). The certified metric on dashboards gives the same figure.
            </p>
          )}
          {data.suppliers.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              No order lines were due and nothing was delivered in this period.
            </p>
          ) : (
            <Card className="overflow-x-auto py-0">
              <Table className={stackedTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Supplier</TableHead>
                    <TableHead className="text-right">Lines due</TableHead>
                    <TableHead className="text-right">On time</TableHead>
                    <TableHead className="text-right">In full</TableHead>
                    <TableHead className="text-right">OTIF</TableHead>
                    <TableHead className="text-right">Deliveries</TableHead>
                    <TableHead className="pr-4 text-right">Rejected deliveries</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.suppliers.map((s) => (
                    <TableRow key={s.supplier.id} className="align-top">
                      <TableCell className="pl-4" data-primary>
                        <span className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/${slug}/purchasing?status=all&supplier=${s.supplier.id}`}
                            className="font-medium hover:underline"
                          >
                            {s.supplier.name}
                          </Link>
                          {s.supplier.approvalStatus !== "approved" && (
                            <SupplierApprovalBadge status={s.supplier.approvalStatus} />
                          )}
                        </span>
                      </TableCell>
                      <TableCell data-label="Lines due" className="text-right tabular-nums">
                        {s.linesDue}
                      </TableCell>
                      <TableCell data-label="On time" className="text-right">
                        <Rate percent={s.onTimePercent} count={s.onTime} of={s.linesDue} />
                      </TableCell>
                      <TableCell data-label="In full" className="text-right">
                        <Rate percent={s.inFullPercent} count={s.inFull} of={s.linesDue} />
                      </TableCell>
                      <TableCell data-label="OTIF" className="text-right">
                        <Rate percent={s.otifPercent} count={s.otif} of={s.linesDue} />
                      </TableCell>
                      <TableCell data-label="Deliveries" className="text-right tabular-nums">
                        {s.deliveries}
                      </TableCell>
                      <TableCell
                        data-label="Rejected deliveries"
                        className={`pr-4 text-right tabular-nums ${s.rejectedDeliveries > 0 ? "text-label-red" : ""}`}
                      >
                        {s.rejectedDeliveries}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
          <p className="text-xs text-muted-foreground">
            Supplier details and approval are on the{" "}
            <Link href={`/${slug}/suppliers`} className="underline underline-offset-4">
              Suppliers
            </Link>{" "}
            page.
          </p>
        </div>
      </div>
    </>
  );
}
