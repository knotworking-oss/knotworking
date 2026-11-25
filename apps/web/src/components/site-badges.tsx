import {
  breakageStatusLabels,
  checkOutcomeLabels,
  checkSignOffLabels,
  glassConditionLabels,
  pestActivityLabels,
  siteProgrammeLabels,
  type BreakageStatus,
  type CheckOutcome,
  type CheckSignOffStatus,
  type GlassCondition,
  type PestActivity,
  type SiteProgramme,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { CircleCheck, CircleX, Clock, ShieldAlert } from "lucide-react";

/** Which programme a due item belongs to. */
export function ProgrammeBadge({ programme }: { programme: SiteProgramme }) {
  return (
    <Badge variant="outline" className="whitespace-nowrap">
      {siteProgrammeLabels[programme]}
    </Badge>
  );
}

const conditionClasses: Record<GlassCondition, string> = {
  intact: "bg-label-green-bg text-label-green",
  damaged: "bg-label-red-bg text-label-red",
  missing: "bg-label-red-bg text-label-red",
};

/** A glass item's condition at its last check. */
export function ConditionBadge({ condition }: { condition: GlassCondition }) {
  return (
    <Badge className={`border-transparent ${conditionClasses[condition]}`}>
      {glassConditionLabels[condition]}
    </Badge>
  );
}

const activityClasses: Record<PestActivity, string> = {
  none: "bg-label-green-bg text-label-green",
  low: "bg-label-yellow-bg text-label-yellow",
  moderate: "bg-label-orange-bg text-label-orange",
  high: "bg-label-red-bg text-label-red",
};

/** Pest activity found at a device or place. */
export function ActivityBadge({ activity }: { activity: PestActivity }) {
  return (
    <Badge className={`border-transparent ${activityClasses[activity]}`}>
      {pestActivityLabels[activity]}
    </Badge>
  );
}

/** A breakage: the area is held until a person with manage releases it. */
export function BreakageBadge({ status }: { status: BreakageStatus }) {
  return (
    <Badge
      className={`border-transparent ${status === "open" ? "bg-label-red-bg text-label-red" : "bg-label-green-bg text-label-green"}`}
    >
      {status === "open" ? (
        <ShieldAlert data-icon="inline-start" />
      ) : (
        <CircleCheck data-icon="inline-start" />
      )}{" "}
      {breakageStatusLabels[status]}
    </Badge>
  );
}

/** The result of a pre-start or changeover check. */
export function OutcomeBadge({ outcome }: { outcome: CheckOutcome }) {
  return (
    <Badge
      className={`border-transparent ${outcome === "passed" ? "bg-label-green-bg text-label-green" : "bg-label-red-bg text-label-red"}`}
    >
      {outcome === "passed" ? <CircleCheck data-icon="inline-start" /> : <CircleX data-icon="inline-start" />}{" "}
      {checkOutcomeLabels[outcome]}
    </Badge>
  );
}

const signOffClasses: Record<CheckSignOffStatus, string> = {
  not_required: "text-muted-foreground",
  pending: "bg-label-yellow-bg text-label-yellow",
  approved: "bg-label-green-bg text-label-green",
  rejected: "bg-label-red-bg text-label-red",
};

/** Where a check stands before production starts: awaiting sign-off, signed off, or held. */
export function SignOffBadge({ status }: { status: CheckSignOffStatus }) {
  return (
    <Badge className={`border-transparent ${signOffClasses[status]}`}>
      {status === "pending" && <Clock data-icon="inline-start" />} {checkSignOffLabels[status]}
    </Badge>
  );
}
