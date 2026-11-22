"use client";

import {
  compoundStyleLabels,
  compoundStyles,
  energyMethodLabels,
  energyMethods,
  type EnergyMethod,
  labelPanelSourceLabels,
  labelStaleKindLabels,
  missingNutritionReasonLabels,
  nutrientKeys,
  nutrientLabels,
  nutrientUnits,
  nutritionBasisLabels,
  nutritionBases,
  type CompoundStyle,
  type DeclarationEntry,
  type NutrientKey,
  type NutritionBasis,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { CheckCircle2, Pencil, Printer, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { AllergenBadges } from "@/components/item-badges";
import { LabelPreview, TrafficLights } from "@/components/label-preview";
import { LabelStatusBadge, StaleLabelBadge } from "@/components/labels-badges";
import { AllergenMismatchAlert } from "@/components/recipe-badges";
import type { ProductLabelDetail } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

const labelsApi = () => browserApi().v1.workspaces[":slug"].labelling.labels;

/** A product label: the preview, what it was drafted from, and the draft's editing and approval. */
export function LabelDetail({ slug, label }: { slug: string; label: ProductLabelDetail }) {
  const timeZone = useWorkspaceTimeZone();
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("labels", "write");
  const canManage = can("labels", "manage");
  const [pending, setPending] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"text" | "options" | "nutrition" | "portion" | null>(null);
  const isDraft = label.status === "draft";
  const facts = label.facts;
  const hasDraft = label.history.some((h) => h.status === "draft");
  // The API refuses these too; saying why here saves a round trip.
  const approveBlocker = label.stale
    ? "Out of date: refresh it first"
    : label.includeNutrition && !label.nutrition
      ? "No nutrition panel: complete the data and refresh, type it in, or declare none"
      : null;

  async function run(key: string, action: () => Promise<unknown>, done: string) {
    setPending(key);
    try {
      await action();
      toast.success(done);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function draftCorrection() {
    setPending("correct");
    try {
      const draft = await unwrap(
        labelsApi().$post({ param: { slug }, json: { recipeId: label.recipeId, variant: label.variant } }),
      );
      toast.success("New draft started");
      router.push(`/${slug}/labels/${draft.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={`/${slug}/labels`} className="hover:underline">
              Labels
            </Link>{" "}
            /{" "}
            {label.recipe ? (
              <Link href={`/${slug}/recipes/${label.recipe.id}`} className="hover:underline">
                <span className="font-mono text-xs">{label.recipe.code}</span>
              </Link>
            ) : (
              "—"
            )}
          </p>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {label.productName}
            {label.variant !== "Standard" && (
              <span className="text-base font-normal text-muted-foreground">· {label.variant}</span>
            )}
            <LabelStatusBadge status={label.status} versionNumber={label.versionNumber} />
            <StaleLabelBadge status={label.status} reasons={label.staleReasons} />
          </h2>
          <p className="text-sm text-muted-foreground">
            From {label.recipe?.name ?? "a recipe"}
            {label.recipeVersion && ` v${label.recipeVersion.versionNumber}`}
            {label.approvedAt &&
              ` · approved ${formatLongDate(label.approvedAt, timeZone)}${label.approvedByName ? ` by ${label.approvedByName}` : ""}`}
            {isDraft && label.lastEditedByName && ` · last edited by ${label.lastEditedByName}`}
          </p>
          {isDraft && canManage && (
            <p className="text-xs text-muted-foreground">
              Approval needs a manager other than whoever last edited the draft (unless there is only one
              manager).
            </p>
          )}
          {label.otherLabels.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Other labels of this recipe:{" "}
              {label.otherLabels.map((o, i) => (
                <span key={o.id}>
                  {i > 0 && ", "}
                  <Link href={`/${slug}/labels/${o.id}`} className="underline">
                    {o.variant} v{o.versionNumber}
                  </Link>{" "}
                  ({o.status})
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/${slug}/labels/${label.id}/print`}>
              <Printer data-icon="inline-start" /> Print
            </Link>
          </Button>
          {isDraft && canWrite && (
            <>
              <Button variant="outline" onClick={() => setDialog("text")}>
                <Pencil data-icon="inline-start" /> Edit text
              </Button>
              <Button variant="outline" onClick={() => setDialog("nutrition")}>
                Nutrition panel
              </Button>
              {label.nutrition && (
                <Button variant="outline" onClick={() => setDialog("portion")}>
                  Portion and rounding
                </Button>
              )}
              <Button variant="outline" onClick={() => setDialog("options")} disabled={pending !== null}>
                <RefreshCw data-icon="inline-start" /> Refresh
              </Button>
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() => {
                  if (!window.confirm("Delete this draft label?")) return;
                  void run(
                    "delete",
                    async () => {
                      await unwrapEmpty(labelsApi()[":id"].$delete({ param: { slug, id: label.id } }));
                      router.push(`/${slug}/labels`);
                    },
                    "Draft deleted",
                  );
                }}
              >
                Delete
              </Button>
            </>
          )}
          {isDraft && canManage && (
            <Button
              disabled={pending !== null || approveBlocker !== null}
              title={approveBlocker ?? undefined}
              onClick={() => {
                if (
                  !window.confirm(
                    `Approve label v${label.versionNumber}? It becomes the label for ${label.recipe?.code ?? "this recipe"}${label.history.some((h) => h.status === "approved") ? " and the approved one is superseded" : ""}.${label.includeNutrition && label.panelSource === "entered" ? " Its nutrition panel was typed in, not computed: check it comes from an analysis." : ""} This is recorded against your name.`,
                  )
                )
                  return;
                void run(
                  "approve",
                  () => unwrap(labelsApi()[":id"].approve.$post({ param: { slug, id: label.id } })),
                  `Label v${label.versionNumber} approved`,
                );
              }}
            >
              {pending === "approve" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CheckCircle2 data-icon="inline-start" />
              )}{" "}
              Approve
            </Button>
          )}
          {label.status === "approved" && canWrite && !hasDraft && (
            <Button
              variant={label.stale ? "default" : "outline"}
              disabled={pending !== null}
              onClick={() => void draftCorrection()}
            >
              {pending === "correct" && <Spinner data-icon="inline-start" />} Draft a new version
            </Button>
          )}
        </div>
      </div>

      {label.stale && (
        <Alert variant={label.status === "approved" ? "destructive" : "default"}>
          <TriangleAlert />
          <AlertTitle>
            {label.status === "approved"
              ? "This approved label needs review"
              : "This draft is out of date: refresh it before approval"}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {label.staleReasons.map((r) => (
                <li key={r.kind}>
                  {labelStaleKindLabels[r.kind]}
                  {r.itemCodes.length > 0 && `: ${r.itemCodes.join(", ")}`}
                </li>
              ))}
            </ul>
            {label.status === "approved" && (
              <p>
                An approved label never changes. Draft a new version to correct it; this one stays as
                approved.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {isDraft && facts && facts.nutrition.missing.length > 0 && label.includeNutrition && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Nutrition is missing for some ingredients</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {facts.nutrition.missing.map((m) => (
                <li key={`${m.itemId}-${m.path.join("/")}-${m.reason}`}>
                  <span className="font-mono text-xs">{m.code}</span> {m.name}
                  {m.path.length > 0 && ` (in ${m.path.join(" → ")})`}:{" "}
                  {missingNutritionReasonLabels[m.reason]}
                </li>
              ))}
            </ul>
            <p>
              Enter it under{" "}
              <Link href={`/${slug}/labels/nutrition?nutrition=missing`} className="underline">
                Ingredient nutrition
              </Link>{" "}
              and refresh, type the panel in, or declare no nutrition.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {isDraft && facts && facts.warnings.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Check the wording</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {facts.warnings.map((w) => (
                <li key={`${w.kind}-${w.itemCode}-${w.message}`}>{w.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {facts && facts.omittedWater.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Left out of the ingredients under the 5% rule (added water of 5% or less of the finished product
          need not be listed):{" "}
          {facts.omittedWater.map((w) => `${w.code}, ${w.weightG} g (${w.percent}%)`).join("; ")}. To list it
          anyway, add it back by editing the label text.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Label text</h3>
          <LabelPreview label={label} />
          {label.notes && <p className="text-sm text-muted-foreground">Notes: {label.notes}</p>}
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Allergens</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <AllergenBadges
                contains={label.allergens.contains}
                mayContain={label.allergens.mayContain}
                empty="None from the ingredients"
              />
              {facts && <AllergenMismatchAlert mismatch={facts.allergenMismatch} />}
            </CardContent>
          </Card>
          {label.nutrition && label.trafficLights && (
            <Card>
              <CardHeader>
                <CardTitle>Front-of-pack traffic lights</CardTitle>
                <p className="text-sm text-muted-foreground">
                  UK guidance thresholds, from the declared values
                  {label.nutrition.portion ? " (red when a portion is above its limit too)" : ""}. Optional on
                  pack.
                </p>
              </CardHeader>
              <CardContent>
                <TrafficLights lights={label.trafficLights} />
              </CardContent>
            </Card>
          )}
          {facts && facts.nutrition.micronutrientRows.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Vitamins and minerals</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Per {label.nutrition?.basis === "100ml" ? "100 ml" : "100 g"} after the ingredients' cooking
                  losses (retention factors). For information and claims work: never declared on the label.
                  {facts.nutrition.micronutrientsMissing.length > 0 &&
                    ` No figures for ${facts.nutrition.micronutrientsMissing.join(", ")}, so these are at least the amounts shown.`}
                </p>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <tbody>
                    {facts.nutrition.micronutrientRows.map((r) => (
                      <tr key={r.key} className="border-t first:border-t-0">
                        <td className="py-1">{r.label}</td>
                        <td className="py-1 text-right tabular-nums">
                          {r.value} {r.unit}
                        </td>
                        <td className="py-1 text-right text-muted-foreground tabular-nums">
                          {r.nrvPercent}% NRV
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
          {label.nutrition && (
            <Card>
              <CardHeader>
                <CardTitle>Nutrition, raw and declared</CardTitle>
                {label.panelSource && (
                  <p className="text-sm text-muted-foreground">
                    {labelPanelSourceLabels[label.panelSource]}
                    {label.panelSource === "entered" &&
                      facts &&
                      !facts.nutrition.complete &&
                      ": the ingredients' nutrition is incomplete, so it can't be checked against them"}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 text-left font-normal">
                        {nutritionBasisLabels[label.nutrition.basis]}
                      </th>
                      <th className="py-1 text-right font-normal">Raw</th>
                      <th className="py-1 text-right font-normal">Declared</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nutrientKeys.map((key) => {
                      const raw = label.nutrition!.raw[key];
                      if (raw === null) return null;
                      return (
                        <tr key={key} className="border-t">
                          <td className="py-1">
                            {nutrientLabels[key]} ({nutrientUnits[key]})
                          </td>
                          <td className="py-1 text-right text-muted-foreground tabular-nums">
                            {raw.toLocaleString("en-GB", { maximumFractionDigits: 3 })}
                          </td>
                          <td className="py-1 text-right tabular-nums">
                            {label.nutrition!.declared[key]?.display}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {facts && facts.nutrition.yieldFactor !== null && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Mixing bowl {facts.nutrition.bowlWeightG.toLocaleString("en-GB")} g per batch; finished
                    weight is {Math.round(facts.nutrition.yieldFactor * 1000) / 10}% of it.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y">
              {label.history.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <LabelStatusBadge status={h.status} versionNumber={h.versionNumber} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {h.recipeVersionNumber !== null && `recipe v${h.recipeVersionNumber}`}
                    {h.approvedAt &&
                      ` · approved ${formatLongDate(h.approvedAt, timeZone)}${h.approvedByName ? ` by ${h.approvedByName}` : ""}`}
                  </span>
                  {h.id !== label.id && (
                    <Link href={`/${slug}/labels/${h.id}`} className="hover:underline">
                      View
                    </Link>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {dialog === "text" && <TextDialog slug={slug} label={label} onClose={() => setDialog(null)} />}
      {dialog === "options" && <RefreshDialog slug={slug} label={label} onClose={() => setDialog(null)} />}
      {dialog === "portion" && <PortionDialog slug={slug} label={label} onClose={() => setDialog(null)} />}
      {dialog === "nutrition" && (
        <NutritionPanelDialog slug={slug} label={label} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function TextDialog({
  slug,
  label,
  onClose,
}: {
  slug: string;
  label: ProductLabelDetail;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    productName: label.productName,
    ingredients: label.ingredientsMarkup,
    allergenStatement: label.allergenStatement ?? "",
    storageInstructions: label.storageInstructions ?? "",
    dateGuidance: label.dateGuidance ?? "",
    netQuantity: label.netQuantity ?? "",
    gtin: label.gtin ?? "",
    notes: label.notes ?? "",
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <HaccpDialog
      title="Edit label text"
      description="Refreshing redrafts the ingredients, allergen statement and nutrition from the data; the other text is kept."
      submitLabel="Save"
      wide
      onClose={onClose}
      disabled={!form.productName.trim() || !form.ingredients.trim()}
      onSubmit={async () => {
        await unwrap(labelsApi()[":id"].$patch({ param: { slug, id: label.id }, json: form }));
        return "Label saved";
      }}
    >
      <Field>
        <FieldLabel htmlFor="label-name">Product name</FieldLabel>
        <Input id="label-name" value={form.productName} onChange={set("productName")} />
      </Field>
      <Field>
        <FieldLabel htmlFor="label-ingredients">Ingredients</FieldLabel>
        <Textarea id="label-ingredients" rows={5} value={form.ingredients} onChange={set("ingredients")} />
        <FieldDescription>
          Put allergens between double asterisks to show them in bold: **milk**. Heaviest ingredient first.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="label-allergens">Allergen statement</FieldLabel>
        <Textarea
          id="label-allergens"
          rows={2}
          value={form.allergenStatement}
          onChange={set("allergenStatement")}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="label-storage">Storage</FieldLabel>
        <Input id="label-storage" value={form.storageInstructions} onChange={set("storageInstructions")} />
      </Field>
      <Field>
        <FieldLabel htmlFor="label-date">Date guidance</FieldLabel>
        <Input id="label-date" value={form.dateGuidance} onChange={set("dateGuidance")} />
      </Field>
      <Field>
        <FieldLabel htmlFor="label-net">Net quantity</FieldLabel>
        <Input id="label-net" value={form.netQuantity} onChange={set("netQuantity")} placeholder="400 g" />
      </Field>
      <Field>
        <FieldLabel htmlFor="label-gtin">Barcode (EAN-13)</FieldLabel>
        <Input
          id="label-gtin"
          inputMode="numeric"
          value={form.gtin}
          onChange={set("gtin")}
          placeholder="5 901234 123457"
        />
        <FieldDescription>
          The pack's GTIN, 13 digits (or a 12-digit UPC-A), with its check digit. It is checked on save and
          printed as bars under the label. Each variant has its own.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="label-notes">Notes</FieldLabel>
        <Textarea id="label-notes" rows={2} value={form.notes} onChange={set("notes")} />
      </Field>
    </HaccpDialog>
  );
}

/** Every ingredient of a declaration, compound components included, once each. */
function flatten(entries: readonly DeclarationEntry[]): DeclarationEntry[] {
  const seen = new Map<string, DeclarationEntry>();
  const walk = (list: readonly DeclarationEntry[]) => {
    for (const e of list) {
      if (!seen.has(e.itemId)) seen.set(e.itemId, e);
      if (e.components) walk(e.components);
    }
  };
  walk(entries);
  return [...seen.values()];
}

function RefreshDialog({
  slug,
  label,
  onClose,
}: {
  slug: string;
  label: ProductLabelDetail;
  onClose: () => void;
}) {
  const [style, setStyle] = useState<CompoundStyle>(label.compoundStyle);
  const [quid, setQuid] = useState<Set<string>>(new Set(label.quidItemIds));
  const [nutrition, setNutrition] = useState(label.includeNutrition ? "yes" : "no");
  const [energy, setEnergy] = useState<EnergyMethod>(label.energyMethod);
  const [volatile, setVolatile] = useState<Set<string>>(new Set(label.volatileItemIds));
  const ingredients = flatten(label.facts?.ingredients ?? []);
  const outdatedVersion =
    label.currentRecipeVersion && label.currentRecipeVersion.id !== label.recipeVersionId
      ? label.currentRecipeVersion.versionNumber
      : null;
  return (
    <HaccpDialog
      title="Refresh from the data"
      description={
        <>
          Redrafts the ingredients list, allergens, allergen statement and nutrition panel from current data
          {outdatedVersion !== null && ` and the recipe's approved v${outdatedVersion}`}. Edits to those are
          replaced; the name, storage, date wording, net quantity and notes are kept.
        </>
      }
      submitLabel="Refresh"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          labelsApi()[":id"].refresh.$post({
            param: { slug, id: label.id },
            json: {
              compoundStyle: style,
              quidItemIds: [...quid],
              includeNutrition: nutrition === "yes",
              energyMethod: energy,
              volatileItemIds: [...volatile],
            },
          }),
        );
        return "Label refreshed";
      }}
    >
      <SelectField
        id="refresh-compound"
        label="Compound ingredients"
        value={style}
        onChange={(v) => setStyle(v as CompoundStyle)}
        options={compoundStyles.map((s) => [s, compoundStyleLabels[s]] as const)}
      />
      <SelectField
        id="refresh-nutrition"
        label="Nutrition declaration"
        value={nutrition}
        onChange={setNutrition}
        options={[
          ["yes", "Declare nutrition per 100 g"],
          ["no", "Exempt: no nutrition declaration"],
        ]}
      />
      <SelectField
        id="refresh-energy"
        label="Energy"
        value={energy}
        onChange={(v) => setEnergy(v as EnergyMethod)}
        options={energyMethods.map((m) => [m, energyMethodLabels[m]] as const)}
        description="A typed-in panel keeps the energy that was typed."
      />
      {ingredients.length > 0 && (
        <Field>
          <FieldLabel>Added water and volatile ingredients</FieldLabel>
          <FieldDescription>
            Listed by their weight in the finished product (what is left after cooking) instead of at the
            mixing bowl. The moisture the product loses is taken from the ingredients ticked here. Added water
            that is then 5% or less of the finished product is left out of the list (the 5% rule).
          </FieldDescription>
          <div className="flex flex-col gap-2">
            {ingredients.map((e) => (
              <label key={e.itemId} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={volatile.has(e.itemId)}
                  onCheckedChange={(checked) =>
                    setVolatile((prev) => {
                      const next = new Set(prev);
                      if (checked === true) next.add(e.itemId);
                      else next.delete(e.itemId);
                      return next;
                    })
                  }
                />
                <span className="font-mono text-xs">{e.code}</span>
                {e.name.map((s) => s.text).join("")}
              </label>
            ))}
          </div>
        </Field>
      )}
      {ingredients.length > 0 && (
        <Field>
          <FieldLabel>Percentages (QUID)</FieldLabel>
          <FieldDescription>
            Declare the percentage of ingredients named or pictured on the pack, such as the butter in
            "all-butter shortbread".
          </FieldDescription>
          <div className="flex flex-col gap-2">
            {ingredients.map((e) => (
              <label key={e.itemId} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={quid.has(e.itemId)}
                  onCheckedChange={(checked) =>
                    setQuid((prev) => {
                      const next = new Set(prev);
                      if (checked === true) next.add(e.itemId);
                      else next.delete(e.itemId);
                      return next;
                    })
                  }
                />
                <span className="font-mono text-xs">{e.code}</span>
                {e.name.map((s) => s.text).join("")}
              </label>
            ))}
          </div>
        </Field>
      )}
    </HaccpDialog>
  );
}

const nutrientInputs = nutrientKeys;

function NutritionPanelDialog({
  slug,
  label,
  onClose,
}: {
  slug: string;
  label: ProductLabelDetail;
  onClose: () => void;
}) {
  // Never prefill the partial values of an incomplete roll-up: they count missing ingredients as zero.
  const rollup = label.facts?.nutrition ?? null;
  const missingItems = rollup && !rollup.complete ? rollup.missing : [];
  const start = label.nutrition?.raw ?? (rollup?.complete ? rollup.per100 : null) ?? null;
  const [basis, setBasis] = useState<NutritionBasis>(
    label.nutrition?.basis ?? label.facts?.nutrition.basis ?? "100g",
  );
  const [values, setValues] = useState<Record<NutrientKey, string>>(
    () =>
      Object.fromEntries(
        nutrientInputs.map((k) => [
          k,
          start?.[k] === null || start?.[k] === undefined ? "" : String(start[k]),
        ]),
      ) as Record<NutrientKey, string>,
  );
  const num = (v: string) => Number(v.replace(",", "."));
  const missing = nutrientInputs.filter(
    (k) => k !== "fibre" && (values[k].trim() === "" || !Number.isFinite(num(values[k]))),
  );
  return (
    <HaccpDialog
      title="Nutrition panel"
      description="Type the panel in, for example from a laboratory analysis; values are rounded for the label as the guidance says and the panel is marked as typed in. Refreshing replaces it with the computed values."
      submitLabel="Save panel"
      onClose={onClose}
      disabled={missing.length > 0}
      onSubmit={async () => {
        const n = Object.fromEntries(
          nutrientInputs.map((k) => [
            k,
            values[k].trim() === "" ? null : Math.round(num(values[k]) * 1000) / 1000,
          ]),
        ) as Record<NutrientKey, number | null>;
        await unwrap(
          labelsApi()[":id"].$patch({
            param: { slug, id: label.id },
            json: {
              nutrition: {
                basis,
                energyKj: n.energyKj!,
                energyKcal: n.energyKcal!,
                fat: n.fat!,
                saturates: n.saturates!,
                carbohydrate: n.carbohydrate!,
                sugars: n.sugars!,
                fibre: n.fibre,
                protein: n.protein!,
                salt: n.salt!,
              },
            },
          }),
        );
        return "Nutrition panel saved";
      }}
    >
      {missingItems.length > 0 && !label.nutrition && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Not prefilled: the computed values are incomplete</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {missingItems.map((m) => (
                <li key={`${m.itemId}-${m.path.join("/")}-${m.reason}`}>
                  <span className="font-mono text-xs">{m.code}</span> {m.name}
                  {m.path.length > 0 && ` (in ${m.path.join(" → ")})`}:{" "}
                  {missingNutritionReasonLabels[m.reason]}
                </li>
              ))}
            </ul>
            <p>Type in a panel from an analysis, or enter the missing nutrition and refresh.</p>
          </AlertDescription>
        </Alert>
      )}
      <SelectField
        id="panel-basis"
        label="Per"
        value={basis}
        onChange={(v) => setBasis(v as NutritionBasis)}
        options={nutritionBases.map((b) => [b, nutritionBasisLabels[b]] as const)}
      />
      <div className="grid grid-cols-2 gap-3">
        {nutrientInputs.map((k) => (
          <Field key={k}>
            <FieldLabel htmlFor={`panel-${k}`}>
              {nutrientLabels[k]} ({nutrientUnits[k]}){k === "fibre" ? " — optional" : ""}
            </FieldLabel>
            <Input
              id={`panel-${k}`}
              inputMode="decimal"
              value={values[k]}
              onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
            />
          </Field>
        ))}
      </div>
    </HaccpDialog>
  );
}

function PortionDialog({
  slug,
  label,
  onClose,
}: {
  slug: string;
  label: ProductLabelDetail;
  onClose: () => void;
}) {
  const unit = label.nutrition?.basis === "100ml" ? "ml" : "g";
  const [size, setSize] = useState(label.portionSize === null ? "" : String(label.portionSize));
  const [portionLabel, setPortionLabel] = useState(label.portionLabel ?? "");
  const [zero, setZero] = useState(label.negligibleAsZero);
  const parsed = Number(size.replace(",", "."));
  return (
    <HaccpDialog
      title="Portion and rounding"
      description="Applied to the panel's values straight away; no refresh is needed."
      submitLabel="Save"
      onClose={onClose}
      disabled={size.trim() !== "" && !(Number.isFinite(parsed) && parsed > 0)}
      onSubmit={async () => {
        await unwrap(
          labelsApi()[":id"].$patch({
            param: { slug, id: label.id },
            json: {
              portionSize: size.trim() === "" ? null : parsed,
              portionLabel: portionLabel.trim() || null,
              negligibleAsZero: zero,
            },
          }),
        );
        return "Saved";
      }}
    >
      <Field>
        <FieldLabel htmlFor="portion-size">Portion size ({unit}), empty for none</FieldLabel>
        <Input id="portion-size" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} />
        <FieldDescription>
          Adds per-portion values and the percentage of the reference intake (Regulation 1169/2011).
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="portion-label">Portion wording</FieldLabel>
        <Input
          id="portion-label"
          value={portionLabel}
          maxLength={60}
          placeholder="1 slice"
          onChange={(e) => setPortionLabel(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={zero} onCheckedChange={(c) => setZero(c === true)} />
        Declare negligible amounts as "0 g" instead of "&lt;0.5 g"
      </label>
    </HaccpDialog>
  );
}
