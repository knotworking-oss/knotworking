"use client";

import { unitCodes, type DeliverySite, type UnitCode, isDespatchableItem } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Customer, Despatch, StockLot } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

type Line = { lotId: string; locationId: string; label: string; quantity: string; unit: UnitCode };
export function DespatchEditor({
  slug,
  today,
  initial,
}: {
  slug: string;
  today: string;
  initial?: Despatch;
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState<{ id: string; name: string; address: string } | null>(
    initial ? { id: initial.customerId, name: initial.customerName, address: initial.customerAddress } : null,
  );
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerTotal, setCustomerTotal] = useState(0);
  const [sites, setSites] = useState<DeliverySite[]>([]);
  const [siteId, setSiteId] = useState(initial?.deliverySiteId ?? "");
  async function loadSites(id: string) {
    try {
      const result = await unwrap(ws().customers[":id"].sites.$get({ param: { slug, id } }));
      setSites(result.sites.filter((s) => s.status === "active"));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const [address, setAddress] = useState(initial?.deliveryAddress ?? "");
  const [lotQuery, setLotQuery] = useState("");
  const [lots, setLots] = useState<StockLot[]>([]);
  const [lotTotal, setLotTotal] = useState(0);
  const [lines, setLines] = useState<Line[]>(
    initial?.lines.map((l) => ({
      lotId: l.lotId,
      locationId: l.locationId,
      label: `${l.itemCode} · ${l.lotCode} · ${l.locationName}`,
      quantity: String(l.amount.display),
      unit: l.itemUnit,
    })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ws = () => browserApi().v1.workspaces[":slug"];
  async function search(kind: "customers" | "lots") {
    setBusy(true);
    setError("");
    try {
      if (kind === "customers") {
        const page = await unwrap(
          ws().customers.$get({
            param: { slug },
            query: { q: customerQuery, limit: "50", status: "active" },
          }),
        );
        setCustomers(page.customers);
        setCustomerTotal(page.total);
      } else {
        const page = await unwrap(
          ws().stock.lots.$get({ param: { slug }, query: { q: lotQuery, status: "available", limit: "50" } }),
        );
        setLots(
          page.lots.filter(
            (l) =>
              isDespatchableItem(l.item.type) &&
              l.item.status === "active" &&
              (!l.expiresOn || l.expiresOn >= today),
          ),
        );
        setLotTotal(page.total);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  function addLine(lot: StockLot, locationId: string, locationName: string) {
    if (lines.some((l) => l.lotId === lot.id && l.locationId === locationId)) {
      toast.error("This lot and location are already on the despatch");
      return;
    }
    setLines([
      ...lines,
      {
        lotId: lot.id,
        locationId,
        label: `${lot.item.code} · ${lot.lotCode} · ${locationName}`,
        quantity: "",
        unit: lot.item.unit,
      },
    ]);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!customer) {
      setError("Choose a customer");
      return;
    }
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const json = {
      customerId: customer.id,
      deliverySiteId: siteId || null,
      deliveryAddress: address,
      despatchedOn: String(f.get("despatchedOn")),
      externalReference: String(f.get("externalReference") ?? "") || null,
      notes: String(f.get("notes") ?? "") || null,
      lines: lines.map(({ lotId, locationId, quantity, unit }) => ({
        lotId,
        locationId,
        quantity: Number(quantity),
        unit,
      })),
    };
    try {
      const result = initial
        ? await unwrap(ws().despatch[":id"].$put({ param: { slug, id: initial.id }, json }))
        : await unwrap(ws().despatch.$post({ param: { slug }, json }));
      toast.success("Draft saved");
      router.push(`/${slug}/despatch/${result.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex-1 overflow-y-auto">
      <form onSubmit={submit} className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6">
        <Link href={`/${slug}/despatch`} className="text-sm text-muted-foreground hover:underline">
          Back to despatches
        </Link>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="mb-2 font-medium">Customer</legend>
          <label className="text-sm">
            Find by business name or code
            <div className="mt-1 flex gap-2">
              <Input
                value={customerQuery}
                maxLength={200}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Customer name or code"
              />
              <Button type="button" variant="outline" onClick={() => void search("customers")}>
                Find customers
              </Button>
            </div>
          </label>
          <div className="flex flex-wrap gap-2">
            {customers.map((c) => (
              <Button
                type="button"
                key={c.id}
                variant={customer?.id === c.id ? "default" : "outline"}
                onClick={() => {
                  setCustomer(c);
                  setAddress(c.address);
                  setSiteId("");
                  setSites([]);
                  void loadSites(c.id);
                }}
              >
                {c.code} · {c.name}
              </Button>
            ))}
          </div>
          {customerTotal > 50 && (
            <p className="text-xs text-muted-foreground">
              Showing the first 50 matches. Refine your search for more.
            </p>
          )}
          {customer ? (
            <p className="text-sm">
              Selected: <strong>{customer.name}</strong>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Choose a customer before saving. New accounts can be added under Customers.
            </p>
          )}
          {customer && (
            <div className="space-y-2">
              <label htmlFor="delivery-site" className="text-sm">
                Delivery site
              </label>
              <select
                id="delivery-site"
                className="block w-full rounded-md border bg-background p-2 text-sm"
                value={siteId}
                onChange={(e) => {
                  setSiteId(e.target.value);
                  setAddress(sites.find((s) => s.id === e.target.value)?.address ?? customer.address);
                }}
              >
                <option value="">Account address / custom delivery address</option>
                {siteId && !sites.some((s) => s.id === siteId) && (
                  <option value={siteId}>{initial?.deliverySiteName ?? "Current selected site"}</option>
                )}
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-3">
                <Button type="button" size="sm" variant="outline" onClick={() => void loadSites(customer.id)}>
                  Load delivery sites
                </Button>
                <Link className="text-sm underline" href={`/${slug}/customers/${customer.id}/sites`}>
                  Manage delivery sites
                </Link>
              </div>
            </div>
          )}
          <label className="block space-y-1 text-sm">
            Delivery address
            <Textarea
              aria-label="Delivery address"
              readOnly={!!siteId}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={2000}
              required
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              Despatch date
              <Input type="date" name="despatchedOn" defaultValue={initial?.despatchedOn ?? today} required />
            </label>
            <label className="space-y-1 text-sm">
              Customer order / external reference
              <Input
                name="externalReference"
                maxLength={200}
                defaultValue={initial?.externalReference ?? ""}
              />
            </label>
          </div>
        </fieldset>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="mb-2 font-medium">Lots to despatch</legend>
          <label className="text-sm">
            Find by lot code
            <div className="mt-1 flex gap-2">
              <Input
                value={lotQuery}
                maxLength={200}
                onChange={(e) => setLotQuery(e.target.value)}
                placeholder="Lot code"
              />
              <Button type="button" variant="outline" onClick={() => void search("lots")}>
                Find lots
              </Button>
            </div>
          </label>
          <p className="text-xs text-muted-foreground">
            Only released, unexpired finished goods, merchandise and spare parts are shown. Available stock
            and production reservations are checked again when confirming.
          </p>
          {lotTotal > 50 && (
            <p className="text-xs text-muted-foreground">
              First 50 matching lots searched. Refine the lot code if your product is missing.
            </p>
          )}
          <ul className="space-y-2">
            {lots.map((lot) => (
              <li key={lot.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">
                  {lot.item.name} · {lot.lotCode}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {lot.balances
                    .filter((b) => b.amount.base > 0)
                    .map((b) => (
                      <Button
                        key={b.locationId}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={lines.length >= 100}
                        onClick={() => addLine(lot, b.locationId, b.locationName)}
                      >
                        {b.locationName}: {b.amount.display} {b.amount.displayUnit} — Add
                      </Button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
          {!lines.length && (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              Search for a lot and add stock from a location.
            </p>
          )}
          {lines.map((line, i) => (
            <div
              key={`${line.lotId}:${line.locationId}`}
              className="flex flex-wrap items-end gap-3 rounded-md border p-3"
            >
              <p className="w-full text-sm font-medium">{line.label}</p>
              <label className="flex-1 space-y-1 text-sm">
                Quantity
                <Input
                  type="number"
                  min="0.0001"
                  step="any"
                  required
                  value={line.quantity}
                  onChange={(e) =>
                    setLines(lines.map((l, n) => (n === i ? { ...l, quantity: e.target.value } : l)))
                  }
                />
              </label>
              <label className="space-y-1 text-sm">
                Unit
                <select
                  value={line.unit}
                  onChange={(e) =>
                    setLines(lines.map((l, n) => (n === i ? { ...l, unit: e.target.value as UnitCode } : l)))
                  }
                  className="block h-9 rounded-md border bg-background px-3"
                >
                  {unitCodes.map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                onClick={() => setLines(lines.filter((_, n) => n !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
        </fieldset>
        <label className="space-y-1 text-sm">
          Notes
          <Textarea name="notes" defaultValue={initial?.notes ?? ""} maxLength={4000} disabled={busy} />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button disabled={busy || !customer || !lines.length}>{busy ? "Saving…" : "Save draft"}</Button>
        </div>
      </form>
    </div>
  );
}
