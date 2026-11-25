"use client";

import { newId } from "@knotworking/core";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  expiryTypeLabels,
  expiryTypes,
  type ExpiryType,
  isOverDeliveryTolerance,
  type PurchaseReceiptLineInput,
} from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import { Textarea } from "@knotworking/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { formatLineAmount, lineTitle, lineUnitLabel } from "@/components/purchasing-badges";
import type { PurchaseOrderDetail, PurchaseOrderLine } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { NONE, parseNumber, purchasingApi, type LocationOption } from "../../purchasing-forms";

type Outcome = "accepted" | "rejected" | "skip";

interface LineEntry {
  outcome: Outcome;
  quantity: string;
  locationId: string;
  supplierLotCode: string;
  expiresOn: string;
  expiryType: ExpiryType;
  quarantine: boolean;
  reason: string;
  /** Why more than the tolerance was accepted. */
  overDeliveryReason: string;
}

/**
 * Whether accepting `entry` goes past the workspace's over-delivery tolerance for the line (in the
 * line's unit; when the line can't be converted the server decides).
 */
function pastTolerance(line: PurchaseOrderLine, entry: LineEntry, tolerance: number | null) {
  const quantity = parseNumber(entry.quantity);
  const ordered = line.ordered.inLineUnit;
  const received = line.received.inLineUnit;
  if (entry.outcome !== "accepted" || quantity === null || ordered === null || received === null)
    return false;
  return isOverDeliveryTolerance({ ordered, received, receiving: quantity, tolerancePercent: tolerance });
}

const formatQty = (n: number) => String(Math.round(n * 10_000) / 10_000);

/**
 * Goods-in against a sent order: one delivery, each line accepted (a stock line into stock as a new
 * lot; a non-stock line just counted as received), refused at the door with a reason, or not in
 * this delivery. Prefilled with what is outstanding; over-delivery is allowed. A supplier pending
 * approval delivers stock into quarantine only. Stock lines are left out when the viewer can't
 * use stock (`stock` false); non-stock lines never ask for a location, lot or expiry.
 */
