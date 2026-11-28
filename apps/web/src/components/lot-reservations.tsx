import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import Link from "next/link";
import { BatchStatusBadge } from "@/components/production-badges";
import { formatAmount } from "@/components/stock-badges";
import type { LotReservation, StockLotDetail } from "@/lib/api";

/**
 * What production batches have set aside of a lot (active reservations): the lot's on-hand
 * quantity less what is reserved is what other batches can still reserve. Shown to people who can
 * read the production module.
 */
export function LotReservations({
  slug,
  lot,
  reservations,
}: {
  slug: string;
  lot: StockLotDetail;
  reservations: LotReservation[];
}) {
  const held = reservations.reduce((t, r) => t + r.held.base, 0);
  const free = Math.max(lot.onHand.base - held, 0);
  const display = (base: number) => ({
    ...lot.onHand,
    base,
    display: lot.onHand.base ? (base / lot.onHand.base) * lot.onHand.display : 0,
  });
  return (
    <div className="pb-8">
      <Card>
        <CardHeader>
          <CardTitle>Reservations</CardTitle>
          <CardDescription>
            {formatAmount(display(held))} reserved, {formatAmount(display(free))} free of{" "}
            {formatAmount(lot.onHand)} on hand.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reservations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is reserved from this lot.</p>
          ) : (
            <ul className="flex flex-col divide-y text-sm">
              {reservations.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/${slug}/production/batches/${r.batchId}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {r.batchCode}
                    </Link>
                    <BatchStatusBadge status={r.batchStatus} />
                    <span className="text-muted-foreground">planned {r.batchPlannedOn}</span>
                  </span>
                  <span className="tabular-nums">{formatAmount(r.held)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
