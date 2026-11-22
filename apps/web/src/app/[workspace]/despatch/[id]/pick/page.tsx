import { SsccBarcode } from "@/components/sscc-barcode";
import Link from "next/link";
import { stockAmount } from "@knotworking/core";
import { PrintHeading, PrintNotice, PrintPage } from "@/components/print-page";
import { getBootstrap, getDespatch, getDespatchOperations } from "@/lib/api";
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const [d, ops, boot] = await Promise.all([
    getDespatch(slug, id),
    getDespatchOperations(slug, id),
    getBootstrap(slug),
  ]);
  return (
    <PrintPage crumbs={<Link href={`/${slug}/despatch/${id}`}>{d.reference} / Pick list</Link>}>
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={boot.workspace.timeZone}
        title="Pick list and handling units"
        subtitle={d.reference}
      />
      {d.status === "draft" && !d.allocatedAt && (
        <PrintNotice strong>No current stock allocation — review and allocate before picking.</PrintNotice>
      )}
      {d.status === "confirmed" && (
        <PrintNotice strong>Confirmed shipment — historical pick record; do not pick again.</PrintNotice>
      )}
      {d.status === "voided" && <PrintNotice strong>Voided despatch — do not pick.</PrintNotice>}
      <p>
        {d.customerName} · {d.deliverySiteName ?? "Delivery address"}
      </p>
      <p className="whitespace-pre-line">{d.deliveryAddress}</p>
      <p>Order reference: {d.externalReference ?? "—"}</p>
      <table className="my-5 w-full border-collapse text-left">
        <thead>
          <tr className="border-y border-black">
            <th className="py-2">Pick location</th>
            <th>Product / lot</th>
            <th>Expiry</th>
            <th>Quantity</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id} className="border-b">
              <td className="py-2">{l.locationName}</td>
              <td>
                {l.itemCode} · {l.itemName}
                <br />
                {l.lotCode}
              </td>
              <td>{l.expiresOn ?? "—"}</td>
              <td>
                {l.amount.display} {l.amount.displayUnit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ops.packages
        .filter((p) => !p.supersededAt)
        .map((p) => (
          <section className="my-5 break-inside-avoid border border-black p-4" key={p.id}>
            <h2 className="font-semibold">{p.reference}</h2>
            {p.sscc && <SsccBarcode sscc={p.sscc} />}
            <ul>
              {p.contents.map((c) => {
                const line = d.lines.find((l) => l.id === c.lineId);
                const a = line ? stockAmount(c.quantity, { unit: line.itemUnit }) : null;
                return (
                  <li key={c.lineId}>
                    {line?.itemName} · {line?.lotCode} ·{" "}
                    {a ? `${a.display} ${a.displayUnit}` : "Historical packing line"}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </PrintPage>
  );
}
