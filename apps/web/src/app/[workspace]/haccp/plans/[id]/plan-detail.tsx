"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import {
  Archive,
  ArchiveRestore,
  BadgeCheck,
  BookCopy,
  FilePenLine,
  History,
  Printer,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DueStateBadge, HazardBadge, PlanVersionStateBadge } from "@/components/haccp-badges";
import { HaccpDialog } from "@/components/haccp-forms";
import { HazardAnalysis } from "@/components/hazard-analysis";
import type { HaccpLibraryEntry, HaccpPlan, HaccpPlanVersion, HaccpSignoff } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { PlanDraftEditor, type Option } from "./plan-draft-editor";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

const planApi = (slug: string, id: string) => ({
  route: browserApi().v1.workspaces[":slug"].haccp.plans[":id"],
  param: { slug, id },
});

/**
 * One HACCP plan under document control: the version in force, an approved version scheduled to
 * take over on a later date, the draft (edited by anyone with write, approved by a person with
 * manage), and the version history.
 */
export function PlanDetail({
  slug,
  plan,
  viewing,
  signoffs,
  products,
  recipes,
  library,
}: {
  slug: string;
  plan: HaccpPlan;
  /** A replaced version picked from the history. */
  viewing: HaccpPlanVersion | null;
  /** The days a supervisor has signed off, newest first. */
  signoffs: HaccpSignoff[];
  products: Option[];
  recipes: Option[];
  /** The hazard library, to copy hazards into the analysis from. */
  library: HaccpLibraryEntry[];
}) {
  const timeZone = useWorkspaceTimeZone();
  const router = useRouter();
  const { can, viewer } = useWorkspace();
  const canWrite = can("haccp", "write");
  const canManage = can("haccp", "manage");
  const [editing, setEditing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { route, param } = planApi(slug, plan.id);
  const draft = plan.draftVersion;
  const current = plan.currentVersion;
  const upcoming = plan.upcomingVersion;
  const archived = plan.status === "archived";

  async function run(label: string, request: () => Promise<unknown>) {
    setBusy(true);
    try {
      await request();
      toast.success(label);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <PlanDraftEditor
        slug={slug}
        planId={plan.id}
        base={draft ?? upcoming ?? current}
        isNew={!draft}
        products={products}
        recipes={recipes}
        library={library}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="text-sm text-muted-foreground">
            <Link href={`/${slug}/haccp/plans`} className="hover:underline">
              HACCP plans
            </Link>{" "}
            / <span className="font-mono">{plan.code}</span>
          </div>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {plan.name}
            {current && <PlanVersionStateBadge state="in_force" />}
            {archived && <Badge variant="secondary">Archived</Badge>}
          </h2>
          {plan.description && <p className="text-sm text-muted-foreground">{plan.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/${slug}/haccp/plans/${plan.id}/audit`}>
              <Printer data-icon="inline-start" /> Audit record
            </Link>
          </Button>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {!archived && !draft && (
              <Button onClick={() => setEditing(true)} disabled={busy}>
                <FilePenLine data-icon="inline-start" /> {current ? "Revise" : "Start draft"}
              </Button>
            )}
            {(current || draft) && (
              <Button variant="outline" disabled={busy} onClick={() => setTemplating(true)}>
                <BookCopy data-icon="inline-start" /> Save as template
              </Button>
            )}
            {/* Archiving takes the plan out of force: a sign-off, like approval. */}
            {canManage && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(archived ? "Plan restored" : "Plan archived", () =>
                    unwrap(route.status.$post({ param, json: { status: archived ? "active" : "archived" } })),
                  )
                }
              >
                {archived ? (
                  <ArchiveRestore data-icon="inline-start" />
                ) : (
                  <Archive data-icon="inline-start" />
                )}
                {archived ? "Restore" : "Archive"}
              </Button>
            )}
          </div>
        )}
      </div>

      {viewing ? (
        <>
          <Alert>
            <History />
            <AlertTitle>Version {viewing.versionNumber} (replaced)</AlertTitle>
            <AlertDescription>
              Kept for the record; it no longer applies.{" "}
              <Link className="underline" href={`/${slug}/haccp/plans/${plan.id}`}>
                Back to the current version
              </Link>
            </AlertDescription>
          </Alert>
          <VersionCard version={viewing} title={`Version ${viewing.versionNumber}`} />
        </>
      ) : (
        <>
          {(plan.hazardReviewDueOn || (current && current.steps.length > 0)) && (
            <Card className="py-0">
              <CardHeader className="pt-4">
                <CardTitle className="flex items-center gap-2">
                  Hazard analysis review
                  {(plan.hazardReviewState === "overdue" ||
                    plan.hazardReviewState === "due" ||
                    plan.hazardReviewState === "soon") && <DueStateBadge state={plan.hazardReviewState} />}
                </CardTitle>
                <CardDescription>
                  Reviewed every {plan.hazardReviewIntervalEffective} months
                  {plan.hazardReviewIntervalMonths === null ? " (as often as the plan)" : ""}.{" "}
                  {plan.hazardReviewDueOn ? `Next review ${formatLongDate(plan.hazardReviewDueOn)}.` : ""}{" "}
                  {plan.hazardReviewedOn
                    ? `Last reviewed ${formatLongDate(plan.hazardReviewedOn)} by ${plan.hazardReviewedByName ?? "—"}${
                        plan.hazardReviewNote ? `: ${plan.hazardReviewNote}` : ""
                      }.`
                    : ""}
                </CardDescription>
              </CardHeader>
              {canManage && !archived && current && current.steps.length > 0 && (
                <CardContent className="px-4 pb-4">
                  <Button variant="outline" disabled={busy} onClick={() => setReviewing(true)}>
                    <BadgeCheck data-icon="inline-start" /> Record a review
                  </Button>
                </CardContent>
              )}
            </Card>
          )}

          {current ? (
            <VersionCard
              version={current}
              title={`Current version ${current.versionNumber}`}
              description={
                <>
                  Effective {formatLongDate(current.effectiveOn)}
                  {current.inForceUntil ? `, in force until ${formatLongDate(current.inForceUntil)}` : ""} ·
                  review due {formatLongDate(current.reviewDueOn)} · approved by{" "}
                  {current.approvedByName ?? "—"}
                  {current.approvedAt ? ` on ${formatLongDate(current.approvedAt, timeZone)}` : ""}
                  {current.approvalNote ? ` · ${current.approvalNote}` : ""}
                </>
              }
            />
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              {upcoming
                ? "No version is in force yet: nothing is monitored against this plan until the approved version takes effect."
                : "No version has been approved yet: nothing is monitored against this plan."}
            </p>
          )}

          {upcoming && (
            <VersionCard
              version={upcoming}
              title={`Approved version ${upcoming.versionNumber}`}
              description={
                <>
                  Effective from {formatLongDate(upcoming.effectiveOn)}: monitoring moves to its CCPs on that
                  date · approved by {upcoming.approvedByName ?? "—"}
                  {upcoming.approvedAt ? ` on ${formatLongDate(upcoming.approvedAt, timeZone)}` : ""}
                  {upcoming.approvalNote ? ` · ${upcoming.approvalNote}` : ""}
                </>
              }
            />
          )}

          {draft && (
            <VersionCard
              version={draft}
              title={`Draft version ${draft.versionNumber}`}
              description={`Last saved by ${draft.updatedByName ?? "—"}. Takes effect only once approved${
                draft.updatedBy === viewer.id
                  ? ": you last edited it, so another manager must approve it (unless you are the only one)"
                  : ""
              }.`}
              actions={
                <div className="flex flex-wrap gap-2">
                  {canWrite && !archived && (
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
                      <FilePenLine data-icon="inline-start" /> Edit draft
                    </Button>
                  )}
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run("Draft discarded", () => unwrapEmpty(route.draft.$delete({ param })))
                      }
                    >
                      <Trash2 data-icon="inline-start" /> Discard
                    </Button>
                  )}
                  {canManage && !archived && (
                    <Button
                      size="sm"
                      onClick={() => setApproving(true)}
                      disabled={busy || draft.ccps.length === 0}
                    >
                      <BadgeCheck data-icon="inline-start" /> Approve
                    </Button>
                  )}
                </div>
              }
            />
          )}
        </>
      )}

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Approved by</TableHead>
                <TableHead className="pr-4">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="pl-4">
                    {v.state === "replaced" ? (
                      <Link
                        className="hover:underline"
                        href={`/${slug}/haccp/plans/${plan.id}?version=${v.id}`}
                      >
                        v{v.versionNumber}
                      </Link>
                    ) : (
                      `v${v.versionNumber}`
                    )}
                  </TableCell>
                  <TableCell>
                    <PlanVersionStateBadge state={v.state} />
                  </TableCell>
                  <TableCell>
                    {v.effectiveOn
                      ? v.state === "scheduled"
                        ? `From ${formatLongDate(v.effectiveOn)}`
                        : formatLongDate(v.effectiveOn)
                      : "—"}
                    {v.inForceUntil ? ` · until ${formatLongDate(v.inForceUntil)}` : ""}
                  </TableCell>
                  <TableCell>{v.approvedByName ?? "—"}</TableCell>
                  <TableCell className="pr-4 text-muted-foreground">{v.changeNote ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {current && (
        <SignoffCard slug={slug} planId={plan.id} signoffs={signoffs} canSign={canManage && !archived} />
      )}

      {approving && draft && (
        <ApproveDialog
          slug={slug}
          planId={plan.id}
          version={draft.versionNumber}
          hasAnalysis={draft.steps.length > 0}
          onClose={() => setApproving(false)}
        />
      )}
      {reviewing && <HazardReviewDialog slug={slug} planId={plan.id} onClose={() => setReviewing(false)} />}
      {templating && (
        <SaveTemplateDialog
          slug={slug}
          planId={plan.id}
          name={plan.name}
          onClose={() => setTemplating(false)}
        />
      )}
    </div>
  );
}

/** Records that the hazard analysis in force was reviewed, and when it is next due. */
function HazardReviewDialog({
  slug,
  planId,
  onClose,
}: {
  slug: string;
  planId: string;
  onClose: () => void;
}) {
  const [nextDueOn, setNextDueOn] = useState("");
  const [note, setNote] = useState("");
  const { route, param } = planApi(slug, planId);
  return (
    <HaccpDialog
      title="Record a hazard analysis review"
      description="You have reviewed the hazard analysis in force. Your name and today's date are recorded."
      submitLabel="Record review"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          route["hazard-review"].$post({
            param,
            json: {
              ...(nextDueOn ? { nextDueOn } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          }),
        );
        return "Hazard analysis review recorded";
      }}
    >
      <Field>
        <FieldLabel htmlFor="hazard-next">Next review (optional)</FieldLabel>
        <Input
          id="hazard-next"
          className="w-44"
          type="date"
          value={nextDueOn}
          onChange={(e) => setNextDueOn(e.target.value)}
        />
        <FieldDescription>Defaults to the hazard review interval.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="hazard-note">Note (optional)</FieldLabel>
        <Textarea
          id="hazard-note"
          rows={2}
          maxLength={2000}
          placeholder="e.g. No new hazards; supplier list unchanged"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

/** Saves the plan's draft (else its version in force) as a template new plans can start from. */
function SaveTemplateDialog({
  slug,
  planId,
  name: planName,
  onClose,
}: {
  slug: string;
  planId: string;
  name: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(planName);
  return (
    <HaccpDialog
      title="Save as a template"
      description="Copies the plan's hazard analysis and CCPs (not its scope) into the workspace's plan templates. Plans started from it keep their own copy."
      submitLabel="Save template"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          browserApi().v1.workspaces[":slug"].haccp.templates.$post({
            param: { slug },
            json: { name: name.trim(), fromPlanId: planId },
          }),
        );
        return "Template saved";
      }}
    >
      <Field>
        <FieldLabel htmlFor="template-name">Template name</FieldLabel>
        <Input
          id="template-name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

/** A version: its scope and its critical control points. */
function VersionCard({
  version,
  title,
  description,
  actions,
}: {
  version: HaccpPlanVersion;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  const scope = version.scope;
  return (
    <Card className="py-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 pt-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            {title} <PlanVersionStateBadge state={version.state} />
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-0 pb-2">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 px-4 text-sm">
          <dt className="text-muted-foreground">Scope</dt>
          <dd>
            {scope.wholeSite
              ? "Whole site"
              : [
                  ...scope.items.map((i) => `${i.code} ${i.name}`),
                  ...scope.recipes.map((r) => `Recipe ${r.code}`),
                ].join(", ") || "Products or recipes you can't view"}
          </dd>
          {version.scopeNote && (
            <>
              <dt className="text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap">{version.scopeNote}</dd>
            </>
          )}
          {version.changeNote && (
            <>
              <dt className="text-muted-foreground">Change</dt>
              <dd>{version.changeNote}</dd>
            </>
          )}
        </dl>
        <section className="flex flex-col gap-2">
          <h3 className="px-4 text-sm font-medium">Hazard analysis</h3>
          <HazardAnalysis version={version} />
        </section>
        <h3 className="px-4 text-sm font-medium">Critical control points</h3>
        {version.ccps.length === 0 ? (
          <p className="px-4 pb-2 text-sm text-muted-foreground">No critical control points yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">CCP</TableHead>
                  <TableHead>Hazard</TableHead>
                  <TableHead>Critical limit</TableHead>
                  <TableHead>Monitoring</TableHead>
                  <TableHead>Corrective action</TableHead>
                  <TableHead className="pr-4">Verification</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {version.ccps.map((ccp) => (
                  <TableRow key={ccp.id} className="align-top">
                    <TableCell className="pl-4">
                      <div className="font-medium">{ccp.code}</div>
                      <div className="text-muted-foreground">
                        {ccp.stepId
                          ? `Step ${version.steps.findIndex((st) => st.id === ccp.stepId) + 1}: `
                          : ""}
                        {ccp.processStep}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      <HazardBadge type={ccp.hazardType} />
                      <div className="mt-1">{ccp.hazard}</div>
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">{ccp.limitText}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal">
                      <div>{ccp.monitoringMethod}</div>
                      <div className="text-muted-foreground">
                        {ccp.frequencyText}
                        {ccp.duringProduction ? " during production" : ""} · {ccp.responsibleRole}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-normal">{ccp.correctiveAction}</TableCell>
                    <TableCell className="max-w-56 pr-4 whitespace-normal">{ccp.verification}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The sign-off: effective date, review date and a note; recorded with who and when. */
function ApproveDialog({
  slug,
  planId,
  version,
  hasAnalysis,
  onClose,
}: {
  slug: string;
  planId: string;
  version: number;
  /** The draft has a hazard analysis: approving it counts as a review of it. */
  hasAnalysis: boolean;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [effectiveOn, setEffectiveOn] = useState(today);
  const [reviewDueOn, setReviewDueOn] = useState("");
  const [hazardReviewDueOn, setHazardReviewDueOn] = useState("");
  const [note, setNote] = useState("");
  const { route, param } = planApi(slug, planId);
  return (
    <HaccpDialog
      title={`Approve version ${version}`}
      description="It takes effect on its effective date: until then the version in force stays in force and is monitored against. Your name and the time are recorded."
      submitLabel="Approve"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          route.draft.approve.$post({
            param,
            json: {
              effectiveOn,
              ...(reviewDueOn ? { reviewDueOn } : {}),
              ...(hasAnalysis && hazardReviewDueOn ? { hazardReviewDueOn } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          }),
        );
        return `Version ${version} approved`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="approve-effective">Effective from</FieldLabel>
          <Input
            id="approve-effective"
            type="date"
            required
            value={effectiveOn}
            onChange={(e) => setEffectiveOn(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="approve-review">Review due (optional)</FieldLabel>
          <Input
            id="approve-review"
            type="date"
            value={reviewDueOn}
            onChange={(e) => setReviewDueOn(e.target.value)}
          />
          <FieldDescription>Defaults to the plan&apos;s review interval.</FieldDescription>
        </Field>
      </div>
      {hasAnalysis && (
        <Field>
          <FieldLabel htmlFor="approve-hazard-review">Hazard analysis review due (optional)</FieldLabel>
          <Input
            id="approve-hazard-review"
            className="w-44"
            type="date"
            value={hazardReviewDueOn}
            onChange={(e) => setHazardReviewDueOn(e.target.value)}
          />
          <FieldDescription>
            Approving counts as a review of the hazard analysis. Defaults to the hazard review interval.
          </FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="approve-note">Note (optional)</FieldLabel>
        <Textarea
          id="approve-note"
          rows={2}
          maxLength={2000}
          placeholder="e.g. Validated by the HACCP team on 10 Nov"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

/**
 * The supervisor's sign-off of a day's CCP monitoring for this plan: they have looked at every
 * check of the day, the deviations and what was done. Once per plan per day; not while the day
 * still has readings awaiting review. Shown on the audit record.
 */
function SignoffCard({
  slug,
  planId,
  signoffs,
  canSign,
}: {
  slug: string;
  planId: string;
  signoffs: HaccpSignoff[];
  canSign: boolean;
}) {
  const router = useRouter();
  const today = useWorkspaceToday();
  const [day, setDay] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function sign() {
    setBusy(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].haccp.signoffs.$post({
          param: { slug },
          json: { planId, day, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      );
      toast.success(`${day} signed off`);
      setNote("");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="py-0">
      <CardHeader className="pt-4">
        <CardTitle>Daily sign-off</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-0 pb-4">
        {canSign && (
          <div className="flex flex-wrap items-end gap-3 px-4">
            <Field className="w-44">
              <FieldLabel htmlFor="signoff-day">Day</FieldLabel>
              <Input
                id="signoff-day"
                type="date"
                max={today}
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </Field>
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor="signoff-note">Note (optional)</FieldLabel>
              <Input
                id="signoff-note"
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <Button onClick={() => void sign()} disabled={busy || !day}>
              <BadgeCheck data-icon="inline-start" /> Sign off
            </Button>
          </div>
        )}
        {signoffs.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No day has been signed off yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Day</TableHead>
                <TableHead>Checks</TableHead>
                <TableHead>Deviations</TableHead>
                <TableHead>Signed by</TableHead>
                <TableHead className="pr-4">Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {signoffs.slice(0, 14).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4">{formatLongDate(s.day)}</TableCell>
                  <TableCell>
                    {s.checkCount}
                    {s.addedAfter > 0 && (
                      <span className="text-xs text-destructive"> (+{s.addedAfter} added after)</span>
                    )}
                  </TableCell>
                  <TableCell>{s.deviationCount}</TableCell>
                  <TableCell>{s.signedByName ?? "—"}</TableCell>
                  <TableCell className="pr-4 text-muted-foreground">{s.note ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
