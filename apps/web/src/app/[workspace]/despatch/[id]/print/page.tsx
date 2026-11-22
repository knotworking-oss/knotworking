import Link from "next/link";
import { PrintHeading, PrintNotice, PrintPage } from "@/components/print-page";
import { getBootstrap, getDespatch } from "@/lib/api";
import { printDate, printDateTime } from "@/lib/print";
export default async function DeliveryNotePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [d, boot] = await Promise.all([getDespatch(slug, id), getBootstrap(slug)]);
  return (
    <PrintPage crumbs={<Link href={`/${slug}/despatch/${id}`}>{d.reference} / Delivery note</Link>}>
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={boot.workspace.timeZone}
        title="Delivery note"
        subtitle={d.reference}
      />
      {d.status !== "confirmed" && (
        <PrintNotice strong>
          {d.status === "draft" ? "Draft — not despatched" : "Voided — not a valid delivery note"}
        </PrintNotice>
      )}
      <div className="my-5 grid grid-cols-2 gap-6">
        <section>
          <h2 className="font-semibold">Customer</h2>
          <p>
            {d.customerName} ({d.customerCode})
          </p>
          <p className="whitespace-pre-line">{d.customerAddress}</p>
        </section>
        <section>
          <h2 className="font-semibold">Deliver to</h2>
          {d.deliverySiteName && (
            <p>
              {d.deliverySiteCode} · {d.deliverySiteName}
            </p>
          )}
          <p className="whitespace-pre-line">{d.deliveryAddress}</p>
        </section>
      </div>
      <p>Despatched: {printDate(d.despatchedOn)}</p>
      <p>Order reference: {d.externalReference ?? "—"}</p>
      <table className="my-5 w-full border-collapse text-left">
        <thead>
          <tr className="border-y border-black">
            <th className="py-2">Product</th>
            <th>Lot</th>
            <th>Expiry</th>
            <th className="text-right">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id} className="border-b">
              <td className="py-2">
                {l.itemCode} · {l.itemName}
              </td>
              <td>{l.lotCode}</td>
              <td>{l.expiresOn ? printDate(l.expiresOn) : "—"}</td>
              <td className="text-right">
                {l.amount.display} {l.amount.displayUnit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.confirmedAt && (
        <p>
          Confirmed by {boot.users.find((u) => u.id === d.confirmedBy)?.name ?? "Former member"} ·{" "}
          {printDateTime(d.confirmedAt, boot.workspace.timeZone)}
        </p>
      )}
      {d.voidReason && <p>Void reason: {d.voidReason}</p>}
      <div className="mt-10 flex gap-10">
        <p className="flex-1 border-b border-black pb-6">Received by:</p>
        <p className="flex-1 border-b border-black pb-6">Date / time:</p>
      </div>
    </PrintPage>
  );
}
