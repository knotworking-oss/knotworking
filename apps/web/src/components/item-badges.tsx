import {
  allergens,
  supplierApprovalLabels,
  type AllergenCode,
  type SupplierApprovalStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";

/** Allergens an item contains (solid) and may contain (dashed outline), in declaration order. */
export function AllergenBadges({
  contains,
  mayContain = [],
  empty = "None declared",
}: {
  contains: readonly AllergenCode[];
  mayContain?: readonly AllergenCode[];
  empty?: string;
}) {
  if (contains.length === 0 && mayContain.length === 0) {
    return <span className="text-muted-foreground">{empty}</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {contains.map((code) => (
        <Badge key={code} className="border-transparent bg-label-orange-bg text-label-orange">
          {allergens[code]}
        </Badge>
      ))}
      {mayContain.map((code) => (
        <Badge key={`may-${code}`} variant="outline" className="border-dashed text-muted-foreground">
          May contain: {allergens[code].toLowerCase()}
        </Badge>
      ))}
    </span>
  );
}

const approvalClasses: Record<SupplierApprovalStatus, string> = {
  approved: "bg-label-green-bg text-label-green",
  pending: "bg-label-yellow-bg text-label-yellow",
  suspended: "bg-label-orange-bg text-label-orange",
  rejected: "bg-label-red-bg text-label-red",
};

/** A supplier's approval status. */
export function SupplierApprovalBadge({ status }: { status: SupplierApprovalStatus }) {
  return (
    <Badge className={`border-transparent ${approvalClasses[status]}`}>
      {supplierApprovalLabels[status]}
    </Badge>
  );
}
