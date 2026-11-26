"use client";

import { allergens, diffRecipeVersions, roundQuantity, units, type AllergenChange } from "@knotworking/core";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Recipe, RecipeVersion } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-store";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { recipeTerms } from "@/lib/recipe-terms";

type Line = RecipeVersion["lines"][number];

const qty = (line: Pick<Line, "quantity" | "unit">) =>
  `${roundQuantity(line.quantity)} ${units[line.unit].label}`;
const itemLabel = (line: Line) => (
  <>
    <span className="font-mono text-xs">{line.item.code}</span> · {line.item.name}
  </>
);
const names = (codes: AllergenChange["added"]) => codes.map((c) => allergens[c]).join(", ");

/** Compares two versions of a recipe: lines added, removed and changed, yield, method and allergens. */
export function VersionCompare({ slug, recipe }: { slug: string; recipe: Recipe }) {
  const terms = recipeTerms(useWorkspace().can("food_items"));
  // `versions` is newest first: compare the previous one with the newest by default.
  const [toId, setToId] = useState(recipe.versions[0]?.id ?? "");
  const [fromId, setFromId] = useState(recipe.versions[1]?.id ?? "");
  const [loaded, setLoaded] = useState<{ from: RecipeVersion; to: RecipeVersion } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!fromId || !toId) return;
    let cancelled = false;
    setLoading(true);
    const get = (versionId: string) =>
      unwrap(
        browserApi().v1.workspaces[":slug"].recipes[":id"].versions[":versionId"].$get({
          param: { slug, id: recipe.id, versionId },
          query: {},
        }),
      ) as unknown as Promise<RecipeVersion>;
    Promise.all([get(fromId), get(toId)])
      .then(([from, to]) => {
        if (!cancelled) setLoaded({ from, to });
      })
      .catch((err) => toast.error(errorMessage(err)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, recipe.id, fromId, toId]);

  const diff = useMemo(
    () =>
      loaded && loaded.from.id === fromId && loaded.to.id === toId
        ? diffRecipeVersions(
            { ...loaded.from, allergens: loaded.from.rollup.allergens },
            { ...loaded.to, allergens: loaded.to.rollup.allergens },
          )
        : null,
    [loaded, fromId, toId],
  );

  const picker = (label: string, value: string, onChange: (id: string) => void) => (
    <div className="flex items-center gap-2 text-sm">
      <span className="font-medium">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-44" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {recipe.versions.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                v{v.versionNumber} · {v.status}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Compare versions</CardTitle>
        <div className="flex flex-wrap gap-4">
          {picker("From", fromId, setFromId)}
          {picker("To", toId, setToId)}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {loading && !diff && <Spinner />}
        {fromId === toId && <p className="text-muted-foreground">Pick two different versions.</p>}
        {diff && fromId !== toId && (
          <>
            {!diff.hasChanges && <p className="text-muted-foreground">No differences.</p>}
            {diff.yield.changed && (
              <p>
                <span className="font-medium">Yield</span>: {roundQuantity(diff.yield.from.yieldQuantity)}{" "}
                {units[diff.yield.from.yieldUnit].label} →{" "}
                <span className="font-medium">
                  {roundQuantity(diff.yield.to.yieldQuantity)} {units[diff.yield.to.yieldUnit].label}
                </span>
              </p>
            )}
            {diff.methodChanged && (
              <p>
                <span className="font-medium">Method</span> was changed.
              </p>
            )}
            {(diff.allergens.contains.added.length > 0 ||
              diff.allergens.contains.removed.length > 0 ||
              diff.allergens.mayContain.added.length > 0 ||
              diff.allergens.mayContain.removed.length > 0) && (
              <div>
                <p className="font-medium">Allergens</p>
                {diff.allergens.contains.added.length > 0 && (
                  <p className="text-status-red">Now contains: {names(diff.allergens.contains.added)}</p>
                )}
                {diff.allergens.contains.removed.length > 0 && (
                  <p className="text-muted-foreground">
                    No longer contains: {names(diff.allergens.contains.removed)}
                  </p>
                )}
                {diff.allergens.mayContain.added.length > 0 && (
                  <p className="text-status-red">Now may contain: {names(diff.allergens.mayContain.added)}</p>
                )}
                {diff.allergens.mayContain.removed.length > 0 && (
                  <p className="text-muted-foreground">
                    No longer may contain: {names(diff.allergens.mayContain.removed)}
                  </p>
                )}
              </div>
            )}
            {(diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) && (
              <ul className="flex flex-col divide-y rounded-lg border">
                {diff.added.map((line) => (
                  <li key={`a-${line.id}`} className="text-status-green flex gap-3 px-3 py-2">
                    <span className="w-16 font-medium">Added</span>
                    <span className="flex-1">{itemLabel(line)}</span>
                    <span className="tabular-nums">{qty(line)}</span>
                  </li>
                ))}
                {diff.removed.map((line) => (
                  <li key={`r-${line.id}`} className="text-status-red flex gap-3 px-3 py-2">
                    <span className="w-16 font-medium">Removed</span>
                    <span className="flex-1">{itemLabel(line)}</span>
                    <span className="tabular-nums">{qty(line)}</span>
                  </li>
                ))}
                {diff.changed.map(({ before, after, quantityChanged, noteChanged }) => (
                  <li key={`c-${after.id}`} className="flex gap-3 px-3 py-2">
                    <span className="w-16 font-medium">Changed</span>
                    <span className="flex-1">
                      {itemLabel(after)}
                      {noteChanged && (
                        <span className="block text-muted-foreground">
                          Note: {before.note ?? "none"} → {after.note ?? "none"}
                        </span>
                      )}
                    </span>
                    {quantityChanged && (
                      <span className="tabular-nums">
                        {qty(before)} → {qty(after)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {diff.unchanged.length > 0 && (
              <p className="text-muted-foreground">
                {diff.unchanged.length} {terms.linesLower} unchanged.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
