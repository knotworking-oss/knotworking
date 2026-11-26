import { producibleItemTypes } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getAllItems, getRecipes } from "@/lib/api";
import { RecipesManager } from "./recipes-manager";
import { recipeTerms } from "@/lib/recipe-terms";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string }>;
}): Promise<Metadata> {
  const { workspace } = await params;
  return { title: recipeTerms(await canReadModule(workspace, "food_items")).title };
}

export default async function RecipesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; status?: string; drift?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const showFood = await canReadModule(slug, "food_items");
  const filters = {
    q: search.q?.trim() || undefined,
    status: (search.status === "all" || search.status === "archived" ? search.status : "active") as
      "active" | "archived" | "all",
    drift: showFood && search.drift === "1",
  };
  const [page, ...outputs] = await Promise.all([
    getRecipes(slug, {
      ...(filters.q ? { q: filters.q } : {}),
      status: filters.status,
      ...(filters.drift ? { allergenDrift: "true" as const } : {}),
    }),
    ...producibleItemTypes.map((type) => getAllItems(slug, { type, status: "active" })),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">{recipeTerms(showFood).title}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <RecipesManager
          slug={slug}
          recipes={page.recipes}
          total={page.total}
          outputItems={outputs.flatMap((output) => output.items).sort((a, b) => a.name.localeCompare(b.name))}
          filters={filters}
        />
      </div>
    </>
  );
}
