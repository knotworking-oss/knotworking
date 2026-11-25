"use client";

import { useWorkspaceCurrency } from "@/lib/workspace-time";
import { uninvoicedQuantity, units } from "@knotworking/core";
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
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HaccpDialog } from "@/components/haccp-forms";
import { formatPrice, lineUnitLabel } from "@/components/purchasing-badges";
import type { PurchaseInvoiceDetail } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { NONE, parseNumber, purchasingApi, type SupplierOption } from "../purchasing-forms";

/** A line being entered: an order line (with what the form shows about it) or a charge. */
type DraftLine =
  | {
      key: string;
      kind: "order";
      orderLineId: string;
      label: string;
      /** The order line's unit as shown: a stock unit's label, a non-stock line's own text, or "". */
      unit: string;
      orderPrice: number | null;
      received: number | null;
      /** Already on approved invoices (lines brought in from an order; unknown when editing). */
      invoiced?: number;
      quantity: string;
      unitPrice: string;
    }
  | { key: string; kind: "charge"; description: string; quantity: string; unitPrice: string };

type OrderChoice = { id: string; reference: string; state: string };

let seq = 0;
const key = () => `l${++seq}`;

const fromInvoice = (invoice: PurchaseInvoiceDetail): DraftLine[] =>
  invoice.lines.map((l) =>
    l.kind === "order" && l.orderLine
      ? {
          key: key(),
          kind: "order",
          orderLineId: l.orderLine.id,
          label: `${l.orderLine.reference} · line ${l.orderLine.lineNo}${l.item ? ` · ${l.item.code} ${l.item.name}` : l.orderLine.description ? ` · ${l.orderLine.description}` : ""}`,
          unit: l.unit ? units[l.unit].label : (l.orderLine.unitLabel ?? ""),
          orderPrice: l.orderLine.unitPrice,
          received: l.received,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
        }
      : {
          key: key(),
          kind: "charge",
          description: l.description ?? "",
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
        },
  );

/**
 * Enter a supplier invoice as a draft, or edit one. Lines are picked from the supplier's sent and
 * closed orders (each order line comes in at what was received and the order price, to adjust to
 * what the invoice says), plus charges such as carriage. The match is worked out on save.
 */
