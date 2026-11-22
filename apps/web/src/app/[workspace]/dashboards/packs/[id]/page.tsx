import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getMembers, getPack, getSnapshots } from "@/lib/api";
import { PackView } from "./pack-view";

export const metadata: Metadata = { title: "Board pack" };

export default async function PackPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const pack = await getPack(slug, id);
  const [snapshots, members] = pack.canEdit
    ? await Promise.all([
        getSnapshots(slug).then((r) => r.snapshots),
        getMembers(slug).then((r) => r.members),
      ])
    : [[], []];
  // Who can be named in the audience: active members, never guests.
  const people = members
    .filter((m) => m.role !== "guest" && !m.deactivatedAt)
    .map((m) => ({ userId: m.userId, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/dashboards/packs`} className="text-muted-foreground hover:text-foreground">
          Board packs
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="truncate font-medium">{pack.title}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PackView slug={slug} pack={pack} snapshots={snapshots} people={people} />
      </div>
    </>
  );
}
