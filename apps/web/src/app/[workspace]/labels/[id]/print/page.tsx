import { allergens, labelStaleKindLabels } from "@knotworking/core";
import type { Metadata } from "next";
import Link from "next/link";
import { LabelPreview } from "@/components/label-preview";
import { PrintHeading, PrintNotice, PrintPage } from "@/components/print-page";
import { getBootstrap, getProductLabel } from "@/lib/api";
import { labelPrintState } from "@/lib/label-print";
import { printDate } from "@/lib/print";

export const metadata: Metadata = { title: "Print label" };

/** The label as it goes on pack, on an A4 sheet; "DRAFT" or "NEEDS REVIEW" across it unless it is approved and current. */
export default async function PrintLabelPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [label, boot] = await Promise.all([getProductLabel(slug, id), getBootstrap(slug)]);
  const state = labelPrintState(label);

  return (
    <PrintPage
      crumbs={
        <>
          <Link href={`/${slug}/labels`} className="text-muted-foreground hover:text-foreground">
            Labels
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link href={`/${slug}/labels/${label.id}`} className="text-muted-foreground hover:text-foreground">
            {label.productName}
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-medium">Print</h1>
        </>
      }
    >
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={boot.workspace.timeZone}
        title="Product label"
        subtitle={`${label.productName} · label v${label.versionNumber}${label.recipe ? ` · recipe ${label.recipe.code}` : ""}`}
      />
      {state.banner && (
        <div className="mb-4">
          <PrintNotice strong>
            {state.banner}
            <p className="text-sm font-normal normal-case">{state.reason}</p>
            {label.stale && (
              <ul className="list-disc pl-5 text-sm font-normal normal-case">
                {label.staleReasons.map((r) => (
                  <li key={r.kind}>
                    {labelStaleKindLabels[r.kind]}
                    {r.itemCodes.length > 0 && `: ${r.itemCodes.join(", ")}`}
                  </li>
                ))}
              </ul>
            )}
          </PrintNotice>
        </div>
      )}

      <div className="relative overflow-hidden">
        <LabelPreview label={label} />
        {state.banner && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-7xl font-black tracking-widest text-black/15 uppercase"
            style={{ transform: "rotate(-20deg)" }}
          >
            {state.banner}
          </span>
        )}
      </div>

      <dl className="mt-6 grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 border-t border-black/40 pt-3 text-[12px]">
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          {state.status}
          {label.approvedAt &&
            ` · approved ${printDate(label.approvedAt, boot.workspace.timeZone)}${label.approvedByName ? ` by ${label.approvedByName}` : ""}`}
        </dd>
        <dt className="text-muted-foreground">Recipe version</dt>
        <dd>{label.recipeVersion ? `v${label.recipeVersion.versionNumber}` : "—"}</dd>
        <dt className="text-muted-foreground">Allergens</dt>
        <dd>
          {label.allergens.contains.length > 0
            ? `Contains: ${label.allergens.contains.map((a) => allergens[a]).join(", ")}`
            : "None"}
          {label.allergens.mayContain.length > 0 &&
            ` · may contain: ${label.allergens.mayContain.map((a) => allergens[a]).join(", ")}`}
        </dd>
        {label.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd>{label.notes}</dd>
          </>
        )}
      </dl>
    </PrintPage>
  );
}
