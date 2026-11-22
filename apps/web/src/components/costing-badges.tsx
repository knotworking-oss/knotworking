import {
  lotCostReasonLabels,
  lotCostSourceLabels,
  units,
  type LotCostReason,
  type LotCostSource,
  type UnitCode,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { formatMoney } from "@/lib/format";

/** A cost or variance in the workspace's currency: `£1,234.50`, up to 4 decimals where a figure needs them. */
export const formatCost = (value: number, currency: string) => formatMoney(value, currency);

/** A cost per unit, "£1.3895 / kg": up to the 8 places a per-gram cost may need. */
export const formatUnitCost = (value: number | null, unit: UnitCode | null | undefined, currency: string) =>
  value === null
    ? "—"
    : `${formatMoney(value, currency, { maxDecimals: value < 0.01 ? 8 : 4 })}${unit ? ` / ${units[unit].label}` : ""}`;

const sourceClasses: Record<LotCostSource, string> = {
  invoice: "bg-label-teal-bg text-label-teal",
  purchase: "bg-label-green-bg text-label-green",
  batch: "bg-label-blue-bg text-label-blue",
  standard: "bg-label-yellow-bg text-label-yellow",
  missing: "bg-label-red-bg text-label-red",
};

/**
 * Where a consumed lot's cost comes from: the approved invoice price, the purchase price, the batch that made it, or the
 * item's standard cost (an estimate, with why), or nothing at all.
 */
export function CostSourceBadge({
  source,
  reason,
  estimatedPercent,
}: {
  source: LotCostSource;
  reason?: LotCostReason | null;
  /** For a lot made by a batch: how much of that batch's cost was estimated. */
  estimatedPercent?: number;
}) {
  const partly = source === "batch" && (estimatedPercent ?? 0) > 0;
  return (
    <Badge
      className={`border-transparent ${partly ? "bg-label-yellow-bg text-label-yellow" : sourceClasses[source]}`}
      title={reason ? lotCostReasonLabels[reason] : undefined}
    >
      {lotCostSourceLabels[source]}
      {partly && ` · ${estimatedPercent}% estimated`}
    </Badge>
  );
}

/**
 * A variance: actual minus standard. Positive is adverse (red, "+"), negative favourable (green);
 * a dash when it can't be worked out.
 */
export function VarianceValue({
  value,
  percent,
  currency,
}: {
  value: number | null;
  percent?: number | null;
  currency: string;
}) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const tone = value > 0 ? "text-label-red" : value < 0 ? "text-label-green" : "text-muted-foreground";
  return (
    <span
      className={`tabular-nums ${tone}`}
      title={value > 0 ? "Adverse" : value < 0 ? "Favourable" : undefined}
    >
      {value > 0 ? "+" : ""}
      {formatCost(value, currency)}
      {percent !== undefined && percent !== null && (
        <span className="ml-1 text-xs">
          ({percent > 0 ? "+" : ""}
          {percent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%)
        </span>
      )}
    </span>
  );
}

/** The share of a cost resting on standard costs rather than prices paid; nothing when none. */
export function EstimatedBadge({ percent }: { percent: number | null }) {
  if (!percent) return null;
  return (
    <Badge
      className="border-transparent bg-label-yellow-bg text-label-yellow tabular-nums"
      title="Lots with no purchase price, valued at the item's standard cost"
    >
      {percent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}% estimated
    </Badge>
  );
}

/** The figures can still change: the batch, or one upstream of it, is still in progress. */
export function ProvisionalBadge() {
  return (
    <Badge
      className="border-transparent bg-label-gray-bg text-label-gray"
      title="This batch, or one that made what it used, is still in progress"
    >
      Provisional
    </Badge>
  );
}

/** Some of the cost is missing: items with neither a purchase price nor a standard cost. */
export function IncompleteCostBadge({ codes }: { codes: readonly string[] }) {
  return (
    <Badge
      className="border-transparent bg-label-red-bg text-label-red"
      title={codes.length ? `No price or standard cost: ${codes.join(", ")}` : undefined}
    >
      Cost incomplete
    </Badge>
  );
}
