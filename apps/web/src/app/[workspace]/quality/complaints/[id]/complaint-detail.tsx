"use client";

import { RecordAttachments } from "@/components/record-attachments";
import {
  complaintCategories,
  complaintCategoryLabels,
  complaintSourceLabels,
  qualitySeverities,
  qualitySeverityLabels,
  type ComplaintCategory,
  type QualitySeverity,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { BadgeCheck, CircleDot, Pencil, Plus, RotateCcw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { ComplaintStatusBadge, NonconformanceStatusBadge, SeverityBadge } from "@/components/quality-badges";
import type { ComplaintDetail } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { NonconformanceDialog } from "../../nonconformances/nonconformance-dialog";
import {
  ItemLotFields,
  NONE,
  orNull,
  qualityApi,
  Row,
  TextField,
  TextRow,
  type ItemOption,
  type MemberOption,
  useLinkFields,
} from "../../quality-forms";
import { useFormatDateTime } from "@/lib/workspace-time";

/** One complaint: what was reported, the investigation, and a manager's closure. */
export function ComplaintDetailView({
  slug,
  complaint: c,
  items,
  members,
}: {
  slug: string;
  complaint: ComplaintDetail;
  items: ItemOption[];
  members: MemberOption[];
}) {
  const time = useFormatDateTime();
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("quality", "write");
  const canManage = can("quality", "manage");
  const closed = c.status === "closed";
  const [dialog, setDialog] = useState<"edit" | "close" | "reopen" | "nc" | null>(null);

  async function setStatus(status: "open" | "investigating") {
    try {
      await unwrap(qualityApi().complaints[":id"].$patch({ param: { slug, id: c.id }, json: { status } }));
      toast.success(status === "investigating" ? "Investigation started" : "Moved back to open");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {complaintCategoryLabels[c.category]} complaint
            <SeverityBadge severity={c.severity} />
            <ComplaintStatusBadge status={c.status} />
          </h2>
          <p className="text-sm text-muted-foreground">
            Received {formatLongDate(c.receivedOn)} from {complaintSourceLabels[c.source].toLowerCase()}
            {c.customer ? ` (${c.customer})` : ""} · logged by {c.createdByName ?? "—"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && !closed && (
            <>
              {c.status === "open" ? (
                <Button variant="outline" size="sm" onClick={() => void setStatus("investigating")}>
                  <Search data-icon="inline-start" /> Start investigating
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
          {canManage && !closed && (
            <Button size="sm" onClick={() => setDialog("close")}>
              <BadgeCheck data-icon="inline-start" /> Close
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
          <CardTitle>Reported</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <Row label="Description">{c.description}</Row>
            <Row label="Product">{c.item ? `${c.item.code} ${c.item.name}` : "—"}</Row>
            <Row label="Lot">
              {c.lot ? (
                <Link className="font-mono text-xs hover:underline" href={`/${slug}/stock/lots/${c.lot.id}`}>
                  {c.lot.lotCode}
                </Link>
              ) : (
                "—"
              )}
              {c.reportedLotCode && (
                <span className="text-muted-foreground"> (reported as {c.reportedLotCode})</span>
              )}
            </Row>
            <Row label="Complainant">
              {[c.complainantName, c.complainantContact].filter(Boolean).join(" · ") || "—"}
            </Row>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Investigation and response</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <TextRow label="Investigation" value={c.investigation} />
            <TextRow label="Root cause" value={c.rootCause} />
            <TextRow label="Response" value={c.response} />
            <Row label="Justified">{c.justified === null ? "Not decided" : c.justified ? "Yes" : "No"}</Row>
            {c.closedAt && (
              <Row label="Closed">
                {time(c.closedAt)} by {c.closedByName ?? "—"}
                {c.closeNote ? ` · ${c.closeNote}` : ""}
              </Row>
            )}
            {c.reopenedAt && (
              <Row label="Reopened">
                {time(c.reopenedAt)} · {c.reopenReason}
              </Row>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Non-conformances</CardTitle>
          </div>
          {canWrite && (
            <Button size="sm" variant="outline" onClick={() => setDialog("nc")}>
              <Plus data-icon="inline-start" /> Raise
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {c.nonconformances.length === 0 ? (
            <p className="text-sm text-muted-foreground">None raised.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {c.nonconformances.map((nc) => (
                <li key={nc.id} className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/${slug}/quality/nonconformances/${nc.id}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {nc.reference}
                  </Link>
                  <span>{nc.title}</span>
                  <NonconformanceStatusBadge status={nc.status} overdue={nc.overdue} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <RecordAttachments key={c.status} entityType="quality_complaint" entityId={c.id} />
        </CardContent>
      </Card>

      {dialog === "edit" && (
        <EditDialog slug={slug} complaint={c} items={items} onClose={() => setDialog(null)} />
      )}
      {dialog === "close" && <CloseDialog slug={slug} complaint={c} onClose={() => setDialog(null)} />}
      {dialog === "reopen" && <ReopenDialog slug={slug} complaint={c} onClose={() => setDialog(null)} />}
      {dialog === "nc" && (
        <NonconformanceDialog
          slug={slug}
          items={items}
          members={members}
          from={{
            complaintId: c.id,
            reference: c.reference,
            severity: c.severity,
            title: `${complaintCategoryLabels[c.category]} complaint ${c.reference}`,
            description: c.description,
            itemId: c.itemId,
            lotId: c.lotId,
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

const JUSTIFIED = [
  ["unknown", "Not decided"],
  ["yes", "Yes"],
  ["no", "No"],
] as const;
const justifiedValue = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");
const justifiedFrom = (v: string) => (v === "unknown" ? null : v === "yes");

function EditDialog({
  slug,
  complaint: c,
  items,
  onClose,
}: {
  slug: string;
  complaint: ComplaintDetail;
  items: ItemOption[];
  onClose: () => void;
}) {
  const [category, setCategory] = useState<ComplaintCategory>(c.category);
  const [severity, setSeverity] = useState<QualitySeverity>(c.severity);
  const linkFields = useLinkFields();
  const [itemId, setItemId] = useState(c.itemId ?? NONE);
  const [lotId, setLotId] = useState(c.lotId ?? NONE);
  const [description, setDescription] = useState(c.description);
  const [investigation, setInvestigation] = useState(c.investigation ?? "");
  const [rootCause, setRootCause] = useState(c.rootCause ?? "");
  const [response, setResponse] = useState(c.response ?? "");
  const [justified, setJustified] = useState<string>(justifiedValue(c.justified));
  const itemOptions =
    c.item && !items.some((i) => i.id === c.item!.id)
      ? [{ id: c.item.id, code: c.item.code, name: c.item.name }, ...items]
      : items;
  return (
    <HaccpDialog
      title={`Update ${c.reference}`}
      description="Record what the investigation found and what was said to the complainant."
      submitLabel="Save"
      wide
      disabled={!description.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().complaints[":id"].$patch({
            param: { slug, id: c.id },
            json: {
              category,
              severity,
              ...linkFields(itemId, lotId, true),
              description: description.trim(),
              investigation: orNull(investigation),
              rootCause: orNull(rootCause),
              response: orNull(response),
              justified: justifiedFrom(justified),
            },
          }),
        );
        return `${c.reference} updated`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="e-category"
          label="Category"
          value={category}
          onChange={(v) => setCategory(v as ComplaintCategory)}
          options={complaintCategories.map((x) => [x, complaintCategoryLabels[x]] as const)}
        />
        <SelectField
          id="e-severity"
          label="Severity"
          value={severity}
          onChange={(v) => setSeverity(v as QualitySeverity)}
          options={qualitySeverities.map((x) => [x, qualitySeverityLabels[x]] as const)}
        />
        <ItemLotFields
          slug={slug}
          items={itemOptions}
          itemId={itemId}
          lotId={lotId}
          onItem={setItemId}
          onLot={setLotId}
          idPrefix="e"
          currentLot={c.lot}
        />
      </div>
      <TextField
        id="e-description"
        label="What was reported"
        required
        rows={3}
        maxLength={8000}
        value={description}
        onChange={setDescription}
      />
      <TextField
        id="e-investigation"
        label="Investigation"
        rows={4}
        maxLength={8000}
        value={investigation}
        onChange={setInvestigation}
      />
      <TextField id="e-root" label="Root cause" value={rootCause} onChange={setRootCause} />
      <TextField
        id="e-response"
        label="Response to the complainant"
        value={response}
        onChange={setResponse}
      />
      <SelectField
        id="e-justified"
        label="Justified"
        value={justified}
        onChange={setJustified}
        options={JUSTIFIED}
      />
    </HaccpDialog>
  );
}

function CloseDialog({
  slug,
  complaint: c,
  onClose,
}: {
  slug: string;
  complaint: ComplaintDetail;
  onClose: () => void;
}) {
  const [response, setResponse] = useState(c.response ?? "");
  const [justified, setJustified] = useState<string>(justifiedValue(c.justified));
  const [note, setNote] = useState("");
  return (
    <HaccpDialog
      title={`Close ${c.reference}`}
      description="Your sign-off that the complaint is investigated and answered. Your name and the time are recorded."
      submitLabel="Close complaint"
      disabled={!response.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().complaints[":id"].close.$post({
            param: { slug, id: c.id },
            json: {
              response: response.trim(),
              justified: justifiedFrom(justified),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          }),
        );
        return `${c.reference} closed`;
      }}
    >
      <TextField
        id="close-response"
        label="Response to the complainant"
        required
        value={response}
        onChange={setResponse}
      />
      <SelectField
        id="close-justified"
        label="Justified"
        value={justified}
        onChange={setJustified}
        options={JUSTIFIED}
      />
      <TextField
        id="close-note"
        label="Note (optional)"
        rows={2}
        maxLength={2000}
        value={note}
        onChange={setNote}
      />
    </HaccpDialog>
  );
}

function ReopenDialog({
  slug,
  complaint: c,
  onClose,
}: {
  slug: string;
  complaint: ComplaintDetail;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <HaccpDialog
      title={`Reopen ${c.reference}`}
      description="The complaint goes back to investigating, and needs closing again. The reason is recorded on it."
      submitLabel="Reopen"
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          qualityApi().complaints[":id"].reopen.$post({
            param: { slug, id: c.id },
            json: { reason: reason.trim() },
          }),
        );
        return `${c.reference} reopened`;
      }}
    >
      <TextField
        id="reopen-reason"
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
