"use client";

import {
  NUTRITION_CSV_TEMPLATE,
  energyExtraKeys,
  energyExtraLabels,
  itemTypeLabels,
  kcalToKj,
  micronutrientKeys,
  micronutrients,
  missingNutritionReasonLabels,
  nutrientKeys,
  nutrientLabels,
  nutrientUnits,
  nutritionBasisLabels,
  nutritionBases,
  roundNutrient,
  type EnergyExtraKey,
  type MicronutrientKey,
  type NutrientKey,
  type NutritionBasis,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Textarea } from "@knotworking/ui/components/textarea";
import { FileUp } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { AllergenBadges } from "@/components/item-badges";
import { NutritionSourceBadge } from "@/components/labels-badges";
import { stackedTable } from "@/components/stacked-table";
import type { LabellingItem } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export type NutritionFilter = "all" | "missing" | "entered" | "recipe";

const filterLabels: Record<NutritionFilter, string> = {
  all: "All",
  missing: "Missing",
  entered: "Entered",
  recipe: "From recipes",
};

const shown = (key: NutrientKey, value: number | null | undefined) =>
  value === null || value === undefined ? "—" : roundNutrient(key, value).display;

/**
 * Food items' labelling data: nutrition per 100 g from specifications (or computed from the recipe
 * of an item made in house), the name used in ingredients lists and a compound's components.
 */
