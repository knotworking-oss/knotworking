"use client";

import {
  checkItemResultLabels,
  checkItemResults,
  glassConditionLabels,
  glassConditions,
  pestActivityLabels,
  pestActivityLevels,
  type CheckItemResult,
  type GlassCondition,
  type PestActivity,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  NONE,
  SelectField,
  SiteDialog,
  TextAreaField,
  TextField,
  siteApi,
  maintenanceApi,
  text,
} from "@/components/site-forms";
import type {
  ChecklistCheck,
  GlassCheck,
  MaintenanceRecord,
  PestDevice,
  PestVisit,
  StorageReading,
} from "@/lib/api";
import { unwrap } from "@/lib/auth-client";

/**
 * Corrections of site records. A record is never edited: a correction appends a new record that
 * replaces the old one (which stays, struck through, in the printed records), so every form asks
 * for the reason. A correction is a person's act (never an API token).
 */

const reasonField = (value: string, onChange: (v: string) => void) => (
  <TextAreaField
    id="correct-reason"
    label="Why is it being corrected?"
    required
    rows={2}
    value={value}
    onChange={onChange}
    description="Kept with the correction, and printed in the audit records."
  />
);

export function CorrectGlassCheckDialog({
  slug,
  check,
  onClose,
}: {
  slug: string;
  check: GlassCheck;
  onClose: () => void;
}) {
  const [condition, setCondition] = useState<GlassCondition>(check.condition);
  const [note, setNote] = useState(check.note ?? "");
  const [reason, setReason] = useState("");
  return (
    <SiteDialog
      title="Correct a glass check"
      description={`${check.item?.description ?? "Item"}: recorded as ${glassConditionLabels[check.condition].toLowerCase()}. The correction replaces it.`}
      submitLabel="Correct check"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().glass.checks[":id"].correct.$post({
            param: { slug, id: check.id },
            json: { reason: reason.trim(), condition, ...(text(note) ? { note: text(note)! } : {}) },
          }),
        );
        return "Check corrected";
      }}
    >
      <SelectField
        id="cg-condition"
        label="Condition"
        value={condition}
        onChange={(v) => setCondition(v as GlassCondition)}
        options={glassConditions.map((c) => [c, glassConditionLabels[c]] as const)}
      />
      <TextField
        id="cg-note"
        label="Note"
        required={condition !== "intact"}
        value={note}
        onChange={setNote}
      />
      {reasonField(reason, setReason)}
    </SiteDialog>
  );
}

export function CorrectReadingDialog({
  slug,
  reading,
  canManage,
  onClose,
}: {
  slug: string;
  reading: StorageReading;
  canManage: boolean;
  onClose: () => void;
}) {
  const [value, setValue] = useState(String(reading.value));
  const [note, setNote] = useState(reading.note ?? "");
  const [reason, setReason] = useState("");
  return (
    <SiteDialog
      title="Correct a reading"
      description={`${reading.unit?.name}: ${reading.readingText}. The correction is judged against the limits the original was.${reading.withinLimits || canManage ? "" : " Correcting an out-of-limit reading needs manage access."}`}
      submitLabel="Correct reading"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().storage.readings[":id"].correct.$post({
            param: { slug, id: reading.id },
            json: {
              value: Number(value),
              reason: reason.trim(),
              ...(text(note) ? { note: text(note)! } : {}),
            },
          }),
        );
        return "Reading corrected";
      }}
    >
      <TextField
        id="cr-value"
        label="Correct value"
        type="number"
        step="any"
        required
        value={value}
        onChange={setValue}
      />
      <TextField id="cr-note" label="Note" value={note} onChange={setNote} />
      {reasonField(reason, setReason)}
    </SiteDialog>
  );
}

