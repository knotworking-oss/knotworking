import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getProductionLines, getRecipes } from "@/lib/api";
import { LinesManager } from "./lines-manager";

export const metadata: Metadata = { title: "Production lines" };

export default async function LinesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ lines }, { recipes }] = await Promise.all([
    getProductionLines(slug),
    getRecipes(slug, { status: "active" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Production lines</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <LinesManager slug={slug} lines={lines} recipes={recipes} />
      </div>
    </>
  );
}
