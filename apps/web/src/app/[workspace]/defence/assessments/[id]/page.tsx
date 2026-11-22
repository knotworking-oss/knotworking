import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getDefenceAssessment } from "@/lib/api";
import { AssessmentDetail } from "./assessment-detail";

export const metadata: Metadata = { title: "Food defence assessment" };

export default async function DefenceAssessmentPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const assessment = await getDefenceAssessment(slug, id);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Food defence</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <AssessmentDetail slug={slug} assessment={assessment} />
      </div>
    </>
  );
}
