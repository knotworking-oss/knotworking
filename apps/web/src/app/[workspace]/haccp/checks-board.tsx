"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { ClipboardCheck, ClipboardList, Clock, Undo2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ApiSourceBadge, DueStateBadge, ReadingBadge, ReviewStatusBadge } from "@/components/haccp-badges";
import {
  CcpCheckDialog,
  CheckSheetDialog,
  CorrectReadingDialog,
  type CheckableCcp,
  type CheckSheetRow,
} from "@/components/haccp-forms";
import type { HaccpCcp, HaccpDue, HaccpDueCheck, HaccpLog } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

type Plan = { id: string; code: string; name: string; ccps: HaccpCcp[] };
type Recording = { planId: string; planCode: string; ccp: CheckableCcp; batchId?: string | null };

function dueText(check: HaccpDueCheck, time: (iso: string) => string) {
  if (check.dueAt) return time(check.dueAt);
  if (check.dueOn) return formatLongDate(check.dueOn);
  return "Now";
}

/**
 * Today's checks: what is overdue or due (CCP monitoring, cleaning, calibration), quick entry of a
 * CCP reading with automatic out-of-limit flagging, and the latest checks recorded.
 */
export function ChecksBoard({
  slug,
  due,
  logs,
  plans,
}: {
  slug: string;
  due: HaccpDue;
  logs: HaccpLog[];
  plans: Plan[];
}) {
  const time = useFormatDateTime();
  const { can } = useWorkspace();
  const canWrite = can("haccp", "write");
  const canManage = can("haccp", "manage");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [correcting, setCorrecting] = useState<HaccpLog | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const actionable = due.checks.filter((c) => c.state === "overdue" || c.state === "due");
  const later = due.checks.filter((c) => c.state !== "overdue" && c.state !== "due");
  const batchesFor = (planId: string) => due.batchesInProgress.filter((b) => b.planIds.includes(planId));

  const action = (check: HaccpDueCheck) => {
    if (check.kind === "ccp") {
      return canWrite ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setRecording({
              planId: check.plan.id,
              planCode: check.plan.code,
              ccp: check.ccp,
              batchId: check.batch?.id ?? null,
            })
          }
        >
          Record
        </Button>
      ) : null;
    }
    return (
      <Button size="sm" variant="ghost" asChild>
        <Link href={`/${slug}/haccp/records`}>Open</Link>
      </Button>
    );
  };

  const checkRows = (checks: HaccpDueCheck[]) =>
    checks.map((check) => (
      <TableRow key={check.key}>
        <TableCell className="pl-4">
          <div className="font-medium">{check.label}</div>
          <div className="text-xs text-muted-foreground">
            {check.kind === "ccp"
              ? `${check.plan.code} · ${check.ccp.limitText}`
              : check.kind === "cleaning"
                ? "Cleaning"
                : "Calibration"}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground">{check.frequencyText}</TableCell>
        <TableCell>
          <DueStateBadge state={check.state} />
        </TableCell>
        <TableCell className="tabular-nums">{check.state === "idle" ? "—" : dueText(check, time)}</TableCell>
        <TableCell className="text-muted-foreground tabular-nums">
          {check.lastAt ? time(check.lastAt) : "Never"}
        </TableCell>
        <TableCell className="pr-4 text-right">{action(check)}</TableCell>
      </TableRow>
    ));

  const checksTable = (checks: HaccpDueCheck[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Check</TableHead>
          <TableHead>Frequency</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Due</TableHead>
          <TableHead>Last done</TableHead>
          <TableHead className="pr-4" />
        </TableRow>
      </TableHeader>
      <TableBody>{checkRows(checks)}</TableBody>
    </Table>
  );

  // The check sheet: every CCP check that is overdue or due, a line per batch for per-batch CCPs.
  const sheetRows: CheckSheetRow[] = actionable.flatMap((check) =>
    check.kind === "ccp"
      ? [{ key: check.key, planCode: check.plan.code, ccp: check.ccp, batch: check.batch ?? null }]
      : [],
  );
  const ccpById = new Map(plans.flatMap((p) => p.ccps.map((c) => [c.id, { plan: p, ccp: c }] as const)));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Today&apos;s checks</h2>
          <p className="text-sm text-muted-foreground">
            {formatLongDate(due.today)} · {due.counts.overdue} overdue · {due.counts.due} due ·{" "}
            {due.batchesInProgress.length} batch{due.batchesInProgress.length === 1 ? "" : "es"} in production
          </p>
        </div>
        {canWrite && plans.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {sheetRows.length > 0 && (
              <Button variant="outline" onClick={() => setSheetOpen(true)}>
                <ClipboardList data-icon="inline-start" /> Check sheet
              </Button>
            )}
            <Select
              value=""
              onValueChange={(id) => {
                const found = ccpById.get(id);
                if (found) setRecording({ planId: found.plan.id, planCode: found.plan.code, ccp: found.ccp });
              }}
            >
              <SelectTrigger className="w-64" aria-label="Record a check">
                <ClipboardCheck />
                <SelectValue placeholder="Record a check…" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((plan) => (
                  <SelectGroup key={plan.id}>
                    <SelectLabel>
                      {plan.code} · {plan.name}
                    </SelectLabel>
                    {plan.ccps.map((ccp) => (
                      <SelectItem key={ccp.id} value={ccp.id}>
                        {ccp.code} · {ccp.processStep}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {due.counts.awaitingReview > 0 && (
        <Alert>
          <Clock />
          <AlertTitle>
            {due.counts.awaitingReview} reading{due.counts.awaitingReview === 1 ? "" : "s"} awaiting review
          </AlertTitle>
          <AlertDescription>
            <p>
              Recorded through the API by an agent or a sensor feed. They count as done until someone with
              manage access rejects them.{" "}
              {canManage && (
                <Link className="underline" href={`/${slug}/haccp/review`}>
                  Review them
                </Link>
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}

      {plans.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No HACCP plan is approved yet. CCP checks appear here once a plan is approved on the{" "}
          <Link className="underline" href={`/${slug}/haccp/plans`}>
            plans page
          </Link>
          .
        </p>
      )}

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Overdue and due</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {actionable.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Nothing is due. Well done.</p>
          ) : (
            checksTable(actionable)
          )}
        </CardContent>
      </Card>

      {later.length > 0 && (
        <details className="rounded-xl border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            Coming up and up to date ({later.length})
          </summary>
          <div className="overflow-x-auto pb-2">{checksTable(later)}</div>
        </details>
      )}

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Latest CCP checks</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {logs.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No checks recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Checked</TableHead>
                  <TableHead>CCP</TableHead>
                  <TableHead>Reading</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => {
                  const corrected = !!log.correctedByLogId;
                  return (
                    <TableRow key={log.id} className={corrected ? "text-muted-foreground" : undefined}>
                      <TableCell className="pl-4 tabular-nums">{time(log.checkedAt)}</TableCell>
                      <TableCell>
                        <span className="font-medium">{log.ccpCode}</span>{" "}
                        <span className="text-muted-foreground">{log.ccp.processStep}</span>
                      </TableCell>
                      <TableCell className={corrected ? "line-through" : "tabular-nums"}>
                        {log.readingText}
                        <span className="ml-1 text-xs text-muted-foreground">({log.ccp.limitText})</span>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-1">
                          <ReadingBadge withinLimits={log.withinLimits} reason={log.deviationReason} />
                          {log.source === "api" && <ApiSourceBadge />}
                          <ReviewStatusBadge status={log.reviewStatus} note={log.reviewNote} />
                          {corrected && <span className="text-xs">Corrected</span>}
                          {log.correctsLogId && (
                            <span
                              className="text-xs text-muted-foreground"
                              title={log.correctionReason ?? ""}
                            >
                              Correction
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        {log.batch ? (
                          <Link
                            className="font-mono text-xs hover:underline"
                            href={`/${slug}/production/batches/${log.batch.id}`}
                          >
                            {log.batch.batchCode}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{log.recordedByName ?? "—"}</TableCell>
                      <TableCell className="pr-4 text-right">
                        {!corrected && canWrite && (log.withinLimits || canManage) && (
                          <Button size="sm" variant="ghost" onClick={() => setCorrecting(log)}>
                            <Undo2 data-icon="inline-start" /> Correct
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {recording && (
        <CcpCheckDialog
          slug={slug}
          planCode={recording.planCode}
          ccp={recording.ccp}
          batches={batchesFor(recording.planId)}
          batchId={recording.batchId}
          onClose={() => setRecording(null)}
        />
      )}
      {sheetOpen && <CheckSheetDialog slug={slug} rows={sheetRows} onClose={() => setSheetOpen(false)} />}
      {correcting && (
        <CorrectReadingDialog
          slug={slug}
          log={correcting}
          ccp={correcting.ccp}
          onClose={() => setCorrecting(null)}
        />
      )}
    </div>
  );
}
