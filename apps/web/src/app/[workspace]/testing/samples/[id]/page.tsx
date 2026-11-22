import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getTestSample } from "@/lib/api";
import { SampleDetail } from "./sample-detail";

export const metadata: Metadata = { title: "Test sample" };

export default async function SamplePage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const sample = await getTestSample(slug, id);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">{sample.reference}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SampleDetail slug={slug} sample={sample} />
      </div>
    </>
  );
}
