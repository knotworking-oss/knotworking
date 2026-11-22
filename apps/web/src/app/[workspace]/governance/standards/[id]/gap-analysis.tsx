"use client";

import {
  clauseAssessmentLabels,
  clauseAssessmentStatuses,
  evidenceCheckIds,
  evidenceChecks,
  evidenceCheckStatusLabels,
  openFindingStatuses,
  type EvidenceCheckId,
  type EvidenceCheckStatus,
  type ClauseAssessmentStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { Camera, Download, TriangleAlert, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { GapAnalysis, GapSnapshotSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";
import { GovernanceFrame, MemberSelect } from "../../governance-nav";

type Clause = GapAnalysis["clauses"][number];
const gov = () => browserApi().v1.workspaces[":slug"].governance;
const ALL = "all";
const tone: Record<ClauseAssessmentStatus, string> = {
  not_assessed: "",
  compliant: "bg-label-green-bg text-label-green",
  partial: "bg-label-orange-bg text-label-orange",
  gap: "bg-label-red-bg text-label-red",
  not_applicable: "bg-muted text-muted-foreground",
};
export function StatusBadge({ status }: { status: ClauseAssessmentStatus }) {
  return (
    <Badge
      className={`border-transparent ${tone[status]}`}
      variant={status === "not_assessed" ? "outline" : "default"}
    >
      {clauseAssessmentLabels[status]}
    </Badge>
  );
}

/**
 * A standard's gap analysis (G1): the summary by status and section, fundamental clauses at risk,
 * and each clause with its latest assessment. Assessing is a person's judgement, kept as history;
 * a gap or partial compliance has an owner and a date, and can raise a task.
 */
export function GapAnalysisView({
  slug,
  today,
  analysis,
  filters,
  teams,
  snapshots,
}: {
  slug: string;
  today: string;
  analysis: GapAnalysis;
  filters: {
    status: string;
    section: string;
    fundamental: boolean;
    q: string;
    evidence: string;
    drafts: boolean;
  };
  teams: { id: string; name: string }[];
  snapshots: GapSnapshotSummary[];
}) {
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("governance", "write");
  const canManage = can("governance", "manage");
  const { standard, summary, clauses } = analysis;
  const base = `/${slug}/governance/standards/${standard.id}`;
  const active = standard.status === "active";
  const [dialog, setDialog] = useState<
    | { kind: "assess"; clause: Clause }
    | { kind: "history"; clause: Clause }
    | { kind: "task"; clause: Clause }
    | { kind: "import" }
    | { kind: "evidence"; clause: Clause }
    | { kind: "review"; clause: Clause }
    | { kind: "dismiss"; clause: Clause }
    | { kind: "snapshot" }
    | null
  >(null);
  const [q, setQ] = useState(filters.q);
  const go = (patch: Partial<typeof filters>) => {
    const f = { ...filters, ...patch };
    const params = new URLSearchParams();
    if (f.status) params.set("status", f.status);
    if (f.section) params.set("section", f.section);
    if (f.fundamental) params.set("fundamental", "true");
    if (f.q) params.set("q", f.q);
    if (f.evidence) params.set("evidence", f.evidence);
    if (f.drafts) params.set("drafts", "open");
    router.push(`${base}${params.size ? `?${params}` : ""}`);
  };

  async function setStatus(status: "active" | "archived") {
    try {
      await unwrap(gov().standards[":id"].$patch({ param: { slug, id: standard.id }, json: { status } }));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <GovernanceFrame
      slug={slug}
      title={`${standard.name} (issue ${standard.issue})`}
      description={`${standard.code}${standard.publisher ? ` · ${standard.publisher}` : ""}`}
      actions={
        <>
          <Button variant="outline" asChild>
            <a href={`/api/v1/workspaces/${slug}/governance/standards/${standard.id}/report.csv`}>
              <Download data-icon="inline-start" /> CSV
            </a>
          </Button>
          {canManage && active && summary.total > 0 && (
            <Button variant="outline" onClick={() => setDialog({ kind: "snapshot" })}>
              <Camera data-icon="inline-start" /> Snapshot
            </Button>
          )}
          {canManage && active && (
            <Button variant="outline" onClick={() => setDialog({ kind: "import" })}>
              <Upload data-icon="inline-start" /> Import clauses
            </Button>
          )}
          {canManage && (
            <Button variant="ghost" onClick={() => void setStatus(active ? "archived" : "active")}>
              {active ? "Archive" : "Reinstate"}
            </Button>
          )}
        </>
      }
    >
      <Link
        href={`/${slug}/governance/standards`}
        className="w-fit text-sm text-muted-foreground hover:underline"
      >
        ← All standards
      </Link>
      {!active && (
        <p className="text-sm text-muted-foreground">Archived: assessments are kept and can't change.</p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
        <Stat
          label="Assessed"
          value={`${summary.assessed} of ${summary.total} (${summary.assessedPercent}%)`}
        />
        <Stat label="Open findings" value={String(summary.openFindings)} />
        <Stat
          label="Overdue findings"
          value={String(summary.overdueFindings)}
          warn={summary.overdueFindings > 0}
        />
        <Stat
          label="Fundamentals at risk"
          value={String(summary.fundamentalAtRisk.length)}
          warn={summary.fundamentalAtRisk.length > 0}
        />
        <Stat
          label="Evidence gaps"
          value={`${summary.evidenceGaps.length} of ${summary.clausesWithEvidence} checked`}
          warn={summary.evidenceGaps.length > 0}
        />
        <Stat
          label="Conflicts"
          value={String(summary.conflicts.length)}
          warn={summary.conflicts.length > 0}
        />
        <Stat label="Drafts to review" value={String(summary.openDrafts)} />
      </dl>
      {summary.conflicts.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="size-4" />
          Assessed compliant, but the evidence shows a gap: {summary.conflicts.join(", ")}
        </p>
      )}
      {summary.fundamentalAtRisk.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="size-4" />
          Fundamental clauses not yet compliant: {summary.fundamentalAtRisk.join(", ")}
        </p>
      )}

      {summary.total === 0 ? (
        <p className="text-sm text-muted-foreground">
          No clauses yet. {canManage ? "Import them from your licensed copy of the standard." : ""}
        </p>
      ) : (
        <>
          <Card className="overflow-x-auto py-0">
            <table className="w-full min-w-[44rem] border-collapse text-sm tabular-nums">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Section</th>
                  {clauseAssessmentStatuses.map((s) => (
                    <th key={s} className="px-3 py-2 text-right font-medium">
                      {clauseAssessmentLabels[s]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.sections.map((s) => (
                  <tr key={s.section} className="border-b last:border-b-0">
                    <td className="px-3 py-1.5">
                      <button
                        type="button"
                        className="hover:underline"
                        onClick={() => go({ section: s.section })}
                      >
                        {s.section}
                        {s.title ? ` ${s.title}` : ""}
                      </button>
                    </td>
                    {clauseAssessmentStatuses.map((st) => (
                      <td
                        key={st}
                        className={`px-3 py-1.5 text-right ${(st === "gap" || st === "partial") && s.counts[st] ? "font-medium text-destructive" : ""}`}
                      >
                        {s.counts[st] || ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={filters.status || ALL} onValueChange={(v) => go({ status: v === ALL ? "" : v })}>
              <SelectTrigger aria-label="Status" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>Every status</SelectItem>
                  {clauseAssessmentStatuses.map((s) => (
                    <SelectItem key={s} value={s}>
                      {clauseAssessmentLabels[s]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select value={filters.section || ALL} onValueChange={(v) => go({ section: v === ALL ? "" : v })}>
              <SelectTrigger aria-label="Section" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>Every section</SelectItem>
                  {summary.sections.map((s) => (
                    <SelectItem key={s.section} value={s.section}>
                      {s.section}
                      {s.title ? ` ${s.title}` : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant={filters.fundamental ? "default" : "outline"}
              size="sm"
              onClick={() => go({ fundamental: !filters.fundamental })}
            >
              Fundamental only
            </Button>
            <Button
              variant={filters.drafts ? "default" : "outline"}
              size="sm"
              onClick={() => go({ drafts: !filters.drafts })}
            >
              Drafts to review
            </Button>
            <Select
              value={filters.evidence || ALL}
              onValueChange={(v) => go({ evidence: v === ALL ? "" : v })}
            >
              <SelectTrigger aria-label="Evidence" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>Any evidence</SelectItem>
                  <SelectItem value="gap">Evidence gaps</SelectItem>
                  <SelectItem value="conflict">Conflicts</SelectItem>
                  <SelectItem value="none">No checks mapped</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                go({ q });
              }}
            >
              <Input
                aria-label="Search clauses"
                placeholder="Search clauses"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-56"
              />
            </form>
            <span className="text-sm text-muted-foreground">
              {clauses.length} of {summary.total}
            </span>
          </div>

          <ul className="flex flex-col gap-2">
            {clauses.map((c) => (
              <ClauseRow
                key={c.id}
                clause={c}
                canAssess={canWrite && active}
                canTask={canWrite && teams.length > 0 && openFindingStatuses.includes(c.status)}
                onAssess={() => setDialog({ kind: "assess", clause: c })}
                onHistory={() => setDialog({ kind: "history", clause: c })}
                onTask={() => setDialog({ kind: "task", clause: c })}
                canMap={canManage && active}
                onMap={() => setDialog({ kind: "evidence", clause: c })}
                canReview={canWrite && active}
                canDismiss={canWrite}
                onReview={() => setDialog({ kind: "review", clause: c })}
                onDismiss={() => setDialog({ kind: "dismiss", clause: c })}
              />
            ))}
          </ul>
        </>
      )}

      {snapshots.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Snapshots</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {snapshots.map((s) => (
              <li key={s.id}>
                <Link href={`${base}/snapshots/${s.id}`} className="hover:underline">
                  {s.label}
                </Link>
                <span className="text-muted-foreground">
                  {" "}
                  · {s.takenOn}
                  {s.takenByName ? ` · ${s.takenByName}` : ""} · {s.clauseCount} clauses
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog?.kind === "assess" && (
        <AssessDialog slug={slug} today={today} clause={dialog.clause} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "review" && dialog.clause.draft && (
        <AssessDialog
          slug={slug}
          today={today}
          clause={dialog.clause}
          draft={dialog.clause.draft}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "dismiss" && dialog.clause.draft && (
        <DismissDialog slug={slug} clause={dialog.clause} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "snapshot" && (
        <SnapshotDialog slug={slug} standardId={standard.id} today={today} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "history" && (
        <HistoryDialog slug={slug} clause={dialog.clause} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "task" && (
        <TaskDialog slug={slug} clause={dialog.clause} teams={teams} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "evidence" && (
        <EvidenceDialog slug={slug} clause={dialog.clause} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "import" && (
        <ImportDialog slug={slug} standardId={standard.id} onClose={() => setDialog(null)} />
      )}
    </GovernanceFrame>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium tabular-nums ${warn ? "text-destructive" : ""}`}>{value}</dd>
    </div>
  );
}

function ClauseRow({
  clause: c,
  canAssess,
  canTask,
  onAssess,
  onHistory,
  onTask,
  canMap,
  onMap,
  canReview,
  canDismiss,
  onReview,
  onDismiss,
}: {
  clause: Clause;
  canAssess: boolean;
  canTask: boolean;
  onAssess: () => void;
  onHistory: () => void;
  onTask: () => void;
  canMap: boolean;
  onMap: () => void;
  canReview: boolean;
  canDismiss: boolean;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const a = c.assessment;
  return (
    <li className="rounded-md border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{c.ref}</span>
            <span className="font-medium">{c.title}</span>
            {c.fundamental && <Badge variant="outline">Fundamental</Badge>}
            <StatusBadge status={c.status} />
            {c.conflict && (
              <Badge className="border-transparent bg-label-red-bg text-label-red">
                Evidence contradicts
              </Badge>
            )}
          </div>
          {a?.note && <p className="text-muted-foreground">{a.note}</p>}
          {a && openFindingStatuses.includes(a.status) && (
            <p className={a.overdue ? "text-destructive" : "text-muted-foreground"}>
              {a.ownerName ?? "No owner"} · due {a.dueOn}
              {a.overdue && " (overdue)"}
            </p>
          )}
          {c.evidence.length > 0 && <EvidenceList evidence={c.evidence} />}
          {c.draft && (
            <div className="flex flex-col gap-1 rounded-md border border-dashed px-3 py-2">
              <p>
                <span className="font-medium">Draft finding: {clauseAssessmentLabels[c.draft.status]}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {c.draft.draftedVia === "agent" ? "drafted by an agent for " : "drafted by "}
                  {c.draft.draftedByName ?? "someone"} · not recorded until accepted
                </span>
              </p>
              <p>{c.draft.note}</p>
              {c.draft.rationale && <p className="text-muted-foreground">Basis: {c.draft.rationale}</p>}
              {(canReview || canDismiss) && (
                <div className="flex gap-1">
                  {canReview && (
                    <Button size="sm" variant="outline" onClick={onReview}>
                      Review draft
                    </Button>
                  )}
                  {canDismiss && (
                    <Button size="sm" variant="ghost" onClick={onDismiss}>
                      Dismiss
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {c.tasks.map((t) => (
            <p key={t.id} className="text-muted-foreground">
              Task: {t.title} · {t.state}
            </p>
          ))}
          {c.text && (
            <button
              type="button"
              className="w-fit text-xs text-muted-foreground underline"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Hide clause text" : "Show clause text"}
            </button>
          )}
          {open && c.text && <p className="whitespace-pre-wrap">{c.text}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          {canAssess && (
            <Button size="sm" variant="outline" onClick={onAssess}>
              Assess
            </Button>
          )}
          {canTask && (
            <Button size="sm" variant="outline" onClick={onTask}>
              Raise task
            </Button>
          )}
          {canMap && (
            <Button size="sm" variant="ghost" onClick={onMap}>
              Evidence
            </Button>
          )}
          {a && (
            <Button size="sm" variant="ghost" onClick={onHistory}>
              History
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function Shell({
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
  wide,
  children,
}: {
  title: string;
  description: string;
  submitLabel?: string;
  onSubmit?: (commandId: string, form: FormData) => Promise<string | null>;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [commandId] = useState(() => crypto.randomUUID());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!onSubmit) return;
    const form = new FormData(e.currentTarget);
    setPending(true);
    try {
      const message = await onSubmit(commandId, form);
      if (message !== null) {
        toast.success(message);
        onClose();
        router.refresh();
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={wide ? "sm:max-w-2xl" : "sm:max-w-lg"}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="max-h-[60vh] overflow-y-auto py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            {submitLabel && (
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                {submitLabel}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssessDialog({
  slug,
  today,
  clause,
  draft,
  onClose,
}: {
  slug: string;
  today: string;
  clause: Clause;
  /** Reviewing a drafted finding: its wording, owner and date are offered, never its finding. */
  draft?: NonNullable<Clause["draft"]>;
  onClose: () => void;
}) {
  // No default finding, even from a draft: compliance is an explicit choice, never a click-through.
  const [status, setStatus] = useState<ClauseAssessmentStatus | "">("");
  const [owner, setOwner] = useState<string | null>(
    draft?.ownerUserId ?? clause.assessment?.ownerUserId ?? null,
  );
  const finding = status !== "" && openFindingStatuses.includes(status);
  return (
    <Shell
      title={`${draft ? "Review draft for" : "Assess"} ${clause.ref} ${clause.title}`}
      description={
        draft
          ? "Accepting records your own assessment: choose the finding yourself and change anything you disagree with. The draft is kept with the clause's history."
          : "Your judgement against the clause, with the evidence you looked at. It's added to the clause's history; earlier assessments stay."
      }
      submitLabel={draft ? "Accept as my assessment" : "Record assessment"}
      onClose={onClose}
      onSubmit={async (commandId, form) => {
        if (!status) throw new Error("Choose a finding");
        const json = {
          commandId,
          status,
          note: String(form.get("note") ?? "").trim(),
          ...(finding ? { ownerUserId: owner, dueOn: String(form.get("due") ?? "") || null } : {}),
        };
        if (draft) {
          await unwrap(gov().drafts[":id"].accept.$post({ param: { slug, id: draft.id }, json }));
          return "Draft accepted as your assessment";
        }
        await unwrap(gov().clauses[":id"].assessments.$post({ param: { slug, id: clause.id }, json }));
        return "Assessment recorded";
      }}
    >
      {draft && (
        <div className="flex flex-col gap-1 rounded-md border border-dashed p-3 text-sm">
          <p className="font-medium">Proposed: {clauseAssessmentLabels[draft.status]}</p>
          {draft.rationale && <p className="text-muted-foreground">Basis: {draft.rationale}</p>}
        </div>
      )}
      {clause.text && (
        <p className="max-h-40 overflow-y-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
          {clause.text}
        </p>
      )}
      <Field>
        <FieldLabel id="as-status">Finding</FieldLabel>
        <Select value={status} onValueChange={(v) => setStatus(v as ClauseAssessmentStatus)}>
          <SelectTrigger aria-labelledby="as-status" className="w-full">
            <SelectValue placeholder="Choose a finding" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {clauseAssessmentStatuses
                .filter((s) => s !== "not_assessed")
                .map((s) => (
                  <SelectItem key={s} value={s}>
                    {clauseAssessmentLabels[s]}
                  </SelectItem>
                ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="as-note">
          {status === "not_applicable"
            ? "Why it doesn't apply"
            : status === "compliant"
              ? "Evidence (optional)"
              : "What was found"}
        </FieldLabel>
        <Textarea
          id="as-note"
          name="note"
          maxLength={4000}
          required={status !== "compliant" && status !== ""}
          defaultValue={draft?.note ?? clause.assessment?.note ?? ""}
        />
      </Field>
      {finding && (
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Owner</FieldLabel>
            <MemberSelect label="Owner" value={owner} onChange={setOwner} />
          </Field>
          <Field>
            <FieldLabel htmlFor="as-due">Close by</FieldLabel>
            <Input
              id="as-due"
              name="due"
              type="date"
              required
              min={today}
              defaultValue={draft?.dueOn ?? clause.assessment?.dueOn ?? ""}
            />
          </Field>
        </div>
      )}
    </Shell>
  );
}

type History = {
  id: string;
  status: ClauseAssessmentStatus;
  note: string | null;
  ownerName: string | null;
  dueOn: string | null;
  assessedByName: string | null;
  assessedAt: string;
};

function HistoryDialog({ slug, clause, onClose }: { slug: string; clause: Clause; onClose: () => void }) {
  const dateTime = useFormatDateTime();
  const [history, setHistory] = useState<History[] | null>(null);
  useEffect(() => {
    let live = true;
    void unwrap(gov().clauses[":id"].$get({ param: { slug, id: clause.id } }))
      .then((r) => live && setHistory(r.history as unknown as History[]))
      .catch((err) => live && toast.error(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [slug, clause.id]);
  return (
    <Shell
      wide
      title={`History of ${clause.ref} ${clause.title}`}
      description="Every assessment, newest first."
      onClose={onClose}
    >
      {history === null ? (
        <Spinner />
      ) : (
        <ol className="flex flex-col divide-y text-sm">
          {history.map((h) => (
            <li key={h.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge status={h.status} />
                <span className="text-muted-foreground">
                  {h.assessedByName ?? "Someone"} · {dateTime(h.assessedAt)}
                </span>
              </span>
              {h.note && <span>{h.note}</span>}
              {h.dueOn && (
                <span className="text-muted-foreground">
                  {h.ownerName ?? "No owner"} · due {h.dueOn}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </Shell>
  );
}

function TaskDialog({
  slug,
  clause,
  teams,
  onClose,
}: {
  slug: string;
  clause: Clause;
  teams: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  return (
    <Shell
      title={`Raise a task for ${clause.ref}`}
      description="A task to close the finding, titled with the clause and assigned to its owner by the finding's date."
      submitLabel="Raise task"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(gov().clauses[":id"].tasks.$post({ param: { slug, id: clause.id }, json: { teamId } }));
        return "Task raised";
      }}
    >
      <Field>
        <FieldLabel id="tk-team">Team</FieldLabel>
        <Select value={teamId} onValueChange={setTeamId}>
          <SelectTrigger aria-labelledby="tk-team" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </Shell>
  );
}

function ImportDialog({
  slug,
  standardId,
  onClose,
}: {
  slug: string;
  standardId: string;
  onClose: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [errors, setErrors] = useState<{ line: number; message: string }[]>([]);
  return (
    <Shell
      wide
      title="Import clauses"
      description="From your own licensed copy of the standard, as CSV with a header row: clause and title (required), then text, section, section title and fundamental (yes/no), in any order. New clauses are added and existing ones corrected; an error anywhere changes nothing."
      submitLabel="Import"
      onClose={onClose}
      onSubmit={async () => {
        const r = await unwrap(
          gov().standards[":id"].clauses.import.$post({ param: { slug, id: standardId }, json: { csv } }),
        );
        if (r.errors.length) {
          setErrors(r.errors);
          return null;
        }
        return `${r.added} added, ${r.updated} corrected, ${r.unchanged} unchanged`;
      }}
    >
      <Field>
        <FieldLabel htmlFor="im-file">CSV file</FieldLabel>
        <Input
          id="im-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void file.text().then(setCsv);
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="im-text">Or paste it</FieldLabel>
        <Textarea
          id="im-text"
          rows={8}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          required
          className="font-mono text-xs"
        />
      </Field>
      {errors.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-destructive">
          {errors.slice(0, 20).map((e) => (
            <li key={`${e.line}-${e.message}`}>
              Line {e.line}: {e.message}
            </li>
          ))}
          {errors.length > 20 && <li>…and {errors.length - 20} more</li>}
        </ul>
      )}
    </Shell>
  );
}

const evidenceTone: Record<EvidenceCheckStatus, string> = {
  met: "text-label-green",
  gap: "text-destructive",
  no_data: "text-muted-foreground",
  unavailable: "text-muted-foreground",
};

/** A clause's mapped evidence checks and their live results; a gap lists the records behind it. */
export function EvidenceList({ evidence }: { evidence: Clause["evidence"] }) {
  return (
    <ul className="flex flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2">
      {evidence.map((e) => (
        <li key={e.id} className="flex flex-col">
          <span>
            <span className={`font-medium ${evidenceTone[e.status]}`}>
              {evidenceCheckStatusLabels[e.status]}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {e.label}: {e.detail}
            </span>
          </span>
          {e.status === "gap" && e.items.length > 0 && (
            <span className="pl-3 text-xs text-muted-foreground">
              {e.items.map((i) => (i.detail ? `${i.label} (${i.detail})` : i.label)).join("; ")}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Which automatic evidence checks support a clause: a manager's judgement, replacing the set. */
function EvidenceDialog({ slug, clause, onClose }: { slug: string; clause: Clause; onClose: () => void }) {
  const [chosen, setChosen] = useState<Set<EvidenceCheckId>>(new Set(clause.evidence.map((e) => e.id)));
  return (
    <Shell
      wide
      title={`Evidence for ${clause.ref} ${clause.title}`}
      description="Choose the checks whose live records support this clause. A clause assessed compliant while one of them shows a gap is flagged."
      submitLabel="Save"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          gov().clauses[":id"].evidence.$put({
            param: { slug, id: clause.id },
            json: { checkIds: [...chosen] },
          }),
        );
        return "Evidence mapping saved";
      }}
    >
      {clause.text && (
        <p className="max-h-32 overflow-y-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
          {clause.text}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {evidenceCheckIds.map((id) => {
          const def = evidenceChecks[id];
          return (
            <li key={id} className="flex items-start gap-2 text-sm">
              <input
                id={`ev-${id}`}
                type="checkbox"
                className="mt-1"
                checked={chosen.has(id)}
                onChange={(e) =>
                  setChosen((c) => {
                    const next = new Set(c);
                    if (e.target.checked) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
              />
              <label htmlFor={`ev-${id}`} className="flex flex-col">
                <span className="font-medium">{def.label}</span>
                <span className="text-muted-foreground">{def.description}</span>
                <span className="text-xs text-muted-foreground">Topics: {def.topics.join(", ")}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

/** Dismisses a drafted finding; the clause's status stays as it is. */
function DismissDialog({ slug, clause, onClose }: { slug: string; clause: Clause; onClose: () => void }) {
  const draft = clause.draft!;
  return (
    <Shell
      title={`Dismiss draft for ${clause.ref}`}
      description={`Proposed: ${clauseAssessmentLabels[draft.status]}. "${draft.note}". The clause's status doesn't change.`}
      submitLabel="Dismiss draft"
      onClose={onClose}
      onSubmit={async (_commandId, form) => {
        await unwrap(
          gov().drafts[":id"].dismiss.$post({
            param: { slug, id: draft.id },
            json: { reason: String(form.get("reason") ?? "").trim() },
          }),
        );
        return "Draft dismissed";
      }}
    >
      <Field>
        <FieldLabel htmlFor="dm-reason">Why (optional)</FieldLabel>
        <Textarea id="dm-reason" name="reason" maxLength={1000} />
      </Field>
    </Shell>
  );
}

/** Freezes the gap analysis as it stands, e.g. before an audit. */
function SnapshotDialog({
  slug,
  standardId,
  today,
  onClose,
}: {
  slug: string;
  standardId: string;
  today: string;
  onClose: () => void;
}) {
  return (
    <Shell
      title="Take a snapshot"
      description="A frozen copy of every clause's status, finding and evidence as it stands now. It is never edited; open it later to see what has changed since."
      submitLabel="Take snapshot"
      onClose={onClose}
      onSubmit={async (_commandId, form) => {
        await unwrap(
          gov().standards[":id"].snapshots.$post({
            param: { slug, id: standardId },
            json: { label: String(form.get("label") ?? "").trim() },
          }),
        );
        return "Snapshot taken";
      }}
    >
      <Field>
        <FieldLabel htmlFor="sn-label">Name</FieldLabel>
        <Input id="sn-label" name="label" required maxLength={120} defaultValue={`Pre-audit ${today}`} />
      </Field>
    </Shell>
  );
}
