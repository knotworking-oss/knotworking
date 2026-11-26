import { hasModuleLevel, invoiceListSchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { formatLongDate } from "@/lib/format";
import { getBootstrap, getCustomerDocuments, getInvoicingSettings } from "@/lib/api";
import { InvoicingSettingsForm } from "./invoice-controls";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const [{ workspace: slug }, query] = await Promise.all([params, searchParams]);
  const parsed = invoiceListSchema.safeParse(query);
  const offset = parsed.success ? parsed.data.offset : 0;
  const [page, boot, settings] = await Promise.all([
    getCustomerDocuments(slug, String(offset)),
    getBootstrap(slug),
    getInvoicingSettings(slug),
  ]);
  const access = boot.modules.find((module) => module.id === "invoicing")?.access;
  const canWrite = hasModuleLevel(access, "write");
  const base = `/${slug}/invoicing`;
  return (
    <>
      <PageHeader
        actions={
          canWrite && (
            <Button size="sm" asChild>
              <Link href={`${base}/new`}>New invoice</Link>
            </Button>
          )
        }
      >
        <h1 className="font-medium">Invoicing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
          {hasModuleLevel(access, "manage") && (
            <InvoicingSettingsForm
              slug={slug}
              taxRegistrationNumber={settings.taxRegistrationNumber}
              requireSecondApprover={settings.requireSecondApprover}
            />
          )}
          {page.documents.length ? (
            <ul className="divide-y rounded-lg border">
              <li
                aria-hidden
                className="hidden gap-2 bg-muted/60 p-3 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[2fr_1fr_1fr]"
              >
                <span>Document · Customer</span>
                <span>Status · Date</span>
                <span className="text-right">Total incl. tax</span>
              </li>
              {page.documents.map((doc) => (
                <li key={doc.id}>
                  <Link
                    href={`${base}/${doc.id}`}
                    className="grid gap-2 p-3 text-sm hover:bg-muted/60 sm:grid-cols-[2fr_1fr_1fr]"
                  >
                    <span>
                      <span className="font-medium">
                        {doc.number ?? (doc.kind === "credit" ? "Credit note draft" : "Invoice draft")}
                      </span>
                      <br />
                      {doc.customer.name}
                    </span>
                    <span className="capitalize">
                      {doc.status}
                      <br />
                      <span className="text-muted-foreground">{formatLongDate(doc.date)}</span>
                    </span>
                    <span className="tabular-nums sm:text-right">
                      {doc.kind === "credit" && <span className="text-muted-foreground">Credit </span>}
                      {doc.currency} {doc.gross}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              No customer invoices or credit notes yet.
            </p>
          )}
          <nav aria-label="Invoice pages" className="flex gap-2">
            {offset > 0 && (
              <Button asChild size="sm" variant="outline">
                <Link href={`${base}?offset=${Math.max(0, offset - 50)}`}>Previous</Link>
              </Button>
            )}
            {page.nextOffset !== null && (
              <Button asChild size="sm" variant="outline">
                <Link href={`${base}?offset=${page.nextOffset}`}>Next</Link>
              </Button>
            )}
          </nav>
        </div>
      </div>
    </>
  );
}