export function NutritionBoard({
  slug,
  filter,
  q,
  page,
}: {
  slug: string;
  filter: NutritionFilter;
  q: string;
  page: { items: LabellingItem[]; total: number; limit: number; offset: number };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [search, setSearch] = useState(q);
  const [editing, setEditing] = useState<LabellingItem | null>(null);
  const [importing, setImporting] = useState(false);
  const go = (next: { filter?: NutritionFilter; q?: string; offset?: number }) => {
    const params = new URLSearchParams();
    const f = next.filter ?? filter;
    const text = next.q ?? search;
    if (f !== "all") params.set("nutrition", f);
    if (text.trim()) params.set("q", text.trim());
    if (next.offset) params.set("offset", String(next.offset));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };
  const { items, total, limit, offset } = page;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Ingredient nutrition</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "item" : "items"}
          </p>
        </div>
        {can("labels", "write") && (
          <Button variant="outline" onClick={() => setImporting(true)}>
            <FileUp data-icon="inline-start" /> Import CSV
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={filter} onValueChange={(v) => go({ filter: v as NutritionFilter, offset: 0 })}>
          <TabsList className="max-w-full overflow-x-auto">
            {(Object.keys(filterLabels) as NutritionFilter[]).map((f) => (
              <TabsTrigger key={f} value={f}>
                {filterLabels[f]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <form
          className="min-w-48 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go({ offset: 0 });
          }}
        >
          <Input
            type="search"
            aria-label="Search items"
            placeholder="Search code or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {q ? "No items match." : filter === "missing" ? "Every food item has nutrition." : "No food items."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Item</TableHead>
                <TableHead>Nutrition</TableHead>
                <TableHead className="text-right">Energy</TableHead>
                <TableHead className="text-right">Fat</TableHead>
                <TableHead className="text-right">Sugars</TableHead>
                <TableHead className="text-right">Salt</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => {
                const v = i.effective.values;
                return (
                  <TableRow key={i.itemId}>
                    <TableCell className="pl-4 whitespace-normal" data-primary>
                      <div>
                        <span className="font-mono text-xs">{i.code}</span> · {i.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {itemTypeLabels[i.type]}
                        {i.declarationName && ` · declared as "${i.declarationName}"`}
                      </div>
                    </TableCell>
                    <TableCell data-label="Nutrition" className="whitespace-normal">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <NutritionSourceBadge source={i.effective.source} />
                        {i.madeBy && (
                          <Link
                            href={`/${slug}/recipes/${i.madeBy.recipeId}`}
                            className="text-xs hover:underline"
                          >
                            {i.madeBy.recipeCode} v{i.madeBy.versionNumber}
                          </Link>
                        )}
                      </span>
                      {i.effective.missing.length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          Missing:{" "}
                          {[
                            ...new Set(
                              i.effective.missing.map(
                                (m) => `${m.code} (${missingNutritionReasonLabels[m.reason].toLowerCase()})`,
                              ),
                            ),
                          ].join(", ")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell data-label="Energy" className="text-right tabular-nums">
                      {v ? `${shown("energyKcal", v.energyKcal)}` : "—"}
                    </TableCell>
                    <TableCell data-label="Fat" className="text-right tabular-nums">
                      {shown("fat", v?.fat)}
                    </TableCell>
                    <TableCell data-label="Sugars" className="text-right tabular-nums">
                      {shown("sugars", v?.sugars)}
                    </TableCell>
                    <TableCell data-label="Salt" className="text-right tabular-nums">
                      {shown("salt", v?.salt)}
                    </TableCell>
                    <TableCell className="pr-4 text-right" data-actions>
                      {can("labels", "write") && (
                        <Button variant="outline" size="sm" onClick={() => setEditing(i)}>
                          Edit
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {total > limit && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          {offset + 1}–{Math.min(offset + items.length, total)} of {total}
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => go({ offset: Math.max(0, offset - limit) })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => go({ offset: offset + limit })}
          >
            Next
          </Button>
        </div>
      )}
      {editing && <ItemLabelDataDialog slug={slug} item={editing} onClose={() => setEditing(null)} />}
      {importing && <NutritionImportDialog slug={slug} onClose={() => setImporting(false)} />}
    </div>
  );
}

const nutritionImportLabels: Record<string, string> = {
  code: "Stock code",
  name: "Item name",
  basis: "Basis",
  energyKj: "Energy kJ",
  energyKcal: "Energy kcal",
  fat: "Fat",
  saturates: "Saturates",
  carbohydrate: "Carbohydrate",
  sugars: "Sugars",
  fibre: "Fibre",
  protein: "Protein",
  salt: "Salt",
  sodium: "Sodium",
  sodiumMg: "Sodium (mg)",
  ...energyExtraLabels,
  declarationName: "Declaration name",
  components: "Components",
  source: "Source",
  ...Object.fromEntries(micronutrientKeys.map((k) => [k, micronutrients[k].label])),
};

/** Set nutrition from a specification sheet or McCance and Widdowson's columns: check, then import. */
function NutritionImportDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  return (
    <CsvImportDialog
      id="nutrition-csv"
      title="Import nutrition from CSV"
      description="One row per food item, found by stock code (or exact name). Check the file first: it shows what would change and lists every problem. Nothing is saved while a row is wrong."
      columns={
        <>
          Columns: <code>code</code> (stock code) or <code>name</code>; <code>basis</code> (100g or 100ml);{" "}
          <code>energy kj</code> and/or <code>energy kcal</code>, <code>fat</code>, <code>saturates</code>,{" "}
          <code>carbohydrate</code>, <code>sugars</code>, <code>protein</code> and <code>salt</code> (or{" "}
          <code>sodium</code>, which is multiplied by 2.5) are all needed; optional <code>fibre</code>,{" "}
          <code>polyols</code>, <code>erythritol</code>, <code>organic acids</code>, <code>alcohol</code>,
          vitamins and minerals, <code>declaration name</code>, <code>components</code>, <code>source</code>.
          McCance and Widdowson&apos;s column names (&quot;Total sugars (g)&quot;, &quot;Satd FA /100g fd
          (g)&quot;, &quot;Sodium (mg)&quot;) are understood; add a stock code column. Tr is read as 0.
        </>
      }
      template={NUTRITION_CSV_TEMPLATE}
      templateFileName="nutrition-template.csv"
      placeholder={
        "code,basis,energy kj,energy kcal,fat,saturates,carbohydrate,sugars,fibre,protein,salt\nFLOUR-01,100g,1459,343,1.4,0.3,72,1.5,3.1,10.5,0.01"
      }
      noun="item"
      keyLabel="Stock code"
      columnLabels={nutritionImportLabels}
      run={(csv, fileName, dryRun) =>
        unwrap(
          browserApi().v1.workspaces[":slug"].labelling.items.import.$post({
            param: { slug },
            json: { csv, dryRun, ...(fileName ? { fileName } : {}) },
          }),
        )
      }
      onClose={onClose}
    />
  );
}

function ItemLabelDataDialog({
  slug,
  item,
  onClose,
}: {
  slug: string;
  item: LabellingItem;
  onClose: () => void;
}) {
  const entered = item.nutrition;
  const [declarationName, setDeclarationName] = useState(item.declarationName ?? "");
  const [components, setComponents] = useState(item.components ?? "");
  const [source, setSource] = useState(item.nutritionSource ?? "");
  const [basis, setBasis] = useState<NutritionBasis>(
    entered?.basis ?? (item.unit === "l" || item.unit === "ml" ? "100ml" : "100g"),
  );
  const [values, setValues] = useState<Record<NutrientKey, string>>(
    () =>
      Object.fromEntries(
        nutrientKeys.map((k) => [
          k,
          entered?.[k] === null || entered?.[k] === undefined ? "" : String(entered[k]),
        ]),
      ) as Record<NutrientKey, string>,
  );
  const [extras, setExtras] = useState<Record<EnergyExtraKey, string>>(
    () =>
      Object.fromEntries(energyExtraKeys.map((k) => [k, entered?.[k] ? String(entered[k]) : ""])) as Record<
        EnergyExtraKey,
        string
      >,
  );
  const [vitamins, setVitamins] = useState<Record<MicronutrientKey, string>>(
    () =>
      Object.fromEntries(
        micronutrientKeys.map((k) => [
          k,
          item.micronutrients?.[k] === undefined ? "" : String(item.micronutrients[k]),
        ]),
      ) as Record<MicronutrientKey, string>,
  );
  // Shown as the percent that is lost when cooked (what a retention table gives); stored as the fraction kept.
  const [lost, setLost] = useState<Record<MicronutrientKey, string>>(
    () =>
      Object.fromEntries(
        micronutrientKeys.map((k) => [
          k,
          item.retention?.[k] === undefined ? "" : String(Math.round((1 - item.retention[k]) * 1000) / 10),
        ]),
      ) as Record<MicronutrientKey, string>,
  );
  const num = (v: string) => Number(v.replace(",", "."));
  const mapOf = (
    values: Record<MicronutrientKey, string>,
    convert: (n: number) => number,
  ): Partial<Record<MicronutrientKey, number>> | null => {
    const out: Partial<Record<MicronutrientKey, number>> = {};
    for (const k of micronutrientKeys) {
      if (values[k].trim() !== "" && Number.isFinite(num(values[k]))) out[k] = convert(num(values[k]));
    }
    return Object.keys(out).length ? out : null;
  };
  const mandatory = nutrientKeys.filter((k) => k !== "fibre");
  const blank = mandatory.every((k) => values[k].trim() === "") && values.fibre.trim() === "";
  const incomplete =
    !blank && mandatory.some((k) => values[k].trim() === "" || !Number.isFinite(num(values[k])));
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  return (
    <HaccpDialog
      title={`${item.code} · ${item.name}`}
      description={
        item.madeBy
          ? `Made in house: its nutrition is computed from ${item.madeBy.recipeCode} v${item.madeBy.versionNumber}, so figures entered here are not used while that recipe is approved.`
          : "From the supplier's specification. Labels that use this item are flagged for review when it changes."
      }
      submitLabel="Save"
      wide
      onClose={onClose}
      disabled={incomplete}
      onSubmit={async () => {
        const n = Object.fromEntries(
          nutrientKeys.map((k) => [k, values[k].trim() === "" ? null : num(values[k])]),
        ) as Record<NutrientKey, number | null>;
        await unwrap(
          browserApi().v1.workspaces[":slug"].labelling.items[":itemId"].$put({
            param: { slug, itemId: item.itemId },
            json: {
              declarationName,
              components,
              nutritionSource: source,
              micronutrients: mapOf(vitamins, round3),
              retention: mapOf(lost, (percent) => round3(Math.min(1, Math.max(0, 1 - percent / 100)))),
              nutrition: blank
                ? null
                : {
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
                    ...Object.fromEntries(
                      energyExtraKeys.map((k) => [k, extras[k].trim() === "" ? null : num(extras[k])]),
                    ),
                  },
            },
          }),
        );
        return "Saved";
      }}
    >
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Allergens on the item</span>
        <AllergenBadges contains={item.allergens} mayContain={item.mayContain} />
      </div>
      <Field>
        <FieldLabel htmlFor="ild-name">Name in ingredients lists</FieldLabel>
        <Input
          id="ild-name"
          value={declarationName}
          onChange={(e) => setDeclarationName(e.target.value)}
          placeholder={item.name}
        />
        <FieldDescription>
          How it is declared, e.g. &quot;Wheat flour&quot;. Allergen words are emphasised automatically; write
          **…** to choose.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="ild-components">Its own ingredients (compound ingredient)</FieldLabel>
        <Textarea
          id="ild-components"
          rows={2}
          value={components}
          onChange={(e) => setComponents(e.target.value)}
          placeholder="sugar, cocoa mass, cocoa butter, emulsifier: soya lecithin"
        />
      </Field>
      <SelectField
        id="ild-basis"
        label="Nutrition"
        value={basis}
        onChange={(v) => setBasis(v as NutritionBasis)}
        options={nutritionBases.map((b) => [b, nutritionBasisLabels[b]] as const)}
        description="Leave every value empty to clear it. Salt, not sodium (salt = sodium × 2.5)."
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {nutrientKeys.map((k) => (
          <Field key={k}>
            <FieldLabel htmlFor={`ild-${k}`}>
              {nutrientLabels[k]} ({nutrientUnits[k]}){k === "fibre" ? " — optional" : ""}
            </FieldLabel>
            <Input
              id={`ild-${k}`}
              inputMode="decimal"
              value={values[k]}
              onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
              onBlur={() => {
                // Most specifications give both; fill kJ from kcal when only that was typed.
                if (
                  k === "energyKcal" &&
                  values.energyKj.trim() === "" &&
                  Number.isFinite(num(values.energyKcal)) &&
                  values.energyKcal.trim()
                ) {
                  setValues((prev) => ({ ...prev, energyKj: String(kcalToKj(num(prev.energyKcal))) }));
                }
              }}
            />
          </Field>
        ))}
      </div>
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          Energy extras: polyols, organic acids, alcohol
        </summary>
        <p className="py-2 text-xs text-muted-foreground">
          Only used when a label's energy is calculated from the nutrients (Regulation 1169/2011 Annex XIV:
          polyols 10 kJ/g, erythritol 0, organic acids 13 kJ/g, alcohol 29 kJ/g). Polyols and erythritol are
          part of the carbohydrate above. Never declared.
        </p>
        <div className="grid grid-cols-2 gap-3 pb-2 sm:grid-cols-4">
          {energyExtraKeys.map((k) => (
            <Field key={k}>
              <FieldLabel htmlFor={`ild-${k}`}>{energyExtraLabels[k]} (g)</FieldLabel>
              <Input
                id={`ild-${k}`}
                inputMode="decimal"
                value={extras[k]}
                onChange={(e) => setExtras((prev) => ({ ...prev, [k]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      </details>
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          Vitamins and minerals, and what cooking loses
        </summary>
        <p className="py-2 text-xs text-muted-foreground">
          Optional, for the recipe's information only: they are never declared on a label. Enter the amount
          per 100 g (or ml) and, if the ingredient is cooked in the recipes that use it, the percent that is
          lost (use a figure from your own source: a retention table or an analysis). Left empty: no loss
          assumed.
        </p>
        <div className="grid grid-cols-[1fr_6rem_6rem] items-center gap-x-3 gap-y-2 pb-2 text-sm">
          <span />
          <span className="text-xs text-muted-foreground">Per 100</span>
          <span className="text-xs text-muted-foreground">% lost</span>
          {micronutrientKeys.map((k) => (
            <Fragment key={k}>
              <label htmlFor={`ild-v-${k}`}>
                {micronutrients[k].label} ({micronutrients[k].unit})
              </label>
              <Input
                id={`ild-v-${k}`}
                inputMode="decimal"
                value={vitamins[k]}
                onChange={(e) => setVitamins((prev) => ({ ...prev, [k]: e.target.value }))}
              />
              <Input
                id={`ild-l-${k}`}
                aria-label={`${micronutrients[k].label}, percent lost in cooking`}
                inputMode="decimal"
                value={lost[k]}
                onChange={(e) => setLost((prev) => ({ ...prev, [k]: e.target.value }))}
              />
            </Fragment>
          ))}
        </div>
      </details>
      <Field>
        <FieldLabel htmlFor="ild-source">Source</FieldLabel>
        <Input
          id="ild-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Supplier specification v3, March 2026"
        />
      </Field>
    </HaccpDialog>
  );
}
