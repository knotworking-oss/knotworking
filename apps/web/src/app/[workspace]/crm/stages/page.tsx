import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getCrmStages } from "@/lib/api";
import { StagesEditor } from "../crm-controls";

export const metadata: Metadata = { title: "Pipeline stages" };

export default async function CrmStagesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { stages } = await getCrmStages(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Pipeline stages</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
          <p className="text-sm text-muted-foreground">
            The open stages an opportunity moves through, in order, with the likelihood of winning at each for
            the weighted pipeline. Won and lost are outcomes, not stages. A stage with open opportunities
            can&apos;t be removed.
          </p>
          <StagesEditor
            key={stages.map((s) => `${s.id}:${s.name}:${s.probability}`).join()}
            stages={stages}
          />
        </div>
      </div>
    </>
  );
}
