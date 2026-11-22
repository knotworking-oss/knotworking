"use client";

import {
  purchaseCreditLineReasonLabels,
  purchaseCreditLineReasons,
  units,
  type PurchaseCreditLineInput,
  type PurchaseCreditLineReason,
} from "@knotworking/core";
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
import { HaccpDialog } from "@/components/haccp-forms";
import { formatPrice } from "@/components/purchasing-badges";
import { useWorkspaceCurrency } from "@/lib/workspace-time";
import type { PurchaseCreditNoteDetail, PurchaseInvoiceDetail } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { NONE, parseNumber, purchasingApi, type SupplierOption } from "../purchasing-forms";

const CHARGE = "charge";

/** A credit line being entered: against an invoice line (a price reduction, goods returned) or a charge. */
interface DraftLine {
  key: string;
  /** An invoice line id, or `charge`. */
  target: string;
  reason: PurchaseCreditLineReason;
  description: string;
  quantity: string;
  unitPrice: string;
}

let seq = 0;
const key = () => `c${++seq}`;

type InvoiceChoice = { id: string; invoiceNumber: string; supplierName: string };

/**
 * Draft a supplier credit note against an approved invoice, or edit a draft. A line credits an
 * invoice line, either as a price reduction (the credited amount is spread over the quantity
 * invoiced) or for goods returned, or credits a charge such as carriage. A person with manage
 * access approves it afterwards; amounts are positive and subtracted.
 */
