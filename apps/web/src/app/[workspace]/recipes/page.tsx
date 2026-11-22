import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getItems, getRecipes } from "@/lib/api";
import { RecipesManager } from "./recipes-manager";

export const metadata: Metadata = { title: "Recipes" };

export default async function RecipesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; status?: string; drift?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filters = {
    q: search.q?.trim() || undefined,
    status: (search.status === "all" || search.status === "archived" ? search.status : "active") as
      "active" | "archived" | "all",
    drift: search.drift === "1",
  };
  const [page, finished, wip] = await Promise.all([
    getRecipes(slug, {
      ...(filters.q ? { q: filters.q } : {}),
      status: filters.status,
      ...(filters.drift ? { allergenDrift: "true" as const } : {}),
    }),
    getItems(slug, { type: "finished", status: "active" }),
    getItems(slug, { type: "wip", status: "active" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Recipes</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <RecipesManager
          slug={slug}
          recipes={page.recipes}
          total={page.total}
          outputItems={[...finished.items, ...wip.items].sort((a, b) => a.name.localeCompare(b.name))}
          filters={filters}
        />
      </div>
    </>
  );
}
