import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getRecallTests } from "@/lib/api";
import { QualityNav } from "@/components/quality-nav";
import { RecallTestsBoard } from "./recall-tests-board";

export const metadata: Metadata = { title: "Recall tests" };

export default async function RecallTestsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ recallTests }, { items }] = await Promise.all([
    getRecallTests(slug, { includeVoided: "true" }),
    getAllItems(slug, { status: "all" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Quality</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <QualityNav slug={slug} />
          <RecallTestsBoard
            slug={slug}
            tests={recallTests}
            items={items.map((i) => ({ id: i.id, code: i.code, name: i.name, unit: i.unit }))}
          />
        </div>
      </div>
    </>
  );
}