export function CorrectMaintenanceDialog({
  slug,
  record,
  onClose,
}: {
  slug: string;
  record: MaintenanceRecord;
  onClose: () => void;
}) {
  const [workDone, setWorkDone] = useState(record.workDone ?? "");
  const [contractor, setContractor] = useState(record.contractor ?? "");
  const [nextDueOn, setNextDueOn] = useState(record.nextDueOn);
  const [note, setNote] = useState(record.note ?? "");
  const [reason, setReason] = useState("");
  return (
    <SiteDialog
      title="Correct maintenance record"
      description={`${record.asset?.name}: ${record.task?.title}. What isn't changed is kept from the original${record.clearanceRequired ? "; the correction needs its own return-to-service clearance" : ""}.`}
      submitLabel="Correct record"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi().records[":id"].correct.$post({
            param: { slug, id: record.id },
            json: {
              reason: reason.trim(),
              workDone: workDone.trim() || null,
              contractor: contractor.trim() || null,
              note: note.trim() || null,
              nextDueOn,
            },
          }),
        );
        return "Record corrected";
      }}
    >
      <TextAreaField id="cm-work" label="Work done" value={workDone} onChange={setWorkDone} />
      <TextField id="cm-contractor" label="Contractor" value={contractor} onChange={setContractor} />
      <TextField
        id="cm-next"
        label="Next due"
        type="date"
        required
        value={nextDueOn}
        onChange={setNextDueOn}
      />
      <TextField id="cm-note" label="Note" value={note} onChange={setNote} />
      {reasonField(reason, setReason)}
    </SiteDialog>
  );
}

export function CorrectCheckDialog({
  slug,
  check,
  onClose,
}: {
  slug: string;
  check: ChecklistCheck;
  onClose: () => void;
}) {
  type Row = { result: CheckItemResult; note: string };
  // A result is keyed by its checklist item, or by its own row when the item was removed since.
  const keyOf = (r: ChecklistCheck["results"][number]) => r.itemId ?? r.id;
  const [rows, setRows] = useState<Record<string, Row>>(
    Object.fromEntries(check.results.map((r) => [keyOf(r), { result: r.result, note: r.note ?? "" }])),
  );
  const [note, setNote] = useState(check.note ?? "");
  const [reason, setReason] = useState("");
  return (
    <SiteDialog
      wide
      title="Correct a check"
      description={`${check.templateName}. The correction replaces it and needs its own sign-off.`}
      submitLabel="Correct check"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().checklists.checks[":id"].correct.$post({
            param: { slug, id: check.id },
            json: {
              reason: reason.trim(),
              results: check.results.map((r) => ({
                itemId: keyOf(r),
                result: rows[keyOf(r)]!.result,
                ...(text(rows[keyOf(r)]!.note) ? { note: text(rows[keyOf(r)]!.note)! } : {}),
              })),
              ...(text(note) ? { note: text(note)! } : {}),
            },
          }),
        );
        return "Check corrected";
      }}
    >
      {check.results.map((r) => (
        <div key={keyOf(r)} className="grid gap-2 rounded-md border p-3 sm:grid-cols-5">
          <div className="text-sm font-medium sm:col-span-2">{r.prompt}</div>
          <SelectField
            id={`cc-${keyOf(r)}`}
            label="Result"
            value={rows[keyOf(r)]!.result}
            onChange={(v) =>
              setRows((p) => ({ ...p, [keyOf(r)]: { ...p[keyOf(r)]!, result: v as CheckItemResult } }))
            }
            options={checkItemResults.map((x) => [x, checkItemResultLabels[x]] as const)}
          />
          <TextField
            id={`cc-note-${keyOf(r)}`}
            label="Note"
            required={rows[keyOf(r)]!.result === "fail"}
            value={rows[keyOf(r)]!.note}
            onChange={(v) => setRows((p) => ({ ...p, [keyOf(r)]: { ...p[keyOf(r)]!, note: v } }))}
            className="sm:col-span-2"
          />
        </div>
      ))}
      <TextField id="cc-note" label="Overall note" value={note} onChange={setNote} />
      {reasonField(reason, setReason)}
    </SiteDialog>
  );
}

interface FindingState {
  key: number;
  device: string;
  location: string;
  activity: PestActivity;
  pest: string;
  count: string;
  action: string;
}

