import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getMe } from "@/lib/api";
import { canManageStructure } from "@/lib/workflow";
import { LabelsManager } from "./labels-manager";

export const metadata: Metadata = { title: "Labels" };

export default async function LabelsSettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [boot, me] = await Promise.all([getBootstrap(slug), getMe()]);
  const canManage = canManageStructure(me.workspaces.find((w) => w.slug === slug)?.role);

  const usage: Record<string, number> = boot.closedWindow?.labelCounts ?? {};
  if (!boot.closedWindow) {
    for (const task of boot.tasks) for (const id of task.labelIds) usage[id] = (usage[id] ?? 0) + 1;
  }

  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Labels</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <LabelsManager
          slug={slug}
          canManage={canManage}
          labels={boot.labels.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
            teamId: l.teamId,
            taskCount: usage[l.id] ?? 0,
          }))}
          teams={boot.teams.map((t) => ({ id: t.id, name: t.name, icon: t.icon }))}
        />
      </div>
    </>
  );
}
