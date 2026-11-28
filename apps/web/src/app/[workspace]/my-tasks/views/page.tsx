import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@knotworking/ui/components/button";
import { PageHeader } from "@/components/page-header";
import { SavedTaskViews } from "@/components/saved-task-views";

export const metadata: Metadata = { title: "Views" };

export default async function ViewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ team?: string }>;
}) {
  const [{ workspace }, { team }] = await Promise.all([params, searchParams]);
  return (
    <>
      <PageHeader
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href={`/${workspace}/my-tasks/fields`}>Custom fields</Link>
          </Button>
        }
      >
        <h1 className="font-medium">Views</h1>
      </PageHeader>
      <div className="flex-1 overflow-auto">
        <SavedTaskViews teamId={team} />
      </div>
    </>
  );
}
