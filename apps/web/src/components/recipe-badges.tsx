import {
  allergens,
  recipeVersionStatusLabels,
  type AllergenDrift,
  type AllergenMismatch,
  type RecipeVersionStatus,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { TriangleAlert } from "lucide-react";

const versionClasses: Record<RecipeVersionStatus, string> = {
  approved: "bg-label-green-bg text-label-green",
  draft: "bg-label-yellow-bg text-label-yellow",
  superseded: "bg-muted text-muted-foreground",
};

/** A recipe version's document-control status, with its number: "v3 Approved". */
export function RecipeVersionBadge({
  status,
  versionNumber,
}: {
  status: RecipeVersionStatus;
  versionNumber?: number | undefined;
}) {
  return (
    <Badge className={`border-transparent ${versionClasses[status]}`}>
      {versionNumber !== undefined && `v${versionNumber} `}
      {recipeVersionStatusLabels[status]}
    </Badge>
  );
}

/**
 * Shown when the allergens the ingredients bring in differ from what the output item declares.
 * Renders nothing when they match.
 */
export function AllergenMismatchAlert({ mismatch }: { mismatch: AllergenMismatch }) {
  if (mismatch.undeclared.length === 0 && mismatch.unexplained.length === 0) return null;
  const names = (codes: readonly (keyof typeof allergens)[]) => codes.map((c) => allergens[c]).join(", ");
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>Allergens don&apos;t match the output item</AlertTitle>
      <AlertDescription>
        {mismatch.undeclared.length > 0 && (
          <p>
            Brought in by the ingredients but not declared on the output item: {names(mismatch.undeclared)}.
          </p>
        )}
        {mismatch.unexplained.length > 0 && (
          <p>Declared on the output item but in no ingredient: {names(mismatch.unexplained)}.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Shown on an approved version when an ingredient's allergen declaration changed after approval,
 * so the allergens recorded with the approval no longer match. Renders nothing when they match.
 */
export function AllergenDriftAlert({ drift }: { drift: AllergenDrift | null | undefined }) {
  if (!drift) return null;
  const names = (codes: readonly (keyof typeof allergens)[]) => codes.map((c) => allergens[c]).join(", ");
  const parts: [string, readonly (keyof typeof allergens)[]][] = [
    ["Now contain", drift.contains.added],
    ["No longer contain", drift.contains.removed],
    ["Now may contain", drift.mayContain.added],
    ["No longer may contain", drift.mayContain.removed],
  ];
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>Ingredient allergens changed since approval</AlertTitle>
      <AlertDescription>
        {parts
          .filter(([, codes]) => codes.length > 0)
          .map(([label, codes]) => (
            <p key={label}>
              {label}: {names(codes)}.
            </p>
          ))}
        <p>Review the ingredients and the output item, then approve a new version to record the change.</p>
      </AlertDescription>
    </Alert>
  );
}
