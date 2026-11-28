import Link from "next/link";
import { addDays, salesCommitmentsSchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { PageHeader } from "@/components/page-header";
import { getSalesCommitments, getWorkspaceToday } from "@/lib/api";
export const metadata = { title: "Sales delivery commitments" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, q] = await Promise.all([params, searchParams]);
  const today = await getWorkspaceToday(slug);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? "") ? q.from! : today,
    to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? "") ? q.to! : addDays(from, 30);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const parsed = salesCommitmentsSchema.safeParse({ from, to, offset });
  const error = parsed.success ? null : parsed.error.issues.map((i) => i.message).join("; ");
  const page = parsed.success
    ? await getSalesCommitments(slug, { from, to, offset: String(offset) })
    : { lines: [], total: 0, limit: 50 };
  const href = (o: number) => `?${new URLSearchParams({ from, to, offset: String(o) })}`;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Delivery commitments</h1>
      </PageHeader>
      <div className="workspace-content flex-1 space-y-5 overflow-y-auto py-6">
        <form className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            From
            <Input type="date" name="from" required defaultValue={from} />
          </label>
          <label className="space-y-1 text-sm">
            To
            <Input type="date" name="to" required defaultValue={to} />
          </label>
          <Button variant="outline">Show</Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {["Due", "Order", "Customer", "Product", "Ordered", "Remaining"].map((h) => (
                  <th key={h} className="p-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.lines.map((l) => (
                <tr key={l.lineId} className="border-t">
                  <td className="p-2">{l.dueOn}</td>
                  <td className="p-2">
                    <Link className="underline" href={`/${slug}/sales/${l.orderId}`}>
                      {l.reference}
                    </Link>
                  </td>
                  <td className="p-2">{l.customerName}</td>
                  <td className="p-2">
                    {l.itemCode} · {l.itemName}
                  </td>
                  <td className="p-2">
                    {l.ordered} {l.baseUnit}
                  </td>
                  <td className="p-2">
                    {l.outstanding} {l.baseUnit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!page.total && !error && (
          <p className="text-sm text-muted-foreground">No confirmed commitments in this date range.</p>
        )}
        <nav aria-label="Commitment pages" className="flex gap-4 text-sm">
          <span>{page.total} order lines</span>
          {offset > 0 && <Link href={href(Math.max(0, offset - page.limit))}>Previous</Link>}
          {offset + page.lines.length < page.total && <Link href={href(offset + page.limit)}>Next</Link>}
        </nav>
      </div>
    </>
  );
}
