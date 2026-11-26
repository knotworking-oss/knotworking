"use client";

import {
  addDays,
  invoiceDecisionSchema,
  invoiceDraftSchema,
  invoiceEditSchema,
  newId,
  supportedCurrencies,
  type InvoiceManualLine,
} from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { CustomerDocument } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { SalesPicker } from "../sales/sales-picker";

const api = () => browserApi().v1.workspaces[":slug"].invoicing;

/** The seller's tax registration number, snapshotted onto documents drafted afterwards. */
export function InvoicingSettingsForm({
  slug,
  taxRegistrationNumber,
}: {
  slug: string;
  taxRegistrationNumber: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(taxRegistrationNumber ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      await unwrap(
        api().settings.$put({ param: { slug }, json: { taxRegistrationNumber: value.trim() || null } }),
      );
      setMessage("Saved. New drafts will show this number.");
      router.refresh();
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3 rounded-lg border p-3 text-sm">
      <label className={field}>
        Your tax registration number
        <Input value={value} maxLength={40} onChange={(e) => setValue(e.target.value)} />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Save
      </Button>
      <p className="w-full text-xs text-muted-foreground" role="status">
        {message || "Optional. Printed on invoices and credit notes drafted after you save it."}
      </p>
    </form>
  );
}
const blank = () => ({ id: newId(), description: "", unit: "", quantity: "1", unitPrice: "", taxRate: "0" });
const field = "grid gap-1.5 text-sm";
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

export function InvoiceEditor({
  slug,
  today,
  currency,
  doc,
  source,
}: {
  slug: string;
  today: string;
  currency: string;
  doc?: CustomerDocument;
  source?: { kind: "sales" | "despatch" | "service"; id: string };
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState({ id: "", label: "" });
  const [lines, setLines] = useState(
    () =>
      doc?.lines.map((line) => ({
        ...line,
        unitPrice: line.pricePending ? "" : line.unitPrice,
        taxRate: line.taxPending ? "" : String(line.taxRate),
      })) ?? [blank()],
  );
  const [commandId] = useState(newId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const manual = doc ? doc.source === "manual" : !source;
  function update<K extends keyof InvoiceManualLine>(id: string, key: K, value: string) {
    setLines((before) => before.map((line) => (line.id === id ? { ...line, [key]: value } : line)));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dates = {
      date: form.get("date"),
      dueDate: form.get("dueDate"),
      issuerAddress: form.get("issuerAddress"),
    };
    const priced = lines.map(({ description, unit, quantity, unitPrice, taxRate }) => ({
      description,
      unit,
      quantity,
      unitPrice,
      taxRate: Number(taxRate),
    }));
    setError("");
    setPending(true);
    try {
      if (doc) {
        const parsed = invoiceEditSchema.safeParse({
          commandId,
          expectedRevision: doc.revision,
          ...dates,
          ...(manual
            ? { lines: priced }
            : {
                pricing: lines.map((line) => ({
                  id: line.id,
                  unitPrice: line.unitPrice,
                  taxRate: Number(line.taxRate),
                })),
              }),
        });
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the draft details");
        await unwrap(api()[":id"].$patch({ param: { slug, id: doc.id }, json: parsed.data }));
        router.refresh();
      } else {
        const data = source
          ? { kind: source.kind, sourceId: source.id }
          : {
              kind: "manual",
              customerId: customer.id,
              currency: form.get("currency"),
              lines: priced,
            };
        const parsed = invoiceDraftSchema.safeParse({ ...data, commandId, ...dates });
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the invoice details");
        const created = await unwrap(api().$post({ param: { slug }, json: parsed.data }));
        router.push(`/${slug}/invoicing/${created.id}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="space-y-4 rounded-lg border p-4" onSubmit={submit}>
      <fieldset className="space-y-4" disabled={pending}>
        {!doc && !source && (
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <div className={field}>
              <span>Customer</span>
              <SalesPicker
                slug={slug}
                kind="customers"
                value={customer.id}
                label={customer.label}
                onChange={(id, label) => setCustomer({ id, label })}
              />
            </div>
            <label className={field}>
              Currency
              <select name="currency" className={selectClass} defaultValue={currency}>
                {supportedCurrencies().map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>
            Invoice date
            <Input type="date" name="date" required defaultValue={doc?.date ?? today} />
          </label>
          <label className={field}>
            Due date
            <Input type="date" name="dueDate" required defaultValue={doc?.dueDate ?? addDays(today, 30)} />
          </label>
        </div>
        <label className={field}>
          Issuer address{" "}
          <Textarea name="issuerAddress" rows={2} maxLength={600} defaultValue={doc?.issuer.address} />
        </label>
        {source && (
          <p className="text-sm text-muted-foreground">
            Review billable lines, prices and tax after creating the draft.
          </p>
        )}
        {(doc || !source) && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium">Invoice lines</h2>
            {lines.map((line, i) => (
              <fieldset key={line.id} className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm">Line {i + 1}</legend>
                {manual ? (
                  <label className={field}>
                    Description
                    <Input
                      required
                      maxLength={200}
                      value={line.description}
                      onChange={(e) => update(line.id, "description", e.target.value)}
                    />
                  </label>
                ) : (
                  <p className="text-sm">
                    {line.description} · {line.quantity} {line.unit}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-4">
                  {manual && (
                    <>
                      <label className={field}>
                        Quantity
                        <Input
                          type="number"
                          min="0.00000001"
                          step="any"
                          required
                          value={line.quantity}
                          onChange={(e) => update(line.id, "quantity", e.target.value)}
                        />
                      </label>
                      <label className={field}>
                        Unit
                        <Input
                          maxLength={24}
                          value={line.unit}
                          onChange={(e) => update(line.id, "unit", e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <label className={field}>
                    Unit price
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={line.unitPrice}
                      readOnly={doc?.lines.find((entry) => entry.id === line.id)?.priceLocked}
                      onChange={(e) => update(line.id, "unitPrice", e.target.value)}
                    />
                  </label>
                  <label className={field}>
                    Tax rate (%)
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      step="0.0001"
                      required
                      value={line.taxRate}
                      onChange={(e) => update(line.id, "taxRate", e.target.value)}
                    />
                  </label>
                </div>
                {manual && lines.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLines((before) => before.filter((item) => item.id !== line.id))}
                  >
                    Remove line
                  </Button>
                )}
              </fieldset>
            ))}
            {manual && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={lines.length >= 500}
                onClick={() => setLines((before) => [...before, blank()])}
              >
                Add line
              </Button>
            )}
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : doc ? "Save changes" : "Create draft"}
      </Button>
    </form>
  );
}

export function InvoiceApproval({ doc, slug }: { doc: CustomerDocument; slug: string }) {
  const router = useRouter();
  const [commandId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const input = invoiceDecisionSchema.parse({
        commandId,
        expectedRevision: doc.revision,
        action,
        reason: data.get("reason"),
      });
      await unwrap(api()[":id"].decision.$post({ param: { slug, id: doc.id }, json: input }));
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const kind = doc.kind === "credit" ? "credit note" : "invoice";
  return (
    <form className="space-y-3 rounded-lg border p-4" onSubmit={submit}>
      {doc.warnings.map((warning) => (
        <Alert key={warning.code}>
          <TriangleAlert />
          <AlertDescription>
            This {kind} is dated {doc.date}, before {warning.latestNumber} ({warning.latestDate}). Issuing it
            still gives it the next number, so numbers will not follow date order. Check the date before you
            approve it.
          </AlertDescription>
        </Alert>
      ))}
      <label className={field}>
        Decision reason
        <Textarea name="reason" required maxLength={2000} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy} value="issue">
          Approve and issue
        </Button>
        <Button type="submit" variant="outline" disabled={busy} value="discard">
          Discard draft
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function CreditDraft({ doc, slug, today }: { doc: CustomerDocument; slug: string; today: string }) {
  const router = useRouter();
  const [commandId] = useState(newId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const parsed = invoiceDraftSchema.safeParse({
        kind: "credit",
        commandId,
        sourceId: doc.id,
        date: data.get("date"),
        lineIds: data.getAll("line"),
        reason: data.get("reason"),
      });
      if (!parsed.success) throw new Error("Choose at least one invoice line and enter a date and reason.");
      const draft = await unwrap(api().$post({ param: { slug }, json: parsed.data }));
      router.push(`/${slug}/invoicing/${draft.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">Draft credit note</summary>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <label className={field}>
          Credit note date
          <Input name="date" type="date" min={doc.date} defaultValue={today} required />
        </label>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Invoice lines to credit in full</legend>
          {doc.lines.map((line) => (
            <label key={line.id} className="flex gap-2 text-sm">
              <input
                name="line"
                value={line.id}
                type="checkbox"
                disabled={doc.creditedLineIds.includes(line.id)}
              />
              {line.description} · {doc.currency} {line.net} net
              {doc.creditedLineIds.includes(line.id) && (
                <span className="text-muted-foreground">(already reserved)</span>
              )}
            </label>
          ))}
        </fieldset>
        <label className={field}>
          Reason for correction
          <Textarea name="reason" maxLength={2000} required />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          Create credit draft
        </Button>
      </form>
    </details>
  );
}
