import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getNpdProject, getRecipes } from "@/lib/api";
import { NpdDetail } from "./npd-detail";

export const metadata: Metadata = { title: "Project" };

export default async function NpdProjectPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [project, items, recipes] = await Promise.all([
    getNpdProject(slug, id),
    getAllItems(slug, { status: "active" }),
    getRecipes(slug, { status: "active" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">{project.code}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <NpdDetail
          slug={slug}
          project={project}
          items={items.items.filter((i) => i.type === "finished" || i.type === "wip")}
          recipes={recipes.recipes}
        />
      </div>
    </>
  );
}
