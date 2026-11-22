"use client";
import { useState } from "react";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
type Kind = "supplier" | "asset" | "staff" | "contractor" | "assessment" | "course" | "task";
export function HsePicker({
  slug,
  kind,
  label,
  value,
  onChange,
  required = false,
}: {
  slug: string;
  kind: Kind;
  label: string;
  value: string;
  onChange: (id: string) => void;
  required?: boolean;
}) {
  const [rows, setRows] = useState<{ id: string; name: string }[]>([]),
    [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0);
  async function load(next = 0) {
    setBusy(true);
    setError("");
    try {
      const api = browserApi().v1.workspaces[":slug"];
      let rows: { id: string; name: string }[] = [],
        total = 0;
      if (kind === "task") {
        if (!q.trim()) throw new Error("Enter a task title to search");
        const r = await unwrap(
          api.search.$get({ param: { slug }, query: { scope: "tasks", q, limit: "50" } }),
        );
        rows = r.tasks.map((t) => ({ id: t.id, name: t.title }));
        total = rows.length;
      }
      if (kind === "supplier") {
        const r = await unwrap(api.suppliers.$get({ param: { slug }, query: { category: "service", q } }));
        rows = r.suppliers.map((s) => ({ id: s.id, name: s.name }));
        total = rows.length;
      }
      if (kind === "asset") {
        const r = await unwrap(
          api.site.maintenance.assets.$get({ param: { slug }, query: { status: "active" } }),
        );
        rows = r.assets
          .filter((a) => a.name.toLowerCase().includes(q.toLowerCase()))
          .map((a) => ({ id: a.id, name: a.name }));
        total = rows.length;
      }
      if (kind === "staff") {
        const r = await unwrap(
          api.people.staff.$get({
            param: { slug },
            query: { q, status: "active", limit: "50", offset: String(next) },
          }),
        );
        rows = r.staff.map((p) => ({ id: p.id, name: `${p.staffNumber} · ${p.firstName} ${p.lastName}` }));
        total = r.total;
      }
      if (kind === "course") {
        const r = await unwrap(
          api.training.courses.$get({ param: { slug }, query: { q, status: "active" } }),
        );
        rows = r.courses.map((c) => ({ id: c.id, name: `${c.code} · ${c.title}` }));
        total = rows.length;
      }
      if (kind === "contractor" || kind === "assessment") {
        const r = await unwrap(
          api.hse.registers.$get({
            param: { slug },
            query: {
              ...(kind === "contractor" ? { kind: "contractor" as const } : {}),
              status: "active",
              limit: "50",
              offset: String(next),
            },
          }),
        );
        rows = r.records
          .filter((r) => kind === "contractor" || ["risk_assessment", "coshh"].includes(r.kind))
          .map((r) => ({
            id: r.id,
            name: `${r.title}${r.approvedVersion ? ` · signed v${r.approvedVersion}` : " · unsigned"}`,
          }));
        total = r.total;
      }
      setRows(rows);
      setOffset(next);
      setTotal(total);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-sm">
        {label}
        <select
          aria-label={label}
          value={value}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-3"
        >
          <option value="">Choose {label.toLowerCase()}</option>
          {value && !rows.some((r) => r.id === value) && (
            <option value={value}>Previously selected record · load choices to view its name</option>
          )}
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <Input
          aria-label={`Find ${label.toLowerCase()}`}
          value={q}
          placeholder="Name or code"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void load();
            }
          }}
        />
        <Button variant="outline" type="button" disabled={busy} onClick={() => void load()}>
          Load {label.toLowerCase()}
        </Button>
      </div>
      {total > 0 && (
        <div className="flex gap-3 text-xs text-muted-foreground">
          <span>{total} matches</span>
          {offset > 0 && (
            <button type="button" onClick={() => void load(Math.max(0, offset - 50))}>
              Previous
            </button>
          )}
          {["staff", "contractor", "assessment"].includes(kind) && offset + 50 < total && (
            <button type="button" onClick={() => void load(offset + 50)}>
              Next
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
