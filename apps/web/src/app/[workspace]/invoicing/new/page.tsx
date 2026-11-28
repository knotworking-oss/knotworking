import { invoiceSourceModules } from "@knotworking/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import {
  getBootstrap,
  getDespatch,
  getSalesOrder,
  getServiceQuote,
  getWorkspaceToday,
  requireModule,
} from "@/lib/api";
import { InvoiceEditor } from "../invoice-controls";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ source?: string; id?: string }>;
}) {
  const [{ workspace: slug }, query] = await Promise.all([params, searchParams]);
  await requireModule(slug, "invoicing", "write");
  const [today, boot] = await Promise.all([getWorkspaceToday(slug), getBootstrap(slug)]);
  let source: { kind: keyof typeof invoiceSourceModules; id: string; reference: string } | undefined;
  const kind = query.source;
  if (kind !== undefined) {
    if (
      (kind !== "sales" && kind !== "despatch" && kind !== "service") ||
      !query.id ||
      !/^[0-9a-f-]{36}$/i.test(query.id)
    )
      notFound();
    await requireModule(slug, invoiceSourceModules[kind]);
    const record =
      kind === "sales"
        ? await getSalesOrder(slug, query.id)
        : kind === "despatch"
          ? await getDespatch(slug, query.id)
          : await getServiceQuote(slug, query.id);
    source = { kind, id: query.id, reference: record.reference };
  }
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/invoicing`} className="hover:underline">
          Invoicing
        </Link>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <section className="workspace-content space-y-4 py-4 md:py-6">
          <h1 className="text-xl font-semibold">New invoice</h1>
          {source && <p className="text-sm text-muted-foreground">From {source.reference}</p>}
          <InvoiceEditor slug={slug} today={today} currency={boot.workspace.currency} source={source} />
        </section>
      </div>
    </>
  );
}
