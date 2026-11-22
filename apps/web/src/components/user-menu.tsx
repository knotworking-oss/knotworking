"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { SidebarMenuButton } from "@knotworking/ui/components/sidebar";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import {
  CalendarCog,
  Landmark,
  ChevronsUpDown,
  Globe,
  KeyRound,
  LogOut,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  SunMoon,
  Tag,
  Users,
  Workflow,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function UserMenu({ user, slug }: { user: { name: string; email: string }; slug: string }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { can, viewer } = useWorkspace();
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop("__TAURI_INTERNALS__" in window), []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
          <UserAvatar name={user.name} className="size-8 rounded-lg" />
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{user.name}</span>
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col">
            <span className="font-medium">{user.name}</span>
            <span className="text-xs text-muted-foreground">{user.email}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`/${slug}/settings/general`}>
            <Globe /> Workspace settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/${slug}/settings/members`}>
            <Users /> Members & access
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/${slug}/settings/teams`}>
            <Workflow /> Teams & workflows
          </Link>
        </DropdownMenuItem>
        {can("tasks") && (
          <DropdownMenuItem asChild>
            <Link href={`/${slug}/settings/labels`}>
              <Tag /> Labels
            </Link>
          </DropdownMenuItem>
        )}
        {can("accounting") && (viewer.role === "owner" || viewer.role === "admin") && (
          <DropdownMenuItem asChild>
            <Link href={`/${slug}/settings/accounting`}>
              <Landmark /> Accounting connections
            </Link>
          </DropdownMenuItem>
        )}
        {can("calendar") && (
          <DropdownMenuItem asChild>
            <Link href={`/${slug}/settings/calendars`}>
              <CalendarCog /> Connected calendars
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/${slug}/settings/api-tokens`}>
            <KeyRound /> API tokens
          </Link>
        </DropdownMenuItem>
        {can("assistant") && (
          <DropdownMenuItem asChild>
            <Link href={`/${slug}/settings/assistant`}>
              <Sparkles /> Assistant
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/${slug}/settings/api-access`}>
            <ShieldCheck /> API access
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoon /> Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {desktop && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => window.location.reload()}>
              <RefreshCw /> Reload
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                window.location.href = "knotworking-desktop://change-server";
              }}
            >
              <MonitorCog /> Change server…
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={async () => {
            await authClient.signOut();
            router.replace("/login");
            router.refresh();
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
