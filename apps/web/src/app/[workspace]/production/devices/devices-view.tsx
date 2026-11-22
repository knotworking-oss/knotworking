"use client";

import {
  calibrationStateLabels,
  deviceKindLabels,
  deviceKinds,
  deviceUnits,
  measuringDeviceKinds,
  type CalibrationState,
  type DeviceKind,
  type DeviceUnit,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { ProductionDevice } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

const NONE = "none";
const stateTone: Record<CalibrationState, string> = {
  in_date: "bg-label-green-bg text-label-green",
  overdue: "bg-label-orange-bg text-label-orange",
  failed: "bg-label-red-bg text-label-red",
  unknown: "bg-label-yellow-bg text-label-yellow",
  not_required: "",
};

/**
 * Production → Devices (3.5.4): registered line devices, the unit each reads in, when it last sent
 * a reading, and its calibration state from the linked HACCP equipment. Readings arrive from a site
 * gateway through the API; they become records (a weight sample) only while calibration is in date.
 */
export function DevicesView({
  slug,
  devices,
  lines,
  equipment,
}: {
  slug: string;
  devices: ProductionDevice[];
  lines: { id: string; name: string }[];
  equipment: { id: string; name: string }[];
}) {
  const router = useRouter();
  const canManage = useWorkspace().can("production", "manage");
  const dateTime = useFormatDateTime();
  const [adding, setAdding] = useState(false);
  const lineName = (id: string | null) => lines.find((l) => l.id === id)?.name ?? null;

  async function setStatus(device: ProductionDevice, status: "active" | "retired") {
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].production.devices[":id"].$patch({
          param: { slug, id: device.id },
          json: { status },
        }),
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-end gap-3">
        {canManage && (
          <Button onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" /> Register device
          </Button>
        )}
      </div>
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No devices registered.</p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Device</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Line</th>
                <th className="px-3 py-2 font-medium">Calibration</th>
                <th className="px-3 py-2 font-medium">Last reading</th>
                {canManage && <th className="sr-only px-3 py-2 font-medium">Status</th>}
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr
                  key={d.id}
                  className={`border-b last:border-b-0 ${d.status === "retired" ? "opacity-60" : ""}`}
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{d.code}</span> {d.name}
                    {d.status === "retired" && (
                      <Badge variant="outline" className="ml-2">
                        Retired
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {d.kindLabel}
                    {d.unit && <span className="text-muted-foreground"> · {d.unit}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {lineName(d.lineId) ?? <span className="text-muted-foreground">–</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      className={`border-transparent ${stateTone[d.calibration.state]}`}
                      variant={d.calibration.state === "not_required" ? "outline" : "default"}
                    >
                      {calibrationStateLabels[d.calibration.state]}
                    </Badge>
                    {d.calibration.nextDueOn && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        due {d.calibration.nextDueOn}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {d.lastReceivedAt ? dateTime(d.lastReceivedAt) : "Never"}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void setStatus(d, d.status === "active" ? "retired" : "active")}
                      >
                        {d.status === "active" ? "Retire" : "Reinstate"}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {adding && (
        <AddDialog slug={slug} lines={lines} equipment={equipment} onClose={() => setAdding(false)} />
      )}
    </div>
  );
}

function AddDialog({
  slug,
  lines,
  equipment,
  onClose,
}: {
  slug: string;
  lines: { id: string; name: string }[];
  equipment: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<DeviceKind>("scale");
  const [unit, setUnit] = useState<DeviceUnit>("g");
  const [lineId, setLineId] = useState(NONE);
  const [assetId, setAssetId] = useState(NONE);
  const [pending, setPending] = useState(false);
  const measuring = measuringDeviceKinds.includes(kind);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].production.devices.$post({
          param: { slug },
          json: {
            code: String(form.get("code") ?? "").trim(),
            name: String(form.get("name") ?? "").trim(),
            kind,
            unit: measuring ? unit : null,
            lineId: lineId === NONE ? null : lineId,
            haccpAssetId: assetId === NONE ? null : assetId,
          },
        }),
      );
      toast.success("Device registered");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  const select = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    options: { id: string; name: string }[],
    none: string,
  ) => (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={set}>
        <SelectTrigger aria-labelledby={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={NONE}>{none}</SelectItem>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Register a device</DialogTitle>
            <DialogDescription>
              The code is how the site gateway names the device when it sends readings. Link calibrated
              equipment so its readings carry a calibration state.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid grid-cols-[8rem_1fr] gap-3">
              <Field>
                <FieldLabel htmlFor="dev-code">Code</FieldLabel>
                <Input id="dev-code" name="code" required maxLength={40} />
              </Field>
              <Field>
                <FieldLabel htmlFor="dev-name">Name</FieldLabel>
                <Input id="dev-name" name="name" required maxLength={120} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel id="dev-kind">Kind</FieldLabel>
                <Select value={kind} onValueChange={(v) => setKind(v as DeviceKind)}>
                  <SelectTrigger aria-labelledby="dev-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {deviceKinds.map((k) => (
                        <SelectItem key={k} value={k}>
                          {deviceKindLabels[k]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {measuring && (
                <Field>
                  <FieldLabel id="dev-unit">Reads in</FieldLabel>
                  <Select value={unit} onValueChange={(v) => setUnit(v as DeviceUnit)}>
                    <SelectTrigger aria-labelledby="dev-unit" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {deviceUnits.map((u) => (
                          <SelectItem key={u} value={u}>
                            {u}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            {select("dev-line", "Line", lineId, setLineId, lines, "No line")}
            {equipment.length > 0 &&
              select(
                "dev-asset",
                "Calibrated equipment (HACCP)",
                assetId,
                setAssetId,
                equipment,
                "Not linked",
              )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
