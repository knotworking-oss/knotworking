"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Textarea } from "@knotworking/ui/components/textarea";
import { BadgeCheck, Paperclip, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  ApiSourceBadge,
  CorrectiveActionBadge,
  ReadingBadge,
  ReviewStatusBadge,
} from "@/components/haccp-badges";
import { RecordAttachments } from "@/components/record-attachments";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import type { CorrectiveAction } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

type Status = "open" | "closed" | "all";
type Batch = { id: string; batchCode: string };

const caApi = () => browserApi().v1.workspaces[":slug"].haccp["corrective-actions"];

const fieldLabels = {
  actionTaken: "What was done",
  rootCause: "Root cause",
  preventiveAction: "Preventive action",
} as const;

/**
 * Deviations and corrective actions. Every out-of-limit reading and failed calibration opens one;
 * anyone with write fills it in, and a person with manage closes it.
 */
export function DeviationsBoard({
  slug,
  status,
  actions,
  total,
  batches,
}: {
  slug: string;
  status: Status;
  actions: CorrectiveAction[];
  total: number;
  batches: Batch[];
}) {
  const time = useFormatDateTime();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("haccp", "write");
  const canManage = can("haccp", "manage");
  const [editing, setEditing] = useState<CorrectiveAction | null>(null);
  const [closing, setClosing] = useState<CorrectiveAction | null>(null);
  const [raising, setRaising] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Deviations and corrective actions</h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        {canWrite && (
          <Button onClick={() => setRaising(true)}>
            <Plus data-icon="inline-start" /> Raise corrective action
          </Button>
        )}
      </div>

      <Tabs
        value={status}
        onValueChange={(v) => router.replace(v === "open" ? pathname : `${pathname}?status=${v}`)}
      >
        <TabsList>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {actions.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {status === "open" ? "No open corrective actions." : "Nothing here."}
        </p>
      )}

      {actions.map((ca) => (
        <Card key={ca.id}>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="flex flex-wrap items-center gap-2">
                {ca.title} <CorrectiveActionBadge status={ca.status} />
                {ca.source === "api" && <ApiSourceBadge />}
              </CardTitle>
              <CardDescription>
                Raised {time(ca.createdAt)} by {ca.raisedByName ?? "—"}
                {ca.status === "closed" &&
                  ` · closed ${ca.closedAt ? time(ca.closedAt) : ""} by ${ca.closedByName ?? "—"}`}
              </CardDescription>
            </div>
            {ca.status === "open" && (
              <div className="flex gap-2">
                {canWrite && (
                  <Button size="sm" variant="outline" onClick={() => setEditing(ca)}>
                    <Pencil data-icon="inline-start" /> Update
                  </Button>
                )}
                {canManage && (
                  <Button size="sm" onClick={() => setClosing(ca)} disabled={ca.missing.length > 0}>
                    <BadgeCheck data-icon="inline-start" /> Close
                  </Button>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
              {ca.log && (
                <>
                  <dt className="text-muted-foreground">Deviation</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <span>
                      {ca.log.plan?.code} {ca.log.ccp.code} {ca.log.ccp.processStep}:{" "}
                      <strong>{ca.log.readingText}</strong> (limit {ca.log.ccp.limitText}) ·{" "}
                      {time(ca.log.checkedAt)} · {ca.log.recordedByName ?? "—"}
                    </span>
                    <ReadingBadge withinLimits={false} reason={ca.log.deviationReason} />
                    {ca.log.source === "api" && <ApiSourceBadge />}
                    <ReviewStatusBadge status={ca.log.reviewStatus} note={ca.log.reviewNote} />
                    {ca.log.correctedByLogId && (
                      <span className="text-xs text-muted-foreground">Reading corrected</span>
                    )}
                  </dd>
                </>
              )}
              {ca.calibration && (
                <>
                  <dt className="text-muted-foreground">Calibration</dt>
                  <dd>
                    {ca.calibration.asset.name}: read {ca.calibration.actualReading}
                    {ca.calibration.unit ? ` ${ca.calibration.unit}` : ""} against{" "}
                    {ca.calibration.referenceReading}
                    {ca.calibration.unit ? ` ${ca.calibration.unit}` : ""} ·{" "}
                    {time(ca.calibration.calibratedAt)}
                  </dd>
                </>
              )}
              {ca.batch && (
                <>
                  <dt className="text-muted-foreground">Batch</dt>
                  <dd>
                    <Link
                      className="font-mono text-xs hover:underline"
                      href={`/${slug}/production/batches/${ca.batch.id}`}
                    >
                      {ca.batch.batchCode}
                    </Link>
                  </dd>
                </>
              )}
              {ca.lot && (
                <>
                  <dt className="text-muted-foreground">Lot</dt>
                  <dd>
                    <Link
                      className="font-mono text-xs hover:underline"
                      href={`/${slug}/stock/lots/${ca.lot.id}`}
                    >
                      {ca.lot.itemCode} {ca.lot.lotCode}
                    </Link>{" "}
                    <span className="text-muted-foreground">({ca.lot.status})</span>
                  </dd>
                </>
              )}
              {(Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]).map((field) => (
                <FieldRow key={field} label={fieldLabels[field]} value={ca[field]} />
              ))}
              {ca.closureNote && <FieldRow label="Closure note" value={ca.closureNote} />}
            </dl>
            <FilesToggle id={ca.id} status={ca.status} />
          </CardContent>
        </Card>
      ))}

      {editing && (
        <EditDialog slug={slug} action={editing} batches={batches} onClose={() => setEditing(null)} />
      )}
      {closing && <CloseDialog slug={slug} action={closing} onClose={() => setClosing(null)} />}
      {raising && <RaiseDialog slug={slug} batches={batches} onClose={() => setRaising(false)} />}
    </div>
  );
}

/** Photos and evidence on a corrective action; loaded when opened. Closed actions still accept files. */
function FilesToggle({ id, status }: { id: string; status: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t pt-3">
      {open ? (
        <RecordAttachments key={status} entityType="haccp_corrective_action" entityId={id} />
      ) : (
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(true)}>
          <Paperclip data-icon="inline-start" /> Attachments
        </Button>
      )}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={value ? "whitespace-pre-wrap" : "text-muted-foreground italic"}>
        {value ?? "Not recorded yet"}
      </dd>
    </>
  );
}

