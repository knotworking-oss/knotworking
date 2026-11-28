"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  pestActivityLabels,
  pestActivityLevels,
  pestDeviceKindLabels,
  pestDeviceKinds,
  type PestActivity,
  type PestDeviceKind,
  type PestTrendGrouping,
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
import { ClipboardList, Plus } from "lucide-react";
import { useState } from "react";
import { ActivityBadge } from "@/components/site-badges";
import {
  NONE,
  SelectField,
  SiteDialog,
  TextAreaField,
  TextField,
  siteApi,
  text,
} from "@/components/site-forms";
import { PestTrendsCard } from "@/components/pest-trends";
import { CorrectVisitDialog } from "@/components/site-correct-dialogs";
import type { PestDevice, PestTrends, PestVisit, SiteArea } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

type Dialog = { kind: "device" } | { kind: "visit" } | { kind: "correct"; visit: PestVisit };

interface FindingRow {
  key: number;
  device: string;
  location: string;
  activity: PestActivity;
  pest: string;
  count: string;
  action: string;
}

/**
 * Pest control: the contractor's devices (bait points, traps, fly killers) with the activity last
 * found, and the visits: findings, recommendations, actions taken and the date of the next visit,
 * which is what's due. Visits are append-only: a correction replaces a visit and keeps the original.
 */
