import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getItemOptions, getComplaint, getMembers } from "@/lib/api";
import { ComplaintDetailView } from "./complaint-detail";

export const metadata: Metadata = { title: "Complaint" };

export default async function ComplaintPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [complaint, items, { members }] = await Promise.all([
    getComplaint(slug, id),
    getItemOptions(slug, { status: "active" }),
    getMembers(slug),
  ]);
  return (
    <>
      <PageHeader>
        <Link href={`/${slug}/quality/complaints`} className="text-muted-foreground hover:text-foreground">
          Complaints
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-mono font-medium">{complaint.reference}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ComplaintDetailView
          slug={slug}
          complaint={complaint}
          items={items.map((i) => ({ id: i.id, code: i.code, name: i.name }))}
          members={members.filter((m) => !m.deactivatedAt).map((m) => ({ userId: m.userId, name: m.name }))}
        />
      </div>
    </>
  );
}
