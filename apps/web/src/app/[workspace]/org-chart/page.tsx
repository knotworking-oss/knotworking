import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrgChart } from "@/components/org-chart";
import { PageHeader } from "@/components/page-header";
import { getMe, getMembers } from "@/lib/api";

export const metadata: Metadata = { title: "Org chart" };

export default async function OrgChartPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [me, { members, canManage }] = await Promise.all([getMe(), getMembers(slug)]);
  // Guests (outside collaborators) don't see the org chart, as they don't see email addresses.
  if (me.workspaces.find((w) => w.slug === slug)?.role === "guest") notFound();
  const active = members.filter((m) => !m.deactivatedAt);
  const placed = active.some((m) => m.title || m.department || m.reportsToUserId);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Org chart</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          {!placed && (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Nobody has a title or a manager yet, so everyone is at the top.
            </p>
          )}
          <OrgChart members={active} />
        </div>
      </div>
    </>
  );
}
