import { despatchStatuses } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
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
import { PageHeader } from "@/components/page-header";
import { getDespatches, getBootstrap } from "@/lib/api";
import { printDate } from "@/lib/print";

export const metadata: Metadata = { title: "Despatch" };
export default async function DespatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = despatchStatuses.find((s) => s === search.status) ?? "all";
  const offset = /^\d{1,8}$/.test(search.offset ?? "") ? Number(search.offset) : 0;
  const [page, boot] = await Promise.all([
    getDespatches(slug, { status, offset: String(offset) }),
    getBootstrap(slug),
  ]);
  const href = (next: number) => `/${slug}/despatch?${new URLSearchParams({ status, offset: String(next) })}`;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Despatch</h1>
      </PageHeader>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        <div className="flex flex-wrap items-center justify-end gap-3">
          {["write", "manage"].includes(boot.modules.find((m) => m.id === "despatch")?.access ?? "none") && (
            <Button asChild>
              <Link href={`/${slug}/despatch/new`}>New despatch</Link>
            </Button>
          )}
        </div>
        <form method="get" className="flex items-center gap-3">
          <label className="text-sm">
            Status{" "}
            <select
              name="status"
              defaultValue={status}
              className="ml-2 h-9 rounded-md border bg-background px-3"
            >
              <option value="all">All</option>
              {despatchStatuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <Button variant="outline">Show</Button>
        </form>
        {["read", "write", "manage"].includes(
          boot.modules.find((m) => m.id === "production")?.access ?? "none",
        ) && (
          <Link prefetch={false} href={`/${slug}/despatch/impact`} className="text-sm underline">
            Trace ingredient-to-customer distribution impact
          </Link>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Order reference</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.despatches.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link href={`/${slug}/despatch/${d.id}`} className="font-mono underline">
                    {d.reference}
                  </Link>
                </TableCell>
                <TableCell>{printDate(d.despatchedOn)}</TableCell>
                <TableCell>{d.customerName}</TableCell>
                <TableCell>{d.externalReference ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{d.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!page.total && (
          <p className="py-8 text-center text-sm text-muted-foreground">No despatches found.</p>
        )}
        <nav aria-label="Despatch pages" className="flex gap-4 text-sm">
          <span>{page.total} despatches</span>
          {offset > 0 && <Link href={href(Math.max(0, offset - page.limit))}>Previous</Link>}
          {offset + page.despatches.length < page.total && <Link href={href(offset + page.limit)}>Next</Link>}
        </nav>
      </div>
    </>
  );
}
