import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getGovernanceCulture, getGovernanceObjectives } from "@/lib/api";
import { CultureBoard } from "./culture-board";

export const metadata: Metadata = { title: "Culture plan" };

export default async function CulturePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ activities }, { objectives }] = await Promise.all([
    getGovernanceCulture(slug),
    getGovernanceObjectives(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <CultureBoard
          slug={slug}
          activities={activities}
          objectives={objectives
            .filter((o) => o.status === "open")
            .map((o) => ({ id: o.id, title: o.title }))}
        />
      </div>
    </>
  );
}
