"use client";

import {
  evaluateStorageReading,
  storageMeasureDefaultUnits,
  storageMeasureLabels,
  storageMeasures,
  storageUnitKindLabels,
  storageUnitKinds,
  type StorageMeasure,
  type StorageUnitKind,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { BadgeCheck, Check, Plus, Thermometer, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  ApiSourceBadge,
  CorrectiveActionBadge,
  DueStateBadge,
  ReadingBadge,
  ReviewStatusBadge,
} from "@/components/haccp-badges";
import {
  FrequencyField,
  NONE,
  SelectField,
  SiteDialog,
  TextAreaField,
  TextField,
  useDateTime,
  frequencyBody,
  siteApi,
  text,
  type FrequencyState,
} from "@/components/site-forms";
import { CorrectReadingDialog } from "@/components/site-correct-dialogs";
import type { SiteAction, SiteArea, StorageReading, StorageUnit } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

type Dialog =
  | { kind: "unit" }
  | { kind: "reading"; unit: StorageUnit }
  | { kind: "correct"; reading: StorageReading }
  | { kind: "reject"; reading: StorageReading }
  | { kind: "action"; action: SiteAction }
  | { kind: "close"; action: SiteAction };

/**
 * Storage temperature logging: units with limits, readings flagged against them, and corrective
 * actions on excursions. A person's reading is approved as entered; a reading an API token
 * recorded (an agent or a sensor feed) waits for a person with manage access to approve or reject
 * it. An out-of-limit reading opens a corrective action at once.
 */
export function StorageBoard({
  slug,
  units,
  readings,
  actions,
  areas,
}: {
  slug: string;
  units: StorageUnit[];
  readings: StorageReading[];
  actions: SiteAction[];
  areas: SiteArea[];
}) {
  const dateTime = useDateTime();
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("site", "write");
  const canManage = can("site", "manage");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const live = units.filter((u) => u.status === "active");

  async function review(reading: StorageReading, decision: "approve") {
    try {
      await unwrap(
        siteApi().storage.readings[":id"].review.$post({
          param: { slug, id: reading.id },
          json: { decision },
        }),
      );
      toast.success("Reading approved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      router.refresh();
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Storage monitoring</h2>
        {canWrite && (
          <Button onClick={() => setDialog({ kind: "unit" })}>
            <Plus data-icon="inline-start" /> Add unit
          </Button>
        )}
      </div>

      <Card className="py-0">
        <CardContent className="overflow-x-auto px-0 py-2">
          {live.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No storage units yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Unit</TableHead>
                  <TableHead>Limits</TableHead>
                  <TableHead>Last reading</TableHead>
                  <TableHead>Next</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {live.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {storageUnitKindLabels[u.kind]}
                        {u.location ? ` · ${u.location}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>{u.limitsText}</TableCell>
                    <TableCell>
                      {u.lastReading ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="tabular-nums">{u.lastReading.text}</span>
                          <ReadingBadge withinLimits={u.lastReading.withinLimits} />
                          <span className="text-xs text-muted-foreground">
                            {dateTime(u.lastReading.checkedAt)}
                          </span>
                        </span>
                      ) : (
                        "Never"
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        {u.due && <DueStateBadge state={u.due.state} />}
                        <span className="text-xs text-muted-foreground">{u.frequencyText}</span>
                      </span>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "reading", unit: u })}
                        >
                          <Thermometer data-icon="inline-start" /> Record
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

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Open corrective actions</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {actions.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">None open.</p>
          ) : (
            <Table>
              <TableBody>
                {actions.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-4 whitespace-normal">
                      <div className="font-medium">{a.title}</div>
                      {a.missing.length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          Still to record: {a.missing.join(", ")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <CorrectiveActionBadge status={a.status} />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <div className="flex justify-end gap-2">
                        {canWrite && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDialog({ kind: "action", action: a })}
                          >
                            Fill in
                          </Button>
                        )}
                        {canManage && (
                          <Button
                            size="sm"
                            disabled={a.missing.length > 0}
                            onClick={() => setDialog({ kind: "close", action: a })}
                          >
                            <BadgeCheck data-icon="inline-start" /> Close
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Readings</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {readings.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No readings yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">When</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Reading</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {readings.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="pl-4 whitespace-nowrap">{dateTime(r.checkedAt)}</TableCell>
                    <TableCell>{r.unit?.name}</TableCell>
                    <TableCell className="tabular-nums">
                      {r.readingText}
                      <span className="ml-2 text-xs text-muted-foreground">limit {r.limitsText}</span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        <ReadingBadge withinLimits={r.withinLimits} reason={r.deviationReason} />
                        {r.source === "api" && <ApiSourceBadge />}
                        <ReviewStatusBadge status={r.reviewStatus} note={r.reviewNote} />
                      </span>
                    </TableCell>
                    <TableCell>{r.recordedByName}</TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "correct", reading: r })}
                        >
                          Correct
                        </Button>
                      )}
                      {canManage && r.reviewStatus === "pending" && (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDialog({ kind: "reject", reading: r })}
                          >
                            <X data-icon="inline-start" /> Reject
                          </Button>
                          <Button size="sm" onClick={() => void review(r, "approve")}>
                            <Check data-icon="inline-start" /> Approve
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === "unit" && <UnitDialog slug={slug} areas={areas} onClose={() => setDialog(null)} />}
      {dialog?.kind === "correct" && (
        <CorrectReadingDialog
          slug={slug}
          reading={dialog.reading}
          canManage={canManage}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "reading" && (
        <ReadingDialog slug={slug} unit={dialog.unit} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "reject" && (
        <RejectDialog slug={slug} reading={dialog.reading} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "action" && (
        <ActionDialog slug={slug} action={dialog.action} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "close" && (
        <CloseDialog slug={slug} action={dialog.action} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function UnitDialog({ slug, areas, onClose }: { slug: string; areas: SiteArea[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<StorageUnitKind>("chiller");
  const [measure, setMeasure] = useState<StorageMeasure>("temperature");
  const [location, setLocation] = useState("");
  const [area, setArea] = useState(NONE);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("5");
  const [unit, setUnit] = useState("°C");
  const [frequency, setFrequency] = useState<FrequencyState>({ every: "1", unit: "day" });
  return (
    <SiteDialog
      title="Add storage unit"
      description="A chiller, freezer or ambient store, with the limits its readings are judged against."
      submitLabel="Add unit"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().storage.units.$post({
            param: { slug },
            json: {
              name: name.trim(),
              kind,
              measure,
              unit: unit.trim(),
              ...(text(code) ? { code: text(code)! } : {}),
              ...(text(location) ? { location: text(location)! } : {}),
              ...(area !== NONE ? { areaId: area } : {}),
              ...(min !== "" ? { limitMin: Number(min) } : {}),
              ...(max !== "" ? { limitMax: Number(max) } : {}),
              readingFrequency: frequencyBody(frequency),
            },
          }),
        );
        return `${name.trim()} added`;
      }}
    >
      <TextField id="su-name" label="Name" required value={name} onChange={setName} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="su-code" label="Code" value={code} onChange={setCode} />
        <SelectField
          id="su-kind"
          label="Kind"
          value={kind}
          onChange={(v) => setKind(v as StorageUnitKind)}
          options={storageUnitKinds.map((k) => [k, storageUnitKindLabels[k]] as const)}
        />
      </div>
      <SelectField
        id="su-measure"
        label="Measures"
        value={measure}
        onChange={(v) => {
          const m = v as StorageMeasure;
          setMeasure(m);
          setUnit(storageMeasureDefaultUnits[m] ?? "");
          setMax(m === "temperature" ? "5" : "");
        }}
        options={storageMeasures.map((m) => [m, storageMeasureLabels[m]] as const)}
        description="One unit measures one thing: add a second unit for the humidity of a chiller."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField id="su-min" label="Minimum" type="number" step="any" value={min} onChange={setMin} />
        <TextField id="su-max" label="Maximum" type="number" step="any" value={max} onChange={setMax} />
        <TextField id="su-unit" label="Unit" required value={unit} onChange={setUnit} />
      </div>
      <FrequencyField id="su-freq" label="Read every" value={frequency} onChange={setFrequency} />
      <TextField id="su-loc" label="Location" value={location} onChange={setLocation} />
      <SelectField
        id="su-area"
        label="Area"
        value={area}
        onChange={setArea}
        options={[[NONE, "No area"], ...areas.map((a) => [a.id, a.name] as const)]}
      />
    </SiteDialog>
  );
}

function ReadingDialog({ slug, unit, onClose }: { slug: string; unit: StorageUnit; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [actionTaken, setActionTaken] = useState("");
  const evaluation =
    value.trim() !== "" && Number.isFinite(Number(value))
      ? evaluateStorageReading({ limitMin: unit.limitMin, limitMax: unit.limitMax }, Number(value))
      : null;
  return (
    <SiteDialog
      title={`Record a reading: ${unit.name}`}
      description={`Limits ${unit.limitsText}. An out-of-limit reading opens a corrective action.`}
      submitLabel="Record reading"
      onClose={onClose}
      onSubmit={async () => {
        const reading = await unwrap(
          siteApi().storage.readings.$post({
            param: { slug },
            json: {
              unitId: unit.id,
              value: Number(value),
              ...(text(note) ? { note: text(note)! } : {}),
              ...(!evaluation?.withinLimits && text(actionTaken)
                ? { correctiveAction: { actionTaken: text(actionTaken)! } }
                : {}),
            },
          }),
        );
        return reading.withinLimits
          ? "Reading recorded"
          : "Reading recorded: outside the limits, corrective action opened";
      }}
    >
      <div className="flex items-end gap-3">
        <TextField
          id="rd-value"
          label={`Reading (${unit.unit})`}
          type="number"
          step="any"
          required
          value={value}
          onChange={setValue}
        />
        {evaluation && <ReadingBadge withinLimits={evaluation.withinLimits} reason={evaluation.reason} />}
      </div>
      <TextField id="rd-note" label="Note" value={note} onChange={setNote} />
      {evaluation && !evaluation.withinLimits && (
        <TextAreaField
          id="rd-action"
          label="Done straight away"
          value={actionTaken}
          onChange={setActionTaken}
          description="For example product probed, moved or held."
        />
      )}
    </SiteDialog>
  );
}

function RejectDialog({
  slug,
  reading,
  onClose,
}: {
  slug: string;
  reading: StorageReading;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <SiteDialog
      title="Reject reading"
      description={`${reading.unit?.name}: ${reading.readingText}. The reading no longer counts, so the check is due again. A corrective action it opened stays open.`}
      submitLabel="Reject reading"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().storage.readings[":id"].review.$post({
            param: { slug, id: reading.id },
            json: { decision: "reject", note: note.trim() },
          }),
        );
        return "Reading rejected";
      }}
    >
      <TextAreaField id="rj-note" label="Why" required value={note} onChange={setNote} />
    </SiteDialog>
  );
}

function ActionDialog({ slug, action, onClose }: { slug: string; action: SiteAction; onClose: () => void }) {
  const [actionTaken, setActionTaken] = useState(action.actionTaken ?? "");
  const [rootCause, setRootCause] = useState(action.rootCause ?? "");
  const [preventive, setPreventive] = useState(action.preventiveAction ?? "");
  return (
    <SiteDialog
      title="Corrective action"
      description={action.title}
      submitLabel="Save"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().actions[":id"].$patch({
            param: { slug, id: action.id },
            json: {
              actionTaken: actionTaken.trim(),
              rootCause: rootCause.trim(),
              preventiveAction: preventive.trim(),
            },
          }),
        );
        return "Saved";
      }}
    >
      <TextAreaField id="ca-taken" label="What was done" value={actionTaken} onChange={setActionTaken} />
      <TextAreaField id="ca-root" label="Root cause" value={rootCause} onChange={setRootCause} />
      <TextAreaField id="ca-prev" label="Preventive action" value={preventive} onChange={setPreventive} />
    </SiteDialog>
  );
}

function CloseDialog({ slug, action, onClose }: { slug: string; action: SiteAction; onClose: () => void }) {
  const [note, setNote] = useState("");
  return (
    <SiteDialog
      title="Close corrective action"
      description={`${action.title}. Closing is your sign-off; a closed action never changes.`}
      submitLabel="Close action"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().actions[":id"].close.$post({
            param: { slug, id: action.id },
            json: { ...(text(note) ? { note: text(note)! } : {}) },
          }),
        );
        return `Closed (${formatLongDate(new Date().toISOString())})`;
      }}
    >
      <TextAreaField id="cc-note" label="Note" value={note} onChange={setNote} />
    </SiteDialog>
  );
}
