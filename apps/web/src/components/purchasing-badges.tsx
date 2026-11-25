import {
  lineReceiptStateLabels,
  purchaseOrderStateLabels,
  purchaseReceiptOutcomeLabels,
  units,
  type LineReceiptState,
  type PurchaseOrderState,
  type PurchaseReceiptOutcome,
  type StockAmount,
  type UnitCode,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Progress } from "@knotworking/ui/components/progress";
import { CircleCheck, CircleX } from "lucide-react";
import { formatAmount } from "@/components/stock-badges";
import { formatUnitMoney } from "@/lib/format";

const stateClasses: Record<PurchaseOrderState, string> = {
  draft: "bg-label-gray-bg text-label-gray",
  sent: "bg-label-blue-bg text-label-blue",
  part_received: "bg-label-yellow-bg text-label-yellow",
  received: "bg-label-green-bg text-label-green",
  closed: "bg-label-teal-bg text-label-teal",
  cancelled: "bg-muted text-muted-foreground",
};

/** Where a purchase order stands: draft, sent, part received, received, closed or cancelled. */
export function PurchaseOrderStateBadge({ state }: { state: PurchaseOrderState }) {
  return (
    <Badge className={`border-transparent ${stateClasses[state]}`}>{purchaseOrderStateLabels[state]}</Badge>
  );
}

/** An open order (or line) with something outstanding past its expected date. */
export function OverdueBadge() {
  return <Badge className="border-transparent bg-label-red-bg text-label-red">Overdue</Badge>;
}

const lineClasses: Record<LineReceiptState, string> = {
  none: "bg-muted text-muted-foreground",
  partial: "bg-label-yellow-bg text-label-yellow",
  full: "bg-label-green-bg text-label-green",
  over: "bg-label-purple-bg text-label-purple",
};

/** One line against what was ordered: not received, part received, received or over-delivered. */
export function LineReceiptStateBadge({ state }: { state: LineReceiptState }) {
  return (
    <Badge className={`border-transparent ${lineClasses[state]}`}>{lineReceiptStateLabels[state]}</Badge>
  );
}

/** A receipt row: accepted into stock, or rejected at the door. A reversed receipt is struck through. */
export function ReceiptOutcomeBadge({
  outcome,
  reversed = false,
  voided = false,
}: {
  outcome: PurchaseReceiptOutcome;
  reversed?: boolean;
  voided?: boolean;
}) {
  if (voided)
    return (
      <Badge variant="outline" className="text-muted-foreground line-through">
        Voided
      </Badge>
    );
  if (reversed)
    return (
      <Badge variant="outline" className="text-muted-foreground line-through">
        Reversed
      </Badge>
    );
  return outcome === "accepted" ? (
    <Badge className="border-transparent bg-label-green-bg text-label-green">
      <CircleCheck data-icon="inline-start" /> {purchaseReceiptOutcomeLabels.accepted}
    </Badge>
  ) : (
    <Badge className="border-transparent bg-label-red-bg text-label-red">
      <CircleX data-icon="inline-start" /> {purchaseReceiptOutcomeLabels.rejected}
    </Badge>
  );
}

/**
 * A supplier performance percentage: green from 95%, amber from 80%, red below. "—" when nothing
 * was due in the period.
 */
export function PerformancePercent({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const tone =
    value >= 95
      ? "bg-label-green-bg text-label-green"
      : value >= 80
        ? "bg-label-yellow-bg text-label-yellow"
        : "bg-label-red-bg text-label-red";
  return (
    <Badge className={`border-transparent tabular-nums ${tone}`}>
      {value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%
    </Badge>
  );
}

const number = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 4 });

/**
 * A price or value in the workspace's currency: at least the currency's own decimals, and up to
 * the 8 a per-gram price may need (£0.00345).
 */
export const formatPrice = (value: number, currency: string) => formatUnitMoney(value, currency);

/**
 * A line quantity in the unit the line was entered in ("25 kg"), falling back to the item's own
 * unit when it no longer converts. A non-stock line (`unit` null) is as entered, in its own
 * free-text unit ("3 visit"), or bare when it has none.
 */
export const formatLineAmount = (
  amount: { display: number; displayUnit: string | null; inLineUnit: number | null },
  unit: UnitCode | null,
) => {
  if (unit === null)
    return `${number(amount.inLineUnit ?? amount.display)}${amount.displayUnit ? ` ${amount.displayUnit}` : ""}`;
  return amount.inLineUnit === null
    ? formatAmount(amount as Pick<StockAmount, "display" | "displayUnit">)
    : `${number(amount.inLineUnit)} ${units[unit].label}`;
};

/** A line's unit label: a stock unit's label, a non-stock line's own text, or "" for none. */
export const lineUnitLabel = (line: { unit: UnitCode | null; unitLabel?: string | null }) =>
  line.unit ? units[line.unit].label : (line.unitLabel ?? "");

/** What a line buys: its item's name, or a non-stock line's description. */
export const lineTitle = (line: {
  item: { name: string } | null;
  description?: string | null;
  kind?: string;
}) =>
  line.kind === "non_stock" || !line.item ? (line.description ?? line.item?.name ?? "") : line.item.name;

/** How many lines have arrived in full: a bar and "1 of 3 lines in full". */
export function ReceivedProgress({ received, total }: { received: number; total: number }) {
  return (
    <div className="inline-flex w-36 flex-col gap-1 align-middle">
      <Progress value={total > 0 ? (received / total) * 100 : 0} aria-label="Lines received" />
      <span className="text-xs text-muted-foreground tabular-nums">
        {received} of {total} line{total === 1 ? "" : "s"} in full
      </span>
    </div>
  );
}
