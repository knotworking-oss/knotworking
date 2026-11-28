"use client";

import {
  defenceReviewTriggerLabels,
  defenceReviewTriggers,
  defenceThreatRating,
  defenceThreatSourceLabels,
  defenceThreatSources,
  formatUkDate,
  newId,
  type DefenceReviewTrigger,
  type DefenceThreat,
  type DefenceThreatSource,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
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
import { CircleAlert, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  DefenceDueBadge,
  DefenceExerciseBadge,
  DefenceRatingBadge,
  DefenceVersionBadge,
} from "@/components/defence-badges";
import type { DefenceAssessment } from "@/lib/api";
import { ApiError, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";
import { DefenceNav } from "../../defence-nav";

type Version = NonNullable<DefenceAssessment["approved"]>;
type Control = DefenceAssessment["controls"][number];
const SCORES = [1, 2, 3, 4, 5] as const;

/** A threat assessment: the approved version, the review draft and every earlier version. */
export function AssessmentDetail({ slug, assessment: a }: { slug: string; assessment: DefenceAssessment }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const active = a.status === "active";
  const canWrite = can("defence", "write") && active;
  const canManage = can("defence", "manage") && active;
  const [pending, setPending] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const api = () => browserApi().v1.workspaces[":slug"].defence.assessments[":id"];

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setPending(key);
    try {
      await fn();
      toast.success(done);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      // Someone changed the draft: show the current one so it is reviewed before approving.
      if (err instanceof ApiError && err.code === "draft_changed") router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <DefenceNav slug={slug} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {a.title}
            {!active && <Badge variant="secondary">Archived</Badge>}
            {active && a.approved && <DefenceDueBadge status={a.reviewStatus} />}
          </h2>
          <p className="text-sm text-muted-foreground">
            {a.scope ?? "No scope given"}
            {a.approved
              ? ` · v${a.approved.versionNumber} approved${a.approved.reviewDueOn ? `, review by ${formatUkDate(a.approved.reviewDueOn)}` : ""}`
              : " · not yet approved"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && a.approved && !a.draft && (
            <Button variant="outline" onClick={() => setReviewing(true)}>
              Start review
            </Button>
          )}
          {can("defence", "write") && (
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void run(
                  "archive",
                  () =>
                    unwrap(
                      api().$patch({
                        param: { slug, id: a.id },
                        json: { status: active ? "archived" : "active" },
                      }),
                    ),
                  active ? "Archived" : "Restored",
                )
              }
            >
              {active ? "Archive" : "Restore"}
            </Button>
          )}
        </div>
      </div>

      {a.draft && (
        <DraftEditor
          key={`${a.draft.id}-${String(a.draft.updatedAt)}`}
          slug={slug}
          assessment={a}
          draft={a.draft}
          canWrite={canWrite}
          canManage={canManage}
          pending={pending}
          onApprove={() =>
            void run(
              "approve",
              () =>
                unwrap(
                  api().draft.approve.$post({
                    param: { slug, id: a.id },
                    json: { draftId: a.draft!.id, revision: a.draft!.revision! },
                  }),
                ),
              "Approved",
            )
          }
        />
      )}

      {a.approved ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Approved version {a.approved.versionNumber} <DefenceVersionBadge status="approved" />
            </CardTitle>
            <CardDescription>
              {a.approved.approvedByName ? `Approved by ${a.approved.approvedByName}` : "Approved"}
              {a.approved.summary ? ` · ${a.approved.summary}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ThreatTable threats={a.approved.threats} controls={a.controls} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {a.history.map((v) => (
            <HistoryRow key={v.id} version={v} controls={a.controls} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exercises</CardTitle>
        </CardHeader>
        <CardContent>
          {a.exercises.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None yet. Record one under{" "}
              <Link href={`/${slug}/defence/exercises`} className="underline">
                Exercises
              </Link>
              .
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {a.exercises.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="font-medium">{e.title}</span>
                  <span className="text-muted-foreground">{formatUkDate(e.heldOn)}</span>
                  <DefenceExerciseBadge outcome={e.outcome} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {reviewing && (
        <StartReviewDialog
          onClose={() => setReviewing(false)}
          onStart={(trigger, reason) =>
            run(
              "review",
              () =>
                unwrap(
                  api().review.$post({
                    param: { slug, id: a.id },
                    json: { trigger, reason: reason || null },
                  }),
                ),
              "Review started",
            ).then(() => setReviewing(false))
          }
        />
      )}
    </div>
  );
}

function ThreatTable({ threats, controls }: { threats: Version["threats"]; controls: Control[] }) {
  if (threats.length === 0) return <p className="text-sm text-muted-foreground">No threats recorded.</p>;
  const name = (id: string) => controls.find((c) => c.id === id)?.name ?? "Removed control";
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Area and threat</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>L × I</TableHead>
            <TableHead>Controls and mitigation</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {threats.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="max-w-xs whitespace-normal">
                <div className="font-medium">{t.area}</div>
                <div className="text-muted-foreground">{t.threat}</div>
              </TableCell>
              <TableCell className="whitespace-normal">{defenceThreatSourceLabels[t.source]}</TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <span className="tabular-nums">
                    {t.likelihood} × {t.impact}
                  </span>
                  <DefenceRatingBadge rating={t.rating} score={t.score} />
                </div>
              </TableCell>
              <TableCell className="max-w-sm text-sm whitespace-normal">
                {t.existingControls && <div>{t.existingControls}</div>}
                {t.mitigation && <div className="text-muted-foreground">Mitigation: {t.mitigation}</div>}
                {t.controlIds.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Checked by: {t.controlIds.map(name).join(", ")}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function HistoryRow({ version: v, controls }: { version: Version; controls: Control[] }) {
  const at = useFormatDateTime();
  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <span className="font-medium">Version {v.versionNumber}</span>
        <DefenceVersionBadge status={v.status} />
        <span className="text-muted-foreground">
          {v.threats.length} {v.threats.length === 1 ? "threat" : "threats"}
          {v.approvedAt
            ? ` · approved ${at(String(v.approvedAt))}${v.approvedByName ? ` by ${v.approvedByName}` : ""}`
            : ""}
          {v.reviewTrigger
            ? ` · ${defenceReviewTriggerLabels[v.reviewTrigger]}${v.reviewReason ? `: ${v.reviewReason}` : ""}`
            : ""}
        </span>
      </summary>
      <div className="pt-3">
        <ThreatTable threats={v.threats} controls={controls} />
      </div>
    </details>
  );
}

type EditableThreat = Omit<DefenceThreat, "existingControls" | "mitigation"> & {
  existingControls: string;
  mitigation: string;
};

function DraftEditor({
  slug,
  assessment: a,
  draft,
  canWrite,
  canManage,
  pending,
  onApprove,
}: {
  slug: string;
  assessment: DefenceAssessment;
  draft: Version;
  canWrite: boolean;
  canManage: boolean;
  pending: string | null;
  onApprove: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState(draft.summary ?? "");
  const [reviewDueOn, setReviewDueOn] = useState(draft.reviewDueOn ?? "");
  const [initialThreats] = useState<EditableThreat[]>(() =>
    draft.threats.map((t) => ({
      id: t.id,
      area: t.area,
      threat: t.threat,
      source: t.source,
      likelihood: t.likelihood,
      impact: t.impact,
      existingControls: t.existingControls ?? "",
      mitigation: t.mitigation ?? "",
      controlIds: t.controlIds,
    })),
  );
  const [threats, setThreats] = useState(initialThreats);
  // Approval signs the saved draft, so unsaved edits in this form must be saved (or undone) first.
  const dirty =
    summary !== (draft.summary ?? "") ||
    reviewDueOn !== (draft.reviewDueOn ?? "") ||
    JSON.stringify(threats) !== JSON.stringify(initialThreats);
  const activeControls = a.controls.filter((c) => c.status === "active");
  const set = (i: number, patch: Partial<EditableThreat>) =>
    setThreats((list) => list.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].defence.assessments[":id"].draft.$put({
          param: { slug, id: a.id },
          json: {
            summary: summary.trim() || null,
            reviewDueOn: reviewDueOn || null,
            threats: threats.map((t) => ({
              ...t,
              area: t.area.trim(),
              threat: t.threat.trim(),
              existingControls: t.existingControls.trim() || null,
              mitigation: t.mitigation.trim() || null,
            })),
          },
        }),
      );
      toast.success("Draft saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Draft version {draft.versionNumber} <DefenceVersionBadge status="draft" />
        </CardTitle>
        <CardDescription>
          {draft.reviewTrigger
            ? `${defenceReviewTriggerLabels[draft.reviewTrigger]}${draft.reviewReason ? `: ${draft.reviewReason}` : ""}. `
            : ""}
          Likelihood and impact are scored 1–5; a threat scoring 15 or more rates high and needs a mitigation.
          {draft.lastEditedByName ? ` Last saved by ${draft.lastEditedByName}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <fieldset disabled={!canWrite} className="flex flex-col gap-4">
            {threats.map((t, i) => {
              const r = defenceThreatRating(t);
              return (
                <div
                  key={t.id}
                  className="flex flex-col gap-3 rounded-md border p-3"
                  aria-label={`Threat ${i + 1}`}
                >
                  <div className="grid gap-3 sm:grid-cols-[1fr_14rem_auto]">
                    <Field>
                      <FieldLabel htmlFor={`area-${t.id}`}>Area</FieldLabel>
                      <Input
                        id={`area-${t.id}`}
                        required
                        maxLength={200}
                        value={t.area}
                        onChange={(e) => set(i, { area: e.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Source</FieldLabel>
                      <Select
                        value={t.source}
                        onValueChange={(v) => set(i, { source: v as DefenceThreatSource })}
                      >
                        <SelectTrigger aria-label="Source">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {defenceThreatSources.map((s) => (
                              <SelectItem key={s} value={s}>
                                {defenceThreatSourceLabels[s]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <div className="flex items-end gap-2">
                      {(["likelihood", "impact"] as const).map((k) => (
                        <Field key={k} className="w-24">
                          <FieldLabel>{k === "likelihood" ? "Likelihood" : "Impact"}</FieldLabel>
                          <Select value={String(t[k])} onValueChange={(v) => set(i, { [k]: Number(v) })}>
                            <SelectTrigger aria-label={k === "likelihood" ? "Likelihood" : "Impact"}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {SCORES.map((n) => (
                                  <SelectItem key={n} value={String(n)}>
                                    {n}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      ))}
                      <div className="pb-1.5">
                        <DefenceRatingBadge rating={r.rating} score={r.score} />
                      </div>
                    </div>
                  </div>
                  <Field>
                    <FieldLabel htmlFor={`threat-${t.id}`}>Threat</FieldLabel>
                    <Textarea
                      id={`threat-${t.id}`}
                      required
                      maxLength={2000}
                      value={t.threat}
                      onChange={(e) => set(i, { threat: e.target.value })}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor={`existing-${t.id}`}>Controls in place</FieldLabel>
                      <Textarea
                        id={`existing-${t.id}`}
                        maxLength={2000}
                        value={t.existingControls}
                        onChange={(e) => set(i, { existingControls: e.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`mitigation-${t.id}`}>Further mitigation</FieldLabel>
                      <Textarea
                        id={`mitigation-${t.id}`}
                        maxLength={2000}
                        value={t.mitigation}
                        onChange={(e) => set(i, { mitigation: e.target.value })}
                      />
                    </Field>
                  </div>
                  {activeControls.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-medium">Verified by checks of</span>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {activeControls.map((c) => (
                          <label key={c.id} className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={t.controlIds.includes(c.id)}
                              onCheckedChange={(on) =>
                                set(i, {
                                  controlIds: on
                                    ? [...t.controlIds, c.id]
                                    : t.controlIds.filter((x) => x !== c.id),
                                })
                              }
                            />
                            {c.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {canWrite && (
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setThreats((list) => list.filter((_, j) => j !== i))}
                      >
                        <Trash2 data-icon="inline-start" /> Remove threat
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
            {canWrite && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setThreats((list) => [
                      ...list,
                      {
                        id: newId(),
                        area: "",
                        threat: "",
                        source: "intruder",
                        likelihood: 1,
                        impact: 1,
                        existingControls: "",
                        mitigation: "",
                        controlIds: [],
                      },
                    ])
                  }
                >
                  <Plus data-icon="inline-start" /> Add threat
                </Button>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <Field>
                <FieldLabel htmlFor="def-summary">Summary</FieldLabel>
                <Textarea
                  id="def-summary"
                  maxLength={4000}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="def-review">Next review</FieldLabel>
                <Input
                  id="def-review"
                  type="date"
                  value={reviewDueOn}
                  onChange={(e) => setReviewDueOn(e.target.value)}
                />
              </Field>
            </div>
          </fieldset>
          {a.draftChanges.length > 0 && a.approved && (
            <div className="text-sm">
              <div className="font-medium">Changes from version {a.approved.versionNumber}</div>
              <ul className="list-disc pl-5 text-muted-foreground">
                {a.draftChanges.map((c) => (
                  <li key={`${c.id}-${c.change}`}>
                    {c.area}: {c.change === "rerated" ? `re-rated ${c.detail}` : c.change}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {a.approvalBlockers.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {a.approvalBlockers.map((b) => (
                <li key={b} className="flex gap-2 text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" /> {b}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {canWrite && (
              <Button type="submit" variant="outline" disabled={saving}>
                {saving && <Spinner data-icon="inline-start" />} Save draft
              </Button>
            )}
            {canManage && (
              <Button
                type="button"
                disabled={pending !== null || dirty || a.approvalBlockers.length > 0}
                title={
                  dirty
                    ? "Save your changes before approving"
                    : a.approvalBlockers.length
                      ? "Save a complete draft first"
                      : undefined
                }
                onClick={onApprove}
              >
                {pending === "approve" && <Spinner data-icon="inline-start" />} Approve version{" "}
                {draft.versionNumber}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function StartReviewDialog({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (trigger: DefenceReviewTrigger, reason: string) => Promise<void>;
}) {
  const [trigger, setTrigger] = useState<DefenceReviewTrigger>("scheduled");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            void onStart(trigger, reason.trim()).finally(() => setPending(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Start a review</DialogTitle>
            <DialogDescription>
              The approved version stays in force until the review is approved, and is kept afterwards.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel>What prompted it</FieldLabel>
              <Select value={trigger} onValueChange={(v) => setTrigger(v as DefenceReviewTrigger)}>
                <SelectTrigger aria-label="What prompted it">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {defenceReviewTriggers.map((t) => (
                      <SelectItem key={t} value={t}>
                        {defenceReviewTriggerLabels[t]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="review-reason">Reason</FieldLabel>
              <Textarea
                id="review-reason"
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Start review
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
