import {
  defenceDueStatusLabels,
  defenceExerciseOutcomeLabels,
  defenceRatingLabels,
  defenceVersionStatusLabels,
  type DefenceDueStatus,
  type DefenceExerciseOutcome,
  type DefenceRating,
  type DefenceVersionStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";

const red = "border-transparent bg-label-red-bg text-label-red";
const orange = "border-transparent bg-label-orange-bg text-label-orange";
const green = "border-transparent bg-label-green-bg text-label-green";

/** Where a control's check or an assessment's review stands. */
export function DefenceDueBadge({ status }: { status: DefenceDueStatus }) {
  const cls = status === "overdue" || status === "never" ? red : status === "due_soon" ? orange : green;
  return (
    <Badge variant="outline" className={cls}>
      {defenceDueStatusLabels[status]}
    </Badge>
  );
}

/** A threat's rating from likelihood × impact. */
export function DefenceRatingBadge({ rating, score }: { rating: DefenceRating; score?: number }) {
  const cls = rating === "high" ? red : rating === "medium" ? orange : green;
  return (
    <Badge variant="outline" className={cls}>
      {defenceRatingLabels[rating]}
      {score !== undefined ? ` · ${score}` : ""}
    </Badge>
  );
}

export function DefenceVersionBadge({ status }: { status: DefenceVersionStatus }) {
  return (
    <Badge
      variant={status === "superseded" ? "secondary" : "outline"}
      className={status === "approved" ? green : undefined}
    >
      {defenceVersionStatusLabels[status]}
    </Badge>
  );
}

export function DefenceExerciseBadge({ outcome }: { outcome: DefenceExerciseOutcome }) {
  const cls = outcome === "effective" ? green : outcome === "partly_effective" ? orange : red;
  return (
    <Badge variant="outline" className={cls}>
      {defenceExerciseOutcomeLabels[outcome]}
    </Badge>
  );
}
