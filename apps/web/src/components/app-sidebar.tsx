"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@knotworking/ui/components/sidebar";
import { Kbd, KbdGroup } from "@knotworking/ui/components/kbd";
import { ChevronRight, Hash, FileText, Inbox, Search, Sparkles, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo } from "react";
import { UserMenu } from "./user-menu";
import { AreaSwitcher } from "./area-switcher";
import { useCommandMenu } from "./command-menu";
import { useNewTask } from "./new-task-dialog";
import { useOptionalAssistant } from "@/lib/assistant-store";
import {
  areaForPath,
  isItemActive,
  resolveArea,
  visibleAreas,
  visiblePinned,
  visibleSections,
  wikiItem,
  type NavAccess,
  type NavItem,
} from "@/lib/sidebar-nav";
import {
  RECENT_DOCS_SHOWN,
  recordRecentDoc,
  useDefaultArea,
  useLastArea,
  useRecentDocIds,
  useTeamsCollapsed,
} from "@/lib/sidebar-prefs";
import { useWorkspace } from "@/lib/workspace-store";

export interface SidebarData {
  workspace: { slug: string; name: string; icon: string | null };
  user: { name: string; email: string };
  teams: { id: string; key: string; name: string; icon: string | null; openCount: number }[];
  myTaskCount: number;
  /** The viewer's unread notifications in this workspace. */
  unreadCount: number;
  /** What the server read from the viewer's cookies, so the first paint matches. */
  initialDefaultArea: string | null;
  initialLastArea: string | null;
  initialTeamsCollapsed: boolean;
}

