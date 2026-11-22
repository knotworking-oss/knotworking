import {
  testOutcomeLabels,
  testSampleStatusLabels,
  type TestOutcome,
  type TestPlanDueState,
  type TestSampleStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";

const outcomeClasses: Record<TestOutcome, string> = {
  pass: "bg-label-green-bg text-label-green",
  fail: "",
  pending: "bg-muted text-muted-foreground",
};

/** A result's or sample's outcome: pass, fail or pending. */
export function TestOutcomeBadge({ outcome }: { outcome: TestOutcome }) {
  return (
    <Badge
      variant={outcome === "fail" ? "destructive" : "default"}
      className={outcome === "fail" ? undefined : `border-transparent ${outcomeClasses[outcome]}`}
    >
      {testOutcomeLabels[outcome]}
    </Badge>
  );
}

/** Where a sample is: awaiting results, complete or cancelled. */
export function TestSampleStatusBadge({ status }: { status: TestSampleStatus }) {
  return (
    <Badge variant={status === "awaiting_results" ? "outline" : "secondary"}>
      {testSampleStatusLabels[status]}
    </Badge>
  );
}

/** An open investigation on a failed sample. Renders nothing otherwise. */
export function TestInvestigationBadge({ status }: { status: "open" | "closed" | null }) {
  if (status !== "open") return null;
  return <Badge variant="destructive">Investigation open</Badge>;
}

const dueLabels: Record<TestPlanDueState, string> = {
  overdue: "Overdue",
  due: "Due today",
  due_soon: "Due soon",
  ok: "On schedule",
};

/** Where a sampling plan stands against its next due date. */
export function TestPlanDueBadge({ state }: { state: TestPlanDueState }) {
  if (state === "overdue") return <Badge variant="destructive">{dueLabels[state]}</Badge>;
  if (state === "ok") return <Badge variant="secondary">{dueLabels[state]}</Badge>;
  return (
    <Badge className="border-transparent bg-label-orange-bg text-label-orange">{dueLabels[state]}</Badge>
  );
}
