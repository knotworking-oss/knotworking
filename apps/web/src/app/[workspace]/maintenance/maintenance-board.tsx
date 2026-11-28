"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { BadgeCheck, Plus, Wrench } from "lucide-react";
import { assetKinds } from "@knotworking/core";
import Link from "next/link";
import { useState } from "react";
import { AssetDialog } from "@/components/asset-dialog";
import { DueStateBadge } from "@/components/haccp-badges";
import {
  FrequencyField,
  NONE,
  SelectField,
  SiteDialog,
  TextAreaField,
  TextField,
  useDateTime,
  frequencyBody,
  maintenanceApi,
  text,
  type FrequencyState,
} from "@/components/site-forms";
import { CorrectMaintenanceDialog } from "@/components/site-correct-dialogs";
import { WorkOrdersCard } from "@/components/work-orders-card";
import type {
  CalibrationInstrument,
  MaintenanceAsset,
  MaintenanceRecord,
  MaintenanceTask,
  SiteArea,
  WorkOrder,
} from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

type Dialog =
  | { kind: "asset" }
  | { kind: "link"; asset: MaintenanceAsset }
  | { kind: "task" }
  | { kind: "record"; task: MaintenanceTask }
  | { kind: "clear"; record: MaintenanceRecord }
  | { kind: "correct"; record: MaintenanceRecord };

/**
 * Planned maintenance: assets with tasks on intervals, what is due, and records of completed work.
 * Work in a production area needs a return-to-service clearance (the area is safe to restart): a sign-off by
 * a person with manage access.
 */
