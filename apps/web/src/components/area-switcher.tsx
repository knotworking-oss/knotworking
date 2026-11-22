"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@knotworking/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@knotworking/ui/components/popover";
import { SidebarMenuButton } from "@knotworking/ui/components/sidebar";
import { ChevronsUpDown, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { WorkspaceAvatar } from "./workspace-avatar";
import { areaHref, groupAreas, type NavAccess, type NavArea } from "@/lib/sidebar-nav";

/**
 * The workspace header of the sidebar. Clicking it lists the modules the viewer can use; picking
 * one switches the sidebar to that module's sections and opens its first page. The star sets a
 * module as the one the workspace opens on.
 */
export function AreaSwitcher({
  slug,
  workspaceName,
  workspaceIcon,
  areas,
  current,
  access,
  defaultAreaId,
  onSetDefault,
}: {
  slug: string;
  workspaceName: string;
  workspaceIcon?: string | null;
  areas: NavArea[];
  current: NavArea;
  access: NavAccess;
  defaultAreaId: string | null;
  onSetDefault: (id: string | null) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const CurrentIcon = current.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarMenuButton
          size="lg"
          tooltip={`${workspaceName}: ${current.label}`}
          className="data-[state=open]:bg-sidebar-accent"
          aria-label={`${workspaceName}, showing ${current.label}. Switch module`}
        >
          <WorkspaceAvatar name={workspaceName} icon={workspaceIcon} />
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">{workspaceName}</span>
            <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              <CurrentIcon className="size-3 shrink-0" />
              <span className="truncate">{current.label}</span>
            </span>
          </div>
          <ChevronsUpDown className="ml-auto" />
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-80 gap-0 p-0">
        {/* Substring match: cmdk's fuzzy scoring pulls in unrelated modules from the descriptions. */}
        <Command
          filter={(value, search) => (value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Find a module…" />
          <CommandList className="max-h-96">
            <CommandEmpty>No module found.</CommandEmpty>
            {groupAreas(areas).map(({ group, areas: inGroup }) => (
              <CommandGroup key={group} heading={group}>
                {inGroup.map((area) => {
                  const Icon = area.icon;
                  const isDefault = area.id === defaultAreaId;
                  return (
                    <CommandItem
                      key={area.id}
                      value={`${area.label} ${area.description} ${(area.keywords ?? []).join(" ")}`}
                      data-checked={area.id === current.id}
                      onSelect={() => {
                        setOpen(false);
                        router.push(areaHref(area, slug, access));
                      }}
                    >
                      <Icon />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{area.label}</span>
                        <span className="truncate text-xs text-muted-foreground">{area.description}</span>
                      </span>
                      <button
                        type="button"
                        // Selecting the row navigates; the star only sets the default.
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetDefault(isDefault ? null : area.id);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        aria-label={
                          isDefault
                            ? `${area.label} is your default module. Click to clear it`
                            : `Set ${area.label} as your default module`
                        }
                        aria-pressed={isDefault}
                        title={isDefault ? "Your default module" : "Set as default"}
                        className="pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        <Star className={isDefault ? "size-3.5 fill-current text-foreground" : "size-3.5"} />
                      </button>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          Star a module to open it by default.
        </p>
      </PopoverContent>
    </Popover>
  );
}