export function PestBoard({
  slug,
  devices,
  visits,
  areas,
  trends,
}: {
  slug: string;
  devices: PestDevice[];
  visits: PestVisit[];
  areas: SiteArea[];
  trends: Record<PestTrendGrouping, PestTrends>;
}) {
  const { can } = useWorkspace();
  const canWrite = can("site", "write");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const active = devices.filter((d) => d.status === "active");

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Pest control</h2>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDialog({ kind: "device" })}>
              <Plus data-icon="inline-start" /> Add device
            </Button>
            <Button onClick={() => setDialog({ kind: "visit" })}>
              <ClipboardList data-icon="inline-start" /> Record visit
            </Button>
          </div>
        )}
      </div>

      <PestTrendsCard trends={trends} />

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Visits</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {visits.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No visits recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Visit</TableHead>
                  <TableHead>Findings</TableHead>
                  <TableHead>Recommendations and actions</TableHead>
                  <TableHead>Next visit</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visits.map((v) => (
                  <TableRow key={v.id} className="align-top">
                    <TableCell className="pl-4">
                      <div className="font-medium">{formatLongDate(v.visitedOn)}</div>
                      <div className="text-xs text-muted-foreground">
                        {v.contractor}
                        {v.technician ? `, ${v.technician}` : ""}
                      </div>
                      {v.source === "api" && (
                        <div className="text-xs text-muted-foreground">Entered through the API</div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-col gap-1">
                        {v.findings.filter((f) => f.activity !== "none").length === 0 && (
                          <ActivityBadge activity="none" />
                        )}
                        {v.findings
                          .filter((f) => f.activity !== "none")
                          .map((f) => (
                            <div key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                              <ActivityBadge activity={f.activity} />
                              <span>
                                {f.device?.code ?? f.location}
                                {f.pest ? `: ${f.pest}` : ""}
                                {f.count ? ` (${f.count})` : ""}
                              </span>
                            </div>
                          ))}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md text-sm whitespace-normal">
                      {v.recommendations && <p>{v.recommendations}</p>}
                      {v.actionsTaken && <p className="text-muted-foreground">Done: {v.actionsTaken}</p>}
                      {!v.recommendations && !v.actionsTaken && "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {v.nextVisitOn ? formatLongDate(v.nextVisitOn) : "—"}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "correct", visit: v })}
                        >
                          Correct
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
          <CardTitle>Devices</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto px-0 pb-2">
          {devices.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No devices yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Code</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead className="pr-4">Last finding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow
                    key={d.id}
                    className={d.status === "active" ? undefined : "text-muted-foreground"}
                  >
                    <TableCell className="pl-4 font-mono text-xs">{d.code}</TableCell>
                    <TableCell>{pestDeviceKindLabels[d.kind]}</TableCell>
                    <TableCell>
                      {d.location}
                      {d.area && <span className="text-muted-foreground"> · {d.area.name}</span>}
                    </TableCell>
                    <TableCell className="pr-4">
                      {d.lastFinding ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <ActivityBadge activity={d.lastFinding.activity as PestActivity} />
                          <span className="text-xs text-muted-foreground">
                            {formatLongDate(d.lastFinding.visitedOn)}
                          </span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === "device" && (
        <DeviceDialog slug={slug} areas={areas} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "correct" && (
        <CorrectVisitDialog
          slug={slug}
          visit={dialog.visit}
          devices={devices}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "visit" && (
        <VisitDialog slug={slug} devices={active} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function DeviceDialog({ slug, areas, onClose }: { slug: string; areas: SiteArea[]; onClose: () => void }) {
  const [kind, setKind] = useState<PestDeviceKind>("rodent_bait_station");
  const [code, setCode] = useState("");
  const [location, setLocation] = useState("");
  const [area, setArea] = useState(NONE);
  return (
    <SiteDialog
      title="Add device"
      description="A bait station, trap or fly killer on the contractor's map."
      submitLabel="Add device"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().pest.devices.$post({
            param: { slug },
            json: {
              kind,
              code: code.trim(),
              location: location.trim(),
              ...(area !== NONE ? { areaId: area } : {}),
            },
          }),
        );
        return `${code.trim()} added`;
      }}
    >
      <SelectField
        id="device-kind"
        label="Kind"
        value={kind}
        onChange={(v) => setKind(v as PestDeviceKind)}
        options={pestDeviceKinds.map((k) => [k, pestDeviceKindLabels[k]] as const)}
      />
      <TextField
        id="device-code"
        label="Code"
        required
        value={code}
        onChange={setCode}
        description="The contractor's reference, e.g. RB-07."
      />
      <TextField id="device-location" label="Location" required value={location} onChange={setLocation} />
      <SelectField
        id="device-area"
        label="Area"
        value={area}
        onChange={setArea}
        options={[[NONE, "No area"], ...areas.map((a) => [a.id, a.name] as const)]}
      />
    </SiteDialog>
  );
}

function VisitDialog({
  slug,
  devices,
  onClose,
}: {
  slug: string;
  devices: PestDevice[];
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [contractor, setContractor] = useState("");
  const [technician, setTechnician] = useState("");
  const [visitedOn, setVisitedOn] = useState(today);
  const [nextVisitOn, setNextVisitOn] = useState("");
  const [summary, setSummary] = useState("");
  const [recommendations, setRecommendations] = useState("");
  const [actionsTaken, setActionsTaken] = useState("");
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [seq, setSeq] = useState(0);

  const add = (row: Partial<FindingRow>) => {
    setRows((prev) => [
      ...prev,
      {
        key: seq + prev.length,
        device: NONE,
        location: "",
        activity: "none",
        pest: "",
        count: "",
        action: "",
        ...row,
      },
    ]);
    setSeq((s) => s + 1);
  };
  const patch = (key: number, changes: Partial<FindingRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...changes } : r)));

  return (
    <SiteDialog
      wide
      title="Record a pest control visit"
      description="Enter the contractor's service report: what was found at each device, what they recommend and when they are back."
      submitLabel="Record visit"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          siteApi().pest.visits.$post({
            param: { slug },
            json: {
              contractor: contractor.trim(),
              visitedOn,
              ...(text(technician) ? { technician: text(technician)! } : {}),
              ...(text(summary) ? { summary: text(summary)! } : {}),
              ...(text(recommendations) ? { recommendations: text(recommendations)! } : {}),
              ...(text(actionsTaken) ? { actionsTaken: text(actionsTaken)! } : {}),
              ...(nextVisitOn ? { nextVisitOn } : {}),
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
        return "Visit recorded";
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="visit-contractor"
          label="Contractor"
          required
          value={contractor}
          onChange={setContractor}
        />
        <TextField id="visit-technician" label="Technician" value={technician} onChange={setTechnician} />
        <TextField
          id="visit-date"
          label="Visit date"
          type="date"
          required
          value={visitedOn}
          onChange={setVisitedOn}
        />
        <TextField
          id="visit-next"
          label="Next visit"
          type="date"
          value={nextVisitOn}
          onChange={setNextVisitOn}
          description="What's due follows this date."
        />
      </div>
      <TextAreaField id="visit-summary" label="Summary" value={summary} onChange={setSummary} />
      <TextAreaField
        id="visit-recs"
        label="Recommendations"
        value={recommendations}
        onChange={setRecommendations}
      />
      <TextAreaField
        id="visit-actions"
        label="Actions taken"
        value={actionsTaken}
        onChange={setActionsTaken}
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">Findings</span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={devices.length === 0}
              onClick={() => devices.forEach((d) => add({ device: d.id }))}
            >
              List every device
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => add({})}>
              <Plus data-icon="inline-start" /> Add finding
            </Button>
          </div>
        </div>
        {rows.map((r) => (
          <div key={r.key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <SelectField
                id={`f-${r.key}-device`}
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
                id={`f-${r.key}-activity`}
                label="Activity"
                value={r.activity}
                onChange={(v) => patch(r.key, { activity: v as PestActivity })}
                options={pestActivityLevels.map((a) => [a, pestActivityLabels[a]] as const)}
              />
            </div>
            {r.device === NONE && (
              <TextField
                id={`f-${r.key}-loc`}
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
                  id={`f-${r.key}-pest`}
                  label="Pest"
                  required
                  value={r.pest}
                  onChange={(v) => patch(r.key, { pest: v })}
                  className="sm:col-span-2"
                />
                <TextField
                  id={`f-${r.key}-count`}
                  label="Count"
                  type="number"
                  value={r.count}
                  onChange={(v) => patch(r.key, { count: v })}
                />
                <TextField
                  id={`f-${r.key}-action`}
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
                onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No findings added: the visit is recorded without any.
          </p>
        )}
      </div>
    </SiteDialog>
  );
}
