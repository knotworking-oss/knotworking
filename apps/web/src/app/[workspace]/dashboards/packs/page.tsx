import { hasModuleLevel } from "@knotworking/core";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getPacks, getSnapshots } from "@/lib/api";
import { PackList } from "./pack-list";

export const metadata: Metadata = { title: "Board packs" };

/** Board packs: every pack for managers; issued packs to their audience. */
export default async function PacksPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ packs }, boot, { snapshots: analyses }] = await Promise.all([
    getPacks(slug),
    getBootstrap(slug),
    getSnapshots(slug, { kind: "analysis" }),
  ]);
  const canManage = hasModuleLevel(boot.modules.find((m) => m.id === "bi")?.access, "manage");
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/dashboards`} className="text-muted-foreground hover:text-foreground">
          Dashboards
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-medium">Board packs</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PackList slug={slug} packs={packs} analyses={analyses} canManage={canManage} />
      </div>
    </>
  );
}
