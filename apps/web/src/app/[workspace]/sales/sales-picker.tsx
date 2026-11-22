"use client";
import { useState } from "react";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
/** Search is bounded and shows the total: a large register is never silently an incomplete picker. */
export function SalesPicker({
  slug,
  kind,
  value,
  label,
  onChange,
  disabled = false,
}: {
  slug: string;
  kind: "customers" | "items";
  value: string;
  label?: string;
  onChange: (id: string, label: string) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ id: string; code: string; name: string }[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function search() {
    setBusy(true);
    setError("");
    try {
      const api = browserApi().v1.workspaces[":slug"];
      if (kind === "customers") {
        const r = await unwrap(
          api.customers.$get({ param: { slug }, query: { q, status: "active", limit: "50" } }),
        );
        setRows(r.customers);
        setTotal(r.total);
      } else {
        const r = await unwrap(
          api.items.$get({ param: { slug }, query: { q, status: "active", limit: "50" } }),
        );
        setRows(r.items.filter((i) => ["finished", "wip"].includes(i.type)));
        setTotal(r.total);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label={`Find ${kind}`}
          placeholder={`Find ${kind} by name or code`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
        />
        <Button type="button" variant="outline" onClick={() => void search()} disabled={busy || disabled}>
          Find
        </Button>
      </div>
      <select
        aria-label={kind === "customers" ? "Customer" : "Product"}
        required
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const r = rows.find((r) => r.id === e.target.value);
          onChange(e.target.value, r ? `${r.code} · ${r.name}` : (label ?? ""));
        }}
        className="h-9 w-full rounded-md border bg-background px-3"
      >
        <option value="">Choose {kind === "customers" ? "customer" : "product"}</option>
        {value && !rows.some((r) => r.id === value) && <option value={value}>{label ?? value}</option>}
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.code} · {r.name}
          </option>
        ))}
      </select>
      {total !== null && (
        <p className="text-xs text-muted-foreground">
          {total} matches. Showing up to 50; refine your search
          {kind === "items" ? ". Only finished and WIP products can be sold" : ""}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
