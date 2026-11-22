"use client";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@knotworking/ui/components/command";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import type { WorkflowStateType } from "@knotworking/core";
import {
  CalendarDays,
  CheckCheck,
  ClipboardList,
  CircleDot,
  Clock8,
  FileText,
  FolderKanban,
  GraduationCap,
  IdCard,
  Inbox,
  Keyboard,
  Moon,
  CookingPot,
  Package,
  Palette,
  SquarePen,
  Sun,
  TrendingUp,
  Truck,
  Warehouse,
  Factory,
  ShieldCheck,
  Bug,
  Network,
  ClipboardCheck,
  FileCheck,
  FlaskConical,
  ShoppingCart,
  Lightbulb,
  PackagePlus,
  Fence,
  Landmark,
  LayoutDashboard,
  MessageSquareWarning,
  Coins,
  Calculator,
  Tag,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useContentSearch } from "@/lib/content-search";
import { areaHref, visibleAreas, type NavAccess } from "@/lib/sidebar-nav";
import { useWorkspace } from "@/lib/workspace-store";
import { useNewTask } from "./new-task-dialog";
import { SearchHighlight } from "./search-highlight";
import { useShortcutsHelp } from "./shortcuts-help";

export interface CommandData {
  slug: string;
  tasks: { id: string; title: string; stateType: WorkflowStateType }[];
  documents: { id: string; title: string; icon: string | null }[];
  teams: { key: string; name: string; icon: string | null }[];
}

const Ctx = createContext<{ open: boolean; setOpen: (open: boolean) => void }>({
  open: false,
  setOpen: () => {},
});
export const useCommandMenu = () => useContext(Ctx);

