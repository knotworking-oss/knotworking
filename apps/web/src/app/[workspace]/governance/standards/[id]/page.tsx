import type { ClauseAssessmentStatus } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getBootstrap, getGapAnalysis, getGapSnapshots, getWorkspaceToday } from "@/lib/api";
import { GapAnalysisView } from "./gap-analysis";

export const metadata: Metadata = { title: "Gap analysis" };

export default async function GapAnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{
    status?: string;
    section?: string;
    fundamental?: string;
    q?: string;
    evidence?: string;
    drafts?: string;
  }>;
}) {
  const [{ workspace: slug, id }, search] = await Promise.all([params, searchParams]);
  const evidence = (["gap", "conflict", "none"] as const).find((e) => e === search.evidence);
  const query = {
    ...(search.status ? { status: search.status as ClauseAssessmentStatus } : {}),
    ...(search.section ? { section: search.section } : {}),
    ...(search.fundamental === "true" ? { fundamental: "true" as const } : {}),
    ...(search.q ? { q: search.q } : {}),
    ...(evidence ? { evidence } : {}),
    ...(search.drafts === "open" ? { drafts: "open" as const } : {}),
  };
  const [analysis, boot, tasksReadable, today, { snapshots }] = await Promise.all([
    getGapAnalysis(slug, id, query),
    getBootstrap(slug),
    canReadModule(slug, "tasks"),
    getWorkspaceToday(slug),
    getGapSnapshots(slug, id),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <GapAnalysisView
          slug={slug}
          today={today}
          analysis={analysis}
          filters={{
            status: search.status ?? "",
            section: search.section ?? "",
            fundamental: search.fundamental === "true",
            q: search.q ?? "",
            evidence: evidence ?? "",
            drafts: search.drafts === "open",
          }}
          snapshots={snapshots}
          teams={tasksReadable ? boot.teams.map((t) => ({ id: t.id, name: t.name })) : []}
        />
      </div>
    </>
  );
}
