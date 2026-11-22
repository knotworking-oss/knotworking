import { lotStatusLabels, units, type LotStatus, type StockAmount } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";

const statusClasses: Record<LotStatus, string> = {
  available: "bg-label-green-bg text-label-green",
  quarantine: "bg-label-yellow-bg text-label-yellow",
  rejected: "bg-label-red-bg text-label-red",
};

/** A lot's QA status: available, quarantine (held) or rejected. */
export function LotStatusBadge({ status }: { status: LotStatus }) {
  return <Badge className={`border-transparent ${statusClasses[status]}`}>{lotStatusLabels[status]}</Badge>;
}

export { ExpiryBadge } from "./expiry-badge";

/** A ledger quantity in the item's own unit, e.g. "12.5 kg". */
export const formatAmount = (amount: Pick<StockAmount, "display" | "displayUnit">) =>
  `${amount.display.toLocaleString("en-GB", { maximumFractionDigits: 4 })} ${units[amount.displayUnit].label}`;
