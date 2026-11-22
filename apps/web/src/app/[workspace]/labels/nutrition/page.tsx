import type { Metadata } from "next";
import { LabelsNav } from "@/components/labels-nav";
import { PageHeader } from "@/components/page-header";
import { getLabellingItems } from "@/lib/api";
import { NutritionBoard, type NutritionFilter } from "./nutrition-board";

export const metadata: Metadata = { title: "Ingredient nutrition" };

const FILTERS: readonly NutritionFilter[] = ["all", "missing", "entered", "recipe"];

export default async function NutritionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ nutrition?: string; q?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filter = FILTERS.find((f) => f === search.nutrition) ?? "all";
  const q = search.q?.trim() || undefined;
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const page = await getLabellingItems(slug, {
    nutrition: filter,
    ...(q ? { q } : {}),
    ...(offset ? { offset: String(offset) } : {}),
  });
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Labels</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <LabelsNav slug={slug} />
          <NutritionBoard slug={slug} filter={filter} q={q ?? ""} page={page} />
        </div>
      </div>
    </>
  );
}
