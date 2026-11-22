import {
  invoiceMatchIssueLabels,
  invoiceMatchStatusLabels,
  purchaseCreditNoteStatusLabels,
  purchaseInvoiceStatusLabels,
  type InvoiceMatchIssue,
  type InvoiceMatchStatus,
  type PurchaseCreditNoteStatus,
  type PurchaseInvoiceStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { CircleAlert, CircleCheck, CircleDot } from "lucide-react";

const statusClasses: Record<PurchaseInvoiceStatus, string> = {
  draft: "bg-label-gray-bg text-label-gray",
  approved: "bg-label-green-bg text-label-green",
  superseded: "bg-muted text-muted-foreground line-through",
};

/** A supplier invoice: draft, approved for payment, or superseded by a later version. */
export function InvoiceStatusBadge({ status, version }: { status: PurchaseInvoiceStatus; version?: number }) {
  return (
    <Badge className={`border-transparent ${statusClasses[status]}`}>
      {purchaseInvoiceStatusLabels[status]}
      {version && version > 1 ? ` · v${version}` : ""}
    </Badge>
  );
}

const matchClasses: Record<InvoiceMatchStatus, string> = {
  matched: "bg-label-green-bg text-label-green",
  within_tolerance: "bg-label-yellow-bg text-label-yellow",
  mismatch: "bg-label-red-bg text-label-red",
};
const matchIcons = { matched: CircleCheck, within_tolerance: CircleDot, mismatch: CircleAlert };

/** The three-way match of an invoice or a line: matched, within tolerance, or a mismatch. */
export function MatchStatusBadge({ status }: { status: InvoiceMatchStatus }) {
  const Icon = matchIcons[status];
  return (
    <Badge className={`border-transparent ${matchClasses[status]}`}>
      <Icon data-icon="inline-start" /> {invoiceMatchStatusLabels[status]}
    </Badge>
  );
}

/**
 * A price or quantity variance against the order or what was received: positive (over) in red,
 * negative in green, zero muted, a dash when it can't be worked out. `percent` follows in brackets.
 */
export function MatchVariance({
  value,
  percent,
  decimals = 4,
}: {
  value: number | null;
  percent?: number | null;
  decimals?: number;
}) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const tone = value > 0 ? "text-label-red" : value < 0 ? "text-label-green" : "text-muted-foreground";
  return (
    <span className={`tabular-nums ${tone}`}>
      {value > 0 ? "+" : ""}
      {value.toLocaleString("en-GB", { maximumFractionDigits: decimals })}
      {percent !== null && percent !== undefined && value !== 0 && (
        <span className="text-xs">
          {" "}
          ({percent > 0 ? "+" : ""}
          {percent}%)
        </span>
      )}
    </span>
  );
}

/** Why a line doesn't simply match, as a short list. */
export function MatchIssues({ issues }: { issues: readonly string[] }) {
  if (!issues.length) return null;
  return (
    <ul className="text-xs text-muted-foreground">
      {issues.map((issue) => (
        <li key={issue}>{invoiceMatchIssueLabels[issue as InvoiceMatchIssue] ?? issue}</li>
      ))}
    </ul>
  );
}

const creditStatusClasses: Record<PurchaseCreditNoteStatus, string> = {
  draft: "bg-label-gray-bg text-label-gray",
  approved: "bg-label-green-bg text-label-green",
  voided: "bg-muted text-muted-foreground line-through",
};

/** A supplier credit note: draft, approved, or voided. */
export function CreditNoteStatusBadge({ status }: { status: PurchaseCreditNoteStatus }) {
  return (
    <Badge className={`border-transparent ${creditStatusClasses[status]}`}>
      {purchaseCreditNoteStatusLabels[status]}
    </Badge>
  );
}