/** ⌘K command menu: jump to any task, doc, team or page. */
export function CommandMenuProvider({ data, children }: { data: CommandData; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const { canEdit, can, modules } = useWorkspace();
  const newTask = useNewTask();
  const shortcutsHelp = useShortcutsHelp();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Start every opening with an empty search.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Matches inside doc and task bodies come from the server (debounced); titles are filtered locally.
  const content = useContentSearch({ slug: data.slug, query, enabled: open });

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const base = `/${data.slug}`;
  const access: NavAccess = { can, canEdit, isActive: (id) => modules.some((m) => m.id === id) };

  async function markAllRead() {
    setOpen(false);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].notifications["read-all"].$post({ param: { slug: data.slug } }),
      );
      toast.success("All notifications marked as read");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Ctx.Provider value={{ open, setOpen }}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search Knotworking"
        description="Jump to a task, doc or page"
      >
        <Command>
          <CommandInput placeholder="Search tasks, docs, teams…" value={query} onValueChange={setQuery} />
          <CommandList>
            {content.hits.length === 0 && (
              <CommandEmpty>{content.pending ? "Searching…" : "No results found."}</CommandEmpty>
            )}
            {content.hits.length > 0 && (
              <>
                {/* forceMount: the server already matched these, so cmdk's title filter must not hide them. */}
                <CommandGroup heading="Content matches" forceMount>
                  {content.hits.map((item) => (
                    <CommandItem
                      key={`${item.kind}-${item.hit.id}`}
                      value={`content ${item.kind} ${item.hit.id}`}
                      forceMount
                      onSelect={() =>
                        go(`${base}/${item.kind === "document" ? "docs" : "task"}/${item.hit.id}`)
                      }
                    >
                      {item.kind === "document" ? (
                        <span className="w-4 text-center">{item.hit.icon ?? "📄"}</span>
                      ) : (
                        <CircleDot />
                      )}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">
                          {item.hit.title ? (
                            <SearchHighlight text={item.hit.title} ranges={item.hit.titleMatches} />
                          ) : (
                            "Untitled"
                          )}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          <SearchHighlight text={item.hit.snippet} ranges={item.hit.snippetMatches} />
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading="Inbox">
              <CommandItem value="mark all notifications as read" onSelect={() => void markAllRead()}>
                <CheckCheck /> Mark all notifications as read
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            {canEdit && can("tasks", "write") && (
              <>
                <CommandGroup heading="Actions">
                  <CommandItem
                    onSelect={() => {
                      setOpen(false);
                      // Let the command dialog close (and return focus) before the next one opens.
                      setTimeout(() => newTask(), 0);
                    }}
                  >
                    <SquarePen /> Create new task
                    <CommandShortcut>C</CommandShortcut>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading="Switch module">
              {visibleAreas(access).map((area) => {
                const Icon = area.icon;
                return (
                  <CommandItem
                    key={area.id}
                    value={`module ${area.label} ${area.description} ${(area.keywords ?? []).join(" ")}`}
                    onSelect={() => go(areaHref(area, data.slug, access))}
                  >
                    <Icon /> {area.label}
                    <CommandShortcut>Module</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Navigate">
              <CommandItem onSelect={() => go(`${base}/inbox`)}>
                <Inbox /> Inbox
              </CommandItem>
              {can("tasks") && (
                <CommandItem onSelect={() => go(`${base}/my-tasks`)}>
                  <CircleDot /> My tasks
                </CommandItem>
              )}
              {can("tasks") && (
                <CommandItem onSelect={() => go(`${base}/projects`)}>
                  <FolderKanban /> Projects
                </CommandItem>
              )}
              {can("calendar") && (
                <CommandItem onSelect={() => go(`${base}/calendar`)}>
                  <CalendarDays /> Calendar
                </CommandItem>
              )}
              {can("docs") && (
                <CommandItem onSelect={() => go(`${base}/docs`)}>
                  <FileText /> Docs
                </CommandItem>
              )}
              {canEdit && (
                <CommandItem onSelect={() => go(`${base}/org-chart`)}>
                  <Network /> Org chart
                </CommandItem>
              )}
              {can("items") && (
                <>
                  <CommandItem onSelect={() => go(`${base}/items`)}>
                    <Package /> Items
                  </CommandItem>
                  <CommandItem onSelect={() => go(`${base}/suppliers`)}>
                    <Truck /> Suppliers
                  </CommandItem>
                  {can("recipes") && (
                    <CommandItem onSelect={() => go(`${base}/recipes`)}>
                      <CookingPot /> Recipes
                    </CommandItem>
                  )}
                  {can("labels") && (
                    <>
                      <CommandItem onSelect={() => go(`${base}/labels`)}>
                        <Tag /> Product labels
                      </CommandItem>
                      <CommandItem onSelect={() => go(`${base}/labels/nutrition`)}>
                        <Tag /> Ingredient nutrition
                      </CommandItem>
                    </>
                  )}
                  {can("specifications") && (
                    <CommandItem onSelect={() => go(`${base}/specifications`)}>
                      <FileCheck /> Specifications
                    </CommandItem>
                  )}
                  {can("testing") && (
                    <CommandItem onSelect={() => go(`${base}/testing`)}>
                      <FlaskConical /> Testing
                    </CommandItem>
                  )}
                  {can("npd") && (
                    <CommandItem onSelect={() => go(`${base}/npd`)}>
                      <PackagePlus /> Product development
                    </CommandItem>
                  )}
                </>
              )}
              {can("stock") && (
                <CommandItem onSelect={() => go(`${base}/stock`)}>
                  <Warehouse /> Stock
                </CommandItem>
              )}
              {can("purchasing") && (
                <>
                  <CommandItem onSelect={() => go(`${base}/purchasing`)}>
                    <ShoppingCart /> Purchase orders
                  </CommandItem>
                  {can("production") && (
                    <CommandItem onSelect={() => go(`${base}/purchasing/suggestions`)}>
                      <Lightbulb /> Purchase suggestions
                    </CommandItem>
                  )}
                  <CommandItem onSelect={() => go(`${base}/purchasing/suppliers`)}>
                    <Truck /> Supplier performance
                  </CommandItem>
                </>
              )}
              {can("demand") && (
                <CommandItem onSelect={() => go(`${base}/demand`)}>
                  <TrendingUp /> Demand
                </CommandItem>
              )}
              {can("production") && (
                <CommandItem onSelect={() => go(`${base}/production`)}>
                  <Factory /> Production
                </CommandItem>
              )}
              {can("costing") && (
                <>
                  <CommandItem onSelect={() => go(`${base}/costing`)}>
                    <Coins /> Standard against actual
                  </CommandItem>
                  <CommandItem onSelect={() => go(`${base}/costing/batches`)}>
                    <Calculator /> Batch costs
                  </CommandItem>
                </>
              )}
              {can("haccp") && (
                <CommandItem onSelect={() => go(`${base}/haccp`)}>
                  <ShieldCheck /> Food safety
                </CommandItem>
              )}
              {can("site") && (
                <CommandItem onSelect={() => go(`${base}/site`)}>
                  <Bug /> Site programmes
                </CommandItem>
              )}
              {can("quality") && (
                <CommandItem onSelect={() => go(`${base}/quality`)}>
                  <ClipboardCheck /> Quality
                </CommandItem>
              )}
              {can("defence") && (
                <CommandItem onSelect={() => go(`${base}/defence`)}>
                  <Fence /> Food defence
                </CommandItem>
              )}
              {can("bi") && (
                <CommandItem onSelect={() => go(`${base}/dashboards`)}>
                  <LayoutDashboard /> Dashboards
                </CommandItem>
              )}
              {can("governance") && (
                <CommandItem onSelect={() => go(`${base}/governance`)}>
                  <Landmark /> Management review
                </CommandItem>
              )}
              {modules.some((m) => m.id === "governance") && (
                <CommandItem onSelect={() => go(`${base}/concerns`)}>
                  <MessageSquareWarning /> Raise a confidential concern
                </CommandItem>
              )}
              {can("sops") && (
                <CommandItem onSelect={() => go(`${base}/sops`)}>
                  <ClipboardList /> SOPs
                </CommandItem>
              )}
              {can("people") && (
                <CommandItem onSelect={() => go(`${base}/people`)}>
                  <IdCard /> People
                </CommandItem>
              )}
              {can("attendance") && (
                <CommandItem onSelect={() => go(`${base}/attendance`)}>
                  <Clock8 /> Attendance
                </CommandItem>
              )}
              {can("training") && (
                <CommandItem onSelect={() => go(`${base}/training`)}>
                  <GraduationCap /> Training
                </CommandItem>
              )}
              {(can("tasks") ? data.teams : []).map((t) => (
                <CommandItem key={t.key} onSelect={() => go(`${base}/team/${t.key}`)}>
                  <span className="w-4 text-center">{t.icon}</span> {t.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Tasks">
              {data.tasks.map((i) => (
                <CommandItem
                  key={i.id}
                  value={`task ${i.id} ${i.title}`}
                  keywords={[i.title]}
                  onSelect={() => go(`${base}/task/${i.id}`)}
                >
                  <StatusIcon type={i.stateType} />
                  <span className="truncate">{i.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Docs">
              {data.documents.map((d) => (
                <CommandItem key={d.id} value={`doc ${d.title}`} onSelect={() => go(`${base}/docs/${d.id}`)}>
                  <span className="w-4 text-center">{d.icon ?? "📄"}</span> {d.title || "Untitled"}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Preferences">
              <CommandItem
                onSelect={() => (setTheme(resolvedTheme === "dark" ? "light" : "dark"), setOpen(false))}
              >
                {resolvedTheme === "dark" ? <Sun /> : <Moon />} Toggle theme
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  // Let the command dialog close (and return focus) before the next one opens.
                  setTimeout(shortcutsHelp.show, 0);
                }}
              >
                <Keyboard /> Keyboard shortcuts
                <CommandShortcut>?</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => go("/design")}>
                <Palette /> Design system
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </Ctx.Provider>
  );
}
