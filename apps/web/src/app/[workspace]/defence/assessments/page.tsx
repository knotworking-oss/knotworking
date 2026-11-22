import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getDefenceAssessments } from "@/lib/api";
import { AssessmentsBoard } from "./assessments-board";

export const metadata: Metadata = { title: "Food defence assessments" };

export default async function DefenceAssessmentsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { assessments } = await getDefenceAssessments(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Food defence</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <AssessmentsBoard slug={slug} assessments={assessments} />
      </div>
    </>
  );
}
