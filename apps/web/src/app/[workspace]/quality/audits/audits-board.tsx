"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  canCompleteAudit,
  qualitySeverities,
  qualitySeverityLabels,
  type QualitySeverity,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { BadgeCheck, Ban, Pencil, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { RecordFilesButton } from "@/components/record-attachments";
import { AuditStateBadge } from "@/components/quality-badges";
import type { QualityAuditRow } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import {
  DateField,
  MemberSelect,
  NONE,
  orNull,
  qualityApi,
  Row,
  TextField,
  type MemberOption,
} from "../quality-forms";

/**
 * The internal audit schedule: plan, edit while planned, complete in person (each finding becomes a
 * non-conformance), cancel, or delete one planned by mistake.
 */
export function AuditsBoard({
  slug,
  audits,
  members,
  currentUserId,
}: {
  slug: string;
  audits: QualityAuditRow[];
  members: MemberOption[];
  /** Audits are signed off by their member auditor or by someone with manage. */
  currentUserId: string;
}) {
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("quality", "write");
  const [planning, setPlanning] = useState(false);
  const [editing, setEditing] = useState<QualityAuditRow | null>(null);
  const [completing, setCompleting] = useState<QualityAuditRow | null>(null);
  const [cancelling, setCancelling] = useState<QualityAuditRow | null>(null);
  const planned = audits
    .filter((a) => a.status === "planned")
    .sort((a, b) => a.plannedOn.localeCompare(b.plannedOn));
  const done = audits.filter((a) => a.status !== "planned");

  async function remove(audit: QualityAuditRow) {
    if (
      !window.confirm(
        `Delete ${audit.reference} ${audit.title}? Only do this for an audit planned by mistake.`,
      )
    )
      return;
    try {
      await unwrap(qualityApi().audits[":id"].$delete({ param: { slug, id: audit.id } }));
      toast.success(`${audit.reference} deleted`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const card = (a: QualityAuditRow) => (
    <Card key={a.id} id={`audit-${a.id}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{a.reference}</span> {a.title}
            <AuditStateBadge state={a.state} />
          </CardTitle>
          <CardDescription>
            {a.status === "completed" && a.completedOn
              ? `Completed ${formatLongDate(a.completedOn)} (planned ${formatLongDate(a.plannedOn)})`
              : `Planned ${formatLongDate(a.plannedOn)}`}
            {" · "}
            {a.auditor?.name ?? a.auditorName ?? "No auditor yet"}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <RecordFilesButton
            entityType="quality_audit"
            entityId={a.id}
            title="Audit files"
            description={`${a.reference} ${a.title}: checklist, report, photos. Files can't be removed once the audit is completed or cancelled.`}
          />
        </div>
        {canWrite && a.status === "planned" && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(a)}>
              <Pencil data-icon="inline-start" /> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCancelling(a)}>
              <Ban data-icon="inline-start" /> Cancel
            </Button>
            {a.findings.total === 0 && (
              <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => void remove(a)}>
                <Trash2 />
              </Button>
            )}
            {canCompleteAudit(a, {
              userId: currentUserId,
              level: can("quality", "manage") ? "manage" : "write",
            }) ? (
              <Button size="sm" onClick={() => setCompleting(a)}>
                <BadgeCheck data-icon="inline-start" /> Complete
              </Button>
            ) : (
              <span className="self-center text-xs text-muted-foreground">
                {a.auditor
                  ? `Signed off by ${a.auditor.name} or a quality manager`
                  : "Signed off by a quality manager"}
              </span>
            )}
          </div>
        )}
      </CardHeader>
      {(a.scope || a.summary || a.cancelReason || a.findings.total > 0) && (
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[9rem_1fr]">
            {a.scope && <Row label="Scope">{a.scope}</Row>}
            {a.summary && <Row label="Summary">{a.summary}</Row>}
            {a.cancelReason && (
              <Row label="Cancelled">
                {a.cancelledByName ?? "—"} · {a.cancelReason}
              </Row>
            )}
            {a.findings.total > 0 && (
              <Row label="Findings">
                <Link
                  href={`/${slug}/quality/nonconformances?audit=${a.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {a.findings.total} raised, {a.findings.open} still open
                </Link>
              </Row>
            )}
          </dl>
        </CardContent>
      )}
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Internal audits</h2>
        {canWrite && (
          <Button onClick={() => setPlanning(true)}>
            <Plus data-icon="inline-start" /> Plan audit
          </Button>
        )}
      </div>
      <h3 className="text-sm font-medium text-muted-foreground">Planned</h3>
      {planned.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing planned.
        </p>
      ) : (
        planned.map(card)
      )}
      {done.length > 0 && (
        <>
          <h3 className="text-sm font-medium text-muted-foreground">Completed and cancelled</h3>
          {done.map(card)}
        </>
      )}
      {planning && <PlanDialog slug={slug} members={members} onClose={() => setPlanning(false)} />}
      {editing && (
        <PlanDialog slug={slug} members={members} audit={editing} onClose={() => setEditing(null)} />
      )}
      {completing && (
        <CompleteDialog
          slug={slug}
          audit={completing}
          members={members}
          onClose={() => setCompleting(null)}
        />
      )}
      {cancelling && <CancelDialog slug={slug} audit={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  );
}

const EXTERNAL = "external";

function PlanDialog({
  slug,
  members,
  audit,
  onClose,
}: {
  slug: string;
  members: MemberOption[];
  audit?: QualityAuditRow;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [title, setTitle] = useState(audit?.title ?? "");
  const [scope, setScope] = useState(audit?.scope ?? "");
  const [plannedOn, setPlannedOn] = useState(audit?.plannedOn ?? today);
  const [auditor, setAuditor] = useState(audit?.auditorUserId ?? (audit?.auditorName ? EXTERNAL : NONE));
  const [auditorName, setAuditorName] = useState(audit?.auditorName ?? "");
  const options: MemberOption[] = [...members, { userId: EXTERNAL, name: "Someone else (by name)" }];
  const auditorFields =
    auditor === EXTERNAL
      ? { auditorName: auditorName.trim() || null, auditorUserId: null }
      : { auditorUserId: auditor === NONE ? null : auditor, auditorName: null };
  return (
    <HaccpDialog
      title={audit ? `Edit ${audit.reference}` : "Plan an internal audit"}
      description="What it covers (an area, a process, the clauses of the standard), when, and who audits."
      submitLabel={audit ? "Save" : "Plan"}
      disabled={!title.trim() || (auditor === EXTERNAL && !auditorName.trim())}
      onClose={onClose}
      onSubmit={async () => {
        const json = { title: title.trim(), scope: orNull(scope), plannedOn, ...auditorFields };
        if (audit) {
          await unwrap(qualityApi().audits[":id"].$patch({ param: { slug, id: audit.id }, json }));
          return `${audit.reference} saved`;
        }
        const created = await unwrap(qualityApi().audits.$post({ param: { slug }, json }));
        return `${created.reference} planned`;
      }}
    >
      <TextField
        id="a-title"
        label="Title"
        required
        rows={1}
        maxLength={200}
        value={title}
        onChange={setTitle}
      />
      <TextField
        id="a-scope"
        label="Scope"
        rows={2}
        value={scope}
        onChange={setScope}
        placeholder="e.g. Housekeeping and hygiene, BRCGS clause 4.11"
      />
      <DateField id="a-date" label="Planned for" value={plannedOn} onChange={setPlannedOn} />
      <MemberSelect
        id="a-auditor"
        label="Auditor"
        value={auditor}
        onChange={setAuditor}
        members={options}
        noneLabel="Not chosen yet"
      />
      {auditor === EXTERNAL && (
        <TextField
          id="a-auditor-name"
          label="Auditor's name"
          required
          rows={1}
          maxLength={200}
          value={auditorName}
          onChange={setAuditorName}
        />
      )}
    </HaccpDialog>
  );
}

interface FindingDraft {
  title: string;
  description: string;
  severity: QualitySeverity;
  ownerUserId: string;
}

function CompleteDialog({
  slug,
  audit,
  members,
  onClose,
}: {
  slug: string;
  audit: QualityAuditRow;
  members: MemberOption[];
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [completedOn, setCompletedOn] = useState(today);
  const [summary, setSummary] = useState("");
  const [findings, setFindings] = useState<FindingDraft[]>([]);
  const update = (i: number, patch: Partial<FindingDraft>) =>
    setFindings((list) => list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const incomplete = findings.some((f) => !f.title.trim() || !f.description.trim());
  return (
    <HaccpDialog
      title={`Complete ${audit.reference}`}
      description="Your record of the audit, in person: the summary, and each finding, which becomes a non-conformance."
      submitLabel={findings.length ? `Complete and raise ${findings.length}` : "Complete"}
      wide
      disabled={!summary.trim() || incomplete}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().audits[":id"].complete.$post({
            param: { slug, id: audit.id },
            json: {
              completedOn,
              summary: summary.trim(),
              findings: findings.map((f) => ({
                title: f.title.trim(),
                description: f.description.trim(),
                severity: f.severity,
                ...(f.ownerUserId !== NONE ? { ownerUserId: f.ownerUserId } : {}),
              })),
            },
          }),
        );
        return findings.length
          ? `${audit.reference} completed; ${findings.length} raised`
          : `${audit.reference} completed`;
      }}
    >
      <p className="text-sm">{audit.title}</p>
      <DateField
        id="ac-date"
        label="Completed on"
        value={completedOn}
        onChange={setCompletedOn}
        max={today}
      />
      <TextField
        id="ac-summary"
        label="Summary"
        required
        rows={3}
        maxLength={8000}
        value={summary}
        onChange={setSummary}
      />
      {findings.map((f, i) => (
        <fieldset key={i} className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-medium">Finding {i + 1}</legend>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove finding ${i + 1}`}
              onClick={() => setFindings((list) => list.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
          <TextField
            id={`f-${i}-title`}
            label="Title"
            required
            rows={1}
            maxLength={200}
            value={f.title}
            onChange={(v) => update(i, { title: v })}
          />
          <TextField
            id={`f-${i}-description`}
            label="What was found"
            required
            rows={2}
            maxLength={8000}
            value={f.description}
            onChange={(v) => update(i, { description: v })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id={`f-${i}-severity`}
              label="Severity"
              value={f.severity}
              onChange={(v) => update(i, { severity: v as QualitySeverity })}
              options={qualitySeverities.map((s) => [s, qualitySeverityLabels[s]] as const)}
            />
            <MemberSelect
              id={`f-${i}-owner`}
              label="Owner"
              value={f.ownerUserId}
              onChange={(v) => update(i, { ownerUserId: v })}
              members={members}
            />
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          setFindings((list) => [
            ...list,
            { title: "", description: "", severity: "minor", ownerUserId: NONE },
          ])
        }
      >
        <Plus data-icon="inline-start" /> Add finding
      </Button>
    </HaccpDialog>
  );
}

function CancelDialog({
  slug,
  audit,
  onClose,
}: {
  slug: string;
  audit: QualityAuditRow;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <HaccpDialog
      title={`Cancel ${audit.reference}`}
      description="The audit stays on the schedule, marked cancelled, with the reason."
      submitLabel="Cancel audit"
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().audits[":id"].cancel.$post({
            param: { slug, id: audit.id },
            json: { reason: reason.trim() },
          }),
        );
        return `${audit.reference} cancelled`;
      }}
    >
      <TextField
        id="ax-reason"
        label="Why"
        required
        rows={2}
        maxLength={2000}
        value={reason}
        onChange={setReason}
      />
    </HaccpDialog>
  );
}
