import { salesKinds, salesStatuses, hasModuleLevel } from "@knotworking/core";
import { SalesStatusBadge } from "@/components/sales-status-badge";
import { Button } from "@knotworking/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import Link from "next/link";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getSalesOrders } from "@/lib/api";
export const metadata = { title: "Sales" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ kind?: string; status?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const kind = salesKinds.find((k) => k === search.kind),
    status = salesStatuses.find((k) => k === search.status);
  const offset = /^\d{1,8}$/.test(search.offset ?? "") ? Number(search.offset) : 0;
  const [page, boot] = await Promise.all([
    getSalesOrders(slug, { kind, status, offset: String(offset) }),
    getBootstrap(slug),
  ]);
  const href = (o: number) =>
    `/${slug}/sales?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(status ? { status } : {}), offset: String(o) })}`;
  return (
    <>
      <PageHeader actions={<ModuleDashboardsLink module="sales" />}>
        <h1 className="font-medium">Sales</h1>
      </PageHeader>
      <div className="workspace-content flex-1 space-y-5 overflow-y-auto py-6">
        <div className="flex items-start justify-end gap-4">
          {hasModuleLevel(boot.modules.find((m) => m.id === "sales")?.access, "write") && (
            <Button asChild>
              <Link href={`/${slug}/sales/new`}>New quote or order</Link>
            </Button>
          )}
        </div>
        <form className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Type
            <select
              name="kind"
              defaultValue={kind ?? ""}
              className="ml-2 h-9 rounded-md border bg-background px-3"
            >
              <option value="">All</option>
              {salesKinds.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Status
            <select
              name="status"
              defaultValue={status ?? ""}
              className="ml-2 h-9 rounded-md border bg-background px-3"
            >
              <option value="">All</option>
              {salesStatuses.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <Button variant="outline">Show</Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Customer reference</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Revision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.orders.map((o) => (
              <TableRow key={o.id}>
                <TableCell>
                  <Link className="font-mono underline" href={`/${slug}/sales/${o.id}`}>
                    {o.reference}
                  </Link>
                </TableCell>
                <TableCell>{o.recipient.name}</TableCell>
                <TableCell>{o.customerReference || "—"}</TableCell>
                <TableCell>{o.kind}</TableCell>
                <TableCell>
                  <SalesStatusBadge status={o.status} />
                </TableCell>
                <TableCell>{o.revision}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!page.total && (
          <p className="text-sm text-muted-foreground">
            No sales documents yet. Start with a quote or a draft order.
          </p>
        )}
        <nav aria-label="Sales pages" className="flex gap-4 text-sm">
          <span>{page.total} documents</span>
          {offset > 0 && <Link href={href(Math.max(0, offset - page.limit))}>Previous</Link>}
          {offset + page.orders.length < page.total && <Link href={href(offset + page.limit)}>Next</Link>}
        </nav>
      </div>
    </>
  );
}
