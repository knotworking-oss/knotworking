"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ApiSourceBadge, ReadingBadge } from "@/components/haccp-badges";
import { HaccpDialog } from "@/components/haccp-forms";
import type { HaccpLog } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useFormatDateTime } from "@/lib/workspace-time";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The review queue: CCP readings an agent or a sensor feed recorded through an API token, waiting
 * for a person with manage access. Approve the selected readings at once, or reject them with a
 * note. All or nothing: if one was reviewed meanwhile, nothing changes and the page refreshes.
 * Out-of-limit readings already have an open corrective action; rejecting one leaves it open.
 */
export function ReviewBoard({ slug, logs, total }: { slug: string; logs: HaccpLog[]; total: number }) {
  const time = useFormatDateTime();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const chosen = logs.filter((l) => selected.has(l.id)).map((l) => l.id);
  const allSelected = logs.length > 0 && chosen.length === logs.length;

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const review = (decision: "approve" | "reject", reviewNote?: string) =>
    unwrap(
      browserApi().v1.workspaces[":slug"].haccp.logs.review.$post({
        param: { slug },
        json: { ids: chosen, decision, ...(reviewNote ? { note: reviewNote } : {}) },
      }),
    );

  async function approve() {
    setApproving(true);
    try {
      const { reviewed } = await review("approve");
      toast.success(`${plural(reviewed, "reading")} approved`);
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      router.refresh();
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Readings awaiting review</h2>
          <p className="text-sm text-muted-foreground">{plural(total, "reading")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={chosen.length === 0 || approving}
            onClick={() => {
              setNote("");
              setRejecting(true);
            }}
          >
            <X data-icon="inline-start" /> Reject selected
          </Button>
          <Button disabled={chosen.length === 0 || approving} onClick={() => void approve()}>
            {approving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            Approve selected{chosen.length > 0 ? ` (${chosen.length})` : ""}
          </Button>
        </div>
      </div>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Pending readings</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {logs.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Nothing is waiting for review.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-4">
                    <Checkbox
                      aria-label="Select all readings"
                      checked={allSelected ? true : chosen.length > 0 ? "indeterminate" : false}
                      onCheckedChange={(on) => setSelected(new Set(on === true ? logs.map((l) => l.id) : []))}
                    />
                  </TableHead>
                  <TableHead>Checked</TableHead>
                  <TableHead>CCP</TableHead>
                  <TableHead>Reading</TableHead>
                  <TableHead>Critical limit</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="pr-4">Recorded by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id} data-state={selected.has(log.id) ? "selected" : undefined}>
                    <TableCell className="pl-4">
                      <Checkbox
                        aria-label={`Select the ${log.ccpCode} reading of ${time(log.checkedAt)}`}
                        checked={selected.has(log.id)}
                        onCheckedChange={(on) => toggle(log.id, on === true)}
                      />
                    </TableCell>
                    <TableCell className="tabular-nums">{time(log.checkedAt)}</TableCell>
                    <TableCell>
                      <span className="font-medium">{log.ccpCode}</span>{" "}
                      <span className="text-muted-foreground">{log.ccp.processStep}</span>
                      {log.plan && (
                        <span className="ml-1 text-xs text-muted-foreground">{log.plan.code}</span>
                      )}
                      {log.note && <div className="text-xs text-muted-foreground">{log.note}</div>}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">{log.readingText}</TableCell>
                    <TableCell className="text-muted-foreground">{log.ccp.limitText}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <ReadingBadge withinLimits={log.withinLimits} reason={log.deviationReason} />
                        {log.correctiveActions.some((a) => a.status === "open") && (
                          <span className="text-xs text-destructive">Corrective action open</span>
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
                    <TableCell className="pr-4">
                      <span className="flex flex-wrap items-center gap-1">
                        {log.recordedByName ?? "—"}
                        {log.source === "api" && <ApiSourceBadge />}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {total > logs.length && (
            <p className="px-4 pt-2 pb-2 text-xs text-muted-foreground">
              Showing the latest {logs.length} of {total}. Review these to see the rest.
            </p>
          )}
        </CardContent>
      </Card>

      {rejecting && (
        <HaccpDialog
          title={`Reject ${plural(chosen.length, "reading")}`}
          description="Rejected readings stay on record, marked rejected, and no longer count: the check is due again. Any corrective action they opened stays open for a manager to close."
          submitLabel="Reject"
          disabled={!note.trim()}
          onClose={() => setRejecting(false)}
          onSubmit={async () => {
            const { reviewed } = await review("reject", note.trim());
            setSelected(new Set());
            return `${plural(reviewed, "reading")} rejected`;
          }}
        >
          <Field>
            <FieldLabel htmlFor="review-note">Why</FieldLabel>
            <Textarea
              id="review-note"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Probe was not in the core of the product"
              required
            />
            <FieldDescription>Required. It is kept with each rejected reading.</FieldDescription>
          </Field>
        </HaccpDialog>
      )}
    </div>
  );
}
