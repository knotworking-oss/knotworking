import {
  planIssueLabels,
  productionBatchStatusLabels,
  type PlanIssue,
  type ProductionBatchStatus,
  type StockAmount,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import type { ReactNode } from "react";
import { formatAmount } from "@/components/stock-badges";

const statusClasses: Record<ProductionBatchStatus, string> = {
  planned: "bg-label-blue-bg text-label-blue",
  in_progress: "bg-label-yellow-bg text-label-yellow",
  completed: "bg-label-green-bg text-label-green",
  cancelled: "bg-muted text-muted-foreground",
};

/** A batch's place in its flow: planned, in progress, completed (signed off) or cancelled. */
export function BatchStatusBadge({ status }: { status: ProductionBatchStatus }) {
  return (
    <Badge className={`border-transparent ${statusClasses[status]}`}>
      {productionBatchStatusLabels[status]}
    </Badge>
  );
}

/** Whether stock covers a requirement: "Covered" (green) or "Short 2 kg" (red). */
export function ShortfallBadge({ shortfall }: { shortfall: Pick<StockAmount, "display" | "displayUnit"> }) {
  if (shortfall.display <= 0) {
    return <Badge className="border-transparent bg-label-green-bg text-label-green">Covered</Badge>;
  }
  return (
    <Badge className="border-transparent bg-label-red-bg text-label-red tabular-nums">
      Short {formatAmount(shortfall)}
    </Badge>
  );
}

/**
 * Planning from demand: how much of a week's demand is not yet planned. "Covered" (green) or
 * "Gap 18 each" (yellow).
 */
export function GapBadge({ gap }: { gap: Pick<StockAmount, "display" | "displayUnit"> }) {
  if (gap.display <= 0) {
    return <Badge className="border-transparent bg-label-green-bg text-label-green">Covered</Badge>;
  }
  return (
    <Badge className="border-transparent bg-label-yellow-bg text-label-yellow tabular-nums">
      Gap {formatAmount(gap)}
    </Badge>
  );
}

const planIssueClasses: Record<PlanIssue, string> = {
  no_recipe: "bg-label-red-bg text-label-red",
  no_approved_version: "bg-label-red-bg text-label-red",
  choose_recipe: "bg-label-blue-bg text-label-blue",
  no_yield: "bg-label-red-bg text-label-red",
};

/** Why an item with demand gets no suggested batches (no recipe, nothing approved, choose one, no yield). */
export function PlanIssueBadge({ issue }: { issue: PlanIssue }) {
  return (
    <Badge className={`border-transparent whitespace-normal ${planIssueClasses[issue]}`}>
      {planIssueLabels[issue]}
    </Badge>
  );
}

type Amount = Pick<StockAmount, "display" | "displayUnit">;

/**
 * A lot's mass balance for a mock recall: what came in (received or produced) against where it
 * went (used in batches, wasted, adjusted) and what is still on hand.
 */
export function MassBalance({
  balance,
}: {
  balance: {
    received: Amount;
    returned: Amount;
    produced: Amount;
    consumed: Amount;
    despatched: Amount;
    wasted: Amount;
    adjusted: Amount;
    onHand: Amount;
    adjustedPercent: number | null;
  };
}) {
  const row = (label: string, value: ReactNode, strong = false) => (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-medium" : ""}`}>{value}</dd>
    </div>
  );
  return (
    <dl className="flex flex-col divide-y text-sm">
      {balance.received.display !== 0 && row("Received", formatAmount(balance.received))}
      {balance.returned.display !== 0 && row("Customer returns", formatAmount(balance.returned))}
      {balance.produced.display !== 0 && row("Produced", formatAmount(balance.produced))}
      {row("Used in batches", formatAmount(balance.consumed))}
      {row("Despatched", formatAmount(balance.despatched))}
      {row("Wasted", formatAmount(balance.wasted))}
      {row(
        "Adjusted",
        <>
          {balance.adjusted.display > 0 ? "+" : ""}
          {formatAmount(balance.adjusted)}
          {balance.adjustedPercent !== null && balance.adjustedPercent !== 0 && (
            <span className="ml-1 text-xs text-muted-foreground">({balance.adjustedPercent}%)</span>
          )}
        </>,
      )}
      {row("On hand", formatAmount(balance.onHand), true)}
    </dl>
  );
}
