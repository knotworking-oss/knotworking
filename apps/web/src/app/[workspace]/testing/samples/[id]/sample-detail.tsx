"use client";

import { formatAnalyteLimit, specificationParameterCategoryLabels, todayInZone } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
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
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { RecordAttachments } from "@/components/record-attachments";
import { TestInvestigationBadge, TestOutcomeBadge, TestSampleStatusBadge } from "@/components/testing-badges";
import type { TestSample } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

type Result = TestSample["results"][number];
interface Entry {
  value: string;
  valueText: string;
  outcome: "" | "pass" | "fail";
  correctionReason: string;
}
const blank: Entry = { value: "", valueText: "", outcome: "", correctionReason: "" };
const numericLimit = (r: Result) => r.min != null || r.max != null;

/** A sample: where it came from, its results against their limits, and its investigation. */
export function SampleDetail({ slug, sample: s }: { slug: string; sample: TestSample }) {
  const timeZone = useWorkspaceTimeZone();
  const today = todayInZone(timeZone);
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("testing", "write");
  const canManage = can("testing", "manage");
  const open = s.status !== "cancelled";
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [reportedOn, setReportedOn] = useState(today);
  const [reportReference, setReportReference] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [findings, setFindings] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [actionTaken, setActionTaken] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const api = () => browserApi().v1.workspaces[":slug"].testing.samples[":id"];
  const entry = (id: string) => entries[id] ?? blank;
  const setEntry = (id: string, patch: Partial<Entry>) =>
    setEntries((all) => ({ ...all, [id]: { ...(all[id] ?? blank), ...patch } }));
  const touched = Object.entries(entries).filter(
    ([, e]) => e.value.trim() !== "" || e.outcome !== "" || e.valueText.trim() !== "",
  );

  async function run(label: string, action: () => Promise<unknown>, done: string) {
    setPending(label);
    try {
      await action();
      toast.success(done);
      router.refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setPending(null);
    }
  }

  async function saveResults(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      "results",
      () =>
        unwrap(
          api().results.$post({
            param: { slug, id: s.id },
            json: {
              reportedOn,
              reportReference: reportReference.trim() || null,
              results: touched.map(([resultId, x]) => ({
                resultId,
                ...(x.value.trim() !== "" ? { value: Number(x.value) } : {}),
                valueText: x.valueText.trim() || null,
                ...(x.outcome ? { outcome: x.outcome } : {}),
                correctionReason: x.correctionReason.trim() || null,
              })),
            },
          }),
        ),
      "Results recorded",
    );
    if (ok) setEntries({});
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          <Link href={`/${slug}/testing`} className="hover:underline">
            Testing
          </Link>{" "}
          / <span className="font-mono text-xs">{s.reference}</span>
        </p>
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {s.reference}
          <TestSampleStatusBadge status={s.status} />
          <TestOutcomeBadge outcome={s.outcome} />
          <TestInvestigationBadge status={s.investigationStatus} />
        </h2>
        <p className="text-sm text-muted-foreground">
          {s.lot ? (
            <>
              Lot{" "}
              <Link href={`/${slug}/stock/lots/${s.lot.id}`} className="font-mono text-xs hover:underline">
                {s.lot.lotCode}
              </Link>{" "}
              of {s.item?.code} {s.item?.name} (lot {s.lot.status})
            </>
          ) : (
            <>
              {s.samplingPoint?.code} {s.samplingPoint?.name}
              {s.samplingPoint?.zone ? ` · ${s.samplingPoint.zone}` : ""}
            </>
          )}{" "}
          · sampled {formatLongDate(s.sampledOn, timeZone)}
          {s.sampledBy ? ` by ${s.sampledBy}` : ""}
          {s.laboratory
            ? ` · ${s.laboratory.name}${s.laboratory.accreditation ? ` (${s.laboratory.accreditation})` : ""}`
            : ""}
          {s.plan ? ` · plan: ${s.plan.name}` : ""}
          {s.specification ? (
            <>
              {" "}
              · limits from{" "}
              <Link
                href={`/${slug}/specifications/${s.specification.specificationId}`}
                className="hover:underline"
              >
                {s.specification.code} v{s.specification.versionNumber}
              </Link>
            </>
          ) : null}
        </p>
      </div>

      {s.lotHeld && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>The lot was put on hold</AlertTitle>
          <AlertDescription>
            A failed result quarantined lot {s.lot?.lotCode}. Releasing it is a QA decision on the lot&apos;s
            stock page.
          </AlertDescription>
        </Alert>
      )}
      {s.status === "cancelled" && (
        <Alert>
          <AlertTitle>Cancelled</AlertTitle>
          <AlertDescription>
            {s.cancelReason} {s.cancelledByName ? `(${s.cancelledByName})` : ""}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void saveResults(e)} className="flex flex-col gap-4">
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Analyte</TableHead>
                    <TableHead>Limit</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Outcome</TableHead>
                    {canWrite && open && <TableHead className="pr-4">Enter</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.results.map((r) => {
                    const e = entry(r.id);
                    return (
                      <TableRow key={r.id} className="align-top">
                        <TableCell className="pl-4">
                          <div className="font-medium">{r.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {specificationParameterCategoryLabels[r.category]}
                            {r.method ? ` · ${r.method}` : ""}
                          </div>
                        </TableCell>
                        <TableCell>{formatAnalyteLimit(r)}</TableCell>
                        <TableCell>
                          {r.value != null ? `${r.value}${r.unit ? ` ${r.unit}` : ""}` : (r.valueText ?? "—")}
                          {r.value != null && r.valueText ? ` (${r.valueText})` : ""}
                          {r.history.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              Corrected {r.history.length}×; last was{" "}
                              {r.history.at(-1)!.value ?? r.history.at(-1)!.valueText ?? "—"} (
                              {r.history.at(-1)!.reason})
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <TestOutcomeBadge outcome={r.outcome} />
                        </TableCell>
                        {canWrite && open && (
                          <TableCell className="pr-4">
                            <div className="flex min-w-56 flex-col gap-1">
                              {numericLimit(r) && (
                                <Input
                                  aria-label={`${r.name} value`}
                                  type="number"
                                  step="any"
                                  placeholder={`Value${r.unit ? ` (${r.unit})` : ""}`}
                                  value={e.value}
                                  onChange={(ev) => setEntry(r.id, { value: ev.target.value })}
                                />
                              )}
                              {(!numericLimit(r) || r.limitText) && (
                                <Select
                                  value={e.outcome || "none"}
                                  onValueChange={(v) =>
                                    setEntry(r.id, { outcome: v === "none" ? "" : (v as "pass" | "fail") })
                                  }
                                >
                                  <SelectTrigger aria-label={`${r.name} verdict`} className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      <SelectItem value="none">Verdict…</SelectItem>
                                      <SelectItem value="pass">Meets the limit</SelectItem>
                                      <SelectItem value="fail">Fails the limit</SelectItem>
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              )}
                              <Input
                                aria-label={`${r.name} as reported`}
                                placeholder="As reported, e.g. Not detected"
                                maxLength={200}
                                value={e.valueText}
                                onChange={(ev) => setEntry(r.id, { valueText: ev.target.value })}
                              />
                              {r.outcome !== "pending" && (e.value || e.outcome || e.valueText) && (
                                <Input
                                  aria-label={`${r.name} correction reason`}
                                  placeholder="Why it is being corrected"
                                  required
                                  maxLength={500}
                                  value={e.correctionReason}
                                  onChange={(ev) => setEntry(r.id, { correctionReason: ev.target.value })}
                                />
                              )}
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {canWrite && open && (
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-44">
                  <FieldLabel htmlFor="report-date">Report date</FieldLabel>
                  <Input
                    id="report-date"
                    type="date"
                    max={today}
                    min={s.sampledOn}
                    required
                    value={reportedOn}
                    onChange={(e) => setReportedOn(e.target.value)}
                  />
                </Field>
                <Field className="w-56">
                  <FieldLabel htmlFor="report-ref">Report reference</FieldLabel>
                  <Input
                    id="report-ref"
                    maxLength={200}
                    value={reportReference}
                    onChange={(e) => setReportReference(e.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={pending !== null || touched.length === 0}>
                  {pending === "results" && <Spinner data-icon="inline-start" />} Record results
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {s.investigationStatus && (
        <Card>
          <CardHeader>
            <CardTitle>Investigation</CardTitle>
            <CardDescription>
              {s.investigationStatus === "open"
                ? "Opened by a failed result. Record what was found and done to close it."
                : `Closed ${s.investigationClosedAt ? formatLongDate(String(s.investigationClosedAt), timeZone) : ""} by ${s.investigationClosedByName ?? "someone"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {s.investigationStatus === "closed" ? (
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Findings</dt>
                <dd className="whitespace-pre-wrap">{s.findings}</dd>
                <dt className="text-muted-foreground">Root cause</dt>
                <dd className="whitespace-pre-wrap">{s.rootCause ?? "—"}</dd>
                <dt className="text-muted-foreground">Action taken</dt>
                <dd className="whitespace-pre-wrap">{s.actionTaken}</dd>
              </dl>
            ) : canManage ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    "close",
                    () =>
                      unwrap(
                        api().investigation.close.$post({
                          param: { slug, id: s.id },
                          json: { findings, rootCause: rootCause.trim() || null, actionTaken },
                        }),
                      ),
                    "Investigation closed",
                  );
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="inv-findings">Findings</FieldLabel>
                    <Textarea
                      id="inv-findings"
                      required
                      maxLength={5000}
                      value={findings}
                      onChange={(e) => setFindings(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="inv-cause">Root cause</FieldLabel>
                    <Textarea
                      id="inv-cause"
                      maxLength={2000}
                      value={rootCause}
                      onChange={(e) => setRootCause(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="inv-action">Action taken</FieldLabel>
                    <Textarea
                      id="inv-action"
                      required
                      maxLength={2000}
                      placeholder="Retest, deep clean, lot rejected or released…"
                      value={actionTaken}
                      onChange={(e) => setActionTaken(e.target.value)}
                    />
                  </Field>
                </FieldGroup>
                <Button type="submit" className="self-start" disabled={pending !== null}>
                  {pending === "close" && <Spinner data-icon="inline-start" />} Close investigation
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                Someone with manage access closes the investigation.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {canWrite && s.status === "awaiting_results" && s.outcome !== "fail" && (
        <Card>
          <CardHeader>
            <CardTitle>Cancel sample</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  "cancel",
                  () =>
                    unwrap(api().cancel.$post({ param: { slug, id: s.id }, json: { reason: cancelReason } })),
                  "Sample cancelled",
                );
              }}
            >
              <Field className="w-80">
                <FieldLabel htmlFor="cancel-reason">Reason</FieldLabel>
                <Input
                  id="cancel-reason"
                  required
                  maxLength={500}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="outline" disabled={pending !== null}>
                Cancel sample
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <RecordAttachments entityType="testing_sample" entityId={s.id} />
        </CardContent>
      </Card>
    </div>
  );
}
