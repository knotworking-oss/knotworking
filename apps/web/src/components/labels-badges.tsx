import {
  labelStaleKindLabels,
  nutritionSourceLabels,
  productLabelStatusLabels,
  type LabelStaleReason,
  type NutritionSource,
  type ProductLabelStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";

const statusClasses: Record<ProductLabelStatus, string> = {
  approved: "bg-label-green-bg text-label-green",
  draft: "bg-label-yellow-bg text-label-yellow",
  superseded: "bg-muted text-muted-foreground",
};

/** A label's document-control status, with its number: "v2 Approved". */
export function LabelStatusBadge({
  status,
  versionNumber,
}: {
  status: ProductLabelStatus;
  versionNumber?: number | undefined;
}) {
  return (
    <Badge className={`border-transparent ${statusClasses[status]}`}>
      {versionNumber !== undefined && `v${versionNumber} `}
      {productLabelStatusLabels[status]}
    </Badge>
  );
}

/**
 * An approved label that needs review, or a draft that needs a refresh: the recipe or an
 * ingredient changed after it was made. The reasons are the badge's title.
 */
export function StaleLabelBadge({
  status,
  reasons,
}: {
  status: ProductLabelStatus;
  reasons: LabelStaleReason[];
}) {
  if (reasons.length === 0) return null;
  const title = reasons
    .map((r) => `${labelStaleKindLabels[r.kind]}${r.itemCodes.length ? `: ${r.itemCodes.join(", ")}` : ""}`)
    .join("\n");
  return (
    <Badge className="border-transparent bg-label-orange-bg text-label-orange" title={title}>
      {status === "draft" ? "Out of date" : "Needs review"}
    </Badge>
  );
}

const sourceClasses: Record<NutritionSource, string> = {
  entered: "bg-label-green-bg text-label-green",
  recipe: "bg-label-blue-bg text-label-blue",
  missing: "bg-label-red-bg text-label-red",
};

/** Where an item's nutrition comes from: entered from a specification, its recipe, or missing. */
export function NutritionSourceBadge({ source }: { source: NutritionSource }) {
  return (
    <Badge className={`border-transparent ${sourceClasses[source]}`}>{nutritionSourceLabels[source]}</Badge>
  );
}
