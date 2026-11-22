import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getRecipe } from "@/lib/api";
import { RecipeDetail } from "./recipe-detail";

export const metadata: Metadata = { title: "Recipe" };

export default async function RecipePage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const recipe = await getRecipe(slug, id);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">{recipe.name}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <RecipeDetail slug={slug} recipe={recipe} />
      </div>
    </>
  );
}
