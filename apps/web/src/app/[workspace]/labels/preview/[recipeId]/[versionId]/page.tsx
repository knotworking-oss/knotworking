import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import type { Metadata } from "next";
import Link from "next/link";
import { LabelPreview, TrafficLights } from "@/components/label-preview";
import { PageHeader } from "@/components/page-header";
import { getLabelPreview } from "@/lib/api";

export const metadata: Metadata = { title: "Label preview" };

/**
 * A recipe version's label as it would read now, computed and never stored: for a draft version
 * (marked DRAFT) or any other. It can't be approved; a label is drafted from the approved version.
 */
export default async function LabelPreviewPage({
  params,
}: {
  params: Promise<{ workspace: string; recipeId: string; versionId: string }>;
}) {
  const { workspace: slug, recipeId, versionId } = await params;
  const facts = await getLabelPreview(slug, recipeId, versionId);
  const { preview } = facts;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Label preview: {facts.recipe.name}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
          <Alert>
            <AlertTitle>
              Preview of {facts.recipe.code} v{facts.version.versionNumber} ({facts.version.status})
            </AlertTitle>
            <AlertDescription>
              <p>
                Computed from the recipe version and the ingredients' current data. Nothing is saved and it
                can&apos;t be approved
                {facts.version.status === "approved" ? (
                  <>
                    ; draft the label from{" "}
                    <Link href={`/${slug}/labels`} className="underline">
                      Labels
                    </Link>
                    .
                  </>
                ) : (
                  ": approve the recipe version first, then draft its label."
                )}
              </p>
            </AlertDescription>
          </Alert>
          <LabelPreview
            watermark={preview.watermark}
            label={{
              productName: preview.productName,
              ingredients: preview.ingredients,
              allergenStatement: preview.allergenStatement,
              includeNutrition: true,
              nutrition: preview.nutrition,
              storageInstructions: preview.storageInstructions,
              dateGuidance: preview.dateGuidance,
              netQuantity: preview.netQuantity,
            }}
          />
          {preview.trafficLights && <TrafficLights lights={preview.trafficLights} />}
          {facts.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              {facts.warnings.map((w) => (
                <li key={`${w.kind}-${w.itemCode}-${w.message}`}>{w.message}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