export function InvoiceDialog({
  slug,
  suppliers,
  invoice,
  initialOrderId,
  onClose,
}: {
  slug: string;
  suppliers: SupplierOption[];
  invoice?: PurchaseInvoiceDetail;
  /** Start with this order's lines (from the purchase order page). */
  initialOrderId?: string;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  const router = useRouter();
  const revision = Boolean(invoice?.supersedesId);
  const [supplierId, setSupplierId] = useState(invoice?.supplierId ?? "");
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber ?? "");
  // The invoice is dated in the workspace's time zone, not the browser's.
  const today = useWorkspaceToday();
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? today);
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? "");
  const [vat, setVat] = useState(invoice ? String(invoice.vat) : "0");
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const [lines, setLines] = useState<DraftLine[]>(invoice ? fromInvoice(invoice) : []);
  const [orders, setOrders] = useState<OrderChoice[]>([]);
  const [pickedOrder, setPickedOrder] = useState(NONE);

  // The supplier's orders that can be invoiced: sent (any state of receipt) or closed.
  useEffect(() => {
    if (!supplierId) return setOrders([]);
    let live = true;
    void unwrap(
      purchasingApi().orders.$get({ param: { slug }, query: { supplierId, status: "all", limit: "200" } }),
    )
      .then((r) => {
        if (live)
          setOrders(
            r.orders
              .filter((o) => o.status === "sent" || o.status === "closed")
              .map((o) => ({ id: o.id, reference: o.reference, state: o.state })),
          );
      })
      .catch(() => live && setOrders([]));
    return () => {
      live = false;
    };
  }, [slug, supplierId]);

  async function addOrder(orderId: string) {
    try {
      const order = await unwrap(purchasingApi().orders[":id"].$get({ param: { slug, id: orderId } }));
      if (!supplierId) setSupplierId(order.supplier.id);
      // Each line comes in at what was received and not yet invoiced on approved invoices; lines with
      // nothing left to invoice are left out (add them by hand from another order pick if needed).
      const have = new Set(lines.flatMap((l) => (l.kind === "order" ? [l.orderLineId] : [])));
      const fresh = order.lines.filter((l) => !have.has(l.id));
      const left = (l: (typeof fresh)[number]) =>
        uninvoicedQuantity(l.received.inLineUnit, l.invoicedQuantity);
      const added = fresh
        .filter((l) => left(l) !== 0)
        .map((l): DraftLine => ({
          key: key(),
          kind: "order",
          orderLineId: l.id,
          label: `${order.reference} · line ${l.lineNo} · ${l.kind === "non_stock" || !l.item ? (l.description ?? "") : `${l.item.code} ${l.item.name}`}`,
          unit: lineUnitLabel(l),
          orderPrice: l.unitPrice,
          received: l.received.inLineUnit,
          invoiced: l.invoicedQuantity,
          quantity: left(l) === null ? "" : String(left(l)),
          unitPrice: l.unitPrice === null ? "" : String(l.unitPrice),
        }));
      const skipped = fresh.length - added.length;
      if (skipped > 0)
        toast.info(
          `${skipped} line${skipped === 1 ? " of" : "s of"} ${order.reference} left out: everything received is already invoiced`,
        );
      setLines((current) => [...current, ...added]);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  useEffect(() => {
    if (initialOrderId && !invoice) void addOrder(initialOrderId);
    // Once, when opened from an order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (k: string, patch: Partial<Record<"quantity" | "unitPrice" | "description", string>>) =>
    setLines((current) => current.map((l) => (l.key === k ? ({ ...l, ...patch } as DraftLine) : l)));

  const parsed = lines.map((l) => ({
    line: l,
    quantity: parseNumber(l.quantity),
    unitPrice: parseNumber(l.unitPrice),
  }));
  const invalid = parsed.some(
    (p) =>
      p.quantity === null ||
      p.quantity <= 0 ||
      p.unitPrice === null ||
      // A charge may be negative: a discount. An order line is billed at a price of 0 or more.
      (p.line.kind === "order" && p.unitPrice < 0) ||
      (p.line.kind === "charge" && !p.line.description.trim()),
  );
  const net = parsed.reduce((sum, p) => sum + (p.quantity ?? 0) * (p.unitPrice ?? 0), 0);
  const vatValue = parseNumber(vat);

  return (
    <HaccpDialog
      wide
      title={
        invoice
          ? `Edit invoice ${invoice.invoiceNumber}${revision ? ` (version ${invoice.version})` : ""}`
          : "Enter a supplier invoice"
      }
      description="A draft until a person with manage access approves it for payment. Quantities and prices are per the order line's unit; each line is matched against the order and what was received."
      submitLabel={invoice ? "Save draft" : "Save as draft"}
      disabled={
        !supplierId || !invoiceNumber.trim() || !invoiceDate || invalid || vatValue === null || vatValue < 0
      }
      onClose={onClose}
      onSubmit={async () => {
        const json = {
          invoiceDate,
          dueDate: dueDate || null,
          vat: vatValue ?? 0,
          notes: notes.trim() || null,
          lines: parsed.map(({ line, quantity, unitPrice }) =>
            line.kind === "order"
              ? {
                  kind: "order" as const,
                  orderLineId: line.orderLineId,
                  quantity: quantity!,
                  unitPrice: unitPrice!,
                }
              : {
                  kind: "charge" as const,
                  description: line.description.trim(),
                  quantity: quantity!,
                  unitPrice: unitPrice!,
                },
          ),
        };
        if (invoice) {
          await unwrap(
            purchasingApi().invoices[":id"].$patch({
              param: { slug, id: invoice.id },
              json: revision ? json : { ...json, supplierId, invoiceNumber: invoiceNumber.trim() },
            }),
          );
          return `Invoice ${invoice.invoiceNumber} saved`;
        }
        const created = await unwrap(
          purchasingApi().invoices.$post({
            param: { slug },
            json: { ...json, supplierId, invoiceNumber: invoiceNumber.trim() },
          }),
        );
        router.push(`/${slug}/purchasing/invoices/${created.id}`);
        return `Invoice ${created.invoiceNumber} entered`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="inv-supplier">Supplier</FieldLabel>
          <Select
            value={supplierId || NONE}
            disabled={revision}
            onValueChange={(v) => {
              setSupplierId(v === NONE ? "" : v);
              setLines((current) => current.filter((l) => l.kind === "charge"));
            }}
          >
            <SelectTrigger id="inv-supplier">
              <SelectValue placeholder="Choose a supplier" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE} disabled>
                  Choose a supplier
                </SelectItem>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="inv-number">Supplier&apos;s invoice number</FieldLabel>
          <Input
            id="inv-number"
            required
            maxLength={60}
            disabled={revision}
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="inv-date">Invoice date</FieldLabel>
          <Input
            id="inv-date"
            type="date"
            required
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="inv-due">Due date</FieldLabel>
          <Input
            id="inv-due"
            type="date"
            min={invoiceDate}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel>Lines</FieldLabel>
        <FieldDescription>
          Add an order to bring in its lines at what was received and the order price, then change them to
          what the invoice says. Remove lines the invoice doesn&apos;t bill. A discount is a charge with a
          negative price (a settlement discount, a volume rebate); it is not matched against an order.
        </FieldDescription>
        <div className="flex flex-wrap gap-2">
          <Select
            value={pickedOrder}
            disabled={!supplierId || orders.length === 0}
            onValueChange={(v) => {
              setPickedOrder(NONE);
              if (v !== NONE) void addOrder(v);
            }}
          >
            <SelectTrigger aria-label="Add an order's lines" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE} disabled>
                  {supplierId
                    ? orders.length
                      ? "Add an order's lines…"
                      : "No sent orders"
                    : "Choose a supplier first"}
                </SelectItem>
                {orders.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.reference}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setLines((current) => [
                ...current,
                { key: key(), kind: "charge", description: "Carriage", quantity: "1", unitPrice: "" },
              ])
            }
          >
            <Plus data-icon="inline-start" /> Add a charge
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setLines((current) => [
                ...current,
                { key: key(), kind: "charge", description: "Discount", quantity: "1", unitPrice: "-" },
              ])
            }
          >
            <Plus data-icon="inline-start" /> Add a discount
          </Button>
        </div>
        {lines.length > 0 && (
          <div className="flex flex-col gap-2">
            {lines.map((l) => (
              <div
                key={l.key}
                className="grid items-end gap-2 rounded-md border p-2 sm:grid-cols-[1fr_7rem_8rem_auto]"
              >
                {l.kind === "order" ? (
                  <div className="text-sm">
                    <div className="font-medium">{l.label}</div>
                    <div className="text-xs text-muted-foreground">
                      Received {l.received ?? "—"} {l.unit}
                      {l.invoiced ? ` · ${l.invoiced} already invoiced` : ""} · order price{" "}
                      {l.orderPrice === null
                        ? "none"
                        : `${formatPrice(l.orderPrice, currency)}${l.unit ? ` / ${l.unit}` : ""}`}
                    </div>
                  </div>
                ) : (
                  <Input
                    aria-label="Charge"
                    value={l.description}
                    maxLength={200}
                    onChange={(e) => update(l.key, { description: e.target.value })}
                  />
                )}
                <Input
                  aria-label="Quantity"
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                />
                <Input
                  aria-label={l.kind === "order" && l.unit ? `Price per ${l.unit}` : "Price"}
                  inputMode="decimal"
                  placeholder={l.kind === "charge" ? "Price (negative: discount)" : "Price"}
                  value={l.unitPrice}
                  onChange={(e) => update(l.key, { unitPrice: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove line"
                  onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="inv-vat">VAT</FieldLabel>
          <Input id="inv-vat" inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
          <FieldDescription>
            Net {formatPrice(Math.round(net * 10000) / 10000, currency)} · gross{" "}
            {formatPrice(Math.round((net + (vatValue ?? 0)) * 10000) / 10000, currency)}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="inv-notes">Notes</FieldLabel>
          <Textarea
            id="inv-notes"
            rows={2}
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </div>
    </HaccpDialog>
  );
}
