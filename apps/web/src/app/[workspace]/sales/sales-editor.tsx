"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { newId, salesDocumentSchema, unitCodes, type SalesDocumentInput } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import type { SalesOrder } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-store";
import { SalesPicker } from "./sales-picker";
type EditLine = {
  key: string;
  id?: string;
  itemId: string;
  label: string;
  quantity: string;
  unit: (typeof unitCodes)[number];
  dueOn: string;
  unitPrice: string;
  note: string;
};
export function SalesEditor({
  slug,
  today,
  currency,
  order,
}: {
  slug: string;
  today: string;
  currency: string;
  order?: SalesOrder;
}) {
  const router = useRouter(),
    { can } = useWorkspace();
  const [kind, setKind] = useState<"quote" | "order">(order?.kind ?? "order");
  const [customerId, setCustomer] = useState(order?.customerId ?? "");
  const [customerLabel, setCustomerLabel] = useState(
    order ? `${order.recipient.code} · ${order.recipient.name}` : "",
  );
  const [sites, setSites] = useState<{ id: string; code: string; name: string }[]>([]);
  const [siteId, setSite] = useState(order?.deliverySiteId ?? "");
  const blank = (): EditLine => ({
    key: newId(),
    itemId: "",
    label: "",
    quantity: "",
    unit: "kg",
    dueOn: today,
    unitPrice: "",
    note: "",
  });
  const [lines, setLines] = useState<EditLine[]>(
    () =>
      order?.lines.map((l) => ({
        key: l.id,
        id: l.id,
        itemId: l.itemId,
        label: `${l.itemCode} · ${l.itemName}`,
        quantity: String(l.quantity),
        unit: l.unit,
        dueOn: l.dueOn,
        unitPrice: String(l.unitPrice),
        note: l.note,
      })) ?? [blank()],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [commandId, setCommandId] = useState(newId);
  const amend = order?.status === "confirmed";
  const allowed = amend ? can("sales", "manage") : can("sales", "write");
  function patch(key: string, patch: Partial<EditLine>) {
    setLines((v) => v.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setCommandId(newId());
  }
  async function loadSites(id: string) {
    try {
      const r = await unwrap(
        browserApi().v1.workspaces[":slug"].customers[":id"].sites.$get({ param: { slug, id } }),
      );
      setSites(r.sites.filter((s) => s.status === "active"));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "");
    const parsed = salesDocumentSchema.safeParse({
      customerId,
      deliverySiteId: siteId || null,
      customerReference: text("reference"),
      currency: text("currency"),
      validUntil: text("validUntil") || null,
      terms: text("terms"),
      notes: text("notes"),
      lines: lines.map((l) => ({
        ...(l.id ? { id: l.id } : {}),
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unit: l.unit,
        dueOn: l.dueOn,
        ...(l.unitPrice !== "" ? { unitPrice: Number(l.unitPrice) } : {}),
        note: l.note,
      })),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      setBusy(false);
      return;
    }
    try {
      const api = browserApi().v1.workspaces[":slug"].sales.orders;
      const json = {
        commandId,
        expectedRevision: order?.revision ?? 1,
        document: parsed.data,
        reason: text("reason") || "Draft entered",
      };
      const result = order
        ? await unwrap(
            amend
              ? api[":id"].amend.$post({ param: { slug, id: order.id }, json })
              : api[":id"].$put({ param: { slug, id: order.id }, json }),
          )
        : await unwrap(api.$post({ param: { slug }, json: { commandId, kind, document: parsed.data } }));
      router.push(`/${slug}/sales/${result.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!allowed)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Sales {amend ? "manage" : "write"} access is required.
      </p>
    );
  return (
    <form
      onSubmit={submit}
      onChange={() => setCommandId(newId())}
      className="mx-auto w-full max-w-5xl space-y-6 p-6"
    >
      <h1 className="text-xl font-medium">
        {order ? `${amend ? "Amend" : "Edit"} ${order.reference}` : "New quote or order"}
      </h1>
      {amend && (
        <p className="text-sm text-muted-foreground">
          An amendment preserves the preceding signed revision. Customer, site, currency and linked line units
          stay fixed.
        </p>
      )}
      <fieldset disabled={busy} className="space-y-5">
        {!order && (
          <label className="block space-y-1 text-sm">
            Type
            <select
              aria-label="Document type"
              value={kind}
              onChange={(e) => setKind(e.target.value as "quote" | "order")}
              className="block h-9 rounded-md border bg-background px-3"
            >
              <option value="order">Order</option>
              <option value="quote">Quote</option>
            </select>
          </label>
        )}
        <SalesPicker
          slug={slug}
          kind="customers"
          value={customerId}
          label={customerLabel}
          disabled={!!amend}
          onChange={(id, label) => {
            setCustomer(id);
            setCustomerLabel(label);
            setSite("");
            void loadSites(id);
          }}
        />
        <label className="block space-y-1 text-sm">
          Delivery site
          <div className="flex gap-2">
            <select
              aria-label="Delivery site"
              value={siteId}
              onChange={(e) => setSite(e.target.value)}
              disabled={!!amend}
              className="h-9 flex-1 rounded-md border bg-background px-3"
            >
              <option value="">Customer address</option>
              {siteId && !sites.some((s) => s.id === siteId) && (
                <option value={siteId}>{order?.recipient.deliverySiteName ?? siteId}</option>
              )}
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
            {customerId && !amend && (
              <Button type="button" variant="outline" onClick={() => void loadSites(customerId)}>
                Load sites
              </Button>
            )}
          </div>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            Customer reference
            <Input name="reference" maxLength={120} defaultValue={order?.customerReference} />
          </label>
          <label className="space-y-1 text-sm">
            Currency
            <Input
              name="currency"
              maxLength={3}
              required
              readOnly={!!amend}
              defaultValue={order?.currency ?? currency}
            />
          </label>
          {kind === "quote" && (
            <label className="space-y-1 text-sm">
              Valid until
              <Input type="date" name="validUntil" defaultValue={order?.validUntil ?? ""} />
            </label>
          )}
        </div>
        <div className="space-y-4">
          {lines.map((l, index) => (
            <fieldset key={l.key} className="space-y-3 rounded-lg border p-4">
              <legend className="px-1 text-sm font-medium">Line {index + 1}</legend>
              <SalesPicker
                slug={slug}
                kind="items"
                value={l.itemId}
                label={l.label}
                onChange={(itemId, label) => patch(l.key, { itemId, label })}
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="space-y-1 text-sm">
                  Quantity
                  <Input
                    aria-label={`Quantity line ${index + 1}`}
                    type="number"
                    min="0.0001"
                    max="1000000000"
                    step="0.0001"
                    required
                    value={l.quantity}
                    onChange={(e) => patch(l.key, { quantity: e.target.value })}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  Unit
                  <select
                    aria-label={`Unit line ${index + 1}`}
                    value={l.unit}
                    onChange={(e) => patch(l.key, { unit: e.target.value as EditLine["unit"] })}
                    className="h-9 w-full rounded-md border bg-background px-3"
                  >
                    {unitCodes.map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  Delivery date
                  <Input
                    type="date"
                    required
                    value={l.dueOn}
                    onChange={(e) => patch(l.key, { dueOn: e.target.value })}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  Price per unit
                  <Input
                    aria-label={`Price line ${index + 1}`}
                    type="number"
                    min="0"
                    max="99999999"
                    step="0.00000001"
                    placeholder="Use agreement"
                    value={l.unitPrice}
                    onChange={(e) => patch(l.key, { unitPrice: e.target.value })}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave price blank to use the customer agreement valid on the delivery date. Zero means free of
                charge. Prices exclude tax.
              </p>
              <label className="block space-y-1 text-sm">
                Line note
                <Input
                  maxLength={500}
                  value={l.note}
                  onChange={(e) => patch(l.key, { note: e.target.value })}
                />
              </label>
              {lines.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLines((v) => v.filter((x) => x.key !== l.key));
                    setCommandId(newId());
                  }}
                >
                  Remove line {index + 1}
                </Button>
              )}
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={lines.length >= 200}
            onClick={() => setLines((v) => [...v, blank()])}
          >
            Add line
          </Button>
        </div>
        <label className="block space-y-1 text-sm">
          Commercial terms
          <Textarea name="terms" maxLength={4000} defaultValue={order?.terms} />
        </label>
        <label className="block space-y-1 text-sm">
          Internal notes
          <Textarea name="notes" maxLength={4000} defaultValue={order?.notes} />
        </label>
        {order && (
          <label className="block space-y-1 text-sm">
            Reason for {amend ? "amendment" : "edit"}
            <Input name="reason" required maxLength={2000} />
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy}>{busy ? "Saving…" : amend ? "Sign amendment" : "Save draft"}</Button>
    </form>
  );
}
