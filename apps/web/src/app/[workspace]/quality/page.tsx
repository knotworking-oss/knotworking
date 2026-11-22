import { complaintCategoryLabels, RECALL_TARGET_MINUTES } from "@knotworking/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { RecallResultBadge, RecallScheduleBadge } from "@/components/quality-badges";
import { getQualitySummary } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { QualityNav } from "@/components/quality-nav";

export const metadata: Metadata = { title: "Quality" };

function Stat({ label, value, href, tone }: { label: string; value: number; href: string; tone?: "bad" }) {
  return (
    <Link href={href} className="flex flex-col rounded-lg border px-3 py-2 hover:bg-muted/50">
      <span
        className={
          tone === "bad" && value > 0 ? "text-2xl font-semibold text-destructive" : "text-2xl font-semibold"
        }
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Link>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default async function QualityPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const s = await getQualitySummary(slug);
  const base = `/${slug}/quality`;
  return (
    <>
      <PageHeader actions={<ModuleDashboardsLink module="quality" />}>
        <h1 className="font-medium">Quality</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
          <QualityNav slug={slug} />
          <div className="grid gap-4 md:grid-cols-2">
            <Section
              title="Complaints"
              description={`${s.complaints.receivedLast30Days} received in the last 30 days`}
            >
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Open" value={s.complaints.open} href={`${base}/complaints?status=open`} />
                <Stat
                  label="Investigating"
                  value={s.complaints.investigating}
                  href={`${base}/complaints?status=investigating`}
                />
              </div>
              {s.complaints.byCategoryLast12Months.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1 text-sm">
                  <li className="text-xs text-muted-foreground">By category, last 12 months</li>
                  {s.complaints.byCategoryLast12Months.map((c) => (
                    <li key={c.category} className="flex justify-between">
                      <span>{complaintCategoryLabels[c.category]}</span>
                      <span className="tabular-nums">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section
              title="Non-conformances"
              description="Corrective and preventive action until a manager verifies it"
            >
              <div className="grid grid-cols-3 gap-2">
                <Stat
                  label="Open"
                  value={s.nonconformances.open}
                  href={`${base}/nonconformances?status=open`}
                />
                <Stat
                  label="To verify"
                  value={s.nonconformances.awaitingVerification}
                  href={`${base}/nonconformances?status=action_taken`}
                />
                <Stat
                  label="Overdue"
                  value={s.nonconformances.overdue}
                  href={`${base}/nonconformances?status=overdue`}
                  tone="bad"
                />
              </div>
            </Section>
            <Section
              title="Internal audits"
              description={`${s.audits.completedLast12Months} completed in the last 12 months`}
            >
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Overdue" value={s.audits.overdue} href={`${base}/audits`} tone="bad" />
                <Stat label="In the next 14 days" value={s.audits.soon} href={`${base}/audits`} />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {s.audits.next ? (
                  <>
                    Next: <span className="text-foreground">{s.audits.next.title}</span> on{" "}
                    {formatLongDate(s.audits.next.plannedOn)}
                  </>
                ) : (
                  "Nothing planned."
                )}
              </p>
            </Section>
            <Section
              title="Mock recall"
              description={`A lot traced and fully reconciled within ${RECALL_TARGET_MINUTES / 60} hours, at least once a year`}
            >
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <RecallScheduleBadge state={s.recallTest.state} />
                  {s.recallTest.dueOn && <span>Next due {formatLongDate(s.recallTest.dueOn)}</span>}
                </div>
                {s.recallTest.last ? (
                  <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    Last test {s.recallTest.last.reference} on {formatLongDate(s.recallTest.last.conductedOn)}
                    <RecallResultBadge passed={s.recallTest.last.passed} />
                  </p>
                ) : (
                  <p className="text-muted-foreground">No recall test on record.</p>
                )}
                <Link href={`${base}/recall-tests`} className="text-sm underline-offset-4 hover:underline">
                  Recall tests
                </Link>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </>
  );
}
