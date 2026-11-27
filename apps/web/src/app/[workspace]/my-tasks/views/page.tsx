import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SavedTaskViews } from "@/components/saved-task-views";

export const metadata: Metadata = { title: "Views" };

export default async function ViewsPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const { team } = await searchParams;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Views</h1>
      </PageHeader>
      <div className="flex-1 overflow-auto">
        <SavedTaskViews teamId={team} />
      </div>
    </>
  );
}
