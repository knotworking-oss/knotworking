import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getGapSnapshot } from "@/lib/api";
import { SnapshotView } from "./snapshot-view";

export const metadata: Metadata = { title: "Gap analysis snapshot" };

export default async function GapSnapshotPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string; snapshotId: string }>;
}) {
  const { workspace: slug, snapshotId } = await params;
  const snapshot = await getGapSnapshot(slug, snapshotId);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SnapshotView slug={slug} standardId={snapshot.snapshot.standardId} view={snapshot} />
      </div>
    </>
  );
}
