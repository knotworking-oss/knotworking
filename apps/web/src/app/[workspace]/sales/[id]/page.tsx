import { hasModuleLevel } from "@knotworking/core";
import Link from "next/link";
import { formatMoney } from "@knotworking/core";
import { SalesStatusBadge } from "@/components/sales-status-badge";
import { printDateTime } from "@/lib/print";
import { PageHeader } from "@/components/page-header";
import {
  canReadModule,
  getSalesOrder,
  getSalesHistory,
  getSalesFulfilments,
  getBootstrap,
  type SalesOrder,
} from "@/lib/api";
import { SalesActions, SalesDeliveryLinks } from "./sales-actions";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ offset?: string; deliveryOffset?: string }>;
}) {
  const [{ workspace: slug, id }, search] = await Promise.all([params, searchParams]);
  const offset = /^\d{1,8}$/.test(search.offset ?? "") ? Number(search.offset) : 0;
  const [order, history, distribution, boot] = await Promise.all([
    getSalesOrder(slug, id),
    getSalesHistory(slug, id, String(offset)),
    canReadModule(slug, "despatch"),
    getBootstrap(slug),
  ]);
  const fulfilments =
    distribution && order.kind === "order"
      ? await getSalesFulfilments(
          slug,
          id,
          /^\d{1,8}$/.test(search.deliveryOffset ?? "") ? search.deliveryOffset : "0",
        )
      : null;
  return (
    <>
      <div className="print:hidden">
        <PageHeader>
          <Link href={`/${slug}/sales`} className="text-muted-foreground">
            Sales
          </Link>
          <span>/</span>
          <h1 className="font-medium">{order.reference}</h1>
        </PageHeader>
      </div>
      <article className="print-sheet print-scroll mx-auto w-full max-w-5xl flex-1 space-y-6 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-medium">
            {order.kind === "quote" ? "Quotation" : "Sales order"} {order.reference}
          </h1>
          {order.kind === "order" &&
            (order.status === "confirmed" || (order.status === "cancelled" && distribution)) &&
            (!boot.modules.some((module) => module.id === "despatch") || distribution) &&
            hasModuleLevel(boot.modules.find((module) => module.id === "invoicing")?.access, "write") && (
              <Link
                className="text-sm underline print:hidden"
                href={`/${slug}/invoicing/new?source=sales&id=${id}`}
              >
                Draft customer invoice
              </Link>
            )}
          <SalesStatusBadge status={order.status} />
          <span className="text-sm text-muted-foreground">Revision {order.revision}</span>
        </div>
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <section>
            <h2 className="mb-1 font-medium">Customer</h2>
            <p>
              {order.recipient.code} · {order.recipient.name}
            </p>
            <p className="whitespace-pre-line">{order.recipient.address}</p>
            <p>Customer reference: {order.customerReference || "—"}</p>
          </section>
          <section>
            <h2 className="mb-1 font-medium">Deliver to</h2>
            <p>{order.recipient.deliverySiteName}</p>
            <p className="whitespace-pre-line">{order.recipient.deliveryAddress}</p>
            {order.validUntil && order.kind === "quote" && <p>Quote valid until {order.validUntil}</p>}
          </section>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Product</th>
                <th className="p-2">Delivery date</th>
                <th className="p-2">Quantity</th>
                <th className="p-2">Unit price ({order.currency})</th>
                <th className="p-2">Line value</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="p-2">
                    <p>
                      {l.itemCode} · {l.itemName}
                    </p>
                    {l.note && <p className="text-muted-foreground">{l.note}</p>}
                  </td>
                  <td className="p-2">{l.dueOn}</td>
                  <td className="p-2">
                    {l.quantity} {l.unit}
                  </td>
                  <td className="p-2">
                    {formatMoney(l.unitPrice, order.currency, { maxDecimals: 8 })} / {l.unit}
                  </td>
                  <td className="p-2">
                    {l.value} {order.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-right font-medium">
          Total excluding tax: {order.total} {order.currency}
        </p>
        <p className="text-sm text-muted-foreground">
          Line values exclude tax. This document is not a tax invoice.
        </p>
        {order.terms && (
          <section className="text-sm">
            <h2 className="font-medium">Commercial terms</h2>
            <p className="whitespace-pre-line">{order.terms}</p>
          </section>
        )}
        {order.notes && (
          <section className="text-sm print:hidden">
            <h2 className="font-medium">Internal notes</h2>
            <p className="whitespace-pre-line">{order.notes}</p>
          </section>
        )}
        {order.signedAt && (
          <p className="text-sm text-muted-foreground">
            Signed by {boot.users.find((u) => u.id === order.signedBy)?.name ?? "Retained signer"} at{" "}
            {printDateTime(order.signedAt, boot.workspace.timeZone)}
          </p>
        )}
        {order.sourceQuoteId && (
          <Link href={`/${slug}/sales/${order.sourceQuoteId}`} className="text-sm underline">
            Source quote
          </Link>
        )}
        {order.convertedOrderId && (
          <Link href={`/${slug}/sales/${order.convertedOrderId}`} className="text-sm underline print:hidden">
            Order created from this quote
          </Link>
        )}
        <SalesActions key={order.revision} slug={slug} order={order} />
        {fulfilments && (
          <SalesDeliveryLinks
            key={`delivery-${order.revision}`}
            slug={slug}
            order={order}
            fulfilments={fulfilments}
          />
        )}
        {fulfilments && (
          <nav aria-label="Delivery link pages" className="flex gap-4 text-sm print:hidden">
            <span>{fulfilments.total} delivery assignments</span>
            {fulfilments.offset > 0 && (
              <Link href={`?deliveryOffset=${Math.max(0, fulfilments.offset - fulfilments.limit)}`}>
                Newer deliveries
              </Link>
            )}
            {fulfilments.offset + fulfilments.links.length < fulfilments.total && (
              <Link href={`?deliveryOffset=${fulfilments.offset + fulfilments.limit}`}>Older deliveries</Link>
            )}
          </nav>
        )}
        <section className="space-y-3 print:hidden">
          <h2 className="font-medium">Retained revisions</h2>
          {history.events.map((event) => (
            <details key={event.id} className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm">
                Revision {event.revision} · {event.action} ·{" "}
                {printDateTime(event.createdAt, boot.workspace.timeZone)}
              </summary>
              <p className="my-2 text-sm">
                {event.reason} · {boot.users.find((u) => u.id === event.actorId)?.name ?? "Retained actor"}
              </p>
              <RetainedRevision snapshot={event.snapshot as unknown as SalesOrder} />
            </details>
          ))}
          <nav aria-label="Revision pages" className="flex gap-4 text-sm">
            <span>{history.total} revisions</span>
            {offset > 0 && <Link href={`?offset=${Math.max(0, offset - history.limit)}`}>Newer</Link>}
            {offset + history.events.length < history.total && (
              <Link href={`?offset=${offset + history.limit}`}>Older</Link>
            )}
          </nav>
        </section>
        <details className="text-xs text-muted-foreground print:hidden">
          <summary>Record identifiers</summary>
          <p>Sales document: {order.id}</p>
          {order.lines.map((l) => (
            <p key={l.id}>
              {l.itemCode}: {l.id}
            </p>
          ))}
        </details>
      </article>
    </>
  );
}

function RetainedRevision({ snapshot: s }: { snapshot: SalesOrder }) {
  return (
    <div className="space-y-2 text-sm">
      <p>
        {s.reference} · {s.status} · {s.recipient.name}
      </p>
      <p className="whitespace-pre-line">{s.recipient.deliveryAddress}</p>
      <ul className="space-y-1">
        {s.lines.map((l) => (
          <li key={l.id}>
            {l.itemCode} · {l.itemName}: {l.quantity} {l.unit} due {l.dueOn}, {l.unitPrice} {s.currency} /{" "}
            {l.unit}
            {l.note ? ` · ${l.note}` : ""}
          </li>
        ))}
      </ul>
      <p className="whitespace-pre-line">{s.terms}</p>
      <p className="whitespace-pre-line">{s.notes}</p>
    </div>
  );
}
