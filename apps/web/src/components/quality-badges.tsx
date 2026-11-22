import {
  auditStatusLabels,
  complaintStatusLabels,
  nonconformanceStatusLabels,
  qualitySeverityLabels,
  type AuditState,
  type ComplaintStatus,
  type NonconformanceStatus,
  type QualitySeverity,
  type RecallTestState,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { CircleCheck, CircleX } from "lucide-react";

const severityClasses: Record<QualitySeverity, string> = {
  minor: "bg-label-gray-bg text-label-gray",
  major: "bg-label-orange-bg text-label-orange",
  critical: "bg-label-red-bg text-label-red",
};

/** How serious a complaint or non-conformance is. */
export function SeverityBadge({ severity }: { severity: QualitySeverity }) {
  return (
    <Badge className={`border-transparent ${severityClasses[severity]}`}>
      {qualitySeverityLabels[severity]}
    </Badge>
  );
}

const complaintClasses: Record<ComplaintStatus, string> = {
  open: "bg-label-blue-bg text-label-blue",
  investigating: "bg-label-yellow-bg text-label-yellow",
  closed: "bg-label-green-bg text-label-green",
};

export function ComplaintStatusBadge({ status }: { status: ComplaintStatus }) {
  return (
    <Badge className={`border-transparent ${complaintClasses[status]}`}>
      {complaintStatusLabels[status]}
    </Badge>
  );
}

const ncClasses: Record<NonconformanceStatus, string> = {
  open: "bg-label-blue-bg text-label-blue",
  action_taken: "bg-label-purple-bg text-label-purple",
  closed: "bg-label-green-bg text-label-green",
};

/** A non-conformance's status; an unresolved one past its due date shows as overdue. */
export function NonconformanceStatusBadge({
  status,
  overdue = false,
}: {
  status: NonconformanceStatus;
  overdue?: boolean;
}) {
  if (overdue) return <Badge className="border-transparent bg-label-red-bg text-label-red">Overdue</Badge>;
  return (
    <Badge className={`border-transparent ${ncClasses[status]}`}>{nonconformanceStatusLabels[status]}</Badge>
  );
}

const auditClasses: Record<AuditState, string> = {
  overdue: "bg-label-red-bg text-label-red",
  soon: "bg-label-yellow-bg text-label-yellow",
  planned: "bg-label-blue-bg text-label-blue",
  completed: "bg-label-green-bg text-label-green",
  cancelled: "bg-muted text-muted-foreground",
};
const auditLabels: Record<AuditState, string> = {
  ...auditStatusLabels,
  overdue: "Overdue",
  soon: "Coming up",
};

export function AuditStateBadge({ state }: { state: AuditState }) {
  return <Badge className={`border-transparent ${auditClasses[state]}`}>{auditLabels[state]}</Badge>;
}

/** A mock recall test's result: passed means fully reconciled within the target time. */
export function RecallResultBadge({ passed, voided = false }: { passed: boolean; voided?: boolean }) {
  if (voided)
    return (
      <Badge variant="outline" className="text-muted-foreground line-through">
        Voided
      </Badge>
    );
  return passed ? (
    <Badge className="border-transparent bg-label-green-bg text-label-green">
      <CircleCheck data-icon="inline-start" /> Passed
    </Badge>
  ) : (
    <Badge className="border-transparent bg-label-red-bg text-label-red">
      <CircleX data-icon="inline-start" /> Failed
    </Badge>
  );
}

const scheduleClasses: Record<RecallTestState, string> = {
  never: "bg-label-red-bg text-label-red",
  overdue: "bg-label-red-bg text-label-red",
  soon: "bg-label-yellow-bg text-label-yellow",
  ok: "bg-label-green-bg text-label-green",
};
const scheduleLabels: Record<RecallTestState, string> = {
  never: "Never tested",
  overdue: "Overdue",
  soon: "Due soon",
  ok: "Up to date",
};

/** Where the yearly mock recall test stands. */
export function RecallScheduleBadge({ state }: { state: RecallTestState }) {
  return <Badge className={`border-transparent ${scheduleClasses[state]}`}>{scheduleLabels[state]}</Badge>;
}
