import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getMe } from "@/lib/api";
import { canManageStructure } from "@/lib/workflow";
import { TeamSettings } from "./team-settings";

type Props = { params: Promise<{ workspace: string; key: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, key } = await params;
  const boot = await getBootstrap(workspace);
  return { title: boot.teams.find((t) => t.key === key.toUpperCase())?.name ?? "Team" };
}

export default async function TeamSettingsPage({ params }: Props) {
  const { workspace: slug, key } = await params;
  const [boot, me] = await Promise.all([getBootstrap(slug), getMe()]);
  const team = boot.teams.find((t) => t.key === key.toUpperCase());
  if (!team) notFound();
  const canManage = canManageStructure(me.workspaces.find((w) => w.slug === slug)?.role);

  const states = boot.workflowStates.filter((s) => s.teamId === team.id);
  const taskCounts = Object.fromEntries(
    states.map((state) => [
      state.id,
      boot.closedWindow?.stateCounts[state.id] ??
        boot.tasks.filter((task) => task.stateId === state.id).length,
    ]),
  );

  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/settings/teams`}>Teams</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{team.name}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <TeamSettings
          slug={slug}
          canManage={canManage}
          team={team}
          states={states}
          taskCounts={taskCounts}
          people={boot.users.map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl }))}
          memberIds={boot.teamMembers.filter((m) => m.teamId === team.id).map((m) => m.userId)}
        />
      </div>
    </>
  );
}
