"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOptionalWorkspace } from "@/lib/workspace-store";

const sections = [
  ["", "What's due"],
  ["/pest", "Pest control"],
  ["/glass", "Glass"],
  ["/maintenance", "Maintenance"],
  ["/storage", "Storage temperatures"],
  ["/checks", "Pre-start checks"],
  ["/records", "Audit records"],
] as const;

/** How many things wait for a person, per section (managers sign these off). */
export type SiteNavCounts = Partial<Record<(typeof sections)[number][0], number>>;

/**
 * The site programme pages, in the page header. Each tab shows how many things wait for a person
 * with manage access (readings to review, checks to sign off, clearances to give, areas to
 * release); the counts are only shown to people who can act on them.
 */
export function SiteNav({ slug, waiting = {} }: { slug: string; waiting?: SiteNavCounts }) {
  const pathname = usePathname();
  // Outside a workspace (the design page) the full navigation is shown.
  const workspace = useOptionalWorkspace();
  const base = `/${slug}/site`;
  return (
    <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Site programmes">
      <span className="mr-2 shrink-0 font-medium">Site</span>
      {sections.map(([path, label]) => {
        const isMaintenance = path === "/maintenance";
        if (path === "/checks" && workspace && !workspace.can("checklists")) return null;
        if (isMaintenance && workspace && !workspace.can("maintenance")) return null;
        const href = isMaintenance ? `/${slug}/maintenance` : `${base}${path}`;
        const canManage = workspace?.can(isMaintenance ? "maintenance" : "site", "manage") ?? true;
        const active = path === "" ? pathname === base : pathname.startsWith(href);
        const count = canManage ? (waiting[path] ?? 0) : 0;
        return (
          <Button key={path} asChild size="sm" variant={active ? "secondary" : "ghost"}>
            <Link href={href} aria-current={active ? "page" : undefined}>
              {label}
              {count > 0 && (
                <Badge
                  className="border-transparent bg-label-yellow-bg text-label-yellow tabular-nums"
                  aria-label={`${count} waiting for a person`}
                >
                  {count}
                </Badge>
              )}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
