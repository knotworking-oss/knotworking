import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getSnapshot } from "@/lib/api";
import { SnapshotPage } from "./snapshot-page";

export const metadata: Metadata = { title: "Snapshot" };

/** A frozen dashboard: shown as taken, never re-queried. */
export default async function Page({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const snapshot = await getSnapshot(slug, id);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/dashboards/packs`} className="text-muted-foreground hover:text-foreground">
          Board packs
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="truncate font-medium">{snapshot.title}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <SnapshotPage slug={slug} snapshot={snapshot} />
      </div>
    </>
  );
}
