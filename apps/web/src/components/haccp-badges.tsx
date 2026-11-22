import {
  ccpLogReviewStatusLabels,
  correctiveActionStatusLabels,
  deviationReasonLabels,
  dueStateLabels,
  haccpHazardTypeLabels,
  haccpPlanVersionStatusLabels,
  planVersionStateLabels,
  type CcpLogReviewStatus,
  type CorrectiveActionStatus,
  type DeviationReason,
  type DueState,
  type HaccpHazardType,
  type HaccpPlanVersionStatus,
  type PlanVersionState,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { CircleCheck, CircleX, Clock, Cpu, Undo2 } from "lucide-react";

const dueClasses: Record<DueState, string> = {
  overdue: "bg-label-red-bg text-label-red",
  due: "bg-label-orange-bg text-label-orange",
  soon: "bg-label-yellow-bg text-label-yellow",
  ok: "bg-label-green-bg text-label-green",
  idle: "bg-muted text-muted-foreground",
};

/** Where a scheduled check stands: overdue, due, due soon, up to date, or idle outside production. */
export function DueStateBadge({ state }: { state: DueState }) {
  return <Badge className={`border-transparent ${dueClasses[state]}`}>{dueStateLabels[state]}</Badge>;
}

/** A reading against its critical limit: within, or out (and which way). */
export function ReadingBadge({
  withinLimits,
  reason,
}: {
  withinLimits: boolean;
  reason?: DeviationReason | null | undefined;
}) {
  if (withinLimits) {
    return (
      <Badge className="border-transparent bg-label-green-bg text-label-green">
        <CircleCheck data-icon="inline-start" /> Within limits
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-label-red-bg text-label-red">
      <CircleX data-icon="inline-start" /> {reason ? deviationReasonLabels[reason] : "Out of limits"}
    </Badge>
  );
}

const hazardClasses: Record<HaccpHazardType, string> = {
  biological: "bg-label-purple-bg text-label-purple",
  chemical: "bg-label-blue-bg text-label-blue",
  physical: "bg-label-gray-bg text-label-gray",
  allergen: "bg-label-orange-bg text-label-orange",
};

/** The kind of hazard a CCP controls. */
export function HazardBadge({ type }: { type: HaccpHazardType }) {
  return <Badge className={`border-transparent ${hazardClasses[type]}`}>{haccpHazardTypeLabels[type]}</Badge>;
}

const versionClasses: Record<HaccpPlanVersionStatus, string> = {
  draft: "bg-label-yellow-bg text-label-yellow",
  approved: "bg-label-green-bg text-label-green",
  superseded: "bg-muted text-muted-foreground",
};

/** A plan version in document control. */
export function PlanVersionBadge({ status }: { status: HaccpPlanVersionStatus }) {
  return (
    <Badge className={`border-transparent ${versionClasses[status]}`}>
      {haccpPlanVersionStatusLabels[status]}
    </Badge>
  );
}

const stateClasses: Record<PlanVersionState, string> = {
  draft: "bg-label-yellow-bg text-label-yellow",
  scheduled: "bg-label-blue-bg text-label-blue",
  in_force: "bg-label-green-bg text-label-green",
  replaced: "bg-muted text-muted-foreground",
};

/** Where a plan version stands by its effective date: in force, scheduled, replaced or a draft. */
export function PlanVersionStateBadge({ state }: { state: PlanVersionState }) {
  return (
    <Badge className={`border-transparent ${stateClasses[state]}`}>{planVersionStateLabels[state]}</Badge>
  );
}

/** A corrective action: open until a person with manage closes it. */
export function CorrectiveActionBadge({ status }: { status: CorrectiveActionStatus }) {
  return (
    <Badge
      className={`border-transparent ${status === "open" ? "bg-label-red-bg text-label-red" : "bg-label-green-bg text-label-green"}`}
    >
      {correctiveActionStatusLabels[status]}
    </Badge>
  );
}

/**
 * Where a CCP reading stands in review: "Awaiting review" (recorded through an API token, not yet
 * reviewed by a person with manage) or "Rejected" (with the reviewer's note as its title). An
 * approved reading needs no badge, so nothing is shown.
 */
export function ReviewStatusBadge({
  status,
  note,
}: {
  status: CcpLogReviewStatus;
  note?: string | null | undefined;
}) {
  if (status === "approved") return null;
  if (status === "pending") {
    return (
      <Badge className="border-transparent bg-label-yellow-bg text-label-yellow">
        <Clock data-icon="inline-start" /> {ccpLogReviewStatusLabels.pending}
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-muted text-muted-foreground" title={note ?? undefined}>
      <Undo2 data-icon="inline-start" /> {ccpLogReviewStatusLabels.rejected}
    </Badge>
  );
}

/** Marks a record that came through an API token (a sensor feed or an agent). */
export function ApiSourceBadge() {
  return (
    <Badge variant="outline" className="text-muted-foreground" title="Recorded through an API token">
      <Cpu data-icon="inline-start" /> API
    </Badge>
  );
}