export function AppSidebar({
  workspace,
  user,
  teams,
  myTaskCount,
  unreadCount,
  initialDefaultArea,
  initialLastArea,
  initialTeamsCollapsed,
}: SidebarData) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const { setOpen } = useCommandMenu();
  const newTask = useNewTask();
  const { canEdit, can, modules, viewer, idx } = useWorkspace();
  const assistant = useOptionalAssistant();
  const slug = workspace.slug;
  const base = `/${slug}`;
  // On small screens the sidebar is an overlay: close it once something is selected.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);

  const access = useMemo<NavAccess>(
    () => ({ can, canEdit, isActive: (id) => modules.some((m) => m.id === id) }),
    [can, canEdit, modules],
  );
  const areas = useMemo(() => visibleAreas(access), [access]);

  const [defaultAreaId, setDefaultArea] = useDefaultArea(slug, initialDefaultArea);
  const [lastAreaId, setLastArea] = useLastArea(slug, initialLastArea);
  const area = resolveArea({ pathname, slug, stored: lastAreaId, preferred: defaultAreaId, access });
  const sections = useMemo(() => visibleSections(area, access), [area, access]);
  const pinned = useMemo(() => visiblePinned(access), [access]);
  const [teamsCollapsed, setTeamsCollapsed] = useTeamsCollapsed(slug, initialTeamsCollapsed);
  // Folded, the team whose page is open stays listed, so the viewer can see where they are.
  const visibleTeams = teamsCollapsed
    ? teams.filter((t) => pathname.startsWith(`${base}/team/${t.key}`))
    : teams;

  // Remember the module of the page the viewer is on, for pages that belong to none (the inbox).
  const pathArea = areaForPath(pathname, slug);
  useEffect(() => {
    if (pathArea && pathArea !== lastAreaId && areas.some((a) => a.id === pathArea)) setLastArea(pathArea);
  }, [pathArea, lastAreaId, areas, setLastArea]);

  // Remember the docs the viewer opens, to list the latest few below the module.
  const openedDoc = new RegExp(`^/${slug}/docs/([^/]+)`).exec(pathname)?.[1];
  const hasOpenedDoc = !!openedDoc && idx.documents.has(openedDoc);
  useEffect(() => {
    if (openedDoc && hasOpenedDoc) recordRecentDoc(viewer.id, slug, openedDoc);
  }, [openedDoc, hasOpenedDoc, viewer.id, slug]);
  const recentIds = useRecentDocIds(viewer.id, slug);
  const recentDocs = can("docs")
    ? recentIds.flatMap((id) => idx.documents.get(id) ?? []).slice(0, RECENT_DOCS_SHOWN)
    : [];

  const is = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const itemBadge = (item: NavItem) =>
    item.badge === "myTasks" && myTaskCount > 0 ? <SidebarMenuBadge>{myTaskCount}</SidebarMenuBadge> : null;

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    return (
      <SidebarMenuItem key={item.path}>
        <SidebarMenuButton
          asChild
          isActive={isItemActive(item, pathname, slug)}
          tooltip={item.tooltip ?? item.label}
        >
          <Link href={`${base}/${item.path}`}>
            {Icon && <Icon />}
            <span>{item.label}</span>
          </Link>
        </SidebarMenuButton>
        {itemBadge(item)}
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <AreaSwitcher
              slug={slug}
              workspaceName={idx.boot.workspace.name}
              workspaceIcon={idx.boot.workspace.icon}
              areas={areas}
              current={area}
              access={access}
              defaultAreaId={defaultAreaId}
              onSetDefault={setDefaultArea}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search"
                onClick={() => {
                  setOpenMobile(false);
                  setOpen(true);
                }}
              >
                <Search />
                <span>Search</span>
                <KbdGroup className="ml-auto group-data-[collapsible=icon]:hidden">
                  <Kbd>⌘</Kbd>
                  <Kbd>K</Kbd>
                </KbdGroup>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {assistant?.enabled && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Assistant"
                  isActive={assistant.open}
                  onClick={() => {
                    setOpenMobile(false);
                    assistant.toggle();
                  }}
                >
                  <Sparkles />
                  <span>Assistant</span>
                  <KbdGroup className="ml-auto group-data-[collapsible=icon]:hidden">
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </KbdGroup>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {canEdit && can("tasks", "write") && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="New task"
                  onClick={() => {
                    setOpenMobile(false);
                    newTask();
                  }}
                >
                  <SquarePen />
                  <span>New task</span>
                  <Kbd className="ml-auto">C</Kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={is(`${base}/inbox`)} tooltip="Inbox">
                <Link href={`${base}/inbox`}>
                  <Inbox />
                  <span>Inbox</span>
                </Link>
              </SidebarMenuButton>
              {unreadCount > 0 && (
                <SidebarMenuBadge
                  className="bg-primary text-primary-foreground"
                  aria-label={`${unreadCount} unread`}
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {pinned.length > 0 && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>{pinned.map((item) => renderItem(item))}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {can("tasks") && teams.length > 0 && (
          // Team boards are a list that grows with the workspace, so it can be folded away. Icon-only
          // mode drops it: a column of identical # icons says nothing.
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel asChild>
              <button
                type="button"
                onClick={() => setTeamsCollapsed(!teamsCollapsed)}
                aria-expanded={!teamsCollapsed}
                aria-controls="sidebar-teams"
                className="cursor-pointer hover:text-sidebar-foreground"
              >
                <ChevronRight
                  className={`mr-1 size-3.5 transition-transform ${teamsCollapsed ? "" : "rotate-90"}`}
                />
                Teams
              </button>
            </SidebarGroupLabel>
            <SidebarGroupContent id="sidebar-teams">
              <SidebarMenu>
                {visibleTeams.map((t) => (
                  <SidebarMenuItem key={t.id}>
                    <SidebarMenuButton asChild isActive={is(`${base}/team/${t.key}`)} tooltip={t.name}>
                      <Link href={`${base}/team/${t.key}`}>
                        <Hash />
                        <span>{t.name}</span>
                      </Link>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>{t.openCount}</SidebarMenuBadge>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {sections.map((section, i) => (
          <SidebarGroup key={`${area.id}-${section.label ?? i}`}>
            {section.label && <SidebarGroupLabel>{section.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>{section.items.map((item) => renderItem(item))}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {can("docs") && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {renderItem(wikiItem)}
                {recentDocs.length > 0 && (
                  <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
                    <SidebarMenuSub>
                      {recentDocs.map((d) => (
                        <SidebarMenuSubItem key={d.id}>
                          <SidebarMenuSubButton asChild isActive={pathname === `${base}/docs/${d.id}`}>
                            <Link href={`${base}/docs/${d.id}`}>
                              {d.icon ? (
                                <span className="w-4 text-center text-sm leading-none">{d.icon}</span>
                              ) : (
                                <FileText />
                              )}
                              <span>{d.title || "Untitled"}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu user={user} slug={slug} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
