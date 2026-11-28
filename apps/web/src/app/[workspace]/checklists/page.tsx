import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { ChecksBoard } from "@/components/checks-board";
import { getChecklistActions, getGeneralChecklistChecks, getGeneralChecklistTemplates } from "@/lib/api";
import { ChecklistFollowUps } from "./follow-ups";

export const metadata: Metadata = { title: "Checklists" };

function offsetOf(value: string | undefined, size: number) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 1_000_000) * size : 0;
}

export default async function ChecklistsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ history?: string; followups?: string; status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = search.status === "all" ? "all" : "open";
  const [templates, history, followUps] = await Promise.all([
    getGeneralChecklistTemplates(slug),
    getGeneralChecklistChecks(slug, offsetOf(search.history, 50)),
    getChecklistActions(slug, offsetOf(search.followups, 25), status),
  ]);

  function pageHref(group: "history" | "followups", page: number, nextStatus = status) {
    const query = new URLSearchParams();
    const historyPage = group === "history" ? page : history.offset / history.limit;
    const followUpPage = group === "followups" ? page : followUps.offset / followUps.limit;
    if (historyPage) query.set("history", String(historyPage));
    if (followUpPage) query.set("followups", String(followUpPage));
    if (nextStatus === "all") query.set("status", "all");
    return `/${slug}/checklists?${query}${group === "followups" ? "#follow-ups" : "#completed-checks"}`;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <ChecksBoard
        slug={slug}
        templates={templates.templates}
        checks={history.checks}
        areas={[]}
        batches={[]}
        general
      />
      <div className="workspace-content space-y-4 pb-8">
        <RecordPages
          offset={history.offset}
          limit={history.limit}
          total={history.total}
          pageHref={(page) => pageHref("history", page)}
        />
        <ChecklistFollowUps
          slug={slug}
          actions={followUps.actions}
          filterHref={pageHref("followups", 0, status === "open" ? "all" : "open")}
          showAll={status === "all"}
        />
        <RecordPages
          offset={followUps.offset}
          limit={followUps.limit}
          total={followUps.total}
          pageHref={(page) => pageHref("followups", page)}
        />
      </div>
    </div>
  );
}

function RecordPages({
  offset,
  limit,
  total,
  pageHref,
}: {
  offset: number;
  limit: number;
  total: number;
  pageHref: (page: number) => string;
}) {
  const page = offset / limit;
  if (page === 0 && total <= limit) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-sm text-muted-foreground">
        {total ? Math.min(offset + 1, total) : 0}–{Math.min(offset + limit, total)} of {total}
      </span>
      {page > 0 && (
        <Button asChild variant="outline" size="sm">
          <Link href={pageHref(page - 1)}>Previous</Link>
        </Button>
      )}
      {offset + limit < total && (
        <Button asChild variant="outline" size="sm">
          <Link href={pageHref(page + 1)}>Next</Link>
        </Button>
      )}
    </div>
  );
}
