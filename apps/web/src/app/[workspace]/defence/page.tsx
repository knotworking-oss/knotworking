import { defenceControlKindLabels, formatUkDate } from "@knotworking/core";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import type { Metadata } from "next";
import Link from "next/link";
import { DefenceDueBadge } from "@/components/defence-badges";
import { PageHeader } from "@/components/page-header";
import { getDefenceOverview } from "@/lib/api";
import { DefenceFrame } from "./defence-nav";
import { VisitorsOnSite } from "./visitors-on-site";

export const metadata: Metadata = { title: "Food defence" };

function Stat({ label, value, alert }: { label: string; value: number | string; alert?: boolean }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div className={`text-2xl font-semibold tabular-nums ${alert ? "text-destructive" : ""}`}>
          {value}
        </div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

/** "every day", "every 7 days". */
const everyDays = (n: number) => (n === 1 ? "every day" : `every ${n} days`);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

/** Food defence → overview: what is overdue, failed or due for review. */
export default async function DefenceOverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const o = await getDefenceOverview(slug);
  const base = `/${slug}/defence`;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Food defence</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DefenceFrame slug={slug} title="Overview">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat
              label="Controls overdue or never checked"
              value={o.counts.overdueControls}
              alert={o.counts.overdueControls > 0}
            />
            <Stat
              label="Failed checks open"
              value={o.counts.openFailures}
              alert={o.counts.openFailures > 0}
            />
            <Stat label="Assessments" value={o.counts.assessments} />
            <Stat label="High-rated threats" value={o.counts.highThreats} />
            <Stat
              label={
                o.lastExercise
                  ? `Exercise · last ${formatUkDate(o.lastExercise.heldOn)}, next by ${formatUkDate(o.exerciseDueOn)}`
                  : "Exercise · none recorded yet"
              }
              value={o.exerciseOverdue ? "Due" : "Up to date"}
              alert={o.exerciseOverdue}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Controls to check</CardTitle>
              </CardHeader>
              <CardContent>
                {o.controlsDue.length === 0 ? (
                  <Empty>Every control is up to date.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {o.controlsDue.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3">
                        <div>
                          <Link href={`${base}/controls`} className="font-medium hover:underline">
                            {c.name}
                          </Link>
                          <div className="text-muted-foreground">
                            {defenceControlKindLabels[c.kind]}
                            {c.area ? ` · ${c.area}` : ""} · {everyDays(c.frequencyDays)}
                            {c.lastCheckedOn ? ` · last ${formatUkDate(c.lastCheckedOn)}` : ""}
                          </div>
                        </div>
                        <DefenceDueBadge status={c.dueStatus} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Failed checks</CardTitle>
              </CardHeader>
              <CardContent>
                {o.openFailures.length === 0 ? (
                  <Empty>No failed checks are open.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {o.openFailures.map((f) => (
                      <li key={f.id}>
                        <span className="font-medium">{f.controlName}</span>{" "}
                        <span className="text-muted-foreground">· {formatUkDate(f.checkedOn)}</span>
                        <div className="text-muted-foreground">{f.notes}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Assessments to review</CardTitle>
              </CardHeader>
              <CardContent>
                {o.assessmentsDue.length === 0 ? (
                  <Empty>Every assessment is within its review date.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {o.assessmentsDue.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-3">
                        <div>
                          <Link href={`${base}/assessments/${a.id}`} className="font-medium hover:underline">
                            {a.title}
                          </Link>
                          <div className="text-muted-foreground">
                            {a.approvedVersion
                              ? `v${a.approvedVersion} · review by ${a.reviewDueOn ? formatUkDate(a.reviewDueOn) : "—"}`
                              : "Never approved"}
                          </div>
                        </div>
                        <DefenceDueBadge status={a.reviewStatus} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            {o.visitors && (
              <Card>
                <CardHeader>
                  <CardTitle>Visitors on site</CardTitle>
                </CardHeader>
                <CardContent>
                  <VisitorsOnSite visitors={o.visitors.onSite} />
                </CardContent>
              </Card>
            )}
          </div>
        </DefenceFrame>
      </div>
    </>
  );
}
