"use client";

import { clauseAssessmentLabels, openFindingStatuses } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Download, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { GapSnapshot } from "@/lib/api";
import { GovernanceFrame } from "../../../../governance-nav";
import { EvidenceList, StatusBadge } from "../../gap-analysis";

/**
 * A frozen gap analysis (G3): every clause as it stood when the snapshot was taken, never edited,
 * with what has changed since. Evidence from modules the viewer can't read is hidden by the API.
 */
export function SnapshotView({
  slug,
  standardId,
  view,
}: {
  slug: string;
  standardId: string;
  view: GapSnapshot;
}) {
  const { snapshot, standard, summary, changesSince, clauses } = view;
  const changed = changesSince.status.length + changesSince.added.length + changesSince.removed.length;
  return (
    <GovernanceFrame
      slug={slug}
      title={snapshot.label}
      description={`${standard.name} (issue ${standard.issue}) as it stood on ${snapshot.takenOn}${snapshot.takenByName ? `, taken by ${snapshot.takenByName}` : ""}`}
      actions={
        <Button variant="outline" asChild>
          <a href={`/api/v1/workspaces/${slug}/governance/snapshots/${snapshot.id}/report.csv`}>
            <Download data-icon="inline-start" /> CSV
          </a>
        </Button>
      }
    >
      <Link
        href={`/${slug}/governance/standards/${standardId}`}
        className="w-fit text-sm text-muted-foreground hover:underline"
      >
        ← Live gap analysis
      </Link>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Assessed"
          value={`${summary.assessed} of ${summary.total} (${summary.assessedPercent}%)`}
        />
        <Stat label="Open findings" value={String(summary.openFindings)} />
        <Stat
          label="Overdue findings"
          value={String(summary.overdueFindings)}
          warn={summary.overdueFindings > 0}
        />
        <Stat
          label="Fundamentals at risk"
          value={String(summary.fundamentalAtRisk.length)}
          warn={summary.fundamentalAtRisk.length > 0}
        />
        <Stat
          label="Evidence gaps"
          value={String(summary.evidenceGaps.length)}
          warn={summary.evidenceGaps.length > 0}
        />
        <Stat
          label="Conflicts"
          value={String(summary.conflicts.length)}
          warn={summary.conflicts.length > 0}
        />
      </dl>
      {summary.conflicts.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="size-4" />
          Assessed compliant, but the evidence showed a gap: {summary.conflicts.join(", ")}
        </p>
      )}

      <section className="flex flex-col gap-2 rounded-md border px-4 py-3 text-sm">
        <h3 className="font-medium">Changed since</h3>
        {changed === 0 ? (
          <p className="text-muted-foreground">Nothing: every clause's status is as it was.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {changesSince.status.map((c) => (
              <li key={c.ref}>
                <span className="font-mono text-xs">{c.ref}</span> {c.title}: {clauseAssessmentLabels[c.then]}{" "}
                → <span className="font-medium">{clauseAssessmentLabels[c.now]}</span>
              </li>
            ))}
            {changesSince.added.length > 0 && <li>Clauses added: {changesSince.added.join(", ")}</li>}
            {changesSince.removed.length > 0 && <li>Clauses removed: {changesSince.removed.join(", ")}</li>}
          </ul>
        )}
      </section>

      <ul className="flex flex-col gap-2">
        {clauses.map((c) => (
          <li key={c.id} className="flex flex-col gap-1 rounded-md border px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{c.ref}</span>
              <span className="font-medium">{c.title}</span>
              {c.fundamental && <Badge variant="outline">Fundamental</Badge>}
              <StatusBadge status={c.status} />
              {c.conflict && (
                <Badge className="border-transparent bg-label-red-bg text-label-red">
                  Evidence contradicted
                </Badge>
              )}
            </div>
            {c.assessment?.note && <p className="text-muted-foreground">{c.assessment.note}</p>}
            {c.assessment && openFindingStatuses.includes(c.status) && (
              <p className={c.assessment.overdue ? "text-destructive" : "text-muted-foreground"}>
                {c.assessment.ownerName ?? "No owner"} · due {c.assessment.dueOn}
                {c.assessment.overdue && " (overdue)"}
              </p>
            )}
            {c.evidence.length > 0 && <EvidenceList evidence={c.evidence} />}
          </li>
        ))}
      </ul>
    </GovernanceFrame>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium tabular-nums ${warn ? "text-destructive" : ""}`}>{value}</dd>
    </div>
  );
}
