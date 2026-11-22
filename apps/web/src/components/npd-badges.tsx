import { npdStatusLabels, type NpdCheck, type NpdStatus } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { CircleAlert, CircleCheck, CircleMinus, PenLine } from "lucide-react";

const statusClasses: Partial<Record<NpdStatus, string>> = {
  launched: "border-transparent bg-label-green-bg text-label-green",
  validation: "border-transparent bg-label-orange-bg text-label-orange",
};

/** A product development project's stage. */
export function NpdStatusBadge({ status }: { status: NpdStatus }) {
  return (
    <Badge variant={status === "cancelled" ? "secondary" : "outline"} className={statusClasses[status]}>
      {npdStatusLabels[status]}
    </Badge>
  );
}

/** The launch checklist: met, missing or not applicable; people's sign-offs are marked. */
export function NpdChecklist({ checks }: { checks: readonly NpdCheck[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {checks.map((c) => (
        <li key={c.key} className="flex gap-2">
          {c.status === "met" ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-label-green" aria-label="Met" />
          ) : c.status === "missing" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Missing" />
          ) : (
            <CircleMinus
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-label="Doesn't apply"
            />
          )}
          <div className="flex flex-col">
            <span className="flex items-center gap-1 font-medium">
              {c.label}
              {c.manual && (
                <PenLine className="size-3 text-muted-foreground" aria-label="Signed by a person" />
              )}
            </span>
            <span className="text-muted-foreground">{c.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
