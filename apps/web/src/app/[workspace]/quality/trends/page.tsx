import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { QualityNav } from "@/components/quality-nav";
import { getAllItems, getComplaintTrends } from "@/lib/api";
import { TrendsView } from "./trends-view";

export const metadata: Metadata = { title: "Complaint trends" };

export default async function TrendsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [trends, { items }] = await Promise.all([
    getComplaintTrends(slug, 12),
    getAllItems(slug, { status: "all" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Quality</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <QualityNav slug={slug} />
          <TrendsView
            slug={slug}
            trends={trends}
            items={items
              .filter((i) => i.type === "finished")
              .map((i) => ({ id: i.id, code: i.code, name: i.name }))}
          />
        </div>
      </div>
    </>
  );
}
