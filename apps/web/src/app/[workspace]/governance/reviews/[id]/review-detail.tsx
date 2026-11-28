"use client";

import {
  formatUkDate,
  governanceAgendaTopics,
  governanceObjectiveRagLabels,
  newId,
  type GovernanceAgendaKey,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
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
import { CircleAlert, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { ManagementReview } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";
import { GovernanceNav, MemberSelect } from "../../governance-nav";

type Evidence = ManagementReview["evidence"];
const NONE = "none";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One agenda topic's evidence as short lines, or why it isn't available. */
function evidenceFor(key: GovernanceAgendaKey, e: Evidence): string[] | string {
  switch (key) {
    case "previous_actions":
      return e.previousActions.length
        ? e.previousActions.map(
            (a) =>
              `${a.decision} (${a.review}): ${a.state}${a.dueOn ? `, due ${formatUkDate(a.dueOn)}` : ""}`,
          )
        : ["No actions from earlier signed reviews"];
    case "objectives":
      return [
        `${plural(e.objectives.open, "open objective")}: ${e.objectives.atRisk} at risk, ${e.objectives.offTrack} off track, ${e.objectives.overdue} overdue`,
        `${e.objectives.achievedInPeriod} achieved and ${e.objectives.missedInPeriod} missed in the period`,
        ...e.objectives.list.map(
          (o) =>
            `${o.title}: ${o.rag ? governanceObjectiveRagLabels[o.rag] : "no progress reported"}${o.value ? ` (${o.value})` : ""}`,
        ),
      ];
    case "culture":
      return [
        `${e.culture.doneInPeriod} of ${e.culture.plannedInPeriod} planned activities done in the period; ${e.culture.overdue} overdue`,
        ...e.culture.done.map(
          (a) =>
            `${a.title}${a.participants != null ? `, ${a.participants} took part` : ""}${a.result ? `: ${a.result}` : ""}`,
        ),
      ];
    case "complaints":
      return e.complaints.available
        ? [
            `${plural(e.complaints.received, "complaint")} received, ${e.complaints.justified} justified; ${e.complaints.open} open now`,
            Object.entries(e.complaints.bySeverity)
              .map(([s, n]) => `${n} ${s}`)
              .join(", ") || "None by severity",
          ]
        : e.complaints.reason;
    case "nonconformances":
      return e.nonconformances.available
        ? [
            `${e.nonconformances.raised} raised and ${e.nonconformances.closed} closed in the period`,
            `${e.nonconformances.open} open now, ${e.nonconformances.overdue} past their due date`,
          ]
        : e.nonconformances.reason;
    case "audits":
      return e.audits.available
        ? [
            `${plural(e.audits.completed, "audit")} completed, ${e.audits.overdue} planned audits overdue`,
            `${plural(e.audits.findings, "finding")} raised from audits`,
          ]
        : e.audits.reason;
    case "incidents":
      return e.incidents.available
        ? [
            `${plural(e.incidents.opened, "case")} opened (${
              Object.entries(e.incidents.byKind)
                .map(([k, n]) => `${n} ${k}`)
                .join(", ") || "none"
            }); ${e.incidents.open} open now`,
          ]
        : e.incidents.reason;
    case "testing":
      return e.testing.available
        ? [
            `${plural(e.testing.sampled, "sample")} taken, ${e.testing.failed} failed`,
            `${plural(e.testing.openInvestigations, "investigation")} open`,
          ]
        : e.testing.reason;
    case "defence":
      return e.defence.available
        ? [
            `${plural(e.defence.overdueControls, "security control")} overdue, ${e.defence.openFailures} failed checks open`,
            `${plural(e.defence.assessmentsDue, "assessment")} due for review; exercise ${e.defence.exerciseOverdue ? "overdue" : "in date"}`,
          ]
        : e.defence.reason;
    case "concerns":
      return [
        `${plural(e.concerns.raisedInPeriod, "concern")} raised in the period; ${e.concerns.open} open now (details stay confidential)`,
      ];
    case "requirements":
      return [
        `${plural(e.requirements.total, "requirement")}: ${e.requirements.byCompliance.compliant ?? 0} compliant, ${e.requirements.byCompliance.partial ?? 0} partly, ${e.requirements.byCompliance.non_compliant ?? 0} not compliant, ${e.requirements.byCompliance.not_assessed ?? 0} not assessed`,
        `${e.requirements.reviewOverdue} reviews overdue`,
      ];
    case "resources":
      return [];
  }
}

type DraftDecision = {
  id: string;
  topic: string | null;
  decision: string;
  ownerUserId: string | null;
  dueOn: string;
};

/** A management review: evidence by agenda topic, notes, decisions, sign-off. */
export function ReviewDetail({ slug, review: r }: { slug: string; review: ManagementReview }) {
  const router = useRouter();
  const at = useFormatDateTime();
  const { can, idx } = useWorkspace();
  const draft = r.status === "draft";
  const canWrite = can("governance", "write") && draft;
  const canManage = can("governance", "manage") && draft;
  const [heldOn, setHeldOn] = useState(r.heldOn ?? "");
  const [attendees, setAttendees] = useState(r.attendees ?? "");
  const [resources, setResources] = useState(r.resources ?? "");
  const [notes, setNotes] = useState<Record<string, string>>(r.notes);
  const [teamId, setTeamId] = useState(r.followUpTeamId ?? NONE);
  const [decisions, setDecisions] = useState<DraftDecision[]>(
    r.decisions.map((d) => ({
      id: d.id,
      topic: d.topic,
      decision: d.decision,
      ownerUserId: d.ownerUserId,
      dueOn: d.dueOn ?? "",
    })),
  );
  const [pending, setPending] = useState<string | null>(null);
  const api = () => browserApi().v1.workspaces[":slug"].governance.reviews[":id"];
  const setDecision = (i: number, patch: Partial<DraftDecision>) =>
    setDecisions((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setPending(key);
    try {
      await fn();
      toast.success(done);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }
  const save = () =>
    run(
      "save",
      () =>
        unwrap(
          api().$patch({
            param: { slug, id: r.id },
            json: {
              heldOn: heldOn || null,
              attendees: attendees.trim() || null,
              resources: resources.trim() || null,
              notes: Object.fromEntries(Object.entries(notes).filter(([, v]) => v.trim())),
              followUpTeamId: teamId === NONE ? null : teamId,
              decisions: decisions
                .filter((d) => d.decision.trim())
                .map((d) => ({ ...d, decision: d.decision.trim(), dueOn: d.dueOn || null })),
            },
          }),
        ),
      "Review saved",
    );

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <GovernanceNav slug={slug} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {r.title}
            {draft ? (
              <Badge variant="outline">Draft</Badge>
            ) : (
              <Badge variant="outline" className="border-transparent bg-label-green-bg text-label-green">
                Signed
              </Badge>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {formatUkDate(r.periodFrom)} – {formatUkDate(r.periodTo)}
            {r.signedAt
              ? ` · signed ${at(String(r.signedAt))} by ${r.signedByName ?? "a former member"}`
              : ""}
            {` · evidence ${r.evidenceIsSnapshot ? `as it stood when signed (${formatUkDate(r.evidence.assembledOn)})` : "live, from the records you can see"}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <Button variant="outline" disabled={pending !== null} onClick={() => void save()}>
              {pending === "save" && <Spinner data-icon="inline-start" />} Save
            </Button>
          )}
          {canManage && (
            <Button
              disabled={pending !== null || r.signBlockers.length > 0}
              title={r.signBlockers.length ? "Save a complete review first" : undefined}
              onClick={() =>
                void run(
                  "sign",
                  () => unwrap(api().sign.$post({ param: { slug, id: r.id } })),
                  "Review signed",
                )
              }
            >
              {pending === "sign" && <Spinner data-icon="inline-start" />} Sign review
            </Button>
          )}
        </div>
      </div>
      {draft && r.signBlockers.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {r.signBlockers.map((b) => (
            <li key={b} className="flex gap-2 text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" /> {b}
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Meeting</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-[12rem_1fr]">
          <Field>
            <FieldLabel htmlFor="mr-held">Held on</FieldLabel>
            <Input
              id="mr-held"
              type="date"
              disabled={!canWrite}
              value={heldOn}
              onChange={(e) => setHeldOn(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mr-attendees">Attendees</FieldLabel>
            <Input
              id="mr-attendees"
              disabled={!canWrite}
              maxLength={2000}
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {governanceAgendaTopics.map((t, n) => {
          const ev = evidenceFor(t.key, r.evidence);
          return (
            <Card key={t.key}>
              <CardHeader>
                <CardTitle>
                  {n + 1}. {t.label}
                </CardTitle>
                {typeof ev === "string" ? (
                  <CardDescription>{ev}</CardDescription>
                ) : ev.length > 0 ? (
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    {ev.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </CardHeader>
              <CardContent>
                {t.key === "resources" ? (
                  <Textarea
                    aria-label="Resources"
                    disabled={!canWrite}
                    maxLength={4000}
                    placeholder="People, equipment and budget needed"
                    value={resources}
                    onChange={(e) => setResources(e.target.value)}
                  />
                ) : (
                  <Textarea
                    aria-label={`Notes: ${t.label}`}
                    disabled={!canWrite}
                    maxLength={10_000}
                    placeholder="Discussion and conclusions"
                    value={notes[t.key] ?? ""}
                    onChange={(e) => setNotes((all) => ({ ...all, [t.key]: e.target.value }))}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Decisions and actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {can("tasks") && (
            <Field className="max-w-xs">
              <FieldLabel>Follow-up team</FieldLabel>
              <Select value={teamId} onValueChange={setTeamId} disabled={!canWrite}>
                <SelectTrigger aria-label="Follow-up team">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NONE}>None</SelectItem>
                    {idx.boot.teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
          {decisions.length === 0 && <p className="text-sm text-muted-foreground">No decisions recorded.</p>}
          {decisions.map((d, i) => {
            const saved = r.decisions.find((x) => x.id === d.id);
            return (
              <div
                key={d.id}
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_12rem_10rem_auto]"
                aria-label={`Decision ${i + 1}`}
              >
                <Textarea
                  aria-label="Decision"
                  disabled={!canWrite}
                  maxLength={2000}
                  rows={2}
                  value={d.decision}
                  onChange={(e) => setDecision(i, { decision: e.target.value })}
                />
                {canWrite ? (
                  <MemberSelect
                    label="Owner"
                    value={d.ownerUserId}
                    onChange={(v) => setDecision(i, { ownerUserId: v })}
                  />
                ) : (
                  <span className="text-sm">{saved?.ownerName ?? "No owner"}</span>
                )}
                <Input
                  aria-label="Due"
                  type="date"
                  disabled={!canWrite}
                  value={d.dueOn}
                  onChange={(e) => setDecision(i, { dueOn: e.target.value })}
                />
                <div className="flex items-start">
                  {canWrite ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove decision"
                      onClick={() => setDecisions((list) => list.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </Button>
                  ) : saved?.taskId ? (
                    <Link href={`/${slug}/task/${saved.taskId}`} className="text-sm underline">
                      Task
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })}
          {canWrite && (
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDecisions((list) => [
                    ...list,
                    { id: newId(), topic: null, decision: "", ownerUserId: null, dueOn: "" },
                  ])
                }
              >
                <Plus data-icon="inline-start" /> Add decision
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      {canWrite && (
        <div>
          <Button disabled={pending !== null} onClick={() => void save()}>
            {pending === "save" && <Spinner data-icon="inline-start" />} Save review
          </Button>
        </div>
      )}
    </div>
  );
}
