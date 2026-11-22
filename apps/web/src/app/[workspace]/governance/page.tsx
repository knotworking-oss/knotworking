import { formatUkDate } from "@knotworking/core";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import type { Metadata } from "next";
import Link from "next/link";
import {
  GovernanceComplianceBadge,
  GovernanceCultureBadge,
  GovernanceDueBadge,
  GovernanceRagBadge,
} from "@/components/governance-badges";
import { PageHeader } from "@/components/page-header";
import { getGovernanceOverview } from "@/lib/api";
import { GovernanceFrame } from "./governance-nav";

export const metadata: Metadata = { title: "Management review" };

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

/** Management review → overview: what needs attention before the next review. */
export default async function GovernanceOverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const o = await getGovernanceOverview(slug);
  const base = `/${slug}/governance`;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Management review</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <GovernanceFrame slug={slug} title="Overview">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="gap-1 py-4">
              <CardContent className="px-4">
                <div className="text-sm text-muted-foreground">Last signed review</div>
                {o.lastSignedReview ? (
                  <Link
                    href={`${base}/reviews/${o.lastSignedReview.id}`}
                    className="font-medium hover:underline"
                  >
                    {o.lastSignedReview.title}
                  </Link>
                ) : (
                  <div className="font-medium">None yet</div>
                )}
                {o.lastSignedReview?.heldOn && (
                  <div className="text-sm text-muted-foreground">
                    Held {formatUkDate(o.lastSignedReview.heldOn)}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card className="gap-1 py-4">
              <CardContent className="px-4">
                <div className="text-sm text-muted-foreground">Draft reviews</div>
                {o.draftReviews.length === 0 ? (
                  <div className="font-medium">None</div>
                ) : (
                  o.draftReviews.map((r) => (
                    <div key={r.id}>
                      <Link href={`${base}/reviews/${r.id}`} className="font-medium hover:underline">
                        {r.title}
                      </Link>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
            {o.openConcerns !== null && (
              <Card className="gap-1 py-4">
                <CardContent className="px-4">
                  <div
                    className={`text-2xl font-semibold tabular-nums ${o.openConcerns ? "text-destructive" : ""}`}
                  >
                    {o.openConcerns}
                  </div>
                  <Link href={`${base}/concerns`} className="text-sm text-muted-foreground hover:underline">
                    Confidential concerns open
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Objectives needing attention</CardTitle>
              </CardHeader>
              <CardContent>
                {o.objectivesNeedingAttention.length === 0 ? (
                  <Empty>Every open objective is on track and in date.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {o.objectivesNeedingAttention.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`${base}/objectives`} className="font-medium hover:underline">
                          {x.title}
                        </Link>
                        <span className="flex gap-1">
                          {x.latest && <GovernanceRagBadge rag={x.latest.rag} />}
                          <GovernanceDueBadge status={x.dueStatus} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Culture plan</CardTitle>
              </CardHeader>
              <CardContent>
                {o.cultureOverdue.length + o.cultureUpcoming.length === 0 ? (
                  <Empty>Nothing overdue or planned.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {[...o.cultureOverdue, ...o.cultureUpcoming].map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <span className="font-medium">{a.title}</span>{" "}
                          <span className="text-muted-foreground">· {formatUkDate(a.plannedOn)}</span>
                        </span>
                        <GovernanceCultureBadge state={a.state} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Requirements to review</CardTitle>
              </CardHeader>
              <CardContent>
                {o.requirementsDue.length === 0 ? (
                  <Empty>Every requirement is assessed, compliant and within its review date.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {o.requirementsDue.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <Link href={`${base}/requirements`} className="font-medium hover:underline">
                            {r.title}
                          </Link>
                          {r.reference && <span className="text-muted-foreground"> · {r.reference}</span>}
                        </span>
                        <span className="flex gap-1">
                          <GovernanceComplianceBadge status={r.compliance} />
                          <GovernanceDueBadge status={r.reviewStatus} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </GovernanceFrame>
      </div>
    </>
  );
}
