"use client";

import { compoundStyleLabels, compoundStyles, type CompoundStyle } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { ChevronsUpDown, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { LabelStatusBadge, StaleLabelBadge } from "@/components/labels-badges";
import { stackedTable } from "@/components/stacked-table";
import type { ProductLabelRow } from "@/lib/api";
import { ApiError, browserApi, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

export type LabelFilter = "current" | "review" | "draft" | "all";

const filterLabels: Record<LabelFilter, string> = {
  current: "Current",
  review: "Needs review",
  draft: "Drafts",
  all: "All versions",
};
const emptyText: Record<LabelFilter, string> = {
  current: "No labels yet. Draft one from a recipe's approved version.",
  review: "Nothing to review: every label matches its recipe and ingredients.",
  draft: "No draft labels.",
  all: "No labels yet.",
};

/** A recipe that can be labelled: active, with an approved version. */
export interface LabelRecipeOption {
  id: string;
  code: string;
  name: string;
  version: number;
}

/** Product labels: the current label of each recipe, those needing review, drafts and history. */
export function LabelsBoard({
  slug,
  filter,
  q,
  page,
}: {
  slug: string;
  filter: LabelFilter;
  q: string;
  page: { labels: ProductLabelRow[]; total: number; limit: number; offset: number };
}) {
  const timeZone = useWorkspaceTimeZone();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(q);
  const { labels, total, limit, offset } = page;
  const go = (next: { filter?: LabelFilter; q?: string; offset?: number }) => {
    const params = new URLSearchParams();
    const f = next.filter ?? filter;
    const text = next.q ?? search;
    if (f !== "current") params.set("filter", f);
    if (text.trim()) params.set("q", text.trim());
    if (next.offset) params.set("offset", String(next.offset));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Product labels</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "label" : "labels"}
          </p>
        </div>
        {can("labels", "write") && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> Draft a label
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={filter} onValueChange={(v) => go({ filter: v as LabelFilter, offset: 0 })}>
          <TabsList className="max-w-full overflow-x-auto">
            {(Object.keys(filterLabels) as LabelFilter[]).map((f) => (
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
            aria-label="Search labels"
            placeholder="Search product name or recipe"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>

      {labels.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {q ? "No labels match." : emptyText[filter]}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Product</TableHead>
                <TableHead>Recipe</TableHead>
                <TableHead>Label</TableHead>
                <TableHead className="pr-4">Approved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {labels.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="pl-4" data-primary>
                    <Link href={`/${slug}/labels/${l.id}`} className="font-medium hover:underline">
                      {l.productName}
                      {l.variant !== "Standard" && (
                        <span className="text-muted-foreground"> · {l.variant}</span>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell data-label="Recipe">
                    {l.recipe ? (
                      <Link href={`/${slug}/recipes/${l.recipe.id}`} className="hover:underline">
                        <span className="font-mono text-xs">{l.recipe.code}</span>
                        {l.recipeVersion && (
                          <span className="text-muted-foreground"> v{l.recipeVersion.versionNumber}</span>
                        )}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell data-label="Label">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <LabelStatusBadge status={l.status} versionNumber={l.versionNumber} />
                      <StaleLabelBadge status={l.status} reasons={l.staleReasons} />
                    </span>
                  </TableCell>
                  <TableCell data-label="Approved" className="pr-4 text-muted-foreground">
                    {l.approvedAt
                      ? `${formatLongDate(l.approvedAt, timeZone)}${l.approvedByName ? ` · ${l.approvedByName}` : ""}`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {total > limit && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          {offset + 1}–{Math.min(offset + labels.length, total)} of {total}
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
      {creating && <NewLabelDialog slug={slug} onClose={() => setCreating(false)} />}
    </div>
  );
}

const KEEP = "keep";

/** What a new draft carries over from the recipe's approved label, when it has one. */
interface PreviousOptions {
  versionNumber: number;
  compoundStyle: CompoundStyle;
  includeNutrition: boolean;
}

/**
 * Drafts a label for a recipe. The compound style and the nutrition declaration default to the
 * recipe's approved label's (the server carries them over), and are only sent when changed.
 */
function NewLabelDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const [recipe, setRecipe] = useState<LabelRecipeOption | null>(null);
  const [previous, setPrevious] = useState<PreviousOptions | null>(null);
  const [style, setStyle] = useState<string>(KEEP);
  const [nutrition, setNutrition] = useState<string>(KEEP);
  const [variant, setVariant] = useState("");

  useEffect(() => {
    setPrevious(null);
    // The hint is the Standard label's; another variant carries over its own approved label's.
    if (!recipe || variant.trim()) return;
    let stale = false;
    void (async () => {
      try {
        const page = await unwrap(
          browserApi().v1.workspaces[":slug"].labelling.labels.$get({
            param: { slug },
            query: { recipeId: recipe.id, status: "approved", limit: "1" },
          }),
        );
        const label = page.labels[0];
        if (!stale && label) {
          setPrevious({
            versionNumber: label.versionNumber,
            compoundStyle: label.compoundStyle,
            includeNutrition: label.includeNutrition,
          });
        }
      } catch {
        // Only a hint: the server carries the options over either way.
      }
    })();
    return () => {
      stale = true;
    };
  }, [recipe, slug, variant]);

  const keepStyle = previous
    ? `As approved label v${previous.versionNumber}: ${compoundStyleLabels[previous.compoundStyle].toLowerCase()}`
    : `As the approved label (if none: ${compoundStyleLabels.bracketed.toLowerCase()})`;
  const keepNutrition = previous
    ? `As approved label v${previous.versionNumber}: ${previous.includeNutrition ? "declared" : "exempt"}`
    : "As the approved label (if none: declared)";

  return (
    <HaccpDialog
      title="Draft a label"
      description="Drafted from the recipe's approved version: the ingredients list, allergens and nutrition are computed; you can edit the text before a manager approves it."
      submitLabel="Draft label"
      onClose={onClose}
      disabled={!recipe}
      onSubmit={async () => {
        try {
          const label = await unwrap(
            browserApi().v1.workspaces[":slug"].labelling.labels.$post({
              param: { slug },
              json: {
                recipeId: recipe!.id,
                ...(variant.trim() ? { variant: variant.trim() } : {}),
                // Left out, the server keeps the approved label's choice.
                ...(style !== KEEP ? { compoundStyle: style as CompoundStyle } : {}),
                ...(nutrition !== KEEP ? { includeNutrition: nutrition === "yes" } : {}),
              },
            }),
          );
          router.push(`/${slug}/labels/${label.id}`);
          return "Label drafted";
        } catch (err) {
          // A draft already exists: open it rather than fail.
          const existing = (
            err instanceof ApiError ? (err.details as { id?: string } | undefined) : undefined
          )?.id;
          if (err instanceof ApiError && err.code === "label_draft_exists" && existing) {
            router.push(`/${slug}/labels/${existing}`);
            return "This recipe already has a draft label";
          }
          throw err;
        }
      }}
    >
      <Field>
        <FieldLabel id="label-recipe-label">Recipe</FieldLabel>
        <RecipePicker slug={slug} value={recipe} onChange={setRecipe} labelledBy="label-recipe-label" />
        <FieldDescription>Active recipes with an approved version.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="label-variant">Label name (optional)</FieldLabel>
        <Input
          id="label-variant"
          value={variant}
          placeholder="Standard"
          maxLength={80}
          onChange={(e) => setVariant(e.target.value)}
        />
        <FieldDescription>
          A recipe can have several labels, such as a pack size or a customer's own label. Each is drafted and
          approved on its own; leave empty for the standard one.
        </FieldDescription>
      </Field>
      <SelectField
        id="label-compound"
        label="Compound ingredients"
        value={style}
        onChange={setStyle}
        options={[[KEEP, keepStyle], ...compoundStyles.map((s) => [s, compoundStyleLabels[s]] as const)]}
      />
      <SelectField
        id="label-nutrition"
        label="Nutrition declaration"
        value={nutrition}
        onChange={setNutrition}
        options={[
          [KEEP, keepNutrition],
          ["yes", "Declare nutrition per 100 g"],
          ["no", "Exempt: no nutrition declaration"],
        ]}
        description="Prepacked for direct sale (PPDS) foods are exempt from the nutrition declaration unless a claim is made."
      />
    </HaccpDialog>
  );
}

const RECIPE_PAGE = 50;

/**
 * Search-as-you-type over active recipes (`GET /recipes`), offering those with an approved
 * version, a page at a time ("More" fetches the next).
 */
function RecipePicker({
  slug,
  value,
  onChange,
  labelledBy,
}: {
  slug: string;
  value: LabelRecipeOption | null;
  onChange: (recipe: LabelRecipeOption) => void;
  labelledBy: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LabelRecipeOption[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const page = await recipePage(slug, query, 0);
        if (!stale) {
          setResults(page.options);
          setNext(page.next);
        }
      } catch {
        if (!stale) {
          setResults([]);
          setNext(null);
        }
      } finally {
        if (!stale) setLoading(false);
      }
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, query, slug]);

  async function more() {
    if (next === null) return;
    setLoading(true);
    try {
      const page = await recipePage(slug, query, next);
      setResults((prev) => [...prev, ...page.options]);
      setNext(page.next);
    } catch {
      setNext(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-labelledby={labelledBy}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {value ? `${value.code} · ${value.name} (v${value.version})` : "Choose a recipe"}
          </span>
          <ChevronsUpDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="start">
        <Input
          autoFocus
          placeholder="Search name or code"
          aria-label="Search recipes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="mt-2 flex max-h-60 flex-col overflow-y-auto" aria-busy={loading}>
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                }}
              >
                <span className="font-mono text-xs">{r.code}</span> · {r.name}{" "}
                <span className="text-muted-foreground">v{r.version}</span>
              </button>
            </li>
          ))}
          {!loading && results.length === 0 && next === null && (
            <li className="px-2 py-3 text-center text-sm text-muted-foreground">
              No recipes with an approved version found.
            </li>
          )}
          {next !== null && (
            <li>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={loading}
                onClick={() => void more()}
              >
                More
              </Button>
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** One page of active recipes, keeping those with an approved version; `next` is the next offset. */
async function recipePage(slug: string, query: string, offset: number) {
  const page = await unwrap(
    browserApi().v1.workspaces[":slug"].recipes.$get({
      param: { slug },
      query: {
        ...(query.trim() ? { q: query.trim() } : {}),
        status: "active",
        limit: String(RECIPE_PAGE),
        offset: String(offset),
      },
    }),
  );
  const options: LabelRecipeOption[] = page.recipes.flatMap((r) =>
    r.approvedVersionNumber === null
      ? []
      : [{ id: r.id, code: r.code, name: r.name, version: r.approvedVersionNumber }],
  );
  const fetched = offset + page.recipes.length;
  return { options, next: fetched < page.total ? fetched : null };
}
