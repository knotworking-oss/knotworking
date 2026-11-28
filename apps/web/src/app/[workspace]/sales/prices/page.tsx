import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getSalesPrices, getWorkspaceToday, getWorkspaceCurrency } from "@/lib/api";
import { PriceManager } from "./price-manager";
export const metadata = { title: "Sales prices" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const [{ workspace: slug }, q] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(q.offset ?? "") ? Number(q.offset) : 0;
  const [page, today, currency] = await Promise.all([
    getSalesPrices(slug, String(offset)),
    getWorkspaceToday(slug),
    getWorkspaceCurrency(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Customer price agreements</h1>
      </PageHeader>
      <div className="workspace-content flex-1 space-y-5 overflow-y-auto py-6">
        <PriceManager slug={slug} today={today} currency={currency} prices={page.prices} />
        <nav className="flex gap-4 text-sm" aria-label="Price pages">
          <span>{page.total} agreements</span>
          {offset > 0 && <Link href={`?offset=${Math.max(0, offset - page.limit)}`}>Previous</Link>}
          {offset + page.prices.length < page.total && (
            <Link href={`?offset=${offset + page.limit}`}>Next</Link>
          )}
        </nav>
      </div>
    </>
  );
}
