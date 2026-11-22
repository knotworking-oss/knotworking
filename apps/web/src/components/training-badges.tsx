import { trainingStatusLabels, type TrainingStatus } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { cn } from "@knotworking/ui/lib/utils";

/** Colours per status: green in date, amber needs attention soon, red lapsed or missing, blue waiting on a manager. */
const classes: Record<TrainingStatus, string> = {
  current: "border-transparent bg-label-green-bg text-label-green",
  expiring: "border-transparent bg-label-yellow-bg text-label-yellow",
  expired: "border-transparent bg-label-red-bg text-label-red",
  outdated: "border-transparent bg-label-orange-bg text-label-orange",
  pending_sign_off: "border-transparent bg-label-blue-bg text-label-blue",
  missing: "border-transparent bg-label-red-bg text-label-red",
  not_required: "border-dashed text-muted-foreground",
};

export function TrainingStatusBadge({
  status,
  overdue = false,
  className,
}: {
  status: TrainingStatus;
  overdue?: boolean;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(classes[status], className)}>
      {status === "missing" && overdue ? "Overdue" : trainingStatusLabels[status]}
    </Badge>
  );
}

/** A small square for one cell of the training matrix, with the status spelled out for screen readers. */
export function TrainingCell({
  status,
  overdue = false,
  title,
}: {
  status: TrainingStatus;
  overdue?: boolean;
  title?: string;
}) {
  const label = status === "missing" && overdue ? "Overdue" : trainingStatusLabels[status];
  return (
    <span
      title={title ? `${label}: ${title}` : label}
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-md border px-1 text-[0.65rem] font-semibold",
        classes[status],
        status === "missing" && overdue && "ring-1 ring-destructive",
      )}
    >
      <span aria-hidden>{SHORT[status]}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

const SHORT: Record<TrainingStatus, string> = {
  current: "✓",
  expiring: "!",
  expired: "✕",
  outdated: "↻",
  pending_sign_off: "…",
  missing: "–",
  not_required: "",
};
