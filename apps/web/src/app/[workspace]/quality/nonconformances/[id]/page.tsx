import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getMembers, getNonconformance } from "@/lib/api";
import { NonconformanceDetailView } from "./nonconformance-detail";

export const metadata: Metadata = { title: "Non-conformance" };

export default async function NonconformancePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [nc, { items }, { members }] = await Promise.all([
    getNonconformance(slug, id),
    getAllItems(slug, { status: "active" }),
    getMembers(slug),
  ]);
  return (
    <>
      <PageHeader>
        <Link
          href={`/${slug}/quality/nonconformances`}
          className="text-muted-foreground hover:text-foreground"
        >
          Non-conformances
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-mono font-medium">{nc.reference}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <NonconformanceDetailView
          slug={slug}
          nc={nc}
          items={items.map((i) => ({ id: i.id, code: i.code, name: i.name }))}
          members={members.filter((m) => !m.deactivatedAt).map((m) => ({ userId: m.userId, name: m.name }))}
        />
      </div>
    </>
  );
}
