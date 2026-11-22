import { Badge } from "@knotworking/ui/components/badge";
import { salesStatuses } from "@knotworking/core";
export function SalesStatusBadge({ status }: { status: (typeof salesStatuses)[number] }) {
  return (
    <Badge variant={status === "cancelled" ? "outline" : "secondary"}>
      {status === "draft"
        ? "Draft"
        : status === "issued"
          ? "Issued quote"
          : status === "confirmed"
            ? "Confirmed order"
            : "Cancelled"}
    </Badge>
  );
}
