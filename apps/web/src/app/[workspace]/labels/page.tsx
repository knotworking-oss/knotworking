import type { Metadata } from "next";
import { LabelsNav } from "@/components/labels-nav";
import { PageHeader } from "@/components/page-header";
import { getProductLabels } from "@/lib/api";
import { LabelsBoard, type LabelFilter } from "./labels-board";

export const metadata: Metadata = { title: "Labels" };

const FILTERS: readonly LabelFilter[] = ["current", "review", "draft", "all"];

export default async function LabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ filter?: string; q?: string; offset?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filter = FILTERS.find((f) => f === search.filter) ?? "current";
  const q = search.q?.trim() || undefined;
  const offset = Math.max(0, Number.parseInt(search.offset ?? "0", 10) || 0);
  const page = await getProductLabels(slug, {
    ...(filter === "review" ? { stale: "true" as const } : {}),
    status: filter === "draft" ? "draft" : filter === "all" ? "all" : "current",
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
          <LabelsBoard slug={slug} filter={filter} q={q ?? ""} page={page} />
        </div>
      </div>
    </>
  );
}