export function ReceiveDialog({
  slug,
  order: givenOrder,
  locations: given,
  stock,
  onClose,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  locations: LocationOption[];
  stock: boolean;
  onClose: () => void;
}) {
  // Keep the editable delivery's source lines stable while live updates refresh its parent.
  // The API revalidates each line and supplier status when this delivery is submitted.
  const [o] = useState(givenOrder);
  const today = useWorkspaceToday();
  const receivable = o.lines.filter((l) => l.kind === "non_stock" || stock);
  const hiddenStockLines = o.lines.length - receivable.length;
  const anyStock = receivable.some((l) => l.kind === "stock");
  // The order's delivery location is the default, unless it has been archived since (stock can't
  // be put into an archived location).
  const delivery = o.deliveryLocation?.status === "active" ? o.deliveryLocation : null;
  const locations =
    delivery && !given.some((l) => l.id === delivery.id)
      ? [{ id: delivery.id, name: delivery.name }, ...given]
      : given;
  const defaultLocation = delivery?.id ?? locations[0]?.id ?? NONE;
  const tolerance = o.overDeliveryTolerancePercent;
  const mustQuarantine = o.supplier.approvalStatus === "pending";
  const [commandId] = useState(() => newId());
  const [receivedOn, setReceivedOn] = useState(today);
  const [deliveryReference, setDeliveryReference] = useState("");
  const [notes, setNotes] = useState("");
  const [entries, setEntries] = useState<Record<string, LineEntry>>(() =>
    Object.fromEntries(
      receivable.map((l) => {
        const left = l.outstanding.inLineUnit ?? 0;
        return [
          l.id,
          {
            outcome: left > 0 ? "accepted" : "skip",
            quantity: left > 0 ? formatQty(left) : "",
            locationId: defaultLocation,
            supplierLotCode: "",
            expiresOn: "",
            expiryType: "use_by",
            quarantine: false,
            reason: "",
            overDeliveryReason: "",
          } satisfies LineEntry,
        ];
      }),
    ),
  );
  const update = (id: string, patch: Partial<LineEntry>) =>
    setEntries((all) => ({ ...all, [id]: { ...all[id]!, ...patch } }));

  const chosen = receivable.filter((l) => entries[l.id]!.outcome !== "skip");
  const invalid =
    chosen.length === 0 ||
    chosen.some((l) => {
      const e = entries[l.id]!;
      if (!(parseNumber(e.quantity)! > 0)) return true;
      if (pastTolerance(l, e, tolerance) && !e.overDeliveryReason.trim()) return true;
      if (e.outcome === "rejected") return !e.reason.trim();
      return l.kind === "stock" && e.locationId === NONE;
    });
  const accepted = chosen.filter((l) => entries[l.id]!.outcome === "accepted").length;
  const rejected = chosen.length - accepted;

  return (
    <HaccpDialog
      title={`Receive against ${o.reference}`}
      description={
        anyStock
          ? `A delivery from ${o.supplier.name}. Each accepted stock line becomes a lot in stock; non-stock lines are counted as received; refused goods are recorded but never enter stock.`
          : `A delivery from ${o.supplier.name}: what was received or done, and anything refused.`
      }
      submitLabel={
        chosen.length === 0
          ? "Receive"
          : `Record delivery (${[accepted && `${accepted} accepted`, rejected && `${rejected} rejected`].filter(Boolean).join(", ")})`
      }
      wide
      disabled={invalid}
      onClose={onClose}
      onSubmit={async () => {
        const lines = chosen.map((l): PurchaseReceiptLineInput => {
          const e = entries[l.id]!;
          const quantity = parseNumber(e.quantity)!;
          // A non-stock line is counted in its own unit and never enters stock.
          const unit = l.unit ?? undefined;
          if (e.outcome === "rejected")
            return {
              lineId: l.id,
              outcome: "rejected",
              quantity,
              ...(unit ? { unit } : {}),
              reason: e.reason.trim(),
            };
          if (l.kind === "non_stock")
            return {
              lineId: l.id,
              outcome: "accepted",
              quantity,
              ...(pastTolerance(l, e, tolerance) ? { overDeliveryReason: e.overDeliveryReason.trim() } : {}),
            };
          return {
            lineId: l.id,
            outcome: "accepted",
            quantity,
            ...(unit ? { unit } : {}),
            locationId: e.locationId,
            ...(e.supplierLotCode.trim() ? { supplierLotCode: e.supplierLotCode.trim() } : {}),
            ...(e.expiresOn ? { expiresOn: e.expiresOn, expiryType: e.expiryType } : {}),
            ...(e.quarantine || mustQuarantine ? { status: "quarantine" as const } : {}),
            ...(pastTolerance(l, e, tolerance) ? { overDeliveryReason: e.overDeliveryReason.trim() } : {}),
          };
        });
        const result = await unwrap(
          purchasingApi().orders[":id"].receipts.$post({
            param: { slug, id: o.id },
            json: {
              commandId,
              receivedOn,
              ...(deliveryReference.trim() ? { deliveryReference: deliveryReference.trim() } : {}),
              ...(notes.trim() ? { notes: notes.trim() } : {}),
              lines,
            },
          }),
        );
        const lots = result.receipts.filter((r) => r.lotCode).map((r) => r.lotCode);
        return lots.length
          ? `Delivery recorded: lot${lots.length === 1 ? "" : "s"} ${lots.join(", ")}`
          : "Delivery recorded";
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="rcv-on">Received on</FieldLabel>
          <Input
            id="rcv-on"
            type="date"
            required
            max={today}
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="rcv-ref">Delivery note</FieldLabel>
          <Input
            id="rcv-ref"
            maxLength={120}
            placeholder="Delivery note number"
            value={deliveryReference}
            onChange={(e) => setDeliveryReference(e.target.value)}
          />
        </Field>
      </div>
      {hiddenStockLines > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {hiddenStockLines === 1 ? "One stock line goes" : `${hiddenStockLines} stock lines go`} into
            stock, which you don&apos;t have access to: someone with Stock access receives{" "}
            {hiddenStockLines === 1 ? "it" : "them"}.
          </AlertDescription>
        </Alert>
      )}
      {anyStock && mustQuarantine && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {o.supplier.name} is pending approval, so everything accepted goes into quarantine until QA
            releases it.
          </AlertDescription>
        </Alert>
      )}
      {anyStock && locations.length === 0 && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            There is no stock location to receive into. Add one on the Stock locations page first.
          </AlertDescription>
        </Alert>
      )}
      {receivable.map((l) => (
        <ReceiveLine
          key={l.id}
          line={l}
          entry={entries[l.id]!}
          onChange={(patch) => update(l.id, patch)}
          locations={locations}
          receivedOn={receivedOn}
          mustQuarantine={mustQuarantine}
          tolerance={tolerance}
        />
      ))}
      <Field>
        <FieldLabel htmlFor="rcv-notes">Notes</FieldLabel>
        <Textarea
          id="rcv-notes"
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function ReceiveLine({
  line: l,
  entry: e,
  onChange,
  locations,
  receivedOn,
  mustQuarantine,
  tolerance,
}: {
  line: PurchaseOrderLine;
  entry: LineEntry;
  onChange: (patch: Partial<LineEntry>) => void;
  locations: LocationOption[];
  receivedOn: string;
  mustQuarantine: boolean;
  tolerance: number | null;
}) {
  const id = `rcv-${l.id}`;
  const unit = lineUnitLabel(l);
  const isStock = l.kind === "stock";
  const quantity = parseNumber(e.quantity);
  const over =
    e.outcome === "accepted" &&
    quantity !== null &&
    l.outstanding.inLineUnit !== null &&
    quantity > l.outstanding.inLineUnit;
  const beyondTolerance = pastTolerance(l, e, tolerance);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="text-muted-foreground tabular-nums">{l.lineNo}.</span>{" "}
          <span className="font-medium">{lineTitle(l)}</span>{" "}
          {l.item && <span className="font-mono text-xs text-muted-foreground">{l.item.code}</span>}
          <div className="text-xs text-muted-foreground">
            Ordered {formatLineAmount(l.ordered, l.unit)}
            {l.received.base > 0 && ` · received ${formatLineAmount(l.received, l.unit)}`} · outstanding{" "}
            {formatLineAmount(l.outstanding, l.unit)}
          </div>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label={`Line ${l.lineNo}`}
          value={e.outcome}
          onValueChange={(v) => {
            if (!v) return;
            onChange({
              outcome: v as Outcome,
              // Coming back from "not in this delivery": prefill the outstanding quantity again.
              ...(v !== "skip" && !e.quantity && l.outstanding.inLineUnit
                ? { quantity: formatQty(l.outstanding.inLineUnit) }
                : {}),
            });
          }}
        >
          <ToggleGroupItem value="accepted">Accept</ToggleGroupItem>
          <ToggleGroupItem value="rejected">Reject</ToggleGroupItem>
          <ToggleGroupItem value="skip">Not delivered</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {e.outcome !== "skip" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor={`${id}-qty`}>
              {e.outcome === "accepted" ? "Quantity accepted" : "Quantity refused"}
              {unit ? ` (${unit})` : ""}
            </FieldLabel>
            <Input
              id={`${id}-qty`}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              required
              value={e.quantity}
              onChange={(ev) => onChange({ quantity: ev.target.value })}
            />
            {beyondTolerance ? (
              <FieldDescription>
                More than {tolerance}% over what was ordered: say why it is accepted.
              </FieldDescription>
            ) : (
              over && <FieldDescription>More than outstanding: recorded as over-delivered.</FieldDescription>
            )}
          </Field>
          {e.outcome === "accepted" && !isStock ? (
            beyondTolerance && (
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`${id}-over-reason`}>Why accept more than ordered</FieldLabel>
                <Input
                  id={`${id}-over-reason`}
                  required
                  maxLength={500}
                  value={e.overDeliveryReason}
                  onChange={(ev) => onChange({ overDeliveryReason: ev.target.value })}
                />
              </Field>
            )
          ) : e.outcome === "accepted" ? (
            <>
              <SelectField
                id={`${id}-location`}
                label="Into location"
                value={e.locationId}
                onChange={(v) => onChange({ locationId: v })}
                options={
                  locations.length
                    ? locations.map((loc) => [loc.id, loc.name] as const)
                    : [[NONE, "No locations"] as const]
                }
              />
              <Field>
                <FieldLabel htmlFor={`${id}-supplier-lot`}>Supplier&apos;s lot code</FieldLabel>
                <Input
                  id={`${id}-supplier-lot`}
                  maxLength={80}
                  value={e.supplierLotCode}
                  onChange={(ev) => onChange({ supplierLotCode: ev.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-expires`}>Expiry date</FieldLabel>
                <Input
                  id={`${id}-expires`}
                  type="date"
                  min={receivedOn}
                  value={e.expiresOn}
                  onChange={(ev) => onChange({ expiresOn: ev.target.value })}
                />
              </Field>
              <SelectField
                id={`${id}-expiry-type`}
                label="Expiry type"
                value={e.expiryType}
                onChange={(v) => onChange({ expiryType: v as ExpiryType })}
                disabled={!e.expiresOn}
                options={expiryTypes.map((t) => [t, expiryTypeLabels[t]] as const)}
              />
              {beyondTolerance && (
                <Field className="sm:col-span-3">
                  <FieldLabel htmlFor={`${id}-over-reason`}>Why accept more than ordered</FieldLabel>
                  <Input
                    id={`${id}-over-reason`}
                    required
                    maxLength={500}
                    placeholder="e.g. Pack size, agreed with the supplier"
                    value={e.overDeliveryReason}
                    onChange={(ev) => onChange({ overDeliveryReason: ev.target.value })}
                  />
                </Field>
              )}
              <div className="flex items-center gap-2 sm:pt-6">
                <Checkbox
                  id={`${id}-quarantine`}
                  checked={e.quarantine || mustQuarantine}
                  disabled={mustQuarantine}
                  onCheckedChange={(on) => onChange({ quarantine: on === true })}
                />
                <Label htmlFor={`${id}-quarantine`}>Into quarantine</Label>
              </div>
            </>
          ) : (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={`${id}-reason`}>Why it was refused</FieldLabel>
              <Input
                id={`${id}-reason`}
                required
                maxLength={500}
                placeholder="e.g. Damaged packaging, temperature out of range"
                value={e.reason}
                onChange={(ev) => onChange({ reason: ev.target.value })}
              />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}
