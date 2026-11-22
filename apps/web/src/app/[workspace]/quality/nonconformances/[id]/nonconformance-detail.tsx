"use client";

import { RecordAttachments } from "@/components/record-attachments";
import {
  nonconformanceSourceLabels,
  supplierApprovalLabels,
  qualitySeverities,
  qualitySeverityLabels,
  type QualitySeverity,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { BadgeCheck, CircleDot, ListChecks, Pencil, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { NonconformanceStatusBadge, SeverityBadge } from "@/components/quality-badges";
import type { NonconformanceRow } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import {
  DateField,
  ItemLotFields,
  MemberSelect,
  NONE,
  orNull,
  qualityApi,
  Row,
  TextField,
  TextRow,
  type ItemOption,
  type MemberOption,
} from "../../quality-forms";
import { useFormatDateTime } from "@/lib/workspace-time";

/** One non-conformance: what happened, the CAPA, and a manager's verification. */
export function NonconformanceDetailView({
  slug,
  nc,
  items,
  members,
}: {
  slug: string;
  nc: NonconformanceRow;
  items: ItemOption[];
  members: MemberOption[];
}) {
  const time = useFormatDateTime();
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("quality", "write");
  const canManage = can("quality", "manage");
  const closed = nc.status === "closed";
  const [dialog, setDialog] = useState<"edit" | "close" | "reopen" | null>(null);

  async function setStatus(status: "open" | "action_taken") {
    try {
      await unwrap(
        qualityApi().nonconformances[":id"].$patch({ param: { slug, id: nc.id }, json: { status } }),
      );
      toast.success(status === "action_taken" ? "Marked as action taken" : "Moved back to open");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {nc.title}
            <SeverityBadge severity={nc.severity} />
            <NonconformanceStatusBadge status={nc.status} overdue={nc.overdue} />
          </h2>
          <p className="text-sm text-muted-foreground">
            Raised {formatLongDate(nc.raisedOn)} · {nonconformanceSourceLabels[nc.source]}
            {nc.complaint && (
              <>
                {" "}
                <Link
                  className="font-mono hover:underline"
                  href={`/${slug}/quality/complaints/${nc.complaint.id}`}
                >
                  {nc.complaint.reference}
                </Link>
              </>
            )}
            {nc.audit && (
              <>
                {" "}
                <Link
                  className="font-mono hover:underline"
                  href={`/${slug}/quality/audits#audit-${nc.audit.id}`}
                >
                  {nc.audit.reference}
                </Link>{" "}
                {nc.audit.title}
              </>
            )}
            {" · "}by {nc.createdByName ?? "—"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && !closed && (
            <>
              {nc.status === "open" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!nc.correctiveAction}
                  title={nc.correctiveAction ? undefined : "Record the corrective action first"}
                  onClick={() => void setStatus("action_taken")}
                >
                  <ListChecks data-icon="inline-start" /> Action taken
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void setStatus("open")}>
                  <CircleDot data-icon="inline-start" /> Back to open
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
                <Pencil data-icon="inline-start" /> Update
              </Button>
            </>
          )}
          {canManage && nc.status === "action_taken" && (
            <Button
              size="sm"
              disabled={!nc.rootCause}
              title={nc.rootCause ? undefined : "Record the root cause first"}
              onClick={() => setDialog("close")}
            >
              <BadgeCheck data-icon="inline-start" /> Verify and close
            </Button>
          )}
          {canManage && closed && (
            <Button variant="outline" size="sm" onClick={() => setDialog("reopen")}>
              <RotateCcw data-icon="inline-start" /> Reopen
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What happened</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <Row label="Description">{nc.description}</Row>
            <Row label="Product">{nc.item ? `${nc.item.code} ${nc.item.name}` : "—"}</Row>
            <Row label="Lot">
              {nc.lot ? (
                <Link className="font-mono text-xs hover:underline" href={`/${slug}/stock/lots/${nc.lot.id}`}>
                  {nc.lot.lotCode}
                </Link>
              ) : (
                "—"
              )}
            </Row>
            {nc.supplier && <Row label="Supplier">{nc.supplier.name}</Row>}
            {nc.supplier && (
              <Row label="Supplier review">
                {nc.supplierReviewedAt
                  ? `Weighed when the approval was decided: ${time(nc.supplierReviewedAt)}${
                      nc.supplierReviewedByName ? ` by ${nc.supplierReviewedByName}` : ""
                    }${
                      nc.supplierReviewStatus
                        ? `, supplier left ${supplierApprovalLabels[nc.supplierReviewStatus].toLowerCase()}`
                        : ""
                    }`
                  : "Not yet reviewed against the supplier's approval"}
              </Row>
            )}
            <Row label="Owner">{nc.owner?.name ?? "—"}</Row>
            <Row label="Due">{nc.dueOn ? formatLongDate(nc.dueOn) : "—"}</Row>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Corrective and preventive action</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <TextRow label="Containment" value={nc.containment} />
            <TextRow label="Root cause" value={nc.rootCause} />
            <TextRow label="Corrective action" value={nc.correctiveAction} />
            <TextRow label="Preventive action" value={nc.preventiveAction} />
            {nc.actionTakenAt && (
              <Row label="Action taken">
                {time(nc.actionTakenAt)}
                {nc.actionTakenByName ? ` by ${nc.actionTakenByName}` : ""}
              </Row>
            )}
            {nc.closedAt && (
              <Row label="Verified">
                {time(nc.closedAt)} by {nc.closedByName ?? "—"} · {nc.verificationNote}
              </Row>
            )}
            {nc.reopenedAt && (
              <Row label="Reopened">
                {time(nc.reopenedAt)} · {nc.reopenReason}
              </Row>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <RecordAttachments key={nc.status} entityType="quality_nonconformance" entityId={nc.id} />
        </CardContent>
      </Card>

      {dialog === "edit" && (
        <EditDialog slug={slug} nc={nc} items={items} members={members} onClose={() => setDialog(null)} />
      )}
      {dialog === "close" && <VerifyDialog slug={slug} nc={nc} onClose={() => setDialog(null)} />}
      {dialog === "reopen" && <ReopenDialog slug={slug} nc={nc} onClose={() => setDialog(null)} />}
    </div>
  );
}

function EditDialog({
  slug,
  nc,
  items,
  members,
  onClose,
}: {
  slug: string;
  nc: NonconformanceRow;
  items: ItemOption[];
  members: MemberOption[];
  onClose: () => void;
}) {
  const [severity, setSeverity] = useState<QualitySeverity>(nc.severity);
  const [title, setTitle] = useState(nc.title);
  const [description, setDescription] = useState(nc.description);
  const [itemId, setItemId] = useState(nc.itemId ?? NONE);
  const [lotId, setLotId] = useState(nc.lotId ?? NONE);
  const [ownerUserId, setOwnerUserId] = useState(nc.ownerUserId ?? NONE);
  const [dueOn, setDueOn] = useState(nc.dueOn ?? "");
  const [fields, setFields] = useState({
    containment: nc.containment ?? "",
    rootCause: nc.rootCause ?? "",
    correctiveAction: nc.correctiveAction ?? "",
    preventiveAction: nc.preventiveAction ?? "",
  });
  const set = (key: keyof typeof fields) => (value: string) => setFields((f) => ({ ...f, [key]: value }));
  const itemOptions =
    nc.item && !items.some((i) => i.id === nc.item!.id)
      ? [{ id: nc.item.id, code: nc.item.code, name: nc.item.name }, ...items]
      : items;
  const ownerOptions =
    nc.owner && !members.some((m) => m.userId === nc.owner!.id)
      ? [{ userId: nc.owner.id, name: nc.owner.name }, ...members]
      : members;
  return (
    <HaccpDialog
      title={`Update ${nc.reference}`}
      description="Only what you change is saved. Clearing a field clears it."
      submitLabel="Save"
      wide
      disabled={!title.trim() || !description.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().nonconformances[":id"].$patch({
            param: { slug, id: nc.id },
            json: {
              severity,
              title: title.trim(),
              description: description.trim(),
              itemId: itemId === NONE ? null : itemId,
              lotId: lotId === NONE ? null : lotId,
              ownerUserId: ownerUserId === NONE ? null : ownerUserId,
              ...(dueOn ? { dueOn } : {}),
              containment: orNull(fields.containment),
              rootCause: orNull(fields.rootCause),
              correctiveAction: orNull(fields.correctiveAction),
              preventiveAction: orNull(fields.preventiveAction),
            },
          }),
        );
        return `${nc.reference} updated`;
      }}
    >
      <TextField
        id="u-title"
        label="Title"
        required
        rows={1}
        maxLength={200}
        value={title}
        onChange={setTitle}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="u-severity"
          label="Severity"
          value={severity}
          onChange={(v) => setSeverity(v as QualitySeverity)}
          options={qualitySeverities.map((s) => [s, qualitySeverityLabels[s]] as const)}
        />
        <MemberSelect
          id="u-owner"
          label="Owner"
          value={ownerUserId}
          onChange={setOwnerUserId}
          members={ownerOptions}
        />
        <ItemLotFields
          slug={slug}
          items={itemOptions}
          itemId={itemId}
          lotId={lotId}
          onItem={setItemId}
          onLot={setLotId}
          idPrefix="u"
          currentLot={nc.lot}
        />
        <DateField id="u-due" label="Due" value={dueOn} onChange={setDueOn} min={nc.raisedOn} />
      </div>
      <TextField
        id="u-description"
        label="What happened"
        required
        maxLength={8000}
        value={description}
        onChange={setDescription}
      />
      <TextField
        id="u-containment"
        label="Containment"
        value={fields.containment}
        onChange={set("containment")}
      />
      <TextField id="u-root" label="Root cause" value={fields.rootCause} onChange={set("rootCause")} />
      <TextField
        id="u-corrective"
        label="Corrective action"
        value={fields.correctiveAction}
        onChange={set("correctiveAction")}
      />
      <TextField
        id="u-preventive"
        label="Preventive action"
        value={fields.preventiveAction}
        onChange={set("preventiveAction")}
      />
    </HaccpDialog>
  );
}

function VerifyDialog({ slug, nc, onClose }: { slug: string; nc: NonconformanceRow; onClose: () => void }) {
  const [note, setNote] = useState("");
  return (
    <HaccpDialog
      title={`Verify and close ${nc.reference}`}
      description="Your sign-off that the corrective action worked. Your name and the time are recorded."
      submitLabel="Verify and close"
      disabled={!note.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().nonconformances[":id"].close.$post({
            param: { slug, id: nc.id },
            json: { verificationNote: note.trim() },
          }),
        );
        return `${nc.reference} closed`;
      }}
    >
      <TextField
        id="verify-note"
        label="How it was verified"
        required
        rows={2}
        maxLength={2000}
        placeholder="e.g. Rechecked a week later: no recurrence"
        value={note}
        onChange={setNote}
      />
    </HaccpDialog>
  );
}

function ReopenDialog({ slug, nc, onClose }: { slug: string; nc: NonconformanceRow; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <HaccpDialog
      title={`Reopen ${nc.reference}`}
      description="It goes back to open and needs verifying again. The reason is recorded on it."
      submitLabel="Reopen"
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().nonconformances[":id"].reopen.$post({
            param: { slug, id: nc.id },
            json: { reason: reason.trim() },
          }),
        );
        return `${nc.reference} reopened`;
      }}
    >
      <TextField
        id="nc-reopen"
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
