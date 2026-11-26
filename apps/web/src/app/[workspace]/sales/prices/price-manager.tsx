"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { newId, formatMoney, salesPriceSchema, unitCodes, type UnitCode } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import type { SalesPrice } from "@/lib/api";
import { SalesPicker } from "../sales-picker";
export function PriceManager({
  slug,
  today,
  currency,
  prices,
}: {
  slug: string;
  today: string;
  currency: string;
  prices: SalesPrice[];
}) {
  const router = useRouter(),
    { can } = useWorkspace();
  const [customer, setCustomer] = useState("");
  const [item, setItem] = useState("");
  const [unit, setUnit] = useState<UnitCode>("kg");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [commandId, setCommandId] = useState(newId);
  const [open, setOpen] = useState(false);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const value = (k: string) => String(f.get(k) ?? "");
    const parsed = salesPriceSchema.safeParse({
      commandId,
      customerId: customer,
      itemId: item,
      currency: value("currency"),
      unit: value("unit"),
      unitPrice: Number(value("price")),
      validFrom: value("from"),
      validTo: value("to") || null,
      contractReference: value("reference"),
      terms: value("terms"),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].sales.prices.$post({ param: { slug }, json: parsed.data }),
      );
      setOpen(false);
      setCommandId(newId());
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function archive(id: string, reason: string) {
    setBusy(true);
    setError("");
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].sales.prices[":id"].archive.$post({
          param: { slug, id },
          json: { commandId, reason },
        }),
      );
      setCommandId(newId());
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-3">
        {can("sales", "manage") && <Button onClick={() => setOpen((v) => !v)}>New price agreement</Button>}
      </div>
      {open && (
        <form
          onSubmit={create}
          onChange={() => setCommandId(newId())}
          className="space-y-4 rounded-lg border p-4"
        >
          <h2 className="font-medium">Agree a customer price</h2>
          <fieldset disabled={busy} className="space-y-4">
            <SalesPicker
              slug={slug}
              kind="customers"
              value={customer}
              onChange={(id) => {
                setCustomer(id);
                setCommandId(newId());
              }}
            />
            <SalesPicker
              slug={slug}
              kind="items"
              value={item}
              onChange={(id, _label, row) => {
                setItem(id);
                if (row?.unit) setUnit(row.unit);
                setCommandId(newId());
              }}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-sm">
                Price
                <Input name="price" type="number" min="0" max="99999999" step="0.00000001" required />
              </label>
              <label className="space-y-1 text-sm">
                Per unit
                <select
                  name="unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as UnitCode)}
                  className="h-9 w-full rounded-md border bg-background px-3"
                >
                  {unitCodes.map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                Currency
                <Input name="currency" defaultValue={currency} required maxLength={3} />
              </label>
              <label className="space-y-1 text-sm">
                Valid from
                <Input name="from" type="date" required defaultValue={today} />
              </label>
              <label className="space-y-1 text-sm">
                Valid to (inclusive)
                <Input name="to" type="date" />
              </label>
              <label className="space-y-1 text-sm">
                Contract or agreement reference
                <Input name="reference" maxLength={200} required />
              </label>
            </div>
            <label className="block space-y-1 text-sm">
              Agreed terms
              <Textarea name="terms" maxLength={4000} />
            </label>
          </fieldset>
          <Button disabled={busy}>Sign price agreement</Button>
        </form>
      )}
      {prices.map((p) => (
        <article key={p.id} className="space-y-2 rounded-lg border p-4 text-sm">
          <div className="flex flex-wrap justify-between gap-3">
            <h2 className="font-medium">
              {p.contractReference} · {formatMoney(p.unitPrice, p.currency, { maxDecimals: 8 })} / {p.unit}
            </h2>
            <span>{p.archivedAt ? "Archived" : "Active"}</span>
          </div>
          <p>
            Customer: {p.customerCode} · {p.customerName} · Product: {p.itemCode} · {p.itemName}
          </p>
          <p>
            {p.validFrom} to {p.validTo ?? "open ended"} · {p.currency}
          </p>
          {p.terms && <p className="whitespace-pre-line">{p.terms}</p>}
          {p.archiveReason && <p>Archived: {p.archiveReason}</p>}
          {!p.archivedAt && can("sales", "manage") && (
            <form
              className="flex flex-wrap gap-2"
              onChange={() => setCommandId(newId())}
              onSubmit={(e) => {
                e.preventDefault();
                void archive(p.id, String(new FormData(e.currentTarget).get("reason")));
              }}
            >
              <Input
                name="reason"
                required
                maxLength={2000}
                aria-label={`Archive reason for ${p.contractReference}`}
                placeholder="Reason for ending this agreement"
              />
              <Button variant="outline" disabled={busy}>
                Archive agreement
              </Button>
            </form>
          )}
        </article>
      ))}
      {!prices.length && <p className="text-sm text-muted-foreground">No price agreements yet.</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
