import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import Link from "next/link";
import { BatchStatusBadge, MassBalance } from "@/components/production-badges";
import { formatAmount, LotStatusBadge } from "@/components/stock-badges";
import type { LotTrace as Trace } from "@/lib/api";

type Step = Trace["forward"][number] | Trace["backward"][number];
type TraceLot = Trace["forward"][number]["consumed"]["lot"];
type Edge = { lot: TraceLot; amount: Trace["forward"][number]["consumed"]["amount"] };

function LotLink({ slug, lot }: { slug: string; lot: TraceLot }) {
  return (
    <Link href={`/${slug}/stock/lots/${lot.id}`} className="font-mono text-xs hover:underline">
      {lot.lotCode}
    </Link>
  );
}

function EdgeRow({ slug, edge, verb }: { slug: string; edge: Edge; verb: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground">{verb}</span>
      <span className="tabular-nums">{formatAmount(edge.amount)}</span>
      <span>{edge.lot.item.name}</span>
      <LotLink slug={slug} lot={edge.lot} />
      <LotStatusBadge status={edge.lot.status} />
      {edge.lot.supplierLotCode && (
        <span className="text-xs text-muted-foreground">
          {edge.lot.supplierName ?? "Supplier"} lot {edge.lot.supplierLotCode}
        </span>
      )}
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatAmount(edge.lot.onHand)} on hand
      </span>
    </li>
  );
}

function StepList({
  slug,
  steps,
  direction,
}: {
  slug: string;
  steps: Step[];
  direction: "forward" | "backward";
}) {
  if (steps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {direction === "forward"
          ? "Not used in any batch."
          : "Not made by a recorded batch. Check receipt or customer return provenance on the lot."}
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3 text-sm">
      {steps.map((step) => (
        <li
          key={`${step.batch.id}:${"consumed" in step ? step.consumed.lot.id : step.produced.lot.id}`}
          className="flex flex-col gap-1 border-l-2 pl-3"
          style={{ marginLeft: `${(step.depth - 1) * 1.25}rem` }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/${slug}/production/batches/${step.batch.id}`}
              className="font-medium hover:underline"
            >
              Batch {step.batch.batchCode}
            </Link>
            <span className="text-xs text-muted-foreground">
              {step.batch.recipe.code} v{step.batch.recipeVersion.versionNumber} · {step.batch.plannedOn}
            </span>
            <BatchStatusBadge status={step.batch.status} />
          </div>
          <ul className="flex flex-col gap-1">
            {"consumed" in step ? (
              <>
                <EdgeRow slug={slug} edge={step.consumed} verb="Used" />
                {step.outputs.map((o) => (
                  <EdgeRow key={o.lot.id} slug={slug} edge={o} verb="Made" />
                ))}
              </>
            ) : (
              <>
                <EdgeRow slug={slug} edge={step.produced} verb="Made" />
                {step.inputs.map((i) => (
                  <EdgeRow key={i.lot.id} slug={slug} edge={i} verb="From" />
                ))}
              </>
            )}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/**
 * Traceability through production for one lot: what it was made from (one up, repeated), what
 * it went into (one down, repeated) and its mass balance. Shown on the stock lot page.
 */
export function LotTrace({ slug, trace }: { slug: string; trace: Trace }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium">Production trace</h3>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_18rem]">
        <Card>
          <CardHeader>
            <CardTitle>Made from</CardTitle>
          </CardHeader>
          <CardContent>
            <StepList slug={slug} steps={trace.backward} direction="backward" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Used in</CardTitle>
          </CardHeader>
          <CardContent>
            <StepList slug={slug} steps={trace.forward} direction="forward" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Mass balance</CardTitle>
          </CardHeader>
          <CardContent>
            <MassBalance balance={trace.massBalance} />
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
