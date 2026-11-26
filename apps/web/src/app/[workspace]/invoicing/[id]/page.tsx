import { hasModuleLevel, invoiceSourceModules } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getCustomerDocument, getWorkspaceToday } from "@/lib/api";
import { printDateTime } from "@/lib/print";
import { CreditDraft, InvoiceApproval, InvoiceEditor } from "../invoice-controls";

const sourcePaths = { sales: "sales", despatch: "despatch", service: "client-services" } as const;

export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [doc, boot, today] = await Promise.all([
    getCustomerDocument(slug, id),
    getBootstrap(slug),
    getWorkspaceToday(slug),
  ]);
  const access = boot.modules.find((module) => module.id === "invoicing")?.access;
  const canWrite = hasModuleLevel(access, "write");
  const canApprove = hasModuleLevel(access, "manage");
  const base = `/${slug}/invoicing`;
  const title = doc.number ?? (doc.kind === "invoice" ? "Invoice draft" : "Credit note draft");
  const source = doc.source;
  const sourceLink =
    source === "credit"
      ? `${base}/${doc.creditOf}`
      : source !== "manual" &&
          hasModuleLevel(
            boot.modules.find((module) => module.id === invoiceSourceModules[source])?.access,
            "read",
          )
        ? `/${slug}/${sourcePaths[source]}/${doc.sourceId}`
        : null;
  return (
    <>
      <PageHeader
        actions={
          doc.status === "issued" && (
            <Button asChild size="sm" variant="outline">
              <a href={`/api/v1/workspaces/${slug}/invoicing/${id}/pdf`}>Download PDF</a>
            </Button>
          )
        }
      >
        <Link href={base} className="hover:underline">
          Invoicing
        </Link>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold">{title}</h1>
            <Badge variant="secondary" className="capitalize">
              {doc.status}
            </Badge>
          </div>
          <dl className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Bill to</dt>
              <dd>{doc.customer.name}</dd>
              <dd className="whitespace-pre-wrap">{doc.customer.address}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">From</dt>
              <dd>{doc.issuer.name}</dd>
              <dd className="whitespace-pre-wrap">{doc.issuer.address}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Document date</dt>
              <dd>{doc.date}</dd>
            </div>
            {doc.dueDate && (
              <div>
                <dt className="text-muted-foreground">Due date</dt>
                <dd>{doc.dueDate}</dd>
              </div>
            )}
            {doc.sourceReference && (
              <div>
                <dt className="text-muted-foreground">
                  {doc.kind === "credit" ? "Original invoice" : "Source reference"}
                </dt>
                <dd>
                  {sourceLink ? (
                    <Link className="underline" href={sourceLink}>
                      {doc.sourceReference}
                    </Link>
                  ) : (
                    doc.sourceReference
                  )}
                </dd>
              </div>
            )}
            {doc.creditReason && (
              <div>
                <dt className="text-muted-foreground">Reason for correction</dt>
                <dd className="whitespace-pre-wrap">{doc.creditReason}</dd>
              </div>
            )}
          </dl>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-muted/60">
                  <th className="p-3">Description</th>
                  <th className="p-3">Quantity</th>
                  <th className="p-3">Unit price</th>
                  <th className="p-3">Net</th>
                  <th className="p-3">Tax</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {doc.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="p-3">{line.description}</td>
                    <td className="p-3">
                      {line.quantity} {line.unit}
                    </td>
                    <td className="p-3">{line.pricePending ? "Review price" : line.unitPrice}</td>
                    <td className="p-3">{line.net}</td>
                    <td className="p-3">
                      {line.tax} ({line.taxPending ? "choose tax rate" : `${line.taxRate}%`})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto grid w-fit grid-cols-[auto_auto] gap-x-5 gap-y-1 text-right text-sm tabular-nums">
            <dt>Subtotal</dt>
            <dd>{doc.net}</dd>
            <dt>Tax</dt>
            <dd>{doc.tax}</dd>
            <dt className="font-semibold">Total</dt>
            <dd className="font-semibold">
              {doc.currency} {doc.gross}
            </dd>
          </dl>
          {doc.status === "draft" && canWrite && doc.kind === "invoice" && (
            <InvoiceEditor key={doc.revision} slug={slug} doc={doc} today={today} currency={doc.currency} />
          )}
          {doc.status === "draft" && canApprove && (
            <InvoiceApproval key={`approval-${doc.revision}`} doc={doc} slug={slug} />
          )}
          {doc.status === "issued" &&
            doc.kind === "invoice" &&
            canWrite &&
            doc.lines.some((line) => !doc.creditedLineIds.includes(line.id)) && (
              <CreditDraft doc={doc} slug={slug} today={today} />
            )}
          {doc.credits.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Credit notes</h2>
              <ul className="divide-y rounded-lg border">
                {doc.credits.map((credit) => (
                  <li key={credit.id} className="flex justify-between gap-2 p-3 text-sm">
                    <Link className="underline" href={`${base}/${credit.id}`}>
                      {credit.number ?? "Credit note draft"}
                    </Link>
                    <span className="capitalize">
                      {credit.status} · {doc.currency} {credit.gross}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Document history</summary>
            <ol className="mt-2 divide-y rounded-lg border">
              {doc.history.map((entry) => (
                <li key={entry.revision} className="space-y-1 p-3">
                  <p className="capitalize">
                    {entry.action} · Revision {entry.revision}
                  </p>
                  <p className="text-muted-foreground">
                    {boot.users.find((user) => user.id === entry.actorId)?.name ?? "Former member"} ·{" "}
                    {printDateTime(entry.createdAt, boot.workspace.timeZone)}
                  </p>
                  {entry.reason && <p className="whitespace-pre-wrap">{entry.reason}</p>}
                </li>
              ))}
            </ol>
          </details>
        </article>
      </div>
    </>
  );
}
