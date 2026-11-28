"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AllergenBadges } from "@/components/item-badges";
import { RecipeVersionBadge } from "@/components/recipe-badges";
import type { Item, RecipeRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { recipeTerms } from "@/lib/recipe-terms";

type StatusFilter = "active" | "archived" | "all";
interface Filters {
  q?: string | undefined;
  status: StatusFilter;
  drift?: boolean | undefined;
}

/** Recipes → the recipe list with search and a status filter, and the new-recipe dialog. */
export function RecipesManager({
  slug,
  recipes,
  total,
  outputItems,
  filters,
}: {
  slug: string;
  recipes: RecipeRow[];
  total: number;
  outputItems: Item[];
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("recipes", "write");
  const showFood = can("food_items");
  const terms = recipeTerms(showFood);
  const name = terms.singular;
  const plural = terms.plural;
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState(filters.q ?? "");

  function applyFilters(next: Partial<Filters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status !== "active") params.set("status", merged.status);
    if (merged.drift) params.set("drift", "1");
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  }

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{terms.title}</h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        {canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> New {name}
          </Button>
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters({ q: query.trim() || undefined });
        }}
      >
        <Input
          className="w-64"
          placeholder="Search name or code"
          aria-label={`Search ${plural}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select value={filters.status} onValueChange={(v) => applyFilters({ status: v as StatusFilter })}>
          <SelectTrigger className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {showFood && (
          <Button
            type="button"
            variant={filters.drift ? "secondary" : "outline"}
            aria-pressed={!!filters.drift}
            onClick={() => applyFilters({ drift: !filters.drift })}
          >
            Allergens changed
          </Button>
        )}
      </form>

      {recipes.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filters.q || filters.drift || filters.status !== "active"
            ? `No ${plural} match these filters.`
            : `Create a ${name} for a component, work-in-progress item or finished good.`}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Makes</TableHead>
                <TableHead>Current version</TableHead>
                <TableHead>Draft</TableHead>
                {showFood && <TableHead className="pr-4">Allergens</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipes.map((recipe) => (
                <TableRow key={recipe.id}>
                  <TableCell className="pl-4 font-mono text-xs">{recipe.code}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/${slug}/recipes/${recipe.id}`} className="hover:underline">
                      {recipe.name}
                    </Link>
                    {recipe.status === "archived" && (
                      <Badge variant="secondary" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {recipe.outputItem ? `${recipe.outputItem.code} · ${recipe.outputItem.name}` : "—"}
                  </TableCell>
                  <TableCell>
                    {recipe.approvedVersionNumber !== null ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <RecipeVersionBadge status="approved" versionNumber={recipe.approvedVersionNumber} />
                        {recipe.allergenDrift && (
                          <Badge
                            variant="destructive"
                            title="An ingredient's allergens changed since approval"
                          >
                            Allergens changed
                          </Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not approved</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {recipe.hasDraft ? (
                      <RecipeVersionBadge
                        status="draft"
                        versionNumber={recipe.draftVersionNumber ?? undefined}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {showFood && (
                    <TableCell className="max-w-xs pr-4 whitespace-normal">
                      <AllergenBadges
                        contains={recipe.allergens.contains}
                        mayContain={recipe.allergens.mayContain}
                        empty="—"
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {creating && (
        <NewRecipeDialog
          showFood={showFood}
          slug={slug}
          outputItems={outputItems}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function NewRecipeDialog({
  showFood,
  slug,
  outputItems,
  onClose,
}: {
  showFood: boolean;
  slug: string;
  outputItems: Item[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [outputItemId, setOutputItemId] = useState("");
  const [description, setDescription] = useState("");

  async function create(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].recipes.$post({
          param: { slug },
          json: {
            code: code.trim(),
            name: name.trim(),
            outputItemId,
            description: description.trim() || null,
          },
        }),
      );
      toast.success(`${created.name} created`);
      router.push(`/${slug}/recipes/${created.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void create(e)}>
          <DialogHeader>
            <DialogTitle>New {recipeTerms(showFood).singular}</DialogTitle>
            <DialogDescription>
              Pick the item one batch makes. A manager approves the draft before production can use it.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field>
                <FieldLabel htmlFor="recipe-code">Code</FieldLabel>
                <Input
                  id="recipe-code"
                  required
                  maxLength={40}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="recipe-name">Name</FieldLabel>
                <Input
                  id="recipe-name"
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="recipe-output">Makes</FieldLabel>
              <Select value={outputItemId} onValueChange={setOutputItemId}>
                <SelectTrigger id="recipe-output" className="w-full">
                  <SelectValue placeholder="Choose an item" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {outputItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.code} · {item.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="recipe-description">Description</FieldLabel>
              <Textarea
                id="recipe-description"
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !outputItemId}>
              {pending && <Spinner data-icon="inline-start" />} Create {recipeTerms(showFood).singular}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