export function CreditNoteDialog({
  slug,
  suppliers,
  invoice: given,
  creditNote,
  onClose,
}: {
  slug: string;
  suppliers: SupplierOption[];
  /** Start from this approved invoice (its page). */
  invoice?: { id: string; supplierId: string };
  creditNote?: PurchaseCreditNoteDetail;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  const router = useRouter();
  const today = useWorkspaceToday();
  const [supplierId, setSupplierId] = useState(creditNote?.supplierId ?? given?.supplierId ?? "");
  const [invoiceId, setInvoiceId] = useState(creditNote?.invoiceId ?? given?.id ?? "");
  const [number, setNumber] = useState(creditNote?.creditNoteNumber ?? "");
  const [creditDate, setCreditDate] = useState(creditNote?.creditDate ?? today);
  const [vat, setVat] = useState(creditNote ? String(creditNote.vat) : "0");
  const [notes, setNotes] = useState(creditNote?.notes ?? "");
  const [lines, setLines] = useState<DraftLine[]>(
    creditNote
      ? creditNote.lines.map((l) => ({
          key: key(),
          target: l.kind === "charge" || !l.invoiceLine ? CHARGE : l.invoiceLine.id,
          reason: l.reason ?? "price",
          description: l.description ?? "",
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
        }))
      : [],
  );
  const [invoices, setInvoices] = useState<InvoiceChoice[]>([]);
  const [invoiceDetail, setInvoiceDetail] = useState<PurchaseInvoiceDetail | null>(null);
  const locked = Boolean(creditNote || given);

  // The supplier's approved invoices to credit.
  useEffect(() => {
    if (!supplierId || locked) return setInvoices([]);
    let live = true;
    void unwrap(
      purchasingApi().invoices.$get({
        param: { slug },
        query: { supplierId, status: "approved", limit: "200" },
      }),
    )
      .then((r) => {
        if (live)
          setInvoices(
            r.invoices.map((i) => ({
              id: i.id,
              invoiceNumber: i.invoiceNumber,
              supplierName: i.supplier.name,
            })),
          );
      })
      .catch(() => live && setInvoices([]));
    return () => {
      live = false;
    };
  }, [slug, supplierId, locked]);

  // The credited invoice's lines.
  useEffect(() => {
    if (!invoiceId) return setInvoiceDetail(null);
    let live = true;
    void unwrap(purchasingApi().invoices[":id"].$get({ param: { slug, id: invoiceId } }))
      .then((r) => live && setInvoiceDetail(r))
      .catch(() => live && setInvoiceDetail(null));
    return () => {
      live = false;
    };
  }, [slug, invoiceId]);

  const invoiceLines = invoiceDetail?.lines ?? [];
  const orderLines = invoiceLines.filter((l) => l.kind === "order");
  const target = (id: string) => invoiceLines.find((l) => l.id === id);
  const update = (k: string, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  const parsed = lines.map((l) => ({
    line: l,
    quantity: parseNumber(l.quantity),
    unitPrice: parseNumber(l.unitPrice),
  }));
  const invalid =
    parsed.length === 0 ||
    parsed.some(
      (p) =>
        p.quantity === null ||
        p.quantity <= 0 ||
        p.unitPrice === null ||
        p.unitPrice < 0 ||
        (p.line.target === CHARGE ? !p.line.description.trim() : !target(p.line.target)),
    );
  const net = parsed.reduce((sum, p) => sum + (p.quantity ?? 0) * (p.unitPrice ?? 0), 0);
  const vatValue = parseNumber(vat);
  const requestLines = () =>
    parsed.map(({ line, quantity, unitPrice }): PurchaseCreditLineInput =>
      line.target === CHARGE
        ? { kind: "charge", description: line.description.trim(), quantity: quantity!, unitPrice: unitPrice! }
        : {
            kind: "invoice_line",
            invoiceLineId: line.target,
            reason: line.reason,
            quantity: quantity!,
            unitPrice: unitPrice!,
          },
    );

  return (
    <HaccpDialog
      wide
      title={creditNote ? `Edit credit note ${creditNote.creditNoteNumber}` : "Draft a credit note"}
      description="A draft until a person with manage access approves it. Approved credit notes lower the cost of the lots received against the credited lines; a wrong one is voided and entered again."
      submitLabel="Save draft"
      disabled={!invoiceId || !number.trim() || !creditDate || invalid || vatValue === null || vatValue < 0}
      onClose={onClose}
      onSubmit={async () => {
        const common = {
          creditNoteNumber: number.trim(),
          creditDate,
          vat: vatValue ?? 0,
          notes: notes.trim() || null,
          lines: requestLines(),
        };
        if (creditNote) {
          await unwrap(
            purchasingApi()["credit-notes"][":id"].$patch({
              param: { slug, id: creditNote.id },
              json: common,
            }),
          );
          return `Credit note ${creditNote.creditNoteNumber} saved`;
        }
        const created = await unwrap(
          purchasingApi()["credit-notes"].$post({ param: { slug }, json: { ...common, invoiceId } }),
        );
        router.push(`/${slug}/purchasing/credit-notes/${created.id}`);
        return `Credit note ${created.creditNoteNumber} drafted`;
      }}
    >
      {!locked && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="cn-supplier">Supplier</FieldLabel>
            <Select
              value={supplierId || NONE}
              onValueChange={(v) => {
                setSupplierId(v === NONE ? "" : v);
                setInvoiceId("");
                setLines([]);
              }}
            >
              <SelectTrigger id="cn-supplier">
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
            <FieldLabel htmlFor="cn-invoice">Invoice credited</FieldLabel>
            <Select
              value={invoiceId || NONE}
              disabled={!supplierId}
              onValueChange={(v) => {
                setInvoiceId(v === NONE ? "" : v);
                setLines([]);
              }}
            >
              <SelectTrigger id="cn-invoice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={NONE} disabled>
                    {supplierId
                      ? invoices.length
                        ? "Choose an invoice"
                        : "No approved invoices"
                      : "Choose a supplier first"}
                  </SelectItem>
                  {invoices.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.invoiceNumber}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      {locked && invoiceDetail && (
        <p className="text-sm text-muted-foreground">
          Against invoice {invoiceDetail.invoiceNumber} from {invoiceDetail.supplier.name}.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="cn-number">Supplier&apos;s credit note number</FieldLabel>
          <Input
            id="cn-number"
            required
            maxLength={60}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cn-date">Credit date</FieldLabel>
          <Input
            id="cn-date"
            type="date"
            required
            value={creditDate}
            onChange={(e) => setCreditDate(e.target.value)}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel>Lines</FieldLabel>
        <FieldDescription>
          Credit an invoice line as a price reduction (the amount credited per unit invoiced) or as goods
          returned (units sent back, at the price credited), or credit a charge. Quantities and prices are per
          the invoice line&apos;s unit; a line can&apos;t credit more than the invoice billed.
        </FieldDescription>
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={!invoiceId}
            onClick={() => {
              const first = orderLines[0];
              setLines((current) => [
                ...current,
                first
                  ? {
                      key: key(),
                      target: first.id,
                      reason: "price",
                      description: "",
                      quantity: String(first.quantity),
                      unitPrice: "",
                    }
                  : {
                      key: key(),
                      target: CHARGE,
                      reason: "price",
                      description: "Carriage",
                      quantity: "1",
                      unitPrice: "",
                    },
              ]);
            }}
          >
            <Plus data-icon="inline-start" /> Add a line
          </Button>
        </div>
        {lines.length > 0 && (
          <div className="flex flex-col gap-2">
            {lines.map((l) => {
              const inv = target(l.target);
              return (
                <div key={l.key} className="grid items-end gap-2 rounded-md border p-2 sm:grid-cols-6">
                  <div className="flex flex-col gap-1 sm:col-span-2">
                    <Select
                      value={l.target}
                      onValueChange={(v) => {
                        const next = target(v);
                        update(l.key, {
                          target: v,
                          ...(next && !l.quantity ? { quantity: String(next.quantity) } : {}),
                        });
                      }}
                    >
                      <SelectTrigger aria-label="Credits" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {orderLines.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                              {o.item ? `${o.item.code} ${o.item.name}` : "Item"} (line {o.lineNo})
                            </SelectItem>
                          ))}
                          <SelectItem value={CHARGE}>A charge (carriage)</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {inv && (
                      <span className="text-xs text-muted-foreground">
                        Invoiced {inv.quantity} {inv.unit ? units[inv.unit].label : ""} ×{" "}
                        {formatPrice(inv.unitPrice, currency)}
                      </span>
                    )}
                  </div>
                  {l.target === CHARGE ? (
                    <Input
                      aria-label="Charge credited"
                      className="sm:col-span-1"
                      maxLength={200}
                      value={l.description}
                      onChange={(e) => update(l.key, { description: e.target.value })}
                    />
                  ) : (
                    <Select
                      value={l.reason}
                      onValueChange={(v) => {
                        const reason = v as PurchaseCreditLineReason;
                        update(l.key, {
                          reason,
                          ...(reason === "goods_returned" && !l.unitPrice && inv
                            ? { unitPrice: String(inv.unitPrice) }
                            : {}),
                        });
                      }}
                    >
                      <SelectTrigger aria-label="Reason" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {purchaseCreditLineReasons.map((r) => (
                            <SelectItem key={r} value={r}>
                              {purchaseCreditLineReasonLabels[r]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    aria-label="Quantity"
                    inputMode="decimal"
                    placeholder="Quantity"
                    value={l.quantity}
                    onChange={(e) => update(l.key, { quantity: e.target.value })}
                  />
                  <Input
                    aria-label="Credited per unit"
                    inputMode="decimal"
                    placeholder="Credited per unit"
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
              );
            })}
          </div>
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="cn-vat">VAT credited</FieldLabel>
          <Input id="cn-vat" inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
          <FieldDescription>
            Net {formatPrice(Math.round(net * 100) / 100, currency)} · gross{" "}
            {formatPrice(Math.round((net + (vatValue ?? 0)) * 100) / 100, currency)}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="cn-notes">Notes</FieldLabel>
          <Textarea
            id="cn-notes"
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
