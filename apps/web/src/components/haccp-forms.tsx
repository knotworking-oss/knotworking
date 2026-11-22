"use client";

import {
  describeLimit,
  evaluateReading,
  type CcpLimitType,
  type CcpLogCorrectInput,
  type CcpLogCreateInput,
  type CcpReading,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ReadingBadge } from "@/components/haccp-badges";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const haccpApi = () => browserApi().v1.workspaces[":slug"].haccp;

/** A form dialog that submits, toasts, closes and refreshes the page. */
export function HaccpDialog({
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
  wide = false,
  disabled = false,
  children,
}: {
  title: string;
  description: ReactNode;
  submitLabel: string;
  /** Returns the success message. */
  onSubmit: () => Promise<string>;
  onClose: () => void;
  wide?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      toast.success(await onSubmit());
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={wide ? "sm:max-w-3xl" : "sm:max-w-lg"}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="max-h-[65vh] overflow-y-auto py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || disabled}>
              {pending && <Spinner data-icon="inline-start" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A labelled select of string options. */
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  description,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Field>
      <FieldLabel id={`${id}-label`}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-labelledby={`${id}-label`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map(([v, text]) => (
              <SelectItem key={v} value={v}>
                {text}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

/** What the check form needs to know about a CCP. */
export interface CheckableCcp {
  id: string;
  code: string;
  processStep: string;
  limitType: CcpLimitType;
  limitMin: number | null;
  limitMax: number | null;
  limitUnit: string | null;
  passCriterion: string | null;
  monitoringMethod: string;
  correctiveAction: string;
  frequency: { unit: string };
}

const NO_BATCH = "none";

/** Reading inputs (a value, or pass/fail) with live evaluation against the critical limit. */
function ReadingInput({
  ccp,
  value,
  onValue,
  passed,
  onPassed,
  idPrefix,
}: {
  ccp: CheckableCcp;
  value: string;
  onValue: (v: string) => void;
  passed: "pass" | "fail" | "";
  onPassed: (v: "pass" | "fail" | "") => void;
  idPrefix: string;
}) {
  const reading = readingOf(ccp, value, passed);
  const evaluation = reading ? evaluateReading(ccp, reading) : null;
  return (
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-reading`}>
        Reading <span className="font-normal text-muted-foreground">· limit {describeLimit(ccp)}</span>
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        {ccp.limitType === "range" ? (
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-reading`}
              className="w-32"
              type="number"
              inputMode="decimal"
              step="any"
              required
              autoFocus
              value={value}
              onChange={(e) => onValue(e.target.value)}
            />
            {ccp.limitUnit && <span className="text-sm text-muted-foreground">{ccp.limitUnit}</span>}
          </div>
        ) : (
          <ToggleGroup
            id={`${idPrefix}-reading`}
            type="single"
            variant="outline"
            value={passed}
            onValueChange={(v) => onPassed(v as "pass" | "fail" | "")}
          >
            <ToggleGroupItem value="pass">Pass</ToggleGroupItem>
            <ToggleGroupItem value="fail">Fail</ToggleGroupItem>
          </ToggleGroup>
        )}
        {evaluation && <ReadingBadge withinLimits={evaluation.withinLimits} reason={evaluation.reason} />}
      </div>
      {ccp.limitType === "pass_fail" && ccp.passCriterion && (
        <FieldDescription>Pass: {ccp.passCriterion}</FieldDescription>
      )}
    </Field>
  );
}

function readingOf(ccp: CheckableCcp, value: string, passed: "pass" | "fail" | ""): CcpReading | null {
  if (ccp.limitType === "pass_fail") return passed ? { passed: passed === "pass" } : null;
  return value.trim() !== "" && Number.isFinite(Number(value)) ? { value: Number(value) } : null;
}

/**
 * Records a CCP check. The reading is flagged against the critical limit as it is typed; an
 * out-of-limit reading shows the plan's corrective action and asks what was done straight away
 * (the API opens a corrective action with it).
 */
export function CcpCheckDialog({
  slug,
  planCode,
  ccp,
  batches,
  batchId: initialBatch,
  onClose,
  onRecord,
}: {
  slug: string;
  planCode: string;
  ccp: CheckableCcp;
  /** Batches in progress that the plan covers. */
  batches: { id: string; batchCode: string }[];
  batchId?: string | null;
  onClose: () => void;
  /** Replaces the API call and returns the success message (the /design showcase passes one). */
  onRecord?: (json: CcpLogCreateInput) => Promise<string>;
}) {
  const [value, setValue] = useState("");
  const [passed, setPassed] = useState<"pass" | "fail" | "">("");
  const [batchId, setBatchId] = useState<string>(
    initialBatch ?? (ccp.frequency.unit === "batch" ? batches[0]?.id : undefined) ?? NO_BATCH,
  );
  const [note, setNote] = useState("");
  const [actionTaken, setActionTaken] = useState("");
  const reading = readingOf(ccp, value, passed);
  const evaluation = reading ? evaluateReading(ccp, reading) : null;
  const outOfLimits = evaluation?.withinLimits === false;

  return (
    <HaccpDialog
      title={`${ccp.code} · ${ccp.processStep}`}
      description={
        <>
          {planCode} · {ccp.monitoringMethod}
        </>
      }
      submitLabel={outOfLimits ? "Record deviation" : "Record check"}
      disabled={!reading}
      onClose={onClose}
      onSubmit={async () => {
        const json: CcpLogCreateInput = {
          ccpId: ccp.id,
          ...reading!,
          ...(batchId !== NO_BATCH ? { batchId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(outOfLimits && actionTaken.trim()
            ? { correctiveAction: { actionTaken: actionTaken.trim() } }
            : {}),
        };
        if (onRecord) return onRecord(json);
        const log = await unwrap(haccpApi().logs.$post({ param: { slug }, json }));
        return log.withinLimits
          ? `${ccp.code} recorded: ${log.readingText}`
          : `${ccp.code} out of limits: a corrective action is open on the Deviations page`;
      }}
    >
      <ReadingInput
        ccp={ccp}
        value={value}
        onValue={setValue}
        passed={passed}
        onPassed={setPassed}
        idPrefix="check"
      />
      {(batches.length > 0 || ccp.frequency.unit === "batch") && (
        <SelectField
          id="check-batch"
          label="Batch"
          value={batchId}
          onChange={setBatchId}
          options={[[NO_BATCH, "No batch"], ...batches.map((b) => [b.id, b.batchCode] as const)]}
          description={batches.length === 0 ? "No batch the plan covers is in progress." : undefined}
        />
      )}
      {outOfLimits && (
        <>
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Out of limits: take corrective action</AlertTitle>
            <AlertDescription>{ccp.correctiveAction}</AlertDescription>
          </Alert>
          <Field>
            <FieldLabel htmlFor="check-action">What was done straight away</FieldLabel>
            <Textarea
              id="check-action"
              rows={3}
              maxLength={4000}
              placeholder="e.g. Product held; returned to the oven until the core reached 75 °C"
              value={actionTaken}
              onChange={(e) => setActionTaken(e.target.value)}
            />
            <FieldDescription>
              A corrective action opens with this reading. Root cause and prevention can follow; a manager
              closes it.
            </FieldDescription>
          </Field>
        </>
      )}
      <Field>
        <FieldLabel htmlFor="check-note">Note (optional)</FieldLabel>
        <Input id="check-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </HaccpDialog>
  );
}

/** One line of a check sheet: a CCP, optionally against one batch. */
export interface CheckSheetRow {
  key: string;
  planCode: string;
  ccp: CheckableCcp;
  batch: { id: string; batchCode: string } | null;
}

type SheetEntry = {
  value: string;
  passed: "pass" | "fail" | "";
  actionTaken: string;
  /** `done`: recorded (locked); `error`: the server refused it, the message says why. */
  state: "idle" | "recording" | "done" | "error";
  message: string | null;
};

const emptyEntry: SheetEntry = { value: "", passed: "", actionTaken: "", state: "idle", message: null };

/**
 * A check sheet: several CCP readings at once. Each filled-in line is recorded on its own through
 * `POST /haccp/logs` (the same call as a single check, so an out-of-limit line opens its own
 * corrective action and every line is judged on the server). One that fails stays on the sheet with
 * the reason and the others still go in; lines already recorded are locked, so submitting again
 * never records one twice. Blank lines are skipped.
 */
export function CheckSheetDialog({
  slug,
  rows,
  onClose,
  onRecord,
}: {
  slug: string;
  rows: CheckSheetRow[];
  onClose: () => void;
  /** Replaces the API call for one line and returns the reading's text (the /design showcase passes one). */
  onRecord?: (json: CcpLogCreateInput) => Promise<string>;
}) {
  const router = useRouter();
  const [entries, setEntries] = useState<Record<string, SheetEntry>>({});
  const [pending, setPending] = useState(false);
  const entryOf = (key: string) => entries[key] ?? emptyEntry;
  const patch = (key: string, change: Partial<SheetEntry>) =>
    setEntries((all) => ({ ...all, [key]: { ...(all[key] ?? emptyEntry), ...change } }));
  const readingFor = (row: CheckSheetRow) => {
    const e = entryOf(row.key);
    return readingOf(row.ccp, e.value, e.passed);
  };
  const todo = rows.filter((r) => entryOf(r.key).state !== "done" && readingFor(r));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    let recorded = 0;
    let deviations = 0;
    let failed = 0;
    // One after the other: each write takes the workspace's record lock anyway.
    for (const row of todo) {
      const entry = entryOf(row.key);
      const reading = readingFor(row)!;
      const outOfLimits = evaluateReading(row.ccp, reading)?.withinLimits === false;
      const json: CcpLogCreateInput = {
        ccpId: row.ccp.id,
        ...reading,
        ...(row.batch ? { batchId: row.batch.id } : {}),
        ...(outOfLimits && entry.actionTaken.trim()
          ? { correctiveAction: { actionTaken: entry.actionTaken.trim() } }
          : {}),
      };
      patch(row.key, { state: "recording", message: null });
      try {
        if (onRecord) {
          patch(row.key, { state: "done", message: await onRecord(json) });
        } else {
          const log = await unwrap(haccpApi().logs.$post({ param: { slug }, json }));
          patch(row.key, {
            state: "done",
            message: log.withinLimits ? "Recorded" : "Out of limits: corrective action opened",
          });
          if (!log.withinLimits) deviations += 1;
        }
        recorded += 1;
      } catch (err) {
        failed += 1;
        patch(row.key, { state: "error", message: errorMessage(err) });
      }
    }
    setPending(false);
    if (recorded > 0) {
      toast.success(
        `${recorded} reading${recorded === 1 ? "" : "s"} recorded${deviations > 0 ? `, ${deviations} out of limits` : ""}`,
      );
      router.refresh();
    }
    if (failed > 0) toast.error(`${failed} reading${failed === 1 ? "" : "s"} could not be recorded`);
    else if (recorded > 0) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Check sheet</DialogTitle>
            <DialogDescription>
              Fill in the readings you have taken and leave the rest blank. Each one is checked against its
              critical limit and recorded on its own.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto py-4">
            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground">There are no CCP checks to record.</p>
            )}
            {rows.map((row) => {
              const entry = entryOf(row.key);
              const reading = readingFor(row);
              const evaluation = reading ? evaluateReading(row.ccp, reading) : null;
              const locked = entry.state === "done" || entry.state === "recording";
              const id = `sheet-${row.key}`;
              return (
                <div key={row.key} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor={`${id}-reading`} className="text-sm font-medium">
                      {row.ccp.code} · {row.ccp.processStep}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {row.planCode}
                        {row.batch ? ` · batch ${row.batch.batchCode}` : ""} · limit {describeLimit(row.ccp)}
                      </span>
                    </label>
                    <div className="flex items-center gap-2">
                      {entry.state === "recording" && <Spinner />}
                      {evaluation && entry.state !== "done" && (
                        <ReadingBadge withinLimits={evaluation.withinLimits} reason={evaluation.reason} />
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {row.ccp.limitType === "range" ? (
                      <div className="flex items-center gap-2">
                        <Input
                          id={`${id}-reading`}
                          className="w-32"
                          type="number"
                          inputMode="decimal"
                          step="any"
                          disabled={locked}
                          value={entry.value}
                          onChange={(e) =>
                            patch(row.key, { value: e.target.value, state: "idle", message: null })
                          }
                        />
                        {row.ccp.limitUnit && (
                          <span className="text-sm text-muted-foreground">{row.ccp.limitUnit}</span>
                        )}
                      </div>
                    ) : (
                      <ToggleGroup
                        id={`${id}-reading`}
                        type="single"
                        variant="outline"
                        disabled={locked}
                        value={entry.passed}
                        onValueChange={(v) =>
                          patch(row.key, { passed: v as "pass" | "fail" | "", state: "idle", message: null })
                        }
                      >
                        <ToggleGroupItem value="pass">Pass</ToggleGroupItem>
                        <ToggleGroupItem value="fail">Fail</ToggleGroupItem>
                      </ToggleGroup>
                    )}
                    {entry.message && (
                      <span
                        role={entry.state === "error" ? "alert" : undefined}
                        className={
                          entry.state === "error"
                            ? "text-sm text-destructive"
                            : "text-sm text-muted-foreground"
                        }
                      >
                        {entry.message}
                      </span>
                    )}
                  </div>
                  {evaluation?.withinLimits === false && !locked && (
                    <Field>
                      <FieldLabel htmlFor={`${id}-action`}>
                        What was done straight away{" "}
                        <span className="font-normal text-muted-foreground">
                          · plan: {row.ccp.correctiveAction}
                        </span>
                      </FieldLabel>
                      <Input
                        id={`${id}-action`}
                        maxLength={4000}
                        value={entry.actionTaken}
                        onChange={(e) => patch(row.key, { actionTaken: e.target.value })}
                      />
                    </Field>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || todo.length === 0}>
              {pending && <Spinner data-icon="inline-start" />}
              {todo.length === 0
                ? "Record readings"
                : `Record ${todo.length} reading${todo.length === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Corrects a reading: a new row with the right reading that points at the wrong one. */
export function CorrectReadingDialog({
  slug,
  log,
  ccp,
  onClose,
  onRecord,
}: {
  slug: string;
  log: { id: string; readingText: string; ccpCode: string };
  ccp: CheckableCcp;
  onClose: () => void;
  /** Replaces the API call and returns the success message (the /design showcase passes one). */
  onRecord?: (json: CcpLogCorrectInput) => Promise<string>;
}) {
  const [value, setValue] = useState("");
  const [passed, setPassed] = useState<"pass" | "fail" | "">("");
  const [reason, setReason] = useState("");
  const reading = readingOf(ccp, value, passed);
  return (
    <HaccpDialog
      title={`Correct ${log.ccpCode} reading`}
      description={`Recorded as ${log.readingText}. The original stays on record, marked as corrected.`}
      submitLabel="Record correction"
      disabled={!reading || !reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const json: CcpLogCorrectInput = { ...reading!, reason: reason.trim() };
        if (onRecord) return onRecord(json);
        await unwrap(haccpApi().logs[":id"].correct.$post({ param: { slug, id: log.id }, json }));
        return "Correction recorded";
      }}
    >
      <ReadingInput
        ccp={ccp}
        value={value}
        onValue={setValue}
        passed={passed}
        onPassed={setPassed}
        idPrefix="correct"
      />
      <Field>
        <FieldLabel htmlFor="correct-reason">Why it is being corrected</FieldLabel>
        <Input
          id="correct-reason"
          required
          maxLength={500}
          placeholder="e.g. Typed 7.5 instead of 75"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}
