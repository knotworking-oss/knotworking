"use client";

import {
  calibrationPasses,
  haccpAssetKindLabels,
  scheduleFrequencyUnits,
  type HaccpAssetKind,
  type ScheduleFrequencyUnit,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
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
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { Archive, ArchiveRestore, BadgeCheck, Gauge, PencilLine, Plus, SprayCan } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DueStateBadge } from "@/components/haccp-badges";
import { RecordFilesButton } from "@/components/record-attachments";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import type { CalibrationRecord, CleaningRecord, HaccpAsset, HaccpDueCheck } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

type Member = { id: string; name: string };
type Dialog =
  | { kind: "asset" }
  | { kind: "clean"; asset: HaccpAsset }
  | { kind: "calibrate"; asset: HaccpAsset }
  | { kind: "verify"; record: CleaningRecord }
  | { kind: "correct-cleaning"; record: CleaningRecord }
  | { kind: "correct-calibration"; record: CalibrationRecord };
const haccpApi = () => browserApi().v1.workspaces[":slug"].haccp;
const NONE = "none";
const unitLabels: Record<ScheduleFrequencyUnit, string> = {
  hour: "hours",
  day: "days",
  week: "weeks",
  month: "months",
};

/**
 * Cleaning and calibration: a minimal register of areas and equipment with their schedules, what
 * is due, and the append-only records. Cleaning is verified by a second person; a failed
 * calibration opens a corrective action.
 */
