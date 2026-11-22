"use client";

import {
  canOrderFromSupplier,
  convertUnitPrice,
  PRICE_DECIMALS,
  supplierApprovalLabels,
  units,
  unitsForItem,
  type UnitCode,
} from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { formatLineAmount } from "@/components/purchasing-badges";
import type { PurchaseOrderDetail } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import {
  NONE,
  parseNumber,
  purchasingApi,
  type OrderOptions,
  type PurchasableItem,
  type SupplierOption,
} from "./purchasing-forms";

interface LineDraft {
  /** React key. */
  key: string;
  /** An existing line (kept and edited by the PATCH). */
  id?: string;
  itemId: string;
  quantity: string;
  unit: UnitCode;
  price: string;
  /** The line's own expected date, overriding the order's; "" = the order's. */
  expectedOn: string;
  /** Edited by hand: no longer re-defaulted from the standard cost when the item or unit changes. */
  priceTouched: boolean;
  /** An existing line with receipts: can't be removed or moved to another item. */
  locked: boolean;
  /**
   * An existing line on a supplier invoice: can't be removed, nor change item, unit or price (the
   * invoice was matched and costed against them).
   */
  invoiced: boolean;
  /** What has been accepted, for the "can't go below" hint. */
  receivedText?: string;
}

let nextKey = 0;
const key = () => `line-${++nextKey}`;

/** The item's standard cost per `unit`, as an input value. */
function defaultPrice(item: PurchasableItem | undefined, unit: UnitCode) {
  if (!item || item.standardCost === null) return "";
  // 8 places: a per-gram price of an item costed per kilo is small (3.45/kg is 0.00345/g).
  const price = convertUnitPrice(item.standardCost, item.unit, unit, item, PRICE_DECIMALS);
  return price === null ? "" : String(price);
}

const blankLine = (item?: PurchasableItem): LineDraft => ({
  key: key(),
  itemId: item?.id ?? "",
  quantity: "",
  unit: item?.unit ?? "kg",
  price: defaultPrice(item, item?.unit ?? "kg"),
  expectedOn: "",
  priceTouched: false,
  locked: false,
  invoiced: false,
});

const supplierLabel = (s: SupplierOption) =>
  `${s.name}${s.approvalStatus === "approved" ? "" : ` · ${supplierApprovalLabels[s.approvalStatus]}`}`;

/**
 * A new draft order, or an edit of a draft or sent order. Lines are ingredients and packaging; the
 * price defaults to the item's standard cost in the line's unit. Once sent, the supplier is fixed
 * and lines with receipts can't be removed or change item; lines on a supplier invoice can't be
 * removed or change item, unit or price (the API enforces all of these).
 */
