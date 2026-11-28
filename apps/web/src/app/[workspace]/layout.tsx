import { SidebarInset, SidebarProvider } from "@knotworking/ui/components/sidebar";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { AssistantPanel } from "@/components/assistant-panel";
import { CommandMenuProvider } from "@/components/command-menu";
import { NewTaskProvider } from "@/components/new-task-dialog";
import { ShortcutsHelpProvider } from "@/components/shortcuts-help";
import { getBootstrap, getMe, getUnreadCount } from "@/lib/api";
import { AssistantProvider } from "@/lib/assistant-store";
import { defaultAreaCookie, lastAreaCookie, teamsCollapsedCookie } from "@/lib/sidebar-cookies";
import { WorkspaceProvider } from "@/lib/workspace-store";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const [boot, me, unreadCount, cookieStore] = await Promise.all([
    getBootstrap(slug),
    getMe(),
    getUnreadCount(slug),
    cookies(),
  ]);
  const stateType = new Map(boot.workflowStates.map((s) => [s.id, s.type]));
  const isOpen = (stateId: string) => ["unstarted", "started"].includes(stateType.get(stateId) ?? "");
  const role = me.workspaces.find((w) => w.id === boot.workspace.id)?.role ?? "guest";
  // The assistant sidebar needs the module (it isn't a page, so there's no requireModule layout).
  const assistant = boot.modules.some((m) => m.id === "assistant" && m.access !== "none");

  return (
    <WorkspaceProvider boot={boot} slug={slug} viewer={{ id: me.user.id, role }}>
      <AssistantProvider slug={slug} enabled={assistant}>
        <NewTaskProvider>
          <ShortcutsHelpProvider>
            <CommandMenuProvider
              data={{
                slug,
                teams: boot.teams.map((t) => ({ key: t.key, name: t.name, icon: t.icon })),
                documents: boot.documents.map((d) => ({ id: d.id, title: d.title, icon: d.icon })),
                tasks: boot.tasks.map((i) => ({
                  id: i.id,
                  title: i.title,
                  reference: i.reference,
                  stateType: stateType.get(i.stateId) ?? "unstarted",
                })),
              }}
            >
              {/* Remember the collapsed/expanded sidebar between visits. */}
              <SidebarProvider defaultOpen={cookieStore.get("sidebar_state")?.value !== "false"}>
                <AppSidebar
                  workspace={boot.workspace}
                  user={me.user}
                  teams={boot.teams.map((t) => ({
                    id: t.id,
                    key: t.key,
                    name: t.name,
                    icon: t.icon,
                    openCount: boot.tasks.filter((i) => i.teamId === t.id && isOpen(i.stateId)).length,
                  }))}
                  initialDefaultArea={cookieStore.get(defaultAreaCookie(slug))?.value ?? null}
                  initialLastArea={cookieStore.get(lastAreaCookie(slug))?.value ?? null}
                  initialTeamsCollapsed={cookieStore.get(teamsCollapsedCookie(slug))?.value === "1"}
                  unreadCount={unreadCount}
                  myTaskCount={
                    boot.tasks.filter((i) => i.assigneeId === me.user.id && isOpen(i.stateId)).length
                  }
                />
                <SidebarInset className="h-dvh min-w-0 overflow-hidden">{children}</SidebarInset>
                <AssistantPanel slug={slug} />
              </SidebarProvider>
            </CommandMenuProvider>
          </ShortcutsHelpProvider>
        </NewTaskProvider>
      </AssistantProvider>
    </WorkspaceProvider>
  );
}
