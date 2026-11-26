import { jobCardStatusLabels, type JobCardStatus } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";

/** A job card's status (Routings). */
export function JobCardStatusBadge({ status }: { status: JobCardStatus }) {
  return (
    <Badge
      variant={
        status === "completed"
          ? "default"
          : status === "in_progress"
            ? "secondary"
            : status === "cancelled"
              ? "outline"
              : "outline"
      }
    >
      {jobCardStatusLabels[status]}
    </Badge>
  );
}
