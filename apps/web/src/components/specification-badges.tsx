import {
  allergens,
  specificationParameterCategoryLabels,
  specificationVersionStatusLabels,
  type SpecificationDiff,
  type SpecificationDiscrepancy,
  type SpecificationReviewState,
  type SpecificationVersionStatus,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { CircleAlert, TriangleAlert } from "lucide-react";

const versionClasses: Record<SpecificationVersionStatus, string> = {
  approved: "bg-label-green-bg text-label-green",
  draft: "bg-label-yellow-bg text-label-yellow",
  superseded: "bg-muted text-muted-foreground",
};

/** A specification version's document-control status, with its number: "v3 Approved". */
export function SpecificationVersionBadge({
  status,
  versionNumber,
}: {
  status: SpecificationVersionStatus;
  versionNumber?: number | undefined;
}) {
  return (
    <Badge className={`border-transparent ${versionClasses[status]}`}>
      {versionNumber !== undefined && `v${versionNumber} `}
      {specificationVersionStatusLabels[status]}
    </Badge>
  );
}

/** Where the approved version stands against its review date. Renders nothing when on track. */
export function SpecificationReviewBadge({
  state,
  reviewDueOn,
}: {
  state: SpecificationReviewState;
  reviewDueOn?: string | null | undefined;
}) {
  if (state === "ok") return null;
  if (state === "none") return <Badge variant="outline">Not approved</Badge>;
  return (
    <Badge
      variant={state === "overdue" ? "destructive" : "outline"}
      className={state === "due_soon" ? "border-transparent bg-label-orange-bg text-label-orange" : undefined}
      title={reviewDueOn ? `Review due ${reviewDueOn}` : undefined}
    >
      {state === "overdue" ? "Review overdue" : "Review due soon"}
    </Badge>
  );
}

/**
 * Where the item record disagrees with a specification. Serious ones (the item understates an
 * allergen or outlasts the agreed shelf life) are shown as an error. Renders nothing when they agree.
 */
export function SpecificationDiscrepancies({
  discrepancies,
  title = "The item record disagrees with this specification",
}: {
  discrepancies: readonly SpecificationDiscrepancy[];
  title?: string;
}) {
  if (discrepancies.length === 0) return null;
  const serious = discrepancies.some((d) => d.severity === "serious");
  return (
    <Alert variant={serious ? "destructive" : "default"}>
      {serious ? <TriangleAlert /> : <CircleAlert />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {discrepancies.map((d) => (
            <li key={d.kind}>{d.message}.</li>
          ))}
        </ul>
        <p className="mt-1">Fix the item, or the specification if it is the one that is wrong.</p>
      </AlertDescription>
    </Alert>
  );
}

/** Why a draft can't be approved yet. Renders nothing when it can. */
export function SpecificationBlockers({ blockers }: { blockers: readonly string[] }) {
  if (blockers.length === 0) return null;
  return (
    <Alert>
      <CircleAlert />
      <AlertTitle>Not ready to approve</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** What a version changes against the one before it: fields, then parameters. */
export function SpecificationChanges({ diff, against }: { diff: SpecificationDiff; against?: string }) {
  if (diff.fields.length === 0 && diff.parameters.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes{against ? ` from ${against}` : ""}.</p>;
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      {(diff.addedAllergens.length > 0 || diff.removedAllergens.length > 0) && (
        <p className="flex flex-wrap items-center gap-1">
          {diff.addedAllergens.map((c) => (
            <Badge key={`+${c}`} variant="destructive">
              + {allergens[c]}
            </Badge>
          ))}
          {diff.removedAllergens.map((c) => (
            <Badge key={`-${c}`} variant="outline">
              − {allergens[c]}
            </Badge>
          ))}
        </p>
      )}
      {diff.fields.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[12rem_1fr]">
          {diff.fields.map((f) => (
            <div key={f.field} className="contents">
              <dt className="text-muted-foreground">
                {f.label}
                {f.impacting && (
                  <span
                    className="ml-1 text-xs text-label-orange"
                    title="Recipes, labels or production rely on this"
                  >
                    ●
                  </span>
                )}
              </dt>
              <dd className="break-words">
                <span className="text-muted-foreground line-through">{f.from}</span> → {f.to}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {diff.parameters.length > 0 && (
        <ul className="flex flex-col gap-1">
          {diff.parameters.map((p) => (
            <li key={`${p.category}:${p.name}`}>
              <Badge variant="outline" className="mr-2">
                {p.change === "added" ? "Added" : p.change === "removed" ? "Removed" : "Changed"}
              </Badge>
              <span className="text-muted-foreground">
                {specificationParameterCategoryLabels[p.category]}:
              </span>{" "}
              {p.name}{" "}
              {p.change === "changed" ? (
                <>
                  <span className="text-muted-foreground line-through">{p.from}</span> → {p.to}
                </>
              ) : (
                <span className="text-muted-foreground">{p.to ?? p.from}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
