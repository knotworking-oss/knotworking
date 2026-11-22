import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getCustomers } from "@/lib/api";
import { CustomersManager } from "./customers-manager";

export const metadata: Metadata = { title: "Customers" };
export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(search.offset ?? "") ? Number(search.offset) : 0;
  const page = await getCustomers(slug, {
    status: "all",
    q: search.q?.slice(0, 200),
    offset: String(offset),
  });
  const href = (next: number) =>
    `/${slug}/customers?${new URLSearchParams({ q: search.q ?? "", offset: String(next) })}`;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Customers</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <form method="get" className="mx-auto mb-4 flex max-w-5xl gap-2">
          <Input
            name="q"
            aria-label="Find customers by name or code"
            placeholder="Find a customer"
            defaultValue={search.q}
            maxLength={200}
          />
          <Button variant="outline">Search</Button>
        </form>
        <CustomersManager slug={slug} customers={page.customers} />
        <nav aria-label="Customer pages" className="mx-auto mt-4 flex max-w-5xl items-center gap-4 text-sm">
          <span>{page.total} customers</span>
          {offset > 0 && <Link href={href(Math.max(0, offset - page.limit))}>Previous</Link>}
          {offset + page.customers.length < page.total && <Link href={href(offset + page.limit)}>Next</Link>}
        </nav>
      </div>
    </>
  );
}
