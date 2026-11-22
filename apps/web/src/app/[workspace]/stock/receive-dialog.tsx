"use client";

import { newId } from "@knotworking/core";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  addDays,
  expiryTypeLabels,
  expiryTypes,
  itemTypeLabels,
  receivableItemTypes,
  supplierApprovalLabels,
  units,
  unitsForItem,
  type ExpiryType,
  type UnitCode,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
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
import { Label } from "@knotworking/ui/components/label";
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
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Item, StockLocation, Supplier } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const NONE = "none";
const receivable = (item: Item) => (receivableItemTypes as readonly string[]).includes(item.type);

/**
 * Goods-in: creates a lot and its receipt. Ingredients and packaging only; with `manage`, any
 * item can be received as an opening balance with a reason. Suppliers are the item's own when it
 * has any; a supplier pending approval delivers into quarantine, a suspended or rejected one not
 * at all (the API enforces both).
 */
export function ReceiveDialog({
  slug,
  items,
  suppliers,
  locations,
  canManage,
  onClose,
}: {
  slug: string;
  items: Item[];
  suppliers: Supplier[];
  locations: StockLocation[];
  canManage: boolean;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const router = useRouter();
  const choices = items.filter((i) => canManage || receivable(i));
  const [pending, setPending] = useState(false);
  const [itemId, setItemId] = useState(choices[0]?.id ?? "");
  const item = choices.find((i) => i.id === itemId);
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState<UnitCode>(item?.unit ?? "kg");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [receivedOn, setReceivedOn] = useState(today);
  const [supplierId, setSupplierId] = useState(NONE);
  const [supplierLotCode, setSupplierLotCode] = useState("");
  const [lotCode, setLotCode] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [expiryType, setExpiryType] = useState<ExpiryType>("use_by");
  const [reference, setReference] = useState("");
  const [quarantine, setQuarantine] = useState(false);
  const [reason, setReason] = useState("");
  const [commandId] = useState(() => newId());

  const unitChoices = item ? unitsForItem(item) : [];
  // Limit to the item's suppliers when it has any.
  const linked = new Set(item?.suppliers.map((s) => s.supplierId) ?? []);
  const supplierChoices = linked.size ? suppliers.filter((s) => linked.has(s.id)) : suppliers;
  const supplier = suppliers.find((s) => s.id === supplierId);
  const mustQuarantine = supplier?.approvalStatus === "pending";
  const openingBalance = item ? !receivable(item) : false;

  function pickItem(id: string) {
    const next = choices.find((i) => i.id === id);
    setItemId(id);
    if (next) setUnit(next.unit);
    setSupplierId(NONE);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!item) return;
    setPending(true);
    try {
      const lot = await unwrap(
        browserApi().v1.workspaces[":slug"].stock.receipts.$post({
          param: { slug },
          json: {
            commandId,
            itemId: item.id,
            quantity: Number(quantity),
            unit,
            locationId,
            receivedOn,
            ...(supplier ? { supplierId: supplier.id } : {}),
            ...(supplierLotCode.trim() ? { supplierLotCode: supplierLotCode.trim() } : {}),
            ...(lotCode.trim() ? { lotCode: lotCode.trim() } : {}),
            ...(expiresOn ? { expiresOn, expiryType } : {}),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
            ...(quarantine || mustQuarantine ? { status: "quarantine" as const } : {}),
            ...(openingBalance ? { reason: reason.trim() } : {}),
          },
        }),
      );
      toast.success(`Received ${item.name} as lot ${lot.lotCode}`);
      onClose();
      router.push(`/${slug}/stock/lots/${lot.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Receive stock</DialogTitle>
            <DialogDescription>
              Record a delivery. The supplier&apos;s lot code keeps the trace one step back.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel id="receive-item-label">Item</FieldLabel>
              <Select value={itemId} onValueChange={pickItem}>
                <SelectTrigger aria-labelledby="receive-item-label" className="w-full">
                  <SelectValue placeholder="Choose an item" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {choices.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {i.name} <span className="font-mono text-xs text-muted-foreground">{i.code}</span>
                        {!receivable(i) && (
                          <span className="text-xs text-muted-foreground"> · {itemTypeLabels[i.type]}</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {choices.length === 0 && (
                <FieldDescription>Add ingredients or packaging on the Items page first.</FieldDescription>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem_1fr]">
              <Field>
                <FieldLabel htmlFor="receive-quantity">Quantity</FieldLabel>
                <Input
                  id="receive-quantity"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  required
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel id="receive-unit-label">Unit</FieldLabel>
                <Select value={unit} onValueChange={(v) => setUnit(v as UnitCode)}>
                  <SelectTrigger aria-labelledby="receive-unit-label" className="w-full">
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
              <Field>
                <FieldLabel id="receive-location-label">Location</FieldLabel>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger aria-labelledby="receive-location-label" className="w-full">
                    <SelectValue placeholder="Choose a location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel id="receive-supplier-label">Supplier</FieldLabel>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger aria-labelledby="receive-supplier-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NONE}>No supplier</SelectItem>
                      {supplierChoices.map((s) => (
                        <SelectItem
                          key={s.id}
                          value={s.id}
                          disabled={s.approvalStatus === "suspended" || s.approvalStatus === "rejected"}
                        >
                          {s.name}
                          {s.approvalStatus !== "approved" && (
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              · {supplierApprovalLabels[s.approvalStatus]}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {mustQuarantine && (
                  <FieldDescription>Not approved yet: the delivery goes into quarantine.</FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="receive-supplier-lot">Supplier&apos;s lot code</FieldLabel>
                <Input
                  id="receive-supplier-lot"
                  maxLength={80}
                  value={supplierLotCode}
                  onChange={(e) => setSupplierLotCode(e.target.value)}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="receive-on">Received on</FieldLabel>
                <Input
                  id="receive-on"
                  type="date"
                  required
                  value={receivedOn}
                  onChange={(e) => setReceivedOn(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="receive-expires">Expiry date</FieldLabel>
                <Input
                  id="receive-expires"
                  type="date"
                  min={receivedOn}
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                />
                {!expiresOn && item?.shelfLifeDays != null && receivedOn && (
                  <FieldDescription>
                    Defaults to best before {addDays(receivedOn, item.shelfLifeDays)} (shelf life).
                  </FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel id="receive-expiry-type-label">Expiry type</FieldLabel>
                <Select value={expiryType} onValueChange={(v) => setExpiryType(v as ExpiryType)}>
                  <SelectTrigger
                    aria-labelledby="receive-expiry-type-label"
                    className="w-full"
                    disabled={!expiresOn}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {expiryTypes.map((t) => (
                        <SelectItem key={t} value={t}>
                          {expiryTypeLabels[t]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="receive-lot">Lot code</FieldLabel>
                <Input
                  id="receive-lot"
                  maxLength={60}
                  placeholder="Generated if left blank"
                  value={lotCode}
                  onChange={(e) => setLotCode(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="receive-reference">Reference</FieldLabel>
                <Input
                  id="receive-reference"
                  maxLength={120}
                  placeholder="Delivery note number"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>
            </div>
            {openingBalance && (
              <Field>
                <FieldLabel htmlFor="receive-reason">Reason</FieldLabel>
                <Textarea
                  id="receive-reason"
                  required
                  maxLength={500}
                  placeholder="e.g. Opening balance"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <FieldDescription>
                  {item && itemTypeLabels[item.type]} stock normally comes from production; say why it is
                  received here.
                </FieldDescription>
              </Field>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="receive-quarantine"
                checked={quarantine || mustQuarantine}
                disabled={mustQuarantine}
                onCheckedChange={(on) => setQuarantine(on === true)}
              />
              <Label htmlFor="receive-quarantine">Receive into quarantine (held until QA releases it)</Label>
            </div>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !item || !locationId}>
              {pending && <Spinner data-icon="inline-start" />} Receive
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
