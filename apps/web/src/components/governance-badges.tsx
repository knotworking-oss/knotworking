import {
  governanceComplianceStatusLabels,
  governanceConcernStatusLabels,
  governanceCultureStateLabels,
  governanceDueStatusLabels,
  governanceObjectiveRagLabels,
  governanceObjectiveStatusLabels,
  type GovernanceComplianceStatus,
  type GovernanceConcernStatus,
  type GovernanceCultureState,
  type GovernanceDueStatus,
  type GovernanceObjectiveRag,
  type GovernanceObjectiveStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";

const red = "border-transparent bg-label-red-bg text-label-red";
const orange = "border-transparent bg-label-orange-bg text-label-orange";
const green = "border-transparent bg-label-green-bg text-label-green";

export function GovernanceRagBadge({ rag }: { rag: GovernanceObjectiveRag }) {
  return (
    <Badge variant="outline" className={rag === "on_track" ? green : rag === "at_risk" ? orange : red}>
      {governanceObjectiveRagLabels[rag]}
    </Badge>
  );
}

export function GovernanceObjectiveStatusBadge({ status }: { status: GovernanceObjectiveStatus }) {
  return (
    <Badge
      variant={status === "withdrawn" ? "secondary" : "outline"}
      className={status === "achieved" ? green : status === "missed" ? red : undefined}
    >
      {governanceObjectiveStatusLabels[status]}
    </Badge>
  );
}

export function GovernanceDueBadge({ status }: { status: GovernanceDueStatus }) {
  if (status === "none") return null;
  return (
    <Badge variant="outline" className={status === "overdue" ? red : status === "due_soon" ? orange : green}>
      {governanceDueStatusLabels[status]}
    </Badge>
  );
}

export function GovernanceCultureBadge({ state }: { state: GovernanceCultureState }) {
  return (
    <Badge
      variant={state === "cancelled" ? "secondary" : "outline"}
      className={state === "done" ? green : state === "overdue" ? red : undefined}
    >
      {governanceCultureStateLabels[state]}
    </Badge>
  );
}

export function GovernanceComplianceBadge({ status }: { status: GovernanceComplianceStatus }) {
  const cls =
    status === "compliant"
      ? green
      : status === "partial"
        ? orange
        : status === "non_compliant"
          ? red
          : undefined;
  return (
    <Badge variant={status === "not_assessed" ? "secondary" : "outline"} className={cls}>
      {governanceComplianceStatusLabels[status]}
    </Badge>
  );
}

export function GovernanceConcernBadge({ status }: { status: GovernanceConcernStatus }) {
  return (
    <Badge
      variant={status === "closed" ? "secondary" : "outline"}
      className={status === "open" ? red : status === "investigating" ? orange : undefined}
    >
      {governanceConcernStatusLabels[status]}
    </Badge>
  );
}
