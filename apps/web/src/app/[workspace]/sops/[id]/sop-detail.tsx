"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  DEFAULT_SOP_ACK_REMINDER_DAYS,
  DEFAULT_SOP_REVIEW_INTERVAL_MONTHS,
  docToPlainText,
  type DocContent,
} from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Check, Pencil, Printer, Save, Send } from "lucide-react";
import Link from "next/link";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DocEditor } from "@/components/doc-editor/doc-editor";
import { DocRenderer } from "@/components/doc-renderer";
import { ControlledCopies } from "./sop-copies";
import { SopFlagBadge, SopReviewBadge, SopVersionStatusBadge } from "@/components/sop-badges";
import type { JobRole, SopAcknowledgements, SopCopyRow, SopDetail, SopTargets } from "@/lib/api";
import { ApiError, browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

/** A history row: version-in-review rows are redacted for read-only members, so most fields are optional. */
interface Version {
  id: string;
  versionNumber: number;
  status: "approved" | "rejected" | "in_review" | "superseded";
  submittedBy: string | null;
  submittedAt: string;
  title?: string;
  changeSummary?: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
  effectiveOn?: string | null;
}

const day = (value: string | null | undefined) => (value ? formatLongDate(value) : "—");
const sopsApi = () => browserApi().v1.workspaces[":slug"].sops;

/** One SOP: the current version, the draft and review (editors and approvers), history and acknowledgements. */
export function SopDetailView({
  slug,
  sop,
  acknowledgements,
  targets,
  jobRoles,
  copies,
}: {
  slug: string;
  sop: SopDetail;
  acknowledgements: SopAcknowledgements | null;
  targets: SopTargets | null;
  jobRoles: JobRole[];
  copies: SopCopyRow[];
}) {
  const today = useWorkspaceToday();
  const { can, idx } = useWorkspace();
  const canWrite = can("sops", "write");
  const canManage = can("sops", "manage");
  const [editingDetails, setEditingDetails] = useState(false);
  const name = (id: string | null | undefined) => (id ? (idx.users.get(id)?.name ?? "Unknown") : "—");
  const current = sop.currentVersion;
  const review = sop.inReviewVersion;
  const hasReviewTab = canWrite && sop.inReview;

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{sop.code}</span>
            {sop.category && <span>· {sop.category}</span>}
            {sop.ownerId && <span>· Owner {name(sop.ownerId)}</span>}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{sop.title}</h1>
          <div className="flex flex-wrap gap-1.5">
            {sop.status === "archived" && <SopFlagBadge kind="archived" />}
            {sop.inReview && <SopFlagBadge kind="in_review" />}
            {sop.hasDraft && canWrite && <SopFlagBadge kind="draft" />}
            {sop.acknowledged && <SopFlagBadge kind="acknowledged" />}
            <SopReviewBadge reviewDueOn={current?.reviewDueOn} />
          </div>
        </div>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={() => setEditingDetails(true)}>
            <Pencil data-icon="inline-start" /> Details
          </Button>
        )}
      </div>

      <Tabs defaultValue={hasReviewTab && canManage ? "review" : "current"}>
        <TabsList>
          <TabsTrigger value="current">Current version</TabsTrigger>
          {canWrite && <TabsTrigger value="draft">Draft</TabsTrigger>}
          {hasReviewTab && <TabsTrigger value="review">In review</TabsTrigger>}
          <TabsTrigger value="history">History</TabsTrigger>
          {canManage && <TabsTrigger value="acknowledgements">Acknowledgements</TabsTrigger>}
          {canManage && <TabsTrigger value="copies">Controlled copies</TabsTrigger>}
        </TabsList>

        <TabsContent value="current" className="flex flex-col gap-4 pt-4">
          {current ? (
            <>
              <Card className="flex flex-col gap-3 p-4 text-sm">
                <div className="grid gap-x-6 gap-y-2 sm:grid-cols-4">
                  <Fact label="Version" value={`v${current.versionNumber}`} />
                  <Fact
                    label="Effective"
                    value={`${day(current.effectiveOn)}${current.effectiveOn && current.effectiveOn > today ? " (not yet)" : ""}`}
                  />
                  <Fact label="Review due" value={day(current.reviewDueOn)} />
                  <Fact label="Approved by" value={`${name(current.decidedBy)}, ${day(current.decidedAt)}`} />
                </div>
                <p className="text-muted-foreground">Change: {current.changeSummary}</p>
                <AcknowledgeBar slug={slug} sop={sop} />
                <div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/${slug}/sops/${sop.id}/print`}>
                      <Printer data-icon="inline-start" /> Print or save as PDF
                    </Link>
                  </Button>
                </div>
              </Card>
              <DocRenderer className="max-w-prose" content={current.content as DocContent} />
            </>
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              This SOP has no approved version yet.
              {canWrite ? " Write a draft and submit it for review." : ""}
            </p>
          )}
        </TabsContent>

        {canWrite && (
          <TabsContent value="draft" className="pt-4">
            <DraftPanel slug={slug} sop={sop} />
          </TabsContent>
        )}

        {hasReviewTab && (
          <TabsContent value="review" className="flex flex-col gap-4 pt-4">
            {review ? (
              <>
                <Card className="flex flex-col gap-3 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      Version {review.versionNumber} <SopVersionStatusBadge status={review.status} />
                    </span>
                    {canManage && <DecisionButtons slug={slug} sop={sop} version={review} />}
                  </div>
                  <p>
                    <span className="text-muted-foreground">Submitted by</span> {name(review.submittedBy)},{" "}
                    {day(review.submittedAt)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">What changed:</span> {review.changeSummary}
                  </p>
                  {!canManage && (
                    <p className="text-muted-foreground">
                      Someone with manage access to SOPs approves or rejects it.
                    </p>
                  )}
                </Card>
                <h2 className="text-lg font-semibold">{review.title}</h2>
                <DocRenderer className="max-w-prose" content={review.content as DocContent} />
              </>
            ) : null}
          </TabsContent>
        )}

        <TabsContent value="history" className="pt-4">
          <History slug={slug} sop={sop} name={name} />
        </TabsContent>

        {canManage && (
          <TabsContent value="acknowledgements" className="flex flex-col gap-6 pt-4">
            <TargetsPanel slug={slug} sop={sop} targets={targets} jobRoles={jobRoles} />
            <Acknowledgements data={acknowledgements} />
          </TabsContent>
        )}

        {canManage && (
          <TabsContent value="copies" className="pt-4">
            <ControlledCopies slug={slug} sop={sop} copies={copies} />
          </TabsContent>
        )}
      </Tabs>

      {editingDetails && <DetailsDialog slug={slug} sop={sop} onClose={() => setEditingDetails(false)} />}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

// ─── Acknowledge ─────────────────────────────────────────────────────────────

function AcknowledgeBar({ slug, sop }: { slug: string; sop: SopDetail }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  if (!sop.currentVersion || sop.status === "archived") return null;
  const versionId = sop.currentVersion.id;
  if (sop.acknowledged) {
    return (
      <p className="flex items-center gap-1.5 text-label-green">
        <Check className="size-4" /> You have read and understood this version.
      </p>
    );
  }
  const notRequired = !sop.required;
  async function acknowledge() {
    setPending(true);
    try {
      await unwrap(sopsApi()[":id"].acknowledge.$post({ param: { slug, id: sop.id }, json: { versionId } }));
      toast.success("Recorded: read and understood");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <Button size="sm" onClick={acknowledge} disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}I have read and
        understood this
      </Button>
      {notRequired && (
        <p className="mt-1 text-xs text-muted-foreground">
          This SOP is aimed at other people, so you are not required to, but you may.
        </p>
      )}
    </div>
  );
}

// ─── Draft ───────────────────────────────────────────────────────────────────

function DraftPanel({ slug, sop }: { slug: string; sop: SopDetail }) {
  const router = useRouter();
  const [hasDraft, setHasDraft] = useState(sop.draft !== null);
  // Bumped to remount the editor when a different draft is loaded into it.
  const [generation, setGeneration] = useState(0);
  const [title, setTitle] = useState(sop.draft?.title ?? sop.title);
  const [content, setContent] = useState<DocContent | null>((sop.draft?.content as DocContent) ?? null);
  const [stamp, setStamp] = useState<string | null>(sop.draftUpdatedAt);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<null | {
    title: string;
    content: DocContent | null;
    updatedAt: string | null;
  }>(null);
  const [submitting, setSubmitting] = useState(false);
  const archived = sop.status === "archived";

  function load(next: { title: string; content: DocContent | null; updatedAt: string | null }) {
    setTitle(next.title);
    setContent(next.content);
    setStamp(next.updatedAt);
    setHasDraft(next.content !== null);
    setDirty(false);
    setConflict(null);
    setGeneration((g) => g + 1);
  }

  /** Saves the working copy; returns the new draft stamp, or `undefined` when it was not saved. */
  async function save(body: { content: DocContent | null; title?: string } = { content, title }) {
    setSaving(true);
    try {
      const saved = await unwrap(
        sopsApi()[":id"].draft.$put({
          param: { slug, id: sop.id },
          json: { ...body, expectedDraftUpdatedAt: stamp },
        }),
      );
      setStamp(saved.draftUpdatedAt);
      setDirty(false);
      setConflict(null);
      router.refresh();
      return { stamp: saved.draftUpdatedAt };
    } catch (err) {
      if (err instanceof ApiError && err.code === "draft_conflict") {
        setConflict((err.details as { current: NonNullable<typeof conflict> }).current);
      } else {
        toast.error(errorMessage(err));
      }
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  async function startFromCurrent() {
    const base = (sop.currentVersion?.content as DocContent | undefined) ?? {
      type: "doc" as const,
      content: [],
    };
    const nextTitle = sop.currentVersion?.title ?? sop.title;
    const saved = await save({ content: base, title: nextTitle });
    if (saved) load({ title: nextTitle, content: base, updatedAt: saved.stamp });
  }

  async function discard() {
    if (!window.confirm("Discard this draft? The approved version is not affected.")) return;
    const saved = await save({ content: null });
    if (saved) load({ title: sop.title, content: null, updatedAt: saved.stamp });
  }

  if (archived) {
    return <p className="text-sm text-muted-foreground">This SOP is archived. Reactivate it to edit.</p>;
  }

  if (!hasDraft && !content) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed px-4 py-8 text-sm">
        <p className="text-muted-foreground">
          There is no draft in progress.
          {sop.currentVersion
            ? " Start from the current version to propose a change."
            : " Start the first version."}
        </p>
        <Button
          size="sm"
          disabled={saving}
          onClick={() =>
            sop.currentVersion
              ? void startFromCurrent()
              : void (async () => {
                  const empty = {
                    type: "doc" as const,
                    content: [{ type: "paragraph" as const }],
                  } as DocContent;
                  const saved = await save({ content: empty, title: sop.title });
                  if (saved) load({ title: sop.title, content: empty, updatedAt: saved.stamp });
                })()
          }
        >
          <Pencil data-icon="inline-start" />{" "}
          {sop.currentVersion ? "Start from current version" : "Start a draft"}
        </Button>
      </div>
    );
  }

  const empty = !content || docToPlainText(content).trim() === "";
  const blockedByReview = sop.inReview;

  return (
    <div className="flex flex-col gap-3">
      {conflict && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            Someone else saved this draft while you were editing. Your changes were not saved.
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                load({ title: conflict.title, content: conflict.content, updatedAt: conflict.updatedAt })
              }
            >
              Load their version
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-64 flex-1">
          <FieldLabel htmlFor="sop-draft-title">Title of the next version</FieldLabel>
          <Input
            id="sop-draft-title"
            maxLength={300}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Button variant="outline" onClick={() => void save()} disabled={!dirty || saving || !title.trim()}>
          {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          {dirty ? "Save draft" : "Saved"}
        </Button>
        <Button
          onClick={() => setSubmitting(true)}
          disabled={dirty || saving || empty || blockedByReview}
          title={
            blockedByReview
              ? "A version is already waiting for review"
              : dirty
                ? "Save the draft first"
                : undefined
          }
        >
          <Send data-icon="inline-start" /> Submit for review
        </Button>
        <Button variant="ghost" onClick={() => void discard()} disabled={saving}>
          Discard draft
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Editing a draft does not change the approved version. Paste, drop or insert images (PNG, JPEG, GIF or
        WebP): they belong to this SOP, and once a version uses one it can't be deleted.
        {blockedByReview && " A version is waiting for review; you can keep working on the draft meanwhile."}
      </p>
      <Card className="p-4">
        <DocEditor
          key={generation}
          content={content}
          placeholder="Write the procedure…"
          images={{ entityType: "sop", entityId: sop.id, kind: "photo" }}
          onChange={(next) => {
            setContent(next);
            setDirty(true);
          }}
        />
      </Card>
      {submitting && <SubmitDialog slug={slug} sop={sop} onClose={() => setSubmitting(false)} />}
    </div>
  );
}

function SubmitDialog({ slug, sop, onClose }: { slug: string; sop: SopDetail; onClose: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const v = await unwrap(
        sopsApi()[":id"].submit.$post({
          param: { slug, id: sop.id },
          json: { changeSummary: summary.trim() },
        }),
      );
      toast.success(`Version ${v.versionNumber} submitted for review`);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Submit for review</DialogTitle>
            <DialogDescription>
              The saved draft becomes the next version and waits for someone with manage access to approve it.
              Versions can't be edited once submitted.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="sop-change-summary">What changed and why</FieldLabel>
              <Textarea
                id="sop-change-summary"
                required
                rows={3}
                maxLength={2000}
                autoFocus
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !summary.trim()}>
              {pending && <Spinner data-icon="inline-start" />}
              Submit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Approval ────────────────────────────────────────────────────────────────

function DecisionButtons({
  slug,
  sop,
  version,
}: {
  slug: string;
  sop: SopDetail;
  version: { id: string; versionNumber: number };
}) {
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  return (
    <>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setDeciding("approve")}>
          <Check data-icon="inline-start" /> Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDeciding("reject")}>
          Reject
        </Button>
      </div>
      {deciding && (
        <DecisionDialog
          slug={slug}
          sop={sop}
          version={version}
          decision={deciding}
          onClose={() => setDeciding(null)}
        />
      )}
    </>
  );
}

function DecisionDialog({
  slug,
  sop,
  version,
  decision,
  onClose,
}: {
  slug: string;
  sop: SopDetail;
  version: { id: string; versionNumber: number };
  decision: "approve" | "reject";
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [effectiveOn, setEffectiveOn] = useState(today);
  const [reviewDueOn, setReviewDueOn] = useState("");
  const [note, setNote] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        sopsApi()[":id"].versions[":versionId"].decision.$post({
          param: { slug, id: sop.id, versionId: version.id },
          json:
            decision === "approve"
              ? {
                  decision,
                  effectiveOn,
                  ...(reviewDueOn ? { reviewDueOn } : {}),
                  ...(note.trim() ? { note: note.trim() } : {}),
                }
              : { decision, note: note.trim() },
        }),
      );
      toast.success(
        decision === "approve" ? `Version ${version.versionNumber} approved` : "Version rejected",
      );
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>
              {decision === "approve" ? "Approve" : "Reject"} version {version.versionNumber}
            </DialogTitle>
            <DialogDescription>
              {decision === "approve"
                ? "Your name and the time are recorded. The previous approved version is marked superseded and the draft is cleared."
                : "The draft is kept so the author can rework it."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            {decision === "approve" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="sop-effective">Effective from</FieldLabel>
                  <Input
                    id="sop-effective"
                    type="date"
                    required
                    value={effectiveOn}
                    onChange={(e) => setEffectiveOn(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sop-review-due">Review due</FieldLabel>
                  <Input
                    id="sop-review-due"
                    type="date"
                    min={effectiveOn}
                    value={reviewDueOn}
                    onChange={(e) => setReviewDueOn(e.target.value)}
                  />
                  <FieldDescription>
                    Blank: {sop.reviewIntervalMonths || DEFAULT_SOP_REVIEW_INTERVAL_MONTHS} months after the
                    effective date.
                  </FieldDescription>
                </Field>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="sop-note">
                {decision === "approve" ? "Note (optional)" : "Reason"}
              </FieldLabel>
              <Textarea
                id="sop-note"
                rows={3}
                maxLength={2000}
                required={decision === "reject"}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={decision === "approve" ? "default" : "destructive"}
              disabled={pending || (decision === "reject" && !note.trim())}
            >
              {pending && <Spinner data-icon="inline-start" />}
              {decision === "approve" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── History ─────────────────────────────────────────────────────────────────

function History({
  slug,
  sop,
  name,
}: {
  slug: string;
  sop: SopDetail;
  name: (id: string | null | undefined) => string;
}) {
  const [open, setOpen] = useState<Version | null>(null);
  return (
    <>
      <ul className="flex flex-col divide-y rounded-lg border">
        {(sop.versions as Version[]).map((v) => {
          const full = v.title !== undefined ? v : null;
          return (
            <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <span className="w-10 font-medium">v{v.versionNumber}</span>
              <SopVersionStatusBadge status={v.status} />
              <span className="text-muted-foreground">
                Submitted {day(v.submittedAt)} by {name(v.submittedBy)}
              </span>
              {full?.decidedAt && (
                <span className="text-muted-foreground">
                  · decided {day(full.decidedAt)} by {name(full.decidedBy)}
                </span>
              )}
              {full?.effectiveOn && (
                <span className="text-muted-foreground">· effective {day(full.effectiveOn)}</span>
              )}
              <span className="ml-auto">
                {full ? (
                  <Button variant="ghost" size="sm" onClick={() => setOpen(v)}>
                    View
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">Under review</span>
                )}
              </span>
              {full?.changeSummary && (
                <p className="basis-full text-muted-foreground">{full.changeSummary}</p>
              )}
              {full?.decisionNote && (
                <p className="basis-full text-muted-foreground">Decision note: {full.decisionNote}</p>
              )}
            </li>
          );
        })}
        {sop.versions.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">No versions yet.</li>
        )}
      </ul>
      {open && <VersionDialog slug={slug} sopId={sop.id} version={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function VersionDialog({
  slug,
  sopId,
  version,
  onClose,
}: {
  slug: string;
  sopId: string;
  version: Version;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{ title: string; content: DocContent } | null | "error">(null);
  const [started, setStarted] = useState(false);
  if (!started) {
    setStarted(true);
    unwrap(
      sopsApi()[":id"].versions[":versionId"].$get({ param: { slug, id: sopId, versionId: version.id } }),
    )
      .then((v) => setLoaded({ title: v.title, content: v.content as DocContent }))
      .catch((err) => {
        toast.error(errorMessage(err));
        setLoaded("error");
      });
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Version {version.versionNumber}
            {loaded && loaded !== "error" ? `: ${loaded.title}` : ""}
          </DialogTitle>
          <DialogDescription>
            <SopVersionStatusBadge status={version.status} /> Read-only. Versions are never edited.
          </DialogDescription>
        </DialogHeader>
        {loaded === null ? (
          <Spinner />
        ) : loaded === "error" ? (
          <p className="text-sm text-muted-foreground">This version could not be loaded.</p>
        ) : (
          <DocRenderer content={loaded.content} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Acknowledgements ────────────────────────────────────────────────────────

function Acknowledgements({ data }: { data: SopAcknowledgements | null }) {
  if (!data) {
    return (
      <p className="text-sm text-muted-foreground">
        Acknowledgements are recorded once a version is approved.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground">
        Version {data.versionNumber}: {data.acknowledged.length} acknowledged, {data.pending.length} still to
        read. A new approved version needs fresh acknowledgements.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="gap-2 p-4">
          <h3 className="font-medium">Acknowledged</h3>
          {data.acknowledged.length === 0 && <p className="text-muted-foreground">Nobody yet.</p>}
          <ul className="flex flex-col gap-1">
            {data.acknowledged.map((a) => (
              <li key={a.userId} className="flex justify-between gap-2">
                <span>{a.name}</span>
                <span className="text-muted-foreground">{day(a.acknowledgedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="gap-2 p-4">
          <h3 className="font-medium">Not yet acknowledged</h3>
          {data.pending.length === 0 && <p className="text-muted-foreground">Everyone with access has.</p>}
          <ul className="flex flex-col gap-1">
            {data.pending.map((p) => (
              <li key={p.userId}>{p.name}</li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/** Who must read this SOP: job roles and/or named members; nothing chosen means everyone with access. */
function TargetsPanel({
  slug,
  sop,
  targets,
  jobRoles,
}: {
  slug: string;
  sop: SopDetail;
  targets: SopTargets | null;
  jobRoles: JobRole[];
}) {
  const router = useRouter();
  const { idx } = useWorkspace();
  const [roleIds, setRoleIds] = useState(new Set(targets?.jobRoleIds ?? []));
  const [userIds, setUserIds] = useState(new Set(targets?.userIds ?? []));
  const [pending, setPending] = useState(false);
  const users = [...idx.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };
  async function save() {
    setPending(true);
    try {
      await unwrap(
        sopsApi()[":id"].targets.$put({
          param: { slug, id: sop.id },
          json: { jobRoleIds: [...roleIds], userIds: [...userIds] },
        }),
      );
      toast.success("Saved who must read this SOP");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card className="gap-3 p-4 text-sm">
      <div>
        <h3 className="font-medium">Who must read this</h3>
        <p className="text-muted-foreground">
          Choose job roles and/or named members. With nothing chosen, everyone with access to SOPs must
          acknowledge each new version.{" "}
          {targets?.targeted
            ? `${targets.readers.length} people are expected to.`
            : "Today that is everyone with access."}{" "}
          Reminders go out {sop.ackReminderDays} days after a version takes effect
          {sop.ackReminderRepeatDays ? `, then every ${sop.ackReminderRepeatDays} days` : ""}. People you add
          are told straight away when there is a current version.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 font-medium">Job roles</legend>
          {jobRoles.length === 0 && (
            <p className="text-muted-foreground">No job roles (needs the People module).</p>
          )}
          {jobRoles.map((r) => (
            <label key={r.id} className="flex items-center gap-2">
              <Checkbox
                checked={roleIds.has(r.id)}
                onCheckedChange={() => toggle(roleIds, setRoleIds, r.id)}
              />
              {r.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          <legend className="mb-1 font-medium">Named members</legend>
          {users.map((u) => (
            <label key={u.id} className="flex items-center gap-2">
              <Checkbox
                checked={userIds.has(u.id)}
                onCheckedChange={() => toggle(userIds, setUserIds, u.id)}
              />
              {u.name}
            </label>
          ))}
        </fieldset>
      </div>
      <div>
        <Button size="sm" onClick={() => void save()} disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          Save
        </Button>
      </div>
    </Card>
  );
}

// ─── Details ─────────────────────────────────────────────────────────────────

function DetailsDialog({ slug, sop, onClose }: { slug: string; sop: SopDetail; onClose: () => void }) {
  const router = useRouter();
  const { idx } = useWorkspace();
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState({
    code: sop.code,
    title: sop.title,
    category: sop.category ?? "",
    reviewIntervalMonths: String(sop.reviewIntervalMonths),
    ackReminderDays: String(sop.ackReminderDays),
    ackReminderRepeatDays: sop.ackReminderRepeatDays ? String(sop.ackReminderRepeatDays) : "",
    ownerId: sop.ownerId ?? "none",
  });
  const [status, setStatus] = useState(sop.status);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const neverApproved = !sop.currentVersion && sop.versions.every((v) => v.status !== "superseded");
  const users = [...idx.users.values()].sort((a, b) => a.name.localeCompare(b.name));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        sopsApi()[":id"].$patch({
          param: { slug, id: sop.id },
          json: {
            code: form.code.trim(),
            title: form.title.trim(),
            category: form.category.trim() || null,
            reviewIntervalMonths: Number(form.reviewIntervalMonths) || DEFAULT_SOP_REVIEW_INTERVAL_MONTHS,
            ackReminderDays: Number(form.ackReminderDays) || DEFAULT_SOP_ACK_REMINDER_DAYS,
            ackReminderRepeatDays: Number(form.ackReminderRepeatDays) || null,
            ownerId: form.ownerId === "none" ? null : form.ownerId,
            status,
          },
        }),
      );
      toast.success("Saved");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${sop.code}? This SOP has never been approved.`)) return;
    setPending(true);
    try {
      await unwrapEmpty(sopsApi()[":id"].$delete({ param: { slug, id: sop.id } }));
      toast.success(`${sop.code} deleted`);
      router.push(`/${slug}/sops`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>SOP details</DialogTitle>
            <DialogDescription>
              The title follows the latest approved version. Content changes go through a draft.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field>
                <FieldLabel htmlFor="sop-edit-code">Code</FieldLabel>
                <Input id="sop-edit-code" required maxLength={40} value={form.code} onChange={set("code")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="sop-edit-title">Title</FieldLabel>
                <Input
                  id="sop-edit-title"
                  required
                  maxLength={300}
                  value={form.title}
                  onChange={set("title")}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sop-edit-category">Category</FieldLabel>
                <Input
                  id="sop-edit-category"
                  maxLength={80}
                  value={form.category}
                  onChange={set("category")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sop-edit-interval">Review every (months)</FieldLabel>
                <Input
                  id="sop-edit-interval"
                  type="number"
                  min={1}
                  max={120}
                  value={form.reviewIntervalMonths}
                  onChange={set("reviewIntervalMonths")}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sop-edit-remind">Remind after (days)</FieldLabel>
                <Input
                  id="sop-edit-remind"
                  type="number"
                  min={1}
                  max={365}
                  value={form.ackReminderDays}
                  onChange={set("ackReminderDays")}
                />
                <FieldDescription>
                  Unacknowledged this long after a version takes effect: readers and managers are reminded.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="sop-edit-repeat">Then remind every (days)</FieldLabel>
                <Input
                  id="sop-edit-repeat"
                  type="number"
                  min={1}
                  max={365}
                  placeholder="Don't repeat"
                  value={form.ackReminderRepeatDays}
                  onChange={set("ackReminderRepeatDays")}
                />
                <FieldDescription>
                  Each person still outstanding is reminded again this often. Leave empty for one reminder.
                </FieldDescription>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel id="sop-owner-label">Owner</FieldLabel>
                <Select value={form.ownerId} onValueChange={(v) => setForm((f) => ({ ...f, ownerId: v }))}>
                  <SelectTrigger aria-labelledby="sop-owner-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">No owner</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel id="sop-status-label">Status</FieldLabel>
                <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                  <SelectTrigger aria-labelledby="sop-status-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter className="sm:justify-between">
            {neverApproved ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                onClick={() => void remove()}
                disabled={pending}
              >
                Delete SOP
              </Button>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Save
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
