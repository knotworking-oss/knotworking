import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getReleaseRules } from "@/lib/api";
import { ReleaseRules } from "./release-rules";

export const metadata: Metadata = { title: "Release rules" };

export default async function ReleaseRulesPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ rules }, { items }] = await Promise.all([
    getReleaseRules(slug),
    getAllItems(slug, { status: "active" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Release rules</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ReleaseRules slug={slug} rules={rules} items={items} />
      </div>
    </>
  );
}
