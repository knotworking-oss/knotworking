import { formatUkDate, samplingPointKindLabels } from "@knotworking/core";
import { Card } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TestPlanDueBadge } from "@/components/testing-badges";
import { getSamplingPoints, getTestPlans } from "@/lib/api";
import { TestingNav } from "../testing-nav";

export const metadata: Metadata = { title: "Testing due" };

/** Testing → due: every active sampling plan with when its next sample is due, soonest first. */
export default async function TestingDuePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [{ plans }, { points }] = await Promise.all([getTestPlans(slug), getSamplingPoints(slug)]);
  const kindOf = new Map(points.map((p) => [p.id, p.kind]));
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Testing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
          <TestingNav slug={slug} />
          <h2 className="text-xl font-semibold tracking-tight">Due</h2>
          {plans.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              No sampling plans yet. Add them under Setup.
            </p>
          ) : (
            <Card className="overflow-x-auto py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Plan</TableHead>
                    <TableHead>Samples</TableHead>
                    <TableHead>Every</TableHead>
                    <TableHead>Last sampled</TableHead>
                    <TableHead>Next due</TableHead>
                    <TableHead className="pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="pl-4">
                        <div className="font-medium">{p.name}</div>
                        {p.rationale && (
                          <div className="max-w-sm text-xs whitespace-normal text-muted-foreground">
                            {p.rationale}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {p.item
                          ? `Lots of ${p.item.code} ${p.item.name}`
                          : p.samplingPoint
                            ? `${p.samplingPoint.code} ${p.samplingPoint.name} · ${samplingPointKindLabels[kindOf.get(p.samplingPoint.id) ?? "other"]}`
                            : "—"}
                        <div className="text-xs text-muted-foreground">
                          {p.analytes.length
                            ? p.analytes.map((a) => a.name).join(", ")
                            : "The approved specification"}
                        </div>
                      </TableCell>
                      <TableCell>{p.frequencyDays} days</TableCell>
                      <TableCell>{p.lastSampledOn ? formatUkDate(p.lastSampledOn) : "Never"}</TableCell>
                      <TableCell>{formatUkDate(p.nextDueOn)}</TableCell>
                      <TableCell className="pr-4">
                        <TestPlanDueBadge state={p.state} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
