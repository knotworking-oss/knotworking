import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getGovernanceObjectives } from "@/lib/api";
import { ObjectivesBoard } from "./objectives-board";

export const metadata: Metadata = { title: "Objectives" };

export default async function ObjectivesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { objectives } = await getGovernanceObjectives(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ObjectivesBoard slug={slug} objectives={objectives} />
      </div>
    </>
  );
}