export function MaintenanceBoard({
  slug,
  assets,
  tasks,
  records,
  areas,
  workOrders,
  instruments,
  calibration,
  members,
}: {
  slug: string;
  assets: MaintenanceAsset[];
  tasks: MaintenanceTask[];
  records: MaintenanceRecord[];
  areas: SiteArea[];
  workOrders: WorkOrder[];
  instruments: CalibrationInstrument[];
  /** Whether the viewer can read HACCP: calibration instruments are its records. */
  calibration: boolean;
  members: { id: string; name: string }[];
}) {
  const dateTime = useDateTime();
  const { can } = useWorkspace();
  const canWrite = can("maintenance", "write");
  const canManage = can("maintenance", "manage");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const activeTasks = tasks.filter((t) => t.status === "active");

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Planned maintenance</h2>
        {canWrite && (
          <div className="flex gap-2">
            {can("assets", "write") && (
              <Button variant="outline" onClick={() => setDialog({ kind: "asset" })}>
                <Plus data-icon="inline-start" /> Add asset
              </Button>
            )}
            <Button onClick={() => setDialog({ kind: "task" })} disabled={assets.length === 0}>
              <Plus data-icon="inline-start" /> Add task
            </Button>
          </div>
        )}
      </div>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Tasks</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {activeTasks.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No tasks yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Asset</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Every</TableHead>
                  <TableHead>Last done</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeTasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{t.asset?.name}</div>
                      {t.asset?.area && (
                        <div className="text-xs text-muted-foreground">{t.asset.area.name}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {t.title}
                      {t.clearanceRequired && (
                        <Badge variant="outline" className="ml-2">
                          Return-to-service clearance
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{t.frequencyText}</TableCell>
                    <TableCell>{t.lastRecord ? dateTime(t.lastRecord.completedAt) : "Never"}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        {t.due && <DueStateBadge state={t.due.state} />}
                        {t.due?.dueOn && (
                          <span className="text-xs text-muted-foreground">{formatLongDate(t.due.dueOn)}</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "record", task: t })}
                        >
                          <Wrench data-icon="inline-start" /> Record
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <WorkOrdersCard slug={slug} orders={workOrders} assets={assets.filter((a) => a.status === "active")} />

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Equipment</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Asset</TableHead>
                <TableHead>Area</TableHead>
                {calibration && <TableHead className="pr-4">Calibration instrument</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets
                .filter((a) => a.status === "active" && a.kind !== "area")
                .map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-4 font-medium">
                      {can("assets") ? (
                        <Link className="hover:underline" href={`/${slug}/assets/${a.id}`}>
                          {a.name}
                        </Link>
                      ) : (
                        a.name
                      )}
                    </TableCell>
                    <TableCell>{a.area?.name ?? "—"}</TableCell>
                    {calibration && (
                      <TableCell className="pr-4">
                        {a.calibrationInstrument ? (
                          <span className="flex flex-wrap items-center gap-2">
                            {a.calibrationInstrument.name}
                            <DueStateBadge state={a.calibrationInstrument.state} />
                            <span className="text-xs text-muted-foreground">
                              {a.calibrationInstrument.lastCalibration
                                ? `${a.calibrationInstrument.lastCalibration.passed ? "Passed" : "Failed"} ${formatLongDate(a.calibrationInstrument.lastCalibration.calibratedAt.slice(0, 10))}`
                                : "Never calibrated"}
                            </span>
                          </span>
                        ) : (
                          "—"
                        )}
                        {canWrite && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-2"
                            onClick={() => setDialog({ kind: "link", asset: a })}
                          >
                            {a.calibrationInstrument ? "Change" : "Link"}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Completed work</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {records.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Done</TableHead>
                  <TableHead>Work</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Return-to-service clearance</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="pl-4 whitespace-nowrap">{dateTime(r.completedAt)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="font-medium">
                        {r.asset?.name}: {r.task?.title}
                      </div>
                      {r.workDone && <div className="text-sm text-muted-foreground">{r.workDone}</div>}
                    </TableCell>
                    <TableCell>{r.contractor ?? r.doneByName}</TableCell>
                    <TableCell>
                      {!r.clearanceRequired
                        ? "Not needed"
                        : r.clearedAt
                          ? `Cleared by ${r.clearedByName}, ${dateTime(r.clearedAt)}`
                          : `Awaiting clearance${r.area ? ` (${r.area.name})` : ""}`}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && !r.correctedByRecordId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "correct", record: r })}
                        >
                          Correct
                        </Button>
                      )}
                      {r.awaitingClearance && canManage && (
                        <Button size="sm" onClick={() => setDialog({ kind: "clear", record: r })}>
                          <BadgeCheck data-icon="inline-start" /> Clear area
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === "asset" && (
        <AssetDialog
          slug={slug}
          areas={areas}
          members={members}
          kinds={assetKinds.filter((k) => k !== "area")}
          defaultKind="equipment"
          title="Add asset"
          description="An asset of the register that is maintained. Give it an area if work on it needs a return-to-service clearance."
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "link" && (
        <LinkInstrumentDialog
          slug={slug}
          asset={dialog.asset}
          instruments={instruments}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "correct" && (
        <CorrectMaintenanceDialog slug={slug} record={dialog.record} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "task" && (
        <TaskDialog
          slug={slug}
          assets={assets.filter((a) => a.status === "active")}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "record" && (
        <RecordDialog slug={slug} task={dialog.task} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "clear" && (
        <ClearDialog slug={slug} record={dialog.record} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/** Links a maintained asset to the HACCP calibration instrument it is (read-only there). */
function LinkInstrumentDialog({
  slug,
  asset,
  instruments,
  onClose,
}: {
  slug: string;
  asset: MaintenanceAsset;
  instruments: CalibrationInstrument[];
  onClose: () => void;
}) {
  const [instrument, setInstrument] = useState(asset.calibrationInstrumentId ?? NONE);
  return (
    <SiteDialog
      title={`Calibration instrument of ${asset.name}`}
      description="Links this asset to equipment in the calibration register (read-only there), so its calibration shows here."
      submitLabel="Save"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi().assets[":id"].$patch({
            param: { slug, id: asset.id },
            json: { calibrationInstrumentId: instrument === NONE ? null : instrument },
          }),
        );
        return `${asset.name} saved`;
      }}
    >
      <SelectField
        id="as-instrument"
        label="Calibration instrument"
        value={instrument}
        onChange={setInstrument}
        options={[
          [NONE, "Not a calibrated instrument"],
          ...instruments
            .filter((i) => !i.linkedAssetId || i.linkedAssetId === asset.id)
            .map((i) => [i.id, i.name] as const),
        ]}
      />
    </SiteDialog>
  );
}

function TaskDialog({
  slug,
  assets,
  onClose,
}: {
  slug: string;
  assets: MaintenanceAsset[];
  onClose: () => void;
}) {
  const [asset, setAsset] = useState(assets[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [frequency, setFrequency] = useState<FrequencyState>({ every: "1", unit: "month" });
  const [startOn, setStartOn] = useState("");
  const [clearance, setClearance] = useState(false);
  return (
    <SiteDialog
      title="Add task"
      description="Maintenance done on an asset at an interval."
      submitLabel="Add task"
      disabled={!asset}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi().tasks.$post({
            param: { slug },
            json: {
              assetId: asset,
              title: title.trim(),
              ...(text(description) ? { description: text(description)! } : {}),
              frequency: frequencyBody(frequency),
              ...(startOn ? { startOn } : {}),
              clearanceRequired: clearance,
            },
          }),
        );
        return "Task added";
      }}
    >
      <SelectField
        id="tk-asset"
        label="Asset"
        value={asset}
        onChange={setAsset}
        options={assets.map((a) => [a.id, a.name] as const)}
      />
      <TextField id="tk-title" label="Task" required value={title} onChange={setTitle} />
      <TextAreaField id="tk-desc" label="Description" value={description} onChange={setDescription} />
      <FrequencyField id="tk-freq" label="Every" value={frequency} onChange={setFrequency} />
      <TextField
        id="tk-start"
        label="First due"
        type="date"
        value={startOn}
        onChange={setStartOn}
        description="Without a date a task never done is due now."
      />
      <Field orientation="horizontal">
        <Checkbox id="tk-clear" checked={clearance} onCheckedChange={(v) => setClearance(v === true)} />
        <FieldLabel htmlFor="tk-clear">Require clearance before returning the asset to use</FieldLabel>
      </Field>
    </SiteDialog>
  );
}

function RecordDialog({ slug, task, onClose }: { slug: string; task: MaintenanceTask; onClose: () => void }) {
  const [contractor, setContractor] = useState("");
  const [workDone, setWorkDone] = useState("");
  const [nextDueOn, setNextDueOn] = useState("");
  return (
    <SiteDialog
      title="Record maintenance"
      description={`${task.asset?.name}: ${task.title}. You are recording that the work was done${task.clearanceRequired ? "; a person with manage access then gives the return-to-service clearance" : ""}.`}
      submitLabel="Record"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi().records.$post({
            param: { slug },
            json: {
              taskId: task.id,
              ...(text(contractor) ? { contractor: text(contractor)! } : {}),
              ...(text(workDone) ? { workDone: text(workDone)! } : {}),
              ...(nextDueOn ? { nextDueOn } : {}),
            },
          }),
        );
        return "Maintenance recorded";
      }}
    >
      <TextAreaField id="rc-work" label="Work done" value={workDone} onChange={setWorkDone} />
      <TextField
        id="rc-contractor"
        label="Contractor"
        value={contractor}
        onChange={setContractor}
        description="If an outside contractor did it."
      />
      <TextField
        id="rc-next"
        label="Next due"
        type="date"
        value={nextDueOn}
        onChange={setNextDueOn}
        description={`Default: ${task.frequencyText?.toLowerCase()} from now.`}
      />
    </SiteDialog>
  );
}

function ClearDialog({
  slug,
  record,
  onClose,
}: {
  slug: string;
  record: MaintenanceRecord;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <SiteDialog
      title="Return-to-service clearance"
      description={`${record.area?.name ?? "The area"} is safe to restart after: ${record.task?.title}. This is your sign-off.`}
      submitLabel="Clear area"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi().records[":id"].clearance.$post({
            param: { slug, id: record.id },
            json: { ...(text(note) ? { note: text(note)! } : {}) },
          }),
        );
        return "Area cleared";
      }}
    >
      <TextAreaField
        id="cl-note"
        label="Note"
        value={note}
        onChange={setNote}
        description="For example the swab or inspection result."
      />
    </SiteDialog>
  );
}
