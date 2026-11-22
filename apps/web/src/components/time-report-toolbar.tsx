"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";
import { useWorkspace } from "@/lib/workspace-store";
import { csvDownloadPath, filtersToSearch, type ReportFilters } from "@/lib/time-report";
import { TimeReportFilters } from "./time-report-filters";

/**
 * The report's filters wired to the workspace (project, team and member lists) and the URL: every
 * change navigates to the same page with new search params, so the server renders the new report
 * and the address can be shared or reloaded.
 */
export function TimeReportToolbar({ filters }: { filters: ReportFilters }) {
  const { slug, idx } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const options = useMemo(
    () => ({
      projects: idx.boot.projects.map((p) => ({ id: p.id, name: p.name })),
      teams: idx.boot.teams.map((t) => ({ id: t.id, name: t.name })),
      people: idx.boot.users
        .map((u) => ({ id: u.id, name: u.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }),
    [idx],
  );

  return (
    <div aria-busy={pending} className={pending ? "opacity-70 transition-opacity" : undefined}>
      <TimeReportFilters
        filters={filters}
        options={options}
        exportHref={csvDownloadPath(slug, filters)}
        onChange={(next) => {
          const search = filtersToSearch(next);
          startTransition(() => router.replace(search ? `${pathname}?${search}` : pathname));
        }}
      />
    </div>
  );
}
