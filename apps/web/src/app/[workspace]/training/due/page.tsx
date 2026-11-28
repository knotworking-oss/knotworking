import { staffDisplayName } from "@knotworking/core";
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
import Link from "next/link";
import { stackedTable } from "@/components/stacked-table";
import { PageHeader } from "@/components/page-header";
import { StaffNumber } from "@/components/people-badges";
import { TrainingStatusBadge } from "@/components/training-badges";
import { getPendingSignOffs, getTrainingDue } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { TrainingNav } from "../training-nav";

export const metadata: Metadata = { title: "Training due" };

const WINDOWS = ["30", "60", "90"] as const;

export default async function TrainingDuePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ within?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const within = WINDOWS.find((w) => w === search.within) ?? "30";
  const [due, pending] = await Promise.all([
    getTrainingDue(slug, { withinDays: within }),
    getPendingSignOffs(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Training</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <h2 className="text-xl font-semibold tracking-tight">Training due</h2>
          <TrainingNav slug={slug} pendingCount={pending.total} />
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            Expiring within
            {WINDOWS.map((w) => (
              <Link
                key={w}
                href={w === "30" ? `/${slug}/training/due` : `/${slug}/training/due?within=${w}`}
                className={
                  w === within
                    ? "rounded-md bg-muted px-2 py-0.5 font-medium text-foreground"
                    : "rounded-md px-2 py-0.5 hover:bg-muted"
                }
              >
                {w} days
              </Link>
            ))}
          </p>
          {due.items.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              Nothing due. Everyone is trained on what their roles need.
            </p>
          ) : (
            <Card className="overflow-x-auto py-0">
              <Table className={stackedTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Person</TableHead>
                    <TableHead>Course</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Due or expires</TableHead>
                    <TableHead className="pr-4">Last trained</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {due.items.map((i) => (
                    <TableRow key={`${i.staff.id}:${i.course.id}`}>
                      <TableCell className="pl-4" data-primary>
                        <Link
                          href={`/${slug}/training/staff/${i.staff.id}`}
                          className="font-medium hover:underline"
                        >
                          {staffDisplayName(i.staff)}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">
                          <StaffNumber value={i.staff.staffNumber} />
                        </span>
                      </TableCell>
                      <TableCell data-label="Course" data-block>
                        <span className="font-mono text-xs">{i.course.code}</span> {i.course.title}
                      </TableCell>
                      <TableCell data-label="Status">
                        <TrainingStatusBadge status={i.status} overdue={i.overdue} />
                      </TableCell>
                      <TableCell
                        data-label="Due"
                        className={i.overdue || i.status === "expired" ? "text-destructive" : undefined}
                      >
                        {i.dueOn ? formatLongDate(i.dueOn) : "—"}
                      </TableCell>
                      <TableCell className="pr-4" data-label="Last trained">
                        {i.completedOn ? formatLongDate(i.completedOn) : "Never"}
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
