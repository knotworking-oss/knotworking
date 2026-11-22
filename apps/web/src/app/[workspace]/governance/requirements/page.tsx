import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getGovernanceRequirements } from "@/lib/api";
import { RequirementsBoard } from "./requirements-board";

export const metadata: Metadata = { title: "Requirements register" };

export default async function RequirementsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { requirements } = await getGovernanceRequirements(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <RequirementsBoard slug={slug} requirements={requirements} />
      </div>
    </>
  );
}
