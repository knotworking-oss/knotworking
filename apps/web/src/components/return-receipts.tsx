import type { DespatchReturnView } from "@knotworking/core";
import Link from "next/link";
export function ReturnReceipts({ slug, returns }: { slug: string; returns: DespatchReturnView[] }) {
  return (
    <section className="rounded-md border p-4">
      <h3 className="font-medium">Physical customer returns</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Received goods have their own quarantine lots. Off-site recovery reports are separate evidence;
        reconcile them without counting the same goods twice.
      </p>
      {!returns.length ? (
        <p className="mt-3 text-sm text-muted-foreground">No physical return receipts recorded.</p>
      ) : (
        <ul className="mt-3 divide-y">
          {returns.map((r) => (
            <li key={r.id} className="space-y-1 py-3 text-sm">
              <p>
                <Link className="underline" href={`/${slug}/stock/lots/${r.lotId}`}>
                  {r.lotCode}
                </Link>{" "}
                · {r.quantity} {r.unit} · {r.receivedOn}
                {r.voidedAt
                  ? " · Receipt corrected (excluded from received quantities)"
                  : " · Physical receipt recorded"}
              </p>
              <p>{r.reason}</p>
              <p className="text-muted-foreground">Condition: {r.condition}</p>
              {r.voidReason && <p>Correction: {r.voidReason}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
