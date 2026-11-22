import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getArchivedTeams, getBootstrap, getMe } from "@/lib/api";
import { canManageStructure } from "@/lib/workflow";
import { TeamsManager } from "./teams-manager";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsSettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [boot, me] = await Promise.all([getBootstrap(slug), getMe()]);
  const canManage = canManageStructure(me.workspaces.find((w) => w.slug === slug)?.role);
  const archived = canManage ? (await getArchivedTeams(slug)).teams : [];

  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Teams</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <TeamsManager
          slug={slug}
          canManage={canManage}
          teams={boot.teams.map((t) => ({
            id: t.id,
            key: t.key,
            name: t.name,
            icon: t.icon,
            color: t.color,
            description: t.description,
            memberCount: boot.teamMembers.filter((m) => m.teamId === t.id).length,
            stateCount: boot.workflowStates.filter((s) => s.teamId === t.id).length,
          }))}
          archived={archived.map((t) => ({ id: t.id, key: t.key, name: t.name, icon: t.icon }))}
        />
      </div>
    </>
  );
}