export function OrderDialog({
  slug,
  options,
  order,
  onClose,
}: {
  slug: string;
  options: OrderOptions;
  /** Editing this order; a new draft when left out. */
  order?: PurchaseOrderDetail;
  onClose: () => void;
}) {
  const router = useRouter();
  const sent = order?.status === "sent";
  // Orderable suppliers; the order's own stays listed so the picker shows it.
  const suppliers = options.suppliers.filter(
    (s) => canOrderFromSupplier(s.approvalStatus) || s.id === order?.supplierId,
  );
  if (order && !suppliers.some((s) => s.id === order.supplierId)) suppliers.unshift(order.supplier);
  // Items on the order stay pickable even if archived or no longer purchasable.
  const items = [...options.items];
  for (const line of order?.lines ?? []) {
    if (!items.some((i) => i.id === line.itemId))
      items.push({
        id: line.item.id,
        code: line.item.code,
        name: line.item.name,
        type: line.item.type,
        unit: line.item.unit,
        standardCost: null,
        densityGPerMl: null,
        unitWeightG: null,
        supplierIds: [],
      });
  }
  const itemOf = (id: string) => items.find((i) => i.id === id);

  const [supplierId, setSupplierId] = useState(order?.supplierId ?? "");
  const [expectedOn, setExpectedOn] = useState(order?.expectedOn ?? "");
  const [locationId, setLocationId] = useState(
    order?.deliveryLocationId ?? (options.locations.length === 1 ? options.locations[0]!.id : NONE),
  );
  const [supplierReference, setSupplierReference] = useState(order?.supplierReference ?? "");
  const [notes, setNotes] = useState(order?.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(() =>
    order
      ? order.lines.map((l) => ({
          key: key(),
          id: l.id,
          itemId: l.itemId,
          quantity: String(l.ordered.inLineUnit ?? l.ordered.display),
          unit: l.ordered.inLineUnit === null ? l.ordered.displayUnit : l.unit,
          price: l.unitPrice === null ? "" : String(l.unitPrice),
          expectedOn: l.expectedOn ?? "",
          priceTouched: true,
          locked: l.hasReceipts,
          invoiced: l.invoiced,
          ...(l.received.base > 0 ? { receivedText: formatLineAmount(l.received, l.unit) } : {}),
        }))
      : [blankLine()],
  );

  const update = (k: string, patch: Partial<LineDraft>) =>
    setLines((all) => all.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  function pickItem(line: LineDraft, id: string) {
    const item = itemOf(id);
    if (!item) return;
    update(line.key, {
      itemId: id,
      unit: item.unit,
      ...(line.priceTouched ? {} : { price: defaultPrice(item, item.unit) }),
    });
  }

  function pickUnit(line: LineDraft, unit: UnitCode) {
    update(line.key, {
      unit,
      ...(line.priceTouched ? {} : { price: defaultPrice(itemOf(line.itemId), unit) }),
    });
  }

  const supplier = suppliers.find((s) => s.id === supplierId);
  // Suppliers' own items first, then the rest.
  const sortedItems = supplier
    ? [...items].sort(
        (a, b) => Number(b.supplierIds.includes(supplier.id)) - Number(a.supplierIds.includes(supplier.id)),
      )
    : items;
  const filled = lines.filter((l) => l.itemId || l.quantity);
  const invalid =
    !supplierId ||
    filled.some(
      (l) => !l.itemId || !(parseNumber(l.quantity)! > 0) || (l.price && parseNumber(l.price) === null),
    );

  return (
    <HaccpDialog
      title={order ? `Edit ${order.reference}` : "New purchase order"}
      description={
        sent
          ? "The order has been sent: the supplier can't change, and lines that have had deliveries stay on it."
          : "Saved as a draft. Send it once the supplier has it; a draft commits nobody."
      }
      submitLabel={order ? "Save" : "Create draft"}
      wide
      disabled={invalid}
      onClose={onClose}
      onSubmit={async () => {
        const header = {
          expectedOn: expectedOn || null,
          deliveryLocationId: locationId === NONE ? null : locationId,
          supplierReference: supplierReference.trim() || null,
          notes: notes.trim() || null,
        };
        const lineInput = filled.map((l) => ({
          ...(l.id ? { id: l.id } : {}),
          itemId: l.itemId,
          quantity: parseNumber(l.quantity)!,
          unit: l.unit,
          unitPrice: parseNumber(l.price),
          expectedOn: l.expectedOn || null,
        }));
        if (order) {
          await unwrap(
            purchasingApi().orders[":id"].$patch({
              param: { slug, id: order.id },
              json: {
                ...(supplierId !== order.supplierId ? { supplierId } : {}),
                ...header,
                lines: lineInput,
              },
            }),
          );
          return `${order.reference} saved`;
        }
        const created = await unwrap(
          purchasingApi().orders.$post({
            param: { slug },
            json: { supplierId, ...header, lines: lineInput.map(({ id: _id, ...l }) => l) },
          }),
        );
        router.push(`/${slug}/purchasing/orders/${created.id}`);
        return `${created.reference} drafted`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="po-supplier"
          label="Supplier"
          value={supplierId || NONE}
          onChange={setSupplierId}
          disabled={sent}
          options={[
            ...(supplierId ? [] : [[NONE, "Choose a supplier"] as const]),
            ...suppliers.map((s) => [s.id, supplierLabel(s)] as const),
          ]}
          description={
            supplier?.approvalStatus === "pending"
              ? "Not approved yet: you can order, but deliveries go into quarantine."
              : suppliers.length === 0
                ? "Add a supplier on the Suppliers page first. Suspended and rejected suppliers can't be ordered from."
                : undefined
          }
        />
        <Field>
          <FieldLabel htmlFor="po-expected">Expected delivery</FieldLabel>
          <Input
            id="po-expected"
            type="date"
            value={expectedOn}
            onChange={(e) => setExpectedOn(e.target.value)}
          />
          <FieldDescription>Needed to send, here or on every line.</FieldDescription>
        </Field>
        <SelectField
          id="po-location"
          label="Deliver to"
          value={locationId}
          onChange={setLocationId}
          options={[[NONE, "Not set"], ...options.locations.map((l) => [l.id, l.name] as const)]}
          description="Where the goods-in form puts the delivery by default."
        />
        <Field>
          <FieldLabel htmlFor="po-supplier-ref">Supplier&apos;s reference</FieldLabel>
          <Input
            id="po-supplier-ref"
            maxLength={120}
            placeholder="Their order confirmation number"
            value={supplierReference}
            onChange={(e) => setSupplierReference(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">Lines</div>
        {items.length === 0 && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>
              Only ingredients and packaging are bought. Add them on the Items page first.
            </AlertDescription>
          </Alert>
        )}
        {lines.map((line, index) => {
          const item = itemOf(line.itemId);
          const unitChoices = item ? unitsForItem(item) : [line.unit];
          const unlisted = item && supplier && !item.supplierIds.includes(supplier.id);
          return (
            <div key={line.key} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_6rem_auto] sm:items-end">
                <Field>
                  <FieldLabel id={`${line.key}-item-label`}>Item {index + 1}</FieldLabel>
                  <Select
                    value={line.itemId || NONE}
                    onValueChange={(v) => pickItem(line, v)}
                    disabled={line.locked || line.invoiced}
                  >
                    <SelectTrigger aria-labelledby={`${line.key}-item-label`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {!line.itemId && <SelectItem value={NONE}>Choose an item</SelectItem>}
                        {sortedItems.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} <span className="font-mono text-xs text-muted-foreground">{i.code}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${line.key}-qty`}>Quantity</FieldLabel>
                  <Input
                    id={`${line.key}-qty`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={line.quantity}
                    onChange={(e) => update(line.key, { quantity: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel id={`${line.key}-unit-label`}>Unit</FieldLabel>
                  <Select
                    value={line.unit}
                    onValueChange={(v) => pickUnit(line, v as UnitCode)}
                    disabled={line.invoiced}
                  >
                    <SelectTrigger aria-labelledby={`${line.key}-unit-label`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {unitChoices.map((u) => (
                          <SelectItem key={u} value={u}>
                            {units[u].label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove line ${index + 1}`}
                  title={
                    line.invoiced
                      ? "This line is on a supplier invoice and stays on the order"
                      : line.locked
                        ? "This line has had deliveries and stays on the order"
                        : undefined
                  }
                  disabled={line.locked || line.invoiced || lines.length === 1}
                  onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${line.key}-price`}>Price / {units[line.unit].label}</FieldLabel>
                  <Input
                    id={`${line.key}-price`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    placeholder="Unknown"
                    disabled={line.invoiced}
                    value={line.price}
                    onChange={(e) => update(line.key, { price: e.target.value, priceTouched: true })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${line.key}-expected`}>
                    Expected, if not the order&apos;s date
                  </FieldLabel>
                  <Input
                    id={`${line.key}-expected`}
                    type="date"
                    value={line.expectedOn}
                    onChange={(e) => update(line.key, { expectedOn: e.target.value })}
                  />
                </Field>
              </div>
              {(unlisted || line.receivedText || line.invoiced) && (
                <p className="text-xs text-muted-foreground">
                  {[
                    line.invoiced &&
                      "On a supplier invoice: its item, unit and price are fixed (revise the invoice to correct them)",
                    line.receivedText && `${line.receivedText} received: can't go below that`,
                    unlisted && `Not listed as supplied by ${supplier.name}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((all) => [...all, blankLine()])}
          >
            <Plus data-icon="inline-start" /> Add line
          </Button>
        </div>
      </div>

      <Field>
        <FieldLabel htmlFor="po-notes">Notes</FieldLabel>
        <Textarea
          id="po-notes"
          rows={2}
          maxLength={4000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}
