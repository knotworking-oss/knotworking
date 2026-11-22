import { Badge } from "@knotworking/ui/components/badge";
export function HseAttention({
  attention,
}: {
  attention: { reviewOverdue: boolean; openFailures: number; state: string; dueOn: string | null };
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {attention.reviewOverdue && <Badge variant="destructive">Review overdue</Badge>}
      {attention.openFailures > 0 && (
        <Badge variant="destructive">{attention.openFailures} unresolved failures</Badge>
      )}
      <Badge variant={attention.state === "overdue" ? "destructive" : "outline"}>
        {attention.state.replace(/_/g, " ")}
        {attention.dueOn ? ` · ${attention.dueOn}` : ""}
      </Badge>
    </div>
  );
}
