"use client";

import { nonconformanceSourceLabels } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { NonconformanceStatusBadge, SeverityBadge } from "@/components/quality-badges";
import { stackedTable } from "@/components/stacked-table";
import type { NonconformanceRow } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import type { ItemOption, MemberOption } from "../quality-forms";
import { NonconformanceDialog } from "./nonconformance-dialog";

export type NcFilter = "unresolved" | "open" | "action_taken" | "overdue" | "closed" | "all";

const filterLabels: Record<NcFilter, string> = {
  unresolved: "Unresolved",
  open: "Open",
  action_taken: "To verify",
  overdue: "Overdue",
  closed: "Closed",
  all: "All",
};

/** The non-conformance (CAPA) register. */
export function NonconformancesBoard({
  slug,
  status,
  q,
  auditId,
  nonconformances,
  total,
  items,
  members,
}: {
  slug: string;
  status: NcFilter;
  q: string;
  /** Showing one audit's findings. */
  auditId?: string | undefined;
  nonconformances: NonconformanceRow[];
  total: number;
  items: ItemOption[];
  members: MemberOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [raising, setRaising] = useState(false);
  const [search, setSearch] = useState(q);
  const go = (next: { status?: NcFilter }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    if (auditId) params.set("audit", auditId);
    if (s !== (auditId ? "all" : "unresolved")) params.set("status", s);
    if (search.trim()) params.set("q", search.trim());
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {auditId
              ? `Findings of ${nonconformances[0]?.audit?.reference ?? "an audit"}`
              : "Non-conformances"}
          </h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        {can("quality", "write") && (
          <Button onClick={() => setRaising(true)}>
            <Plus data-icon="inline-start" /> Raise non-conformance
          </Button>
        )}
      </div>
      {auditId && (
        <Link
          href={`/${slug}/quality/nonconformances`}
          className="text-sm underline-offset-4 hover:underline"
        >
          Show every non-conformance
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={(v) => go({ status: v as NcFilter })}>
          <TabsList className="max-w-full overflow-x-auto">
            {(Object.keys(filterLabels) as NcFilter[]).map((f) => (
              <TabsTrigger key={f} value={f}>
                {filterLabels[f]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <form
          className="min-w-48 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go({});
          }}
        >
          <Input
            type="search"
            aria-label="Search non-conformances"
            placeholder="Search reference, title, description"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>
      {nonconformances.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {status === "unresolved" && !q ? "No unresolved non-conformances." : "Nothing matches."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Reference</TableHead>
                <TableHead>Raised</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nonconformances.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="pl-4" data-label="Reference">
                    <Link
                      href={`/${slug}/quality/nonconformances/${n.id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {n.reference}
                    </Link>
                    <div className="line-clamp-1 max-w-72">{n.title}</div>
                  </TableCell>
                  <TableCell data-label="Raised">{formatLongDate(n.raisedOn)}</TableCell>
                  <TableCell data-label="Source">
                    {nonconformanceSourceLabels[n.source]}
                    {(n.complaint || n.audit) && (
                      <div className="font-mono text-xs text-muted-foreground">
                        {n.complaint?.reference ?? n.audit?.reference}
                      </div>
                    )}
                  </TableCell>
                  <TableCell data-label="Owner">{n.owner?.name ?? "—"}</TableCell>
                  <TableCell data-label="Due">{n.dueOn ? formatLongDate(n.dueOn) : "—"}</TableCell>
                  <TableCell data-label="Severity">
                    <SeverityBadge severity={n.severity} />
                  </TableCell>
                  <TableCell data-label="Status">
                    <NonconformanceStatusBadge status={n.status} overdue={n.overdue} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {raising && (
        <NonconformanceDialog slug={slug} items={items} members={members} onClose={() => setRaising(false)} />
      )}
    </div>
  );
}
