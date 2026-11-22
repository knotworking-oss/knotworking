import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getStandards } from "@/lib/api";
import { StandardsLibrary } from "./standards-library";

export const metadata: Metadata = { title: "Standards" };

export default async function StandardsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { standards } = await getStandards(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <StandardsLibrary slug={slug} standards={standards} />
      </div>
    </>
  );
}
