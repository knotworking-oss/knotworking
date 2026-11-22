"use client";

import { units, type UnitCode } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { formatCost } from "@/components/costing-badges";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspaceToday } from "@/lib/workspace-time";

const num = (v: string) => (v.trim() === "" ? 0 : Number(v));

interface RatesData {
  rates: {
    id: string;
    lineId: string | null;
    lineName: string | null;
    effectiveFrom: string;
    labourPerHour: number;
    labourPerKg: number;
    overheadPerHour: number;
    overheadPerKg: number;
  }[];
  lines: { id: string; name: string; active: boolean }[];
}

/**
 * Labour and overhead absorbed by a batch: an amount per batch hour (start to completion) and per
 * kilogram made, for a production line or as the workspace default. Reported next to materials,
 * never inside them.
 */
export function RatesForm({
  slug,
  currency,
  data,
  canManage,
}: {
  slug: string;
  currency: string;
  data: RatesData;
  canManage: boolean;
}) {
  const router = useRouter();
  const today = useWorkspaceToday();
  const [lineId, setLineId] = useState("");
  const [from, setFrom] = useState(today);
  const [v, setV] = useState({ lh: "", lk: "", oh: "", ok: "" });
  const [pending, setPending] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].costing.rates.$put({
          param: { slug },
          json: {
            lineId: lineId || null,
            effectiveFrom: from,
            labourPerHour: num(v.lh),
            labourPerKg: num(v.lk),
            overheadPerHour: num(v.oh),
            overheadPerKg: num(v.ok),
          },
        }),
      );
      toast.success("Rates saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const field = (id: keyof typeof v, label: string) => (
    <Field>
      <FieldLabel htmlFor={`rate-${id}`}>
        {label} ({currency})
      </FieldLabel>
      <Input
        id={`rate-${id}`}
        type="number"
        min={0}
        step="any"
        value={v[id]}
        onChange={(e) => setV({ ...v, [id]: e.target.value })}
      />
    </Field>
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold tracking-tight">Labour and overhead rates</h2>
      {canManage && (
        <Card className="px-4">
          <form onSubmit={save} className="grid gap-3 py-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="rate-line">Applies to</FieldLabel>
              <select
                id="rate-line"
                value={lineId}
                onChange={(e) => setLineId(e.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Every line (default)</option>
                {data.lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="rate-from">From</FieldLabel>
              <Input
                id="rate-from"
                type="date"
                required
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <div />
            {field("lh", "Labour per hour")}
            {field("lk", "Labour per kg")}
            <div />
            {field("oh", "Overhead per hour")}
            {field("ok", "Overhead per kg")}
            <div className="flex items-end">
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />} Save rates
              </Button>
            </div>
          </form>
        </Card>
      )}
      <Card className="overflow-x-auto py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Line</TableHead>
              <TableHead>From</TableHead>
              <TableHead className="text-right">Labour / hour</TableHead>
              <TableHead className="text-right">Labour / kg</TableHead>
              <TableHead className="text-right">Overhead / hour</TableHead>
              <TableHead className="pr-4 text-right">Overhead / kg</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rates.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="pl-4 text-muted-foreground">
                  No rates set: batches absorb no labour or overhead.
                </TableCell>
              </TableRow>
            )}
            {data.rates.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="pl-4">{r.lineName ?? "Every line (default)"}</TableCell>
                <TableCell className="tabular-nums">{formatLongDate(r.effectiveFrom)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCost(r.labourPerHour, currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCost(r.labourPerKg, currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCost(r.overheadPerHour, currency)}
                </TableCell>
                <TableCell className="pr-4 text-right tabular-nums">
                  {formatCost(r.overheadPerKg, currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}

interface HistoryEntry {
  id: string;
  effectiveFrom: string;
  cost: number | null;
  note: string | null;
}

/** An item's standard cost from a date, with the history it already has. */
export function StandardCostForm({
  slug,
  currency,
  canManage,
  items,
}: {
  slug: string;
  currency: string;
  canManage: boolean;
  items: { id: string; code: string; name: string; unit: UnitCode }[];
}) {
  const router = useRouter();
  const today = useWorkspaceToday();
  const [itemId, setItemId] = useState("");
  const [from, setFrom] = useState(today);
  const [cost, setCost] = useState("");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [pending, setPending] = useState(false);
  const item = items.find((i) => i.id === itemId);

  async function pick(id: string) {
    setItemId(id);
    setHistory(null);
    if (!id) return;
    try {
      const r = await unwrap(
        browserApi().v1.workspaces[":slug"].costing["standard-costs"][":itemId"].$get({
          param: { slug, itemId: id },
        }),
      );
      setHistory(r.entries);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const r = await unwrap(
        browserApi().v1.workspaces[":slug"].costing["standard-costs"].$put({
          param: { slug },
          json: { itemId, effectiveFrom: from, cost: cost.trim() === "" ? null : Number(cost) },
        }),
      );
      setHistory(r.entries);
      toast.success("Standard cost saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold tracking-tight">Standard cost history</h2>
      <Card className="px-4">
        <form onSubmit={save} className="grid gap-3 py-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="std-item">Item</FieldLabel>
            <select
              id="std-item"
              value={itemId}
              onChange={(e) => void pick(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Choose an item…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code} {i.name}
                </option>
              ))}
            </select>
          </Field>
          {canManage && (
            <>
              <Field>
                <FieldLabel htmlFor="std-from">From</FieldLabel>
                <Input
                  id="std-from"
                  type="date"
                  required
                  max={today}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="std-cost">
                  Cost{item ? ` per ${units[item.unit].label}` : ""} ({currency})
                </FieldLabel>
                <Input
                  id="std-cost"
                  type="number"
                  min={0}
                  step="any"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </Field>
              <div>
                <Button type="submit" disabled={pending || !itemId}>
                  {pending && <Spinner />} Save
                </Button>
              </div>
            </>
          )}
        </form>
      </Card>
      {history && (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">From</TableHead>
                <TableHead className="pr-4 text-right">Standard cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="pl-4 text-muted-foreground">
                    No history yet: the item&apos;s current cost is used for every date.
                  </TableCell>
                </TableRow>
              )}
              {history.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="pl-4 tabular-nums">{formatLongDate(h.effectiveFrom)}</TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {h.cost === null ? "None" : formatCost(h.cost, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}
