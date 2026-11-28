"use client";

import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ApiSourceBadge, ReadingBadge, ReviewStatusBadge } from "@/components/haccp-badges";
import { CcpCheckDialog } from "@/components/haccp-forms";
import type { HaccpBatchRecord } from "@/lib/api";
import { useOptionalWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

/**
 * Food safety on a production batch page (shown to people who can read the haccp module): the
 * CCPs of the plans that cover the batch, the checks recorded against it, and a warning while a
 * deviation is open or a per-batch check is missing. Production itself doesn't depend on haccp.
 */
export function HaccpBatchPanel({ slug, record }: { slug: string; record: HaccpBatchRecord }) {
  const time = useFormatDateTime();
  // Outside a workspace (the /design showcase) the panel is read-only.
  const workspace = useOptionalWorkspace();
  const canWrite = workspace?.can("haccp", "write") ?? false;
  const canManage = workspace?.can("haccp", "manage") ?? false;
  const [recording, setRecording] = useState<HaccpBatchRecord["ccps"][number] | null>(null);
  const running = record.batch.status === "in_progress";
  if (record.ccps.length === 0 && record.logs.length === 0) return null;
  return (
    <div className="workspace-content pb-8">
      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Food safety checks
          </CardTitle>
          <CardDescription>
            <Link className="underline" href={`/${slug}/haccp`}>
              Today&apos;s checks
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-0 pb-2">
          {(record.openDeviations > 0 || record.openCorrectiveActions > 0) && (
            <div className="px-4">
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>
                  {record.openCorrectiveActions} open corrective action
                  {record.openCorrectiveActions === 1 ? "" : "s"} on this batch
                </AlertTitle>
                <AlertDescription>
                  Resolve them before releasing what the batch made.{" "}
                  <Link className="underline" href={`/${slug}/haccp/deviations`}>
                    Deviations
                  </Link>
                </AlertDescription>
              </Alert>
            </div>
          )}
          {running && record.missingChecks > 0 && (
            <p className="px-4 text-sm text-label-orange">
              {record.missingChecks} per-batch check{record.missingChecks === 1 ? " is" : "s are"} still to be
              recorded.
            </p>
          )}
          {record.awaitingReview > 0 && (
            <p className="px-4 text-sm text-muted-foreground">
              {record.awaitingReview} reading{record.awaitingReview === 1 ? "" : "s"} recorded through the API
              {record.awaitingReview === 1 ? " awaits" : " await"} review by someone with manage access.{" "}
              {canManage && (
                <Link className="underline" href={`/${slug}/haccp/review`}>
                  Review
                </Link>
              )}
            </p>
          )}
          {record.ccps.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">CCP</TableHead>
                    <TableHead>Critical limit</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Checks</TableHead>
                    <TableHead>Last</TableHead>
                    <TableHead className="pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {record.ccps.map((row) => (
                    <TableRow key={`${row.plan.id}:${row.ccp.id}`}>
                      <TableCell className="pl-4">
                        <span className="font-medium">{row.ccp.code}</span> {row.ccp.processStep}
                        <span className="ml-1 text-xs text-muted-foreground">{row.plan.code}</span>
                      </TableCell>
                      <TableCell>{row.ccp.limitText}</TableCell>
                      <TableCell className="text-muted-foreground">{row.ccp.frequencyText}</TableCell>
                      <TableCell className="tabular-nums">
                        {row.checks}
                        {row.awaitingReview > 0 && (
                          <span className="ml-1 text-label-yellow">
                            ({row.awaitingReview} awaiting review)
                          </span>
                        )}
                        {row.deviations > 0 && (
                          <span className="ml-1 text-destructive">({row.deviations} out of limits)</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.lastCheckedAt ? time(row.lastCheckedAt) : "—"}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        {canWrite && running && (
                          <Button size="sm" variant="outline" onClick={() => setRecording(row)}>
                            Record
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {record.logs.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Checked</TableHead>
                    <TableHead>CCP</TableHead>
                    <TableHead>Reading</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="pr-4">By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {record.logs.map((log) => (
                    <TableRow
                      key={log.id}
                      className={log.correctedByLogId ? "text-muted-foreground" : undefined}
                    >
                      <TableCell className="pl-4 tabular-nums">{time(log.checkedAt)}</TableCell>
                      <TableCell>
                        {log.ccpCode} <span className="text-muted-foreground">{log.ccp.processStep}</span>
                      </TableCell>
                      <TableCell className={log.correctedByLogId ? "line-through" : "tabular-nums"}>
                        {log.readingText}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-1">
                          <ReadingBadge withinLimits={log.withinLimits} reason={log.deviationReason} />
                          {log.source === "api" && <ApiSourceBadge />}
                          <ReviewStatusBadge status={log.reviewStatus} note={log.reviewNote} />
                          {log.correctedByLogId && <span className="text-xs">Corrected</span>}
                        </span>
                      </TableCell>
                      <TableCell className="pr-4">{log.recordedByName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {recording && (
        <CcpCheckDialog
          slug={slug}
          planCode={recording.plan.code}
          ccp={recording.ccp}
          batches={[{ id: record.batch.id, batchCode: record.batch.batchCode }]}
          batchId={record.batch.id}
          onClose={() => setRecording(null)}
        />
      )}
    </div>
  );
}
