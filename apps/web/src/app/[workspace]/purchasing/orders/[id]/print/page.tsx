import { purchaseOrderStatusLabels } from "@knotworking/core";
import type { Metadata } from "next";
import Link from "next/link";
import { PrintHeading, PrintNotice, PrintPage, SignatureLine } from "@/components/print-page";
import { formatLineAmount, formatPrice, lineTitle, lineUnitLabel } from "@/components/purchasing-badges";
import { getWorkspaceCurrency, getBootstrap, getPurchaseOrder, getSuppliers } from "@/lib/api";
import { printDate, printDateTime } from "@/lib/print";

export const metadata: Metadata = { title: "Print purchase order" };

/** A purchase order as it goes to the supplier: who, where to, what, how much and when. */
export default async function PrintPurchaseOrderPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const currency = await getWorkspaceCurrency(slug);
  const [order, boot, { suppliers }] = await Promise.all([
    getPurchaseOrder(slug, id),
    getBootstrap(slug),
    getSuppliers(slug),
  ]);
  const supplier = suppliers.find((s) => s.id === order.supplier.id);
  const notSent = order.status === "draft" || order.status === "cancelled";

  return (
    <PrintPage
      crumbs={
        <>
          <Link href={`/${slug}/purchasing`} className="text-muted-foreground hover:text-foreground">
            Purchasing
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link
            href={`/${slug}/purchasing/orders/${order.id}`}
            className="font-mono text-muted-foreground hover:text-foreground"
          >
            {order.reference}
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-medium">Print</h1>
        </>
      }
    >
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={boot.workspace.timeZone}
        title="Purchase order"
        subtitle={<span className="font-mono text-base font-semibold text-black">{order.reference}</span>}
      />

      {notSent && (
        <div className="mb-4">
          <PrintNotice strong>
            {order.status === "draft" ? "Draft: not sent" : "Cancelled"}
            {order.status === "cancelled" && order.cancelReason && (
              <p className="text-sm font-normal normal-case">{order.cancelReason}</p>
            )}
          </PrintNotice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        <section>
          <h2 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Supplier
          </h2>
          <p className="text-base font-semibold">{order.supplier.name}</p>
          {order.supplier.code && <p className="font-mono text-[12px]">{order.supplier.code}</p>}
          {supplier?.address && <p className="whitespace-pre-line">{supplier.address}</p>}
          {supplier?.contactName && <p>Attn: {supplier.contactName}</p>}
          {supplier?.email && <p>{supplier.email}</p>}
          {supplier?.phone && <p>{supplier.phone}</p>}
        </section>
        <section>
          <h2 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Deliver to
          </h2>
          <p className="text-base font-semibold">{boot.workspace.name}</p>
          <p>
            {order.deliveryLocation
              ? `${order.deliveryLocation.name}${order.deliveryLocation.code ? ` (${order.deliveryLocation.code})` : ""}`
              : "Goods in"}
          </p>
        </section>
      </div>

      <dl className="mt-4 grid grid-cols-4 gap-x-4 gap-y-1 border-y border-black/40 py-2 text-[12px]">
        <div>
          <dt className="text-muted-foreground">Order reference</dt>
          <dd className="font-mono font-semibold">{order.reference}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Order date</dt>
          <dd>{order.orderedOn ? printDate(order.orderedOn) : "Not sent yet"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Delivery expected</dt>
          <dd>{order.nextExpectedOn ? printDate(order.nextExpectedOn) : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{purchaseOrderStatusLabels[order.status]}</dd>
        </div>
        {order.supplierReference && (
          <div className="col-span-4">
            <dt className="text-muted-foreground">Your reference</dt>
            <dd>{order.supplierReference}</dd>
          </div>
        )}
      </dl>

      <table className="mt-4 w-full text-[12px]">
        <thead>
          <tr className="border-b-2 border-black text-left">
            <th className="w-8 py-1 pr-2">#</th>
            <th className="py-1 pr-2">Item</th>
            <th className="py-1 pr-2 text-right">Quantity</th>
            <th className="py-1 pr-2 text-right">Unit price</th>
            <th className="py-1 pr-2 text-right">Line total</th>
            <th className="py-1">Needed by</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.id} className="border-b border-black/30 align-top">
              <td className="py-1.5 pr-2 tabular-nums">{l.lineNo}</td>
              <td className="py-1.5 pr-2">
                <span className="font-medium">{lineTitle(l)}</span>{" "}
                {l.item && <span className="font-mono text-[11px] text-muted-foreground">{l.item.code}</span>}
                {l.notes && <div className="text-[11px] text-muted-foreground">{l.notes}</div>}
              </td>
              <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">
                {formatLineAmount(l.ordered, l.unit)}
              </td>
              <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">
                {l.unitPrice === null
                  ? "—"
                  : `${formatPrice(l.unitPrice, currency)}${lineUnitLabel(l) ? ` / ${lineUnitLabel(l)}` : ""}`}
              </td>
              <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">
                {l.lineValue === null ? "—" : formatPrice(l.lineValue, currency)}
              </td>
              <td className="py-1.5 whitespace-nowrap">
                {l.effectiveExpectedOn ? printDate(l.effectiveExpectedOn) : "—"}
              </td>
            </tr>
          ))}
          {order.lines.length === 0 && (
            <tr>
              <td colSpan={6} className="py-3 text-center text-muted-foreground">
                No lines.
              </td>
            </tr>
          )}
        </tbody>
        {order.lines.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-black">
              <td colSpan={4} className="py-1.5 pr-2 text-right font-semibold">
                Total{order.valueComplete ? "" : " (excluding lines without a price)"}
              </td>
              <td className="py-1.5 pr-2 text-right font-semibold whitespace-nowrap tabular-nums">
                {formatPrice(order.value, currency)}
              </td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>

      {order.notes && (
        <section className="mt-4 break-inside-avoid">
          <h2 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Notes
          </h2>
          <p className="whitespace-pre-line">{order.notes}</p>
        </section>
      )}

      <section className="mt-8 flex break-inside-avoid flex-wrap gap-6">
        <SignatureLine
          label="Raised by"
          name={order.createdByName}
          at={`Drafted ${printDateTime(order.createdAt, boot.workspace.timeZone)}`}
        />
        <SignatureLine
          label="Sent by"
          name={order.sentByName}
          at={order.sentAt ? printDateTime(order.sentAt, boot.workspace.timeZone) : undefined}
        />
      </section>
    </PrintPage>
  );
}