const NONE = "none";

function ActionFields({
  values,
  onChange,
}: {
  values: Record<keyof typeof fieldLabels, string>;
  onChange: (field: keyof typeof fieldLabels, value: string) => void;
}) {
  return (
    <>
      {(Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]).map((field) => (
        <Field key={field}>
          <FieldLabel htmlFor={`ca-${field}`}>{fieldLabels[field]}</FieldLabel>
          <Textarea
            id={`ca-${field}`}
            rows={3}
            maxLength={4000}
            value={values[field]}
            onChange={(e) => onChange(field, e.target.value)}
          />
        </Field>
      ))}
    </>
  );
}

function EditDialog({
  slug,
  action,
  batches,
  onClose,
}: {
  slug: string;
  action: CorrectiveAction;
  batches: Batch[];
  onClose: () => void;
}) {
  const [values, setValues] = useState({
    actionTaken: action.actionTaken ?? "",
    rootCause: action.rootCause ?? "",
    preventiveAction: action.preventiveAction ?? "",
  });
  const [batchId, setBatchId] = useState(action.batchId ?? NONE);
  const options = [
    [NONE, "No batch"] as const,
    ...(action.batch && !batches.some((b) => b.id === action.batch!.id) ? [action.batch] : []).map(
      (b) => [b.id, b.batchCode] as const,
    ),
    ...batches.map((b) => [b.id, b.batchCode] as const),
  ];
  return (
    <HaccpDialog
      title="Update corrective action"
      description={action.title}
      submitLabel="Save"
      wide
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          caApi()[":id"].$patch({
            param: { slug, id: action.id },
            json: {
              actionTaken: values.actionTaken.trim() || null,
              rootCause: values.rootCause.trim() || null,
              preventiveAction: values.preventiveAction.trim() || null,
              batchId: batchId === NONE ? null : batchId,
            },
          }),
        );
        return "Corrective action updated";
      }}
    >
      <ActionFields
        values={values}
        onChange={(field, value) => setValues((v) => ({ ...v, [field]: value }))}
      />
      <SelectField id="ca-batch" label="Batch" value={batchId} onChange={setBatchId} options={options} />
    </HaccpDialog>
  );
}

function CloseDialog({
  slug,
  action,
  onClose,
}: {
  slug: string;
  action: CorrectiveAction;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <HaccpDialog
      title="Close corrective action"
      description="Your sign-off that the action is complete and effective. Your name and the time are recorded; it can't change afterwards."
      submitLabel="Close"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          caApi()[":id"].close.$post({
            param: { slug, id: action.id },
            json: note.trim() ? { note: note.trim() } : {},
          }),
        );
        return "Corrective action closed";
      }}
    >
      <p className="text-sm">{action.title}</p>
      <Field>
        <FieldLabel htmlFor="close-note">Note (optional)</FieldLabel>
        <Textarea
          id="close-note"
          rows={2}
          maxLength={2000}
          placeholder="e.g. Product re-cooked and released; thermostat replaced"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function RaiseDialog({ slug, batches, onClose }: { slug: string; batches: Batch[]; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [batchId, setBatchId] = useState(NONE);
  const [values, setValues] = useState({ actionTaken: "", rootCause: "", preventiveAction: "" });
  return (
    <HaccpDialog
      title="Raise corrective action"
      description="For anything not raised by a reading or a calibration: a complaint, an audit finding, a near miss."
      submitLabel="Raise"
      wide
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          caApi().$post({
            param: { slug },
            json: {
              title: title.trim(),
              ...(batchId !== NONE ? { batchId } : {}),
              ...(values.actionTaken.trim() ? { actionTaken: values.actionTaken.trim() } : {}),
              ...(values.rootCause.trim() ? { rootCause: values.rootCause.trim() } : {}),
              ...(values.preventiveAction.trim() ? { preventiveAction: values.preventiveAction.trim() } : {}),
            },
          }),
        );
        return "Corrective action raised";
      }}
    >
      <Field>
        <FieldLabel htmlFor="raise-title">What happened</FieldLabel>
        <Input
          id="raise-title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <FieldDescription>
          To link a stock lot, put it into quarantine on its lot page and mention it here.
        </FieldDescription>
      </Field>
      <SelectField
        id="raise-batch"
        label="Batch"
        value={batchId}
        onChange={setBatchId}
        options={[[NONE, "No batch"], ...batches.map((b) => [b.id, b.batchCode] as const)]}
      />
      <ActionFields
        values={values}
        onChange={(field, value) => setValues((v) => ({ ...v, [field]: value }))}
      />
    </HaccpDialog>
  );
}
