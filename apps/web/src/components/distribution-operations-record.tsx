import {
  loadCheckPassed,
  stockAmount,
  type DespatchOperations,
  type DespatchLoadInput,
  type DespatchPackInput,
  type UnitCode,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { printDateTime } from "@/lib/print";
export function DistributionOperationsRecord({
  record,
  operations,
  lines,
  users,
  timeZone,
}: {
  record: { allocatedAt: string | null; packedAt: string | null; loadCheck: DespatchLoadInput | null };
  operations: DespatchOperations;
  lines: { id: string; lotCode: string; itemName: string; itemUnit: UnitCode }[];
  users: { id: string; name: string }[];
  timeZone: string;
}) {
  const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? "Former member";
  const current = operations.packages.filter((p) => !p.supersededAt);
  return (
    <section className="space-y-4 rounded-md border p-4">
      <h3 className="font-medium">Picking, packing and delivery evidence</h3>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          {record.allocatedAt ? "Pick allocation signed" : "No pick allocation recorded"}
        </Badge>
        <Badge variant="outline">{record.packedAt ? "Packing signed" : "Packing not signed"}</Badge>
        <Badge variant={record.loadCheck && !loadCheckPassed(record.loadCheck) ? "destructive" : "outline"}>
          {record.loadCheck
            ? loadCheckPassed(record.loadCheck)
              ? "Load checks passed"
              : "Load checks failed"
            : "Load not checked"}
        </Badge>
      </div>
      {!!current.length && (
        <div>
          <h4 className="text-sm font-medium">Current handling units</h4>
          <ul className="mt-2 space-y-3">
            {current.map((p) => (
              <li key={p.id} className="rounded-md bg-muted/50 p-3 text-sm">
                <p className="font-medium">
                  {p.reference}
                  {p.sscc ? ` · SSCC ${p.sscc}` : ""}
                </p>
                <ul>
                  {p.contents.map((c) => {
                    const l = lines.find((l) => l.id === c.lineId);
                    const amount = l ? stockAmount(c.quantity, { unit: l.itemUnit }) : null;
                    return (
                      <li key={c.lineId}>
                        {l?.lotCode ?? "Historical line"} · {l?.itemName} ·{" "}
                        {amount ? `${amount.display} ${amount.displayUnit}` : c.quantity}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Signed operations history ({operations.events.length})
        </summary>
        <ol className="mt-2 divide-y">
          {operations.events.map((e) => (
            <li key={e.id} className="space-y-1 py-3 text-sm">
              <p className="font-medium">
                {e.kind.replaceAll("_", " ")} · {printDateTime(e.createdAt, timeZone)} · {name(e.actorId)}
              </p>
              <p>{String(e.data.note ?? "")}</p>
              {e.kind === "pack" && <PackingHistory data={e.data} />}{" "}
              {e.kind === "load_check" && (
                <>
                  <p>
                    {String(e.data.carrier)} · {String(e.data.vehicle)} ·{" "}
                    {e.data.passed ? "Passed" : "Failed"}
                  </p>
                  <p>
                    Cleanliness {String(e.data.clean)} · Security {String(e.data.secure)} · Segregation{" "}
                    {String(e.data.segregation)}
                  </p>
                  <p>
                    {e.data.temperatureMode === "controlled"
                      ? `${e.data.temperatureC} °C (permitted ${e.data.minC} to ${e.data.maxC} °C)`
                      : "Ambient transport"}{" "}
                    · {String(e.data.temperatureBasis)}
                  </p>
                </>
              )}
            </li>
          ))}
        </ol>
      </details>
      <details open={!!operations.proofs.length}>
        <summary className="cursor-pointer text-sm font-medium">
          Proof of delivery ({operations.proofs.length})
        </summary>
        <ol className="mt-2 divide-y">
          {operations.proofs.map((p, i) => (
            <li key={p.id} className="space-y-1 py-3 text-sm">
              <p className="font-medium">
                {i === operations.proofs.length - 1 ? "Current cumulative proof" : "Superseded proof"} ·{" "}
                {printDateTime(p.data.deliveredAt, timeZone)} · {p.data.receivedBy}
              </p>
              <p>Evidence: {p.data.evidenceReference}</p>
              <p>{p.data.note}</p>
              {p.data.correctionReason && <p>Correction: {p.data.correctionReason}</p>}
              <ul>
                {p.data.lines.map((l) => (
                  <li key={l.lineId}>
                    {lines.find((x) => x.id === l.lineId)?.lotCode ?? "Historical line"} · Delivered{" "}
                    {l.deliveredQuantity} {l.unit} · Refused {l.refusedQuantity} {l.unit}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Recorded {printDateTime(p.createdAt, timeZone)} by {name(p.actorId)}
              </p>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function PackingHistory({ data }: { data: Record<string, unknown> }) {
  const packs = Array.isArray(data.packages) ? (data.packages as DespatchPackInput["packages"]) : [];
  const lines = Array.isArray(data.lines)
    ? (data.lines as { id: string; lotCode: string; itemName: string }[])
    : [];
  return (
    <ul className="space-y-2">
      {packs.map((p, i) => (
        <li key={i}>
          <p>
            {p.reference}
            {p.sscc ? ` · SSCC ${p.sscc}` : ""}
          </p>
          <ul>
            {p.contents.map((c) => (
              <li key={c.lineId}>
                {lines.find((l) => l.id === c.lineId)?.lotCode ?? "Historical line"} · {c.quantity} {c.unit}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