/** Corrects a pest control visit: the whole visit again, findings included. */
export function CorrectVisitDialog({
  slug,
  visit,
  devices,
  onClose,
}: {
  slug: string;
  visit: PestVisit;
  devices: PestDevice[];
  onClose: () => void;
}) {
  const [contractor, setContractor] = useState(visit.contractor);
  const [technician, setTechnician] = useState(visit.technician ?? "");
  const [visitedOn, setVisitedOn] = useState(visit.visitedOn);
  const [nextVisitOn, setNextVisitOn] = useState(visit.nextVisitOn ?? "");
  const [summary, setSummary] = useState(visit.summary ?? "");
  const [recommendations, setRecommendations] = useState(visit.recommendations ?? "");
  const [actionsTaken, setActionsTaken] = useState(visit.actionsTaken ?? "");
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<FindingState[]>(
    visit.findings.map((f, i) => ({
      key: i,
      device: f.deviceId ?? NONE,
      location: f.location ?? "",
      activity: f.activity,
      pest: f.pest ?? "",
      count: f.count === null ? "" : String(f.count),
      action: f.action ?? "",
    })),
  );
  const [seq, setSeq] = useState(visit.findings.length);
  const patch = (key: number, changes: Partial<FindingState>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...changes } : r)));
  return (
    <SiteDialog
      wide
      title="Correct a pest control visit"
      description="The correction replaces the whole visit, so check the findings too."
      submitLabel="Correct visit"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().pest.visits[":id"].correct.$post({
            param: { slug, id: visit.id },
            json: {
              reason: reason.trim(),
              contractor: contractor.trim(),
              visitedOn,
              technician: text(technician) ?? null,
              summary: text(summary) ?? null,
              recommendations: text(recommendations) ?? null,
              actionsTaken: text(actionsTaken) ?? null,
              nextVisitOn: nextVisitOn || null,
              findings: rows.map((r) => ({
                ...(r.device !== NONE ? { deviceId: r.device } : { location: r.location.trim() }),
                activity: r.activity,
                ...(text(r.pest) ? { pest: text(r.pest)! } : {}),
                ...(r.count !== "" ? { count: Number(r.count) } : {}),
                ...(text(r.action) ? { action: text(r.action)! } : {}),
              })),
            },
          }),
        );
        return "Visit corrected";
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="cv-contractor"
          label="Contractor"
          required
          value={contractor}
          onChange={setContractor}
        />
        <TextField id="cv-tech" label="Technician" value={technician} onChange={setTechnician} />
        <TextField
          id="cv-date"
          label="Visit date"
          type="date"
          required
          value={visitedOn}
          onChange={setVisitedOn}
        />
        <TextField
          id="cv-next"
          label="Next visit"
          type="date"
          value={nextVisitOn}
          onChange={setNextVisitOn}
        />
      </div>
      <TextAreaField id="cv-summary" label="Summary" value={summary} onChange={setSummary} />
      <TextAreaField
        id="cv-recs"
        label="Recommendations"
        value={recommendations}
        onChange={setRecommendations}
      />
      <TextAreaField id="cv-actions" label="Actions taken" value={actionsTaken} onChange={setActionsTaken} />
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Findings</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setRows((p) => [
                ...p,
                { key: seq, device: NONE, location: "", activity: "none", pest: "", count: "", action: "" },
              ]);
              setSeq((s) => s + 1);
            }}
          >
            <Plus data-icon="inline-start" /> Add finding
          </Button>
        </div>
        {rows.map((r) => (
          <div key={r.key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <SelectField
                id={`cf-${r.key}-device`}
                label="Device"
                value={r.device}
                onChange={(v) => patch(r.key, { device: v })}
                options={[
                  [NONE, "Somewhere else"],
                  ...devices.map((d) => [d.id, `${d.code} · ${d.location}`] as const),
                ]}
              />
            </div>
            <div className="sm:col-span-2">
              <SelectField
                id={`cf-${r.key}-activity`}
                label="Activity"
                value={r.activity}
                onChange={(v) => patch(r.key, { activity: v as PestActivity })}
                options={pestActivityLevels.map((a) => [a, pestActivityLabels[a]] as const)}
              />
            </div>
            {r.device === NONE && (
              <TextField
                id={`cf-${r.key}-loc`}
                label="Where"
                required
                value={r.location}
                onChange={(v) => patch(r.key, { location: v })}
                className="sm:col-span-2"
              />
            )}
            {r.activity !== "none" && (
              <>
                <TextField
                  id={`cf-${r.key}-pest`}
                  label="Pest"
                  required
                  value={r.pest}
                  onChange={(v) => patch(r.key, { pest: v })}
                  className="sm:col-span-2"
                />
                <TextField
                  id={`cf-${r.key}-count`}
                  label="Count"
                  type="number"
                  value={r.count}
                  onChange={(v) => patch(r.key, { count: v })}
                />
                <TextField
                  id={`cf-${r.key}-action`}
                  label="Action"
                  value={r.action}
                  onChange={(v) => patch(r.key, { action: v })}
                  className="sm:col-span-3"
                />
              </>
            )}
            <div className="flex items-end">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
      {reasonField(reason, setReason)}
    </SiteDialog>
  );
}
