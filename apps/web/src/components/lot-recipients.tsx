import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import type { getLotRecipients } from "@/lib/api";
import { printDate } from "@/lib/print";

export function LotRecipients({
  slug,
  page,
  showImpact = false,
}: {
  slug: string;
  page: Awaited<ReturnType<typeof getLotRecipients>>;
  showImpact?: boolean;
}) {
  const href = (offset: number) => `/${slug}/despatch/recipients?lot=${page.lotId}&offset=${offset}`;
  return (
    <section className="flex flex-col gap-3 rounded-md border p-4">
      <h2 className="font-medium">Customer recipients · {page.lotCode}</h2>
      <p className="text-sm text-muted-foreground">
        Confirmed deliveries of this lot only. Products made from it must be traced through their own output
        lots. Voided records are excluded.
      </p>
      {showImpact && (
        <Link
          prefetch={false}
          href={`/${slug}/despatch/impact?lot=${page.lotId}`}
          className="text-sm underline"
        >
          Trace downstream customer impact
        </Link>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Delivery</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Customer / address</TableHead>
            <TableHead>Contact at despatch</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.recipients.map((r, i) => (
            <TableRow key={`${r.despatchId}:${i}`}>
              <TableCell>
                <Link href={`/${slug}/despatch/${r.despatchId}`} className="font-mono underline">
                  {r.reference}
                </Link>
              </TableCell>
              <TableCell>{printDate(r.despatchedOn)}</TableCell>
              <TableCell>
                <p className="font-medium">
                  {r.customerName} ({r.customerCode})
                </p>
                <p className="text-xs whitespace-pre-line text-muted-foreground">{r.deliveryAddress}</p>
              </TableCell>
              <TableCell>{[r.contactName, r.email, r.phone].filter(Boolean).join(" · ") || "—"}</TableCell>
              <TableCell className="text-right">
                {r.amount.display} {r.amount.displayUnit}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!page.recipients.length && (
        <p className="text-sm text-muted-foreground">No confirmed direct deliveries found for this lot.</p>
      )}
      <nav aria-label="Recipient pages" className="flex gap-4 text-sm">
        <span>{page.total} delivery lines</span>
        {page.offset > 0 && <Link href={href(Math.max(0, page.offset - page.limit))}>Previous</Link>}
        {page.offset + page.recipients.length < page.total && (
          <Link href={href(page.offset + page.limit)}>Next</Link>
        )}
      </nav>
    </section>
  );
}
