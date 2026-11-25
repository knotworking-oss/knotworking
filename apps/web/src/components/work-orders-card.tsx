"use client";

import {
  workOrderKindLabels,
  workOrderKinds,
  workOrderPriorities,
  workOrderPriorityLabels,
  workOrderStatusLabels,
  type WorkOrderKind,
  type WorkOrderPriority,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  SelectField,
  SiteDialog,
  TextAreaField,
  TextField,
  maintenanceApi,
  text,
  useDateTime,
} from "@/components/site-forms";
import type { MaintenanceAsset, WorkOrder } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

type Dialog =
  | { kind: "raise" }
  | { kind: "edit"; order: WorkOrder }
  | { kind: "complete"; order: WorkOrder }
  | { kind: "cancel"; order: WorkOrder };

const money = (v: number | null) => (v === null ? "" : v.toFixed(2));
const moneyBody = (v: string) => (v.trim() === "" ? null : Number(v));

/**
 * Breakdowns and work requests on maintained equipment: raised by anyone who can write (an agent
 * may report one), worked, then completed by a person with what was done, the spares used and the
 * costs. Completed and cancelled orders never change.
 */
export function WorkOrdersCard({
  slug,
  orders,
  assets,
}: {
  slug: string;
  orders: WorkOrder[];
  assets: MaintenanceAsset[];
}) {
  const dateTime = useDateTime();
  const { can } = useWorkspace();
  const canWrite = can("maintenance", "write");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  return (
    <Card className="py-0">
      <CardHeader className="pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Breakdowns and work orders</CardTitle>
          </div>
          {canWrite && (
            <Button size="sm" onClick={() => setDialog({ kind: "raise" })} disabled={assets.length === 0}>
              <Plus data-icon="inline-start" /> Raise
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0 pb-2">
        {orders.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">No breakdowns or work orders.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Raised</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <TableRow key={o.id} className="align-top">
                  <TableCell className="pl-4 whitespace-nowrap">
                    {dateTime(o.createdAt)}
                    <div className="text-xs text-muted-foreground">{o.requestedByName}</div>
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal">
                    <div className="font-medium">
                      {o.asset?.name}: {o.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {workOrderKindLabels[o.kind]}
                      {o.stopsProduction ? " · blocks operations" : ""}
                      {o.assignedToName ? ` · ${o.assignedToName}` : ""}
                    </div>
                    {o.description && <div className="text-sm text-muted-foreground">{o.description}</div>}
                    {o.workDone && <div className="text-sm">Done: {o.workDone}</div>}
                    {o.sparesUsed && (
                      <div className="text-xs text-muted-foreground">Spares: {o.sparesUsed}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={o.priority === "urgent" || o.priority === "high" ? "destructive" : "outline"}
                    >
                      {workOrderPriorityLabels[o.priority]}
                    </Badge>
                  </TableCell>
                  <TableCell>{workOrderStatusLabels[o.status]}</TableCell>
                  <TableCell className="tabular-nums">
                    {o.totalCost !== null ? money(o.totalCost) : "—"}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canWrite && o.isOpen && (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: "edit", order: o })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "cancel", order: o })}
                        >
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => setDialog({ kind: "complete", order: o })}>
                          Complete
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
      {dialog?.kind === "raise" && (
        <RaiseDialog slug={slug} assets={assets} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "edit" && (
        <EditDialog slug={slug} order={dialog.order} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "complete" && (
        <CompleteDialog slug={slug} order={dialog.order} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "cancel" && (
        <CancelDialog slug={slug} order={dialog.order} onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}

function RaiseDialog({
  slug,
  assets,
  onClose,
}: {
  slug: string;
  assets: MaintenanceAsset[];
  onClose: () => void;
}) {
  const [asset, setAsset] = useState(assets[0]?.id ?? "");
  const [kind, setKind] = useState<WorkOrderKind>("breakdown");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<WorkOrderPriority>("medium");
  const [stops, setStops] = useState(false);
  return (
    <SiteDialog
      title="Raise a breakdown or work request"
      description="Equipment that has stopped working, or work that is wanted."
      submitLabel="Raise"
      disabled={!asset}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi()["work-orders"].$post({
            param: { slug },
            json: {
              assetId: asset,
              kind,
              title: title.trim(),
              priority,
              stopsProduction: stops,
              ...(text(description) ? { description: text(description)! } : {}),
            },
          }),
        );
        return "Raised";
      }}
    >
      <SelectField
        id="wo-asset"
        label="Equipment"
        value={asset}
        onChange={setAsset}
        options={assets.map((a) => [a.id, a.name] as const)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="wo-kind"
          label="Kind"
          value={kind}
          onChange={(v) => setKind(v as WorkOrderKind)}
          options={workOrderKinds.map((k) => [k, workOrderKindLabels[k]] as const)}
        />
        <SelectField
          id="wo-priority"
          label="Priority"
          value={priority}
          onChange={(v) => setPriority(v as WorkOrderPriority)}
          options={workOrderPriorities.map((p) => [p, workOrderPriorityLabels[p]] as const)}
        />
      </div>
      <TextField id="wo-title" label="What is wrong" required value={title} onChange={setTitle} />
      <TextAreaField id="wo-desc" label="Details" value={description} onChange={setDescription} />
      <Field orientation="horizontal">
        <Checkbox id="wo-stops" checked={stops} onCheckedChange={(v) => setStops(v === true)} />
        <FieldLabel htmlFor="wo-stops">The equipment (and the line) is stopped until this is done</FieldLabel>
      </Field>
    </SiteDialog>
  );
}

function EditDialog({ slug, order, onClose }: { slug: string; order: WorkOrder; onClose: () => void }) {
  const [priority, setPriority] = useState<WorkOrderPriority>(order.priority);
  const [started, setStarted] = useState(order.status === "in_progress");
  const [contractor, setContractor] = useState(order.contractor ?? "");
  const [spares, setSpares] = useState(order.sparesUsed ?? "");
  const [parts, setParts] = useState(money(order.partsCost));
  const [labour, setLabour] = useState(money(order.labourCost));
  const [contractorCost, setContractorCost] = useState(money(order.contractorCost));
  return (
    <SiteDialog
      title={`Edit: ${order.title}`}
      description="Spares and costs can be added as the work goes on and are final once it is completed."
      submitLabel="Save"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi()["work-orders"][":id"].$patch({
            param: { slug, id: order.id },
            json: {
              priority,
              status: started ? "in_progress" : "requested",
              contractor: text(contractor) ?? null,
              sparesUsed: text(spares) ?? null,
              partsCost: moneyBody(parts),
              labourCost: moneyBody(labour),
              contractorCost: moneyBody(contractorCost),
            },
          }),
        );
        return "Saved";
      }}
    >
      <SelectField
        id="we-priority"
        label="Priority"
        value={priority}
        onChange={(v) => setPriority(v as WorkOrderPriority)}
        options={workOrderPriorities.map((p) => [p, workOrderPriorityLabels[p]] as const)}
      />
      <Field orientation="horizontal">
        <Checkbox id="we-started" checked={started} onCheckedChange={(v) => setStarted(v === true)} />
        <FieldLabel htmlFor="we-started">Work has started</FieldLabel>
      </Field>
      <TextField id="we-contractor" label="Contractor" value={contractor} onChange={setContractor} />
      <TextAreaField id="we-spares" label="Spares used" rows={2} value={spares} onChange={setSpares} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          id="we-parts"
          label="Parts cost"
          type="number"
          step="0.01"
          value={parts}
          onChange={setParts}
        />
        <TextField
          id="we-labour"
          label="Labour cost"
          type="number"
          step="0.01"
          value={labour}
          onChange={setLabour}
        />
        <TextField
          id="we-contractor-cost"
          label="Contractor cost"
          type="number"
          step="0.01"
          value={contractorCost}
          onChange={setContractorCost}
        />
      </div>
    </SiteDialog>
  );
}

function CompleteDialog({ slug, order, onClose }: { slug: string; order: WorkOrder; onClose: () => void }) {
  const [workDone, setWorkDone] = useState("");
  const [downtime, setDowntime] = useState("");
  const [spares, setSpares] = useState(order.sparesUsed ?? "");
  const [parts, setParts] = useState(money(order.partsCost));
  const [labour, setLabour] = useState(money(order.labourCost));
  const [contractorCost, setContractorCost] = useState(money(order.contractorCost));
  return (
    <SiteDialog
      title={`Complete: ${order.title}`}
      description="You are recording that the work was done. A completed order can't be changed."
      submitLabel="Complete"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi()["work-orders"][":id"].complete.$post({
            param: { slug, id: order.id },
            json: {
              workDone: workDone.trim(),
              downtimeMinutes: downtime === "" ? null : Number(downtime),
              sparesUsed: text(spares) ?? null,
              partsCost: moneyBody(parts),
              labourCost: moneyBody(labour),
              contractorCost: moneyBody(contractorCost),
            },
          }),
        );
        return "Work order completed";
      }}
    >
      <TextAreaField id="wc-work" label="Work done" required value={workDone} onChange={setWorkDone} />
      <TextField
        id="wc-downtime"
        label="Minutes out of use"
        type="number"
        value={downtime}
        onChange={setDowntime}
      />
      <TextAreaField id="wc-spares" label="Spares used" rows={2} value={spares} onChange={setSpares} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          id="wc-parts"
          label="Parts cost"
          type="number"
          step="0.01"
          value={parts}
          onChange={setParts}
        />
        <TextField
          id="wc-labour"
          label="Labour cost"
          type="number"
          step="0.01"
          value={labour}
          onChange={setLabour}
        />
        <TextField
          id="wc-contractor-cost"
          label="Contractor cost"
          type="number"
          step="0.01"
          value={contractorCost}
          onChange={setContractorCost}
        />
      </div>
    </SiteDialog>
  );
}

function CancelDialog({ slug, order, onClose }: { slug: string; order: WorkOrder; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <SiteDialog
      title={`Cancel: ${order.title}`}
      description="A cancelled order is kept, with the reason."
      submitLabel="Cancel work order"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          maintenanceApi()["work-orders"][":id"].cancel.$post({
            param: { slug, id: order.id },
            json: { reason: reason.trim() },
          }),
        );
        return "Work order cancelled";
      }}
    >
      <TextAreaField id="wx-reason" label="Reason" required rows={2} value={reason} onChange={setReason} />
    </SiteDialog>
  );
}