export function RecordsBoard({
  slug,
  assets,
  cleaning,
  calibration,
  checks,
  members,
}: {
  slug: string;
  assets: HaccpAsset[];
  cleaning: CleaningRecord[];
  calibration: CalibrationRecord[];
  checks: HaccpDueCheck[];
  members: Member[];
}) {
  const time = useFormatDateTime();
  const router = useRouter();
  const { can, viewer } = useWorkspace();
  const canWrite = can("haccp", "write");
  const canManage = can("haccp", "manage");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const stateOf = (kind: "cleaning" | "calibration", assetId: string) =>
    checks.find((c) => c.key === `${kind}:${assetId}`);

  // The areas and equipment are assets of the register: adding and archiving them is the Assets
  // module's (archiving needs its manage level); HACCP keeps their schedules.
  const canAddAsset = canWrite && can("assets", "write");
  const canArchive = can("assets", "manage");
  async function setStatus(asset: HaccpAsset, status: "active" | "archived") {
    try {
      const api = browserApi().v1.workspaces[":slug"].assets[":id"];
      await unwrap(
        (status === "archived" ? api.archive : api.restore).$post({ param: { slug, id: asset.id } }),
      );
      toast.success(status === "archived" ? `${asset.name} archived` : `${asset.name} restored`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const schedule = (check: HaccpDueCheck | undefined, text: string | null) =>
    text ? (
      <span className="flex flex-wrap items-center gap-2">
        {text}
        {check && <DueStateBadge state={check.state} />}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Cleaning and calibration</h2>
        <span className="flex flex-wrap gap-2">
          {can("assets") && (
            <Button variant="outline" asChild>
              <Link href={`/${slug}/assets`}>Asset register</Link>
            </Button>
          )}
          {canAddAsset && (
            <Button onClick={() => setDialog({ kind: "asset" })}>
              <Plus data-icon="inline-start" /> Add area or equipment
            </Button>
          )}
        </span>
      </div>

      <Card className="py-0">
        <CardContent className="overflow-x-auto px-0 py-2">
          {assets.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No areas or equipment yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Cleaning</TableHead>
                  <TableHead>Calibration</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((asset) => {
                  const active = asset.status === "active";
                  return (
                    <TableRow key={asset.id} className={active ? undefined : "text-muted-foreground"}>
                      <TableCell className="pl-4">
                        <div className="font-medium">
                          {asset.name} {asset.code && <span className="font-mono text-xs">{asset.code}</span>}
                        </div>
                        {asset.location && (
                          <div className="text-xs text-muted-foreground">{asset.location}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        {haccpAssetKindLabels[asset.kind]}
                        {!active && (
                          <Badge variant="secondary" className="ml-2">
                            Archived
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {schedule(stateOf("cleaning", asset.id), asset.cleaningFrequencyText)}
                      </TableCell>
                      <TableCell>
                        {schedule(
                          stateOf("calibration", asset.id),
                          asset.calibrationFrequencyText
                            ? `${asset.calibrationFrequencyText}${asset.calibrationTolerance !== null ? ` · ±${asset.calibrationTolerance}${asset.measurementUnit ? ` ${asset.measurementUnit}` : ""}` : ""}`
                            : null,
                        )}
                      </TableCell>
                      <TableCell className="pr-4">
                        {canWrite && (
                          <span className="flex justify-end gap-1">
                            {active && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setDialog({ kind: "clean", asset })}
                              >
                                <SprayCan data-icon="inline-start" /> Cleaned
                              </Button>
                            )}
                            {active && asset.kind === "equipment" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setDialog({ kind: "calibrate", asset })}
                              >
                                <Gauge data-icon="inline-start" /> Calibrate
                              </Button>
                            )}
                            {canArchive && (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={active ? `Archive ${asset.name}` : `Restore ${asset.name}`}
                                onClick={() => void setStatus(asset, active ? "archived" : "active")}
                              >
                                {active ? <Archive /> : <ArchiveRestore />}
                              </Button>
                            )}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Cleaning records</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {cleaning.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No cleaning recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Cleaned</TableHead>
                  <TableHead>Area or equipment</TableHead>
                  <TableHead>Done by</TableHead>
                  <TableHead>Verified</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cleaning.map((r) => (
                  <TableRow
                    key={r.id}
                    className={r.correctedByRecordId ? "text-muted-foreground" : undefined}
                  >
                    <TableCell className={`pl-4 tabular-nums ${r.correctedByRecordId ? "line-through" : ""}`}>
                      {time(r.cleanedAt)}
                    </TableCell>
                    <TableCell className={r.correctedByRecordId ? "line-through" : undefined}>
                      {r.asset.name}
                    </TableCell>
                    <TableCell className={r.correctedByRecordId ? "line-through" : undefined}>
                      {r.doneByName ?? "—"}
                      {r.recordedBy !== r.doneBy && (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          (recorded by {r.recordedByName})
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.verifiedAt ? (
                        <span>
                          {r.verifiedByName} · {time(r.verifiedAt)}
                        </span>
                      ) : canWrite && r.doneBy !== viewer.id && !r.correctedByRecordId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "verify", record: r })}
                        >
                          <BadgeCheck data-icon="inline-start" /> Verify
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">Not yet</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.note ?? "—"}
                      {r.correctsRecordId && <div className="text-xs">Correction: {r.correctionReason}</div>}
                      {r.correctedByRecordId && <div className="text-xs">Replaced by a correction</div>}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && !r.correctedByRecordId && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Correct cleaning of ${r.asset.name}`}
                          onClick={() => setDialog({ kind: "correct-cleaning", record: r })}
                        >
                          <PencilLine />
                        </Button>
                      )}
                      <RecordFilesButton
                        entityType="haccp_cleaning_record"
                        entityId={r.id}
                        title="Cleaning record files"
                        description={`${r.asset.name}, cleaned ${time(r.cleanedAt)}. Files can't be removed once the cleaning is verified.`}
                      />
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
          <CardTitle>Calibration records</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {calibration.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No calibrations recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Calibrated</TableHead>
                  <TableHead>Equipment</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Reading</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {calibration.map((r) => (
                  <TableRow
                    key={r.id}
                    className={r.correctedByRecordId ? "text-muted-foreground" : undefined}
                  >
                    <TableCell className={`pl-4 tabular-nums ${r.correctedByRecordId ? "line-through" : ""}`}>
                      {time(r.calibratedAt)}
                    </TableCell>
                    <TableCell className={r.correctedByRecordId ? "line-through" : undefined}>
                      {r.asset.name}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {r.referenceReading}
                      {r.unit ? ` ${r.unit}` : ""}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {r.actualReading}
                      {r.unit ? ` ${r.unit}` : ""}
                      {r.tolerance !== null && (
                        <span className="text-xs text-muted-foreground"> (±{r.tolerance})</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`border-transparent ${r.passed ? "bg-label-green-bg text-label-green" : "bg-label-red-bg text-label-red"}`}
                      >
                        {r.passed ? "Pass" : "Fail"}
                      </Badge>
                    </TableCell>
                    <TableCell>{r.nextDueOn ? formatLongDate(r.nextDueOn) : "—"}</TableCell>
                    <TableCell>
                      {r.recordedByName ?? "—"}
                      {r.correctsRecordId && (
                        <div className="text-xs text-muted-foreground">Correction: {r.correctionReason}</div>
                      )}
                      {r.correctedByRecordId && (
                        <div className="text-xs text-muted-foreground">Replaced by a correction</div>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && !r.correctedByRecordId && (r.passed || canManage) && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Correct calibration of ${r.asset.name}`}
                          onClick={() => setDialog({ kind: "correct-calibration", record: r })}
                        >
                          <PencilLine />
                        </Button>
                      )}
                      <RecordFilesButton
                        entityType="haccp_calibration_record"
                        entityId={r.id}
                        title="Calibration files"
                        description={`${r.asset.name}, calibrated ${time(r.calibratedAt)}: certificate, photos. Files can be added but not removed, as calibration records are never edited.`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === "asset" && <AssetDialog slug={slug} onClose={() => setDialog(null)} />}
      {dialog?.kind === "clean" && (
        <CleaningDialog
          slug={slug}
          asset={dialog.asset}
          members={members}
          viewerId={viewer.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "calibrate" && (
        <CalibrationDialog slug={slug} asset={dialog.asset} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "correct-cleaning" && (
        <CorrectCleaningDialog
          slug={slug}
          record={dialog.record}
          members={members}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "correct-calibration" && (
        <CorrectCalibrationDialog slug={slug} record={dialog.record} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "verify" && (
        <VerifyDialog slug={slug} record={dialog.record} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function FrequencyFields({
  id,
  label,
  every,
  unit,
  onEvery,
  onUnit,
}: {
  id: string;
  label: string;
  every: string;
  unit: string;
  onEvery: (v: string) => void;
  onUnit: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2">
      <Field>
        <FieldLabel htmlFor={`${id}-every`}>{label} every</FieldLabel>
        <Input
          id={`${id}-every`}
          type="number"
          min={1}
          max={1000}
          disabled={unit === NONE}
          value={every}
          onChange={(e) => onEvery(e.target.value)}
        />
      </Field>
      <SelectField
        id={`${id}-unit`}
        label="Unit"
        value={unit}
        onChange={onUnit}
        options={[[NONE, "Not scheduled"], ...scheduleFrequencyUnits.map((u) => [u, unitLabels[u]] as const)]}
      />
    </div>
  );
}

function AssetDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [kind, setKind] = useState<HaccpAssetKind>("area");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [location, setLocation] = useState("");
  const [cleanEvery, setCleanEvery] = useState("1");
  const [cleanUnit, setCleanUnit] = useState<string>("day");
  const [calEvery, setCalEvery] = useState("1");
  const [calUnit, setCalUnit] = useState<string>(NONE);
  const [tolerance, setTolerance] = useState("");
  const [measurementUnit, setMeasurementUnit] = useState("°C");
  const frequency = (every: string, unit: string) =>
    unit === NONE ? null : { every: Number(every), unit: unit as ScheduleFrequencyUnit };
  return (
    <HaccpDialog
      title="Add area or equipment"
      description="It goes into the asset register. Give it a cleaning schedule, and for equipment such as probe thermometers a calibration schedule."
      submitLabel="Add"
      onClose={onClose}
      onSubmit={async () => {
        const equipment = kind === "equipment";
        // The asset goes into the register; its schedule is HACCP's part of it.
        const asset = await unwrap(
          browserApi().v1.workspaces[":slug"].assets.$post({
            param: { slug },
            json: {
              kind,
              name: name.trim(),
              code: code.trim() || null,
              location: location.trim() || null,
            },
          }),
        );
        await unwrap(
          haccpApi().assets[":id"].$patch({
            param: { slug, id: asset.id },
            json: {
              cleaningFrequency: frequency(cleanEvery, cleanUnit),
              calibrationFrequency: equipment ? frequency(calEvery, calUnit) : null,
              calibrationTolerance: equipment && tolerance.trim() ? Number(tolerance) : null,
              measurementUnit: equipment ? measurementUnit.trim() || null : null,
            },
          }),
        );
        return `${name.trim()} added`;
      }}
    >
      <Field>
        <FieldLabel>Kind</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          value={kind}
          onValueChange={(v) => v && setKind(v as HaccpAssetKind)}
        >
          <ToggleGroupItem value="area">Area</ToggleGroupItem>
          <ToggleGroupItem value="equipment">Equipment</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field>
          <FieldLabel htmlFor="asset-name">Name</FieldLabel>
          <Input
            id="asset-name"
            required
            maxLength={200}
            placeholder={kind === "area" ? "Line 1" : "Probe thermometer 1"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="asset-code">Code</FieldLabel>
          <Input id="asset-code" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="asset-location">Location (optional)</FieldLabel>
        <Input
          id="asset-location"
          maxLength={200}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </Field>
      <FrequencyFields
        id="asset-clean"
        label="Clean"
        every={cleanEvery}
        unit={cleanUnit}
        onEvery={setCleanEvery}
        onUnit={setCleanUnit}
      />
      {kind === "equipment" && (
        <>
          <FrequencyFields
            id="asset-cal"
            label="Calibrate"
            every={calEvery}
            unit={calUnit}
            onEvery={setCalEvery}
            onUnit={setCalUnit}
          />
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="asset-tolerance">Tolerance (±)</FieldLabel>
              <Input
                id="asset-tolerance"
                type="number"
                step="any"
                min={0}
                value={tolerance}
                onChange={(e) => setTolerance(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="asset-unit">Unit</FieldLabel>
              <Input
                id="asset-unit"
                maxLength={20}
                value={measurementUnit}
                onChange={(e) => setMeasurementUnit(e.target.value)}
              />
            </Field>
          </div>
        </>
      )}
    </HaccpDialog>
  );
}

function CleaningDialog({
  slug,
  asset,
  members,
  viewerId,
  onClose,
}: {
  slug: string;
  asset: HaccpAsset;
  members: Member[];
  viewerId: string;
  onClose: () => void;
}) {
  const [doneBy, setDoneBy] = useState(viewerId);
  const [note, setNote] = useState("");
  return (
    <HaccpDialog
      title={`Cleaned: ${asset.name}`}
      description="Recorded now, with your name. Someone else verifies it afterwards."
      submitLabel="Record cleaning"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          haccpApi().cleaning.$post({
            param: { slug },
            json: { assetId: asset.id, doneBy, ...(note.trim() ? { note: note.trim() } : {}) },
          }),
        );
        return `Cleaning of ${asset.name} recorded`;
      }}
    >
      <SelectField
        id="clean-done-by"
        label="Done by"
        value={doneBy}
        onChange={setDoneBy}
        options={members.map((m) => [m.id, m.id === viewerId ? `${m.name} (you)` : m.name] as const)}
      />
      <Field>
        <FieldLabel htmlFor="clean-note">Note (optional)</FieldLabel>
        <Input
          id="clean-note"
          maxLength={1000}
          placeholder="e.g. Deep clean after allergen run"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function CalibrationDialog({
  slug,
  asset,
  onClose,
}: {
  slug: string;
  asset: HaccpAsset;
  onClose: () => void;
}) {
  const [reference, setReference] = useState("");
  const [actual, setActual] = useState("");
  const [passed, setPassed] = useState<"" | "pass" | "fail">("");
  const [method, setMethod] = useState("");
  const unit = asset.measurementUnit ? ` ${asset.measurementUnit}` : "";
  const numbers = reference.trim() !== "" && actual.trim() !== "";
  const computed = numbers
    ? calibrationPasses({
        referenceReading: Number(reference),
        actualReading: Number(actual),
        tolerance: asset.calibrationTolerance,
      })
    : null;
  const needsVerdict = asset.calibrationTolerance === null;
  return (
    <HaccpDialog
      title={`Calibrate ${asset.name}`}
      description={
        needsVerdict
          ? "No tolerance is set for this equipment: say whether it passed."
          : `Passes within ±${asset.calibrationTolerance}${unit} of the reference.`
      }
      submitLabel="Record calibration"
      disabled={!numbers || (needsVerdict && !passed)}
      onClose={onClose}
      onSubmit={async () => {
        const record = await unwrap(
          haccpApi().calibration.$post({
            param: { slug },
            json: {
              assetId: asset.id,
              referenceReading: Number(reference),
              actualReading: Number(actual),
              ...(needsVerdict ? { passed: passed === "pass" } : {}),
              ...(method.trim() ? { method: method.trim() } : {}),
            },
          }),
        );
        return record.passed
          ? `${asset.name} passed calibration`
          : `${asset.name} failed calibration: a corrective action is open`;
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="cal-reference">Reference{unit}</FieldLabel>
          <Input
            id="cal-reference"
            type="number"
            step="any"
            required
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <FieldDescription>e.g. 0 in iced water, 100 in boiling water</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="cal-actual">Reading{unit}</FieldLabel>
          <Input
            id="cal-actual"
            type="number"
            step="any"
            required
            value={actual}
            onChange={(e) => setActual(e.target.value)}
          />
        </Field>
      </div>
      {needsVerdict ? (
        <Field>
          <FieldLabel>Result</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={passed}
            onValueChange={(v) => setPassed(v as "" | "pass" | "fail")}
          >
            <ToggleGroupItem value="pass">Pass</ToggleGroupItem>
            <ToggleGroupItem value="fail">Fail</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      ) : (
        computed !== null && (
          <p className={`text-sm font-medium ${computed ? "text-label-green" : "text-destructive"}`}>
            {computed ? "Within tolerance: pass" : "Outside tolerance: fail (a corrective action will open)"}
          </p>
        )
      )}
      <Field>
        <FieldLabel htmlFor="cal-method">Method (optional)</FieldLabel>
        <Input
          id="cal-method"
          maxLength={500}
          placeholder="Iced water; boiling water"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function VerifyDialog({
  slug,
  record,
  onClose,
}: {
  slug: string;
  record: CleaningRecord;
  onClose: () => void;
}) {
  const time = useFormatDateTime();
  const [note, setNote] = useState("");
  return (
    <HaccpDialog
      title={`Verify cleaning of ${record.asset.name}`}
      description={`Cleaned ${time(record.cleanedAt)} by ${record.doneByName ?? "—"}. Your name and the time are recorded.`}
      submitLabel="Verify"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          haccpApi().cleaning[":id"].verify.$post({
            param: { slug, id: record.id },
            json: note.trim() ? { note: note.trim() } : {},
          }),
        );
        return "Cleaning verified";
      }}
    >
      <Field>
        <FieldLabel htmlFor="verify-note">Note (optional)</FieldLabel>
        <Input
          id="verify-note"
          maxLength={1000}
          placeholder="e.g. Visual check and ATP swab passed"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

const REASON_HINT = "The original stays on the record, struck through, and this correction says why.";

function CorrectCleaningDialog({
  slug,
  record,
  members,
  onClose,
}: {
  slug: string;
  record: CleaningRecord;
  members: Member[];
  onClose: () => void;
}) {
  const time = useFormatDateTime();
  const [reason, setReason] = useState("");
  const [doneBy, setDoneBy] = useState(record.doneBy ?? "");
  const [note, setNote] = useState(record.note ?? "");
  return (
    <HaccpDialog
      title={`Correct cleaning of ${record.asset.name}`}
      description={`Cleaned ${time(record.cleanedAt)}. ${REASON_HINT} The correction needs verifying again.`}
      submitLabel="Record correction"
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          haccpApi().cleaning[":id"].correct.$post({
            param: { slug, id: record.id },
            json: {
              reason: reason.trim(),
              ...(doneBy && doneBy !== record.doneBy ? { doneBy } : {}),
              ...(note.trim() !== (record.note ?? "") ? { note: note.trim() || null } : {}),
            },
          }),
        );
        return "Correction recorded";
      }}
    >
      <Field>
        <FieldLabel htmlFor="cc-reason">Why is it being corrected?</FieldLabel>
        <Input
          id="cc-reason"
          required
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <SelectField
        id="cc-done-by"
        label="Done by"
        value={doneBy}
        onChange={setDoneBy}
        options={members.map((m) => [m.id, m.name] as const)}
      />
      <Field>
        <FieldLabel htmlFor="cc-note">Note</FieldLabel>
        <Input id="cc-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </HaccpDialog>
  );
}

function CorrectCalibrationDialog({
  slug,
  record,
  onClose,
}: {
  slug: string;
  record: CalibrationRecord;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState(String(record.referenceReading));
  const [actual, setActual] = useState(String(record.actualReading));
  const [passed, setPassed] = useState<"" | "pass" | "fail">(record.passed ? "pass" : "fail");
  const unit = record.unit ? ` ${record.unit}` : "";
  const needsVerdict = record.tolerance === null;
  const computed =
    reference.trim() !== "" && actual.trim() !== ""
      ? calibrationPasses({
          referenceReading: Number(reference),
          actualReading: Number(actual),
          tolerance: record.tolerance,
        })
      : null;
  return (
    <HaccpDialog
      title={`Correct calibration of ${record.asset.name}`}
      description={`${REASON_HINT} It is judged against the tolerance of the original${record.tolerance !== null ? ` (±${record.tolerance}${unit})` : ""}.`}
      submitLabel="Record correction"
      disabled={!reason.trim() || reference.trim() === "" || actual.trim() === ""}
      onClose={onClose}
      onSubmit={async () => {
        const fixed = await unwrap(
          haccpApi().calibration[":id"].correct.$post({
            param: { slug, id: record.id },
            json: {
              reason: reason.trim(),
              referenceReading: Number(reference),
              actualReading: Number(actual),
              ...(needsVerdict ? { passed: passed === "pass" } : {}),
            },
          }),
        );
        return fixed.passed ? "Correction recorded: pass" : "Correction recorded: still a fail";
      }}
    >
      <Field>
        <FieldLabel htmlFor="ccal-reason">Why is it being corrected?</FieldLabel>
        <Input
          id="ccal-reason"
          required
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="ccal-reference">Reference{unit}</FieldLabel>
          <Input
            id="ccal-reference"
            type="number"
            step="any"
            required
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="ccal-actual">Reading{unit}</FieldLabel>
          <Input
            id="ccal-actual"
            type="number"
            step="any"
            required
            value={actual}
            onChange={(e) => setActual(e.target.value)}
          />
        </Field>
      </div>
      {needsVerdict ? (
        <Field>
          <FieldLabel>Result</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={passed}
            onValueChange={(v) => setPassed(v as "" | "pass" | "fail")}
          >
            <ToggleGroupItem value="pass">Pass</ToggleGroupItem>
            <ToggleGroupItem value="fail">Fail</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      ) : (
        computed !== null && (
          <p className={`text-sm font-medium ${computed ? "text-label-green" : "text-destructive"}`}>
            {computed ? "Within tolerance: pass" : "Outside tolerance: fail"}
          </p>
        )
      )}
      {!record.passed && (
        <p className="text-sm text-muted-foreground">
          The corrective action opened by the failure stays open until a manager closes it.
        </p>
      )}
    </HaccpDialog>
  );
}
