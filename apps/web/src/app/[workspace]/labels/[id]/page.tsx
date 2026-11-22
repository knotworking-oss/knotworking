import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getProductLabel } from "@/lib/api";
import { LabelDetail } from "./label-detail";

export const metadata: Metadata = { title: "Label" };

export default async function LabelPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const label = await getProductLabel(slug, id);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">{label.productName}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <LabelDetail key={`${label.id}-${label.updatedAt}`} slug={slug} label={label} />
      </div>
    </>
  );
}
