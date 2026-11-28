"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  addWeeks,
  customerKey,
  formatWeek,
  itemTypeLabels,
  normalizeCustomer,
  parseQuantityText,
  roundQuantity,
  toDisplayQuantity,
  units,
  weekStart,
  type DemandItemSummary,
  type PackUnit,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ChevronLeft, ChevronRight, FileUp, LineChart, Plus, Boxes } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { WeekHeading } from "@/components/demand-badges";
import type { DemandForecastData, DemandPackUnit, DemandSummaryData, Item } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { DemandNav } from "./demand-nav";
import { ImportDialog } from "./import-dialog";
import { PackUnitsDialog } from "./pack-units-dialog";
import { GRID_RANGES, type GridRange } from "./ranges";

const NO_ITEM = "";

interface GridRow {
  key: string;
  item: DemandItemSummary;
  customer: string | null;
  /** Demand per week (Monday) in the item's base unit (g, ml or each). */
  cells: Map<string, number>;
  /** Forecast per week (base unit) and how it was worked out, when the forecast is shown. */
  forecast?: Map<string, { base: number; explanation: string }>;
}

/** The row's chosen unit: a pack unit, or the item's own unit (`undefined`). */
type RowUnit = PackUnit | undefined;

/** A base quantity as the row's unit shows it. */
const fromBase = (base: number, row: GridRow, pack: RowUnit) =>
  pack ? roundQuantity(base / pack.size) : toDisplayQuantity(base, row.item);

const rowKey = (itemId: string, customer: string | null) => `${itemId}|${customerKey(customer)}`;
const cellKey = (row: string, periodStart: string) => `${row}@${periodStart}`;
const formatNumber = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 4 });

/**
 * Demand → Plan: one row per product and customer, one column per ISO week. People type
 * quantities in the item's own unit; changed cells are saved together (`PUT /demand/lines`), and
 * clearing a cell removes that line. Rows are the lines that exist in the range plus any added
 * here.
 */
export function DemandGrid({
  slug,
  summary,
  products,
  packUnits,
  from,
  weeks,
}: {
  slug: string;
  summary: DemandSummaryData;
  products: Item[];
  packUnits: DemandPackUnit[];
  from: string;
  weeks: GridRange;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("demand", "write");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<GridRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [importing, setImporting] = useState(false);
  const [newItem, setNewItem] = useState(NO_ITEM);
  const [newCustomer, setNewCustomer] = useState("");
  const [packing, setPacking] = useState(false);
  const [rowUnits, setRowUnits] = useState<Record<string, string>>({});
  const [forecast, setForecast] = useState<DemandForecastData | null>(null);
  const [forecastBusy, setForecastBusy] = useState(false);

  const packsOf = useMemo(() => {
    const map = new Map<string, PackUnit[]>();
    for (const p of packUnits)
      map.set(p.itemId, [...(map.get(p.itemId) ?? []), { name: p.name, size: p.size }]);
    return map;
  }, [packUnits]);
  const packOf = (row: GridRow): RowUnit =>
    packsOf.get(row.item.id)?.find((p) => p.name === rowUnits[row.key]);

  const rows = useMemo(() => {
    const fromServer: GridRow[] = summary.rows.map((r) => ({
      key: rowKey(r.item.id, r.customer),
      item: r.item,
      customer: r.customer,
      cells: new Map(r.periods.map((p) => [p.periodStart, p.quantity.base])),
    }));
    const fromForecast = new Map(
      (forecast?.rows ?? []).map((r) => [
        rowKey(r.item.id, r.customer),
        new Map(r.periods.map((p) => [p.periodStart, { base: p.quantity.base, explanation: p.explanation }])),
      ]),
    );
    const known = new Set(fromServer.map((r) => r.key));
    const all = [...fromServer, ...added.filter((r) => !known.has(r.key))].map((r) => ({
      ...r,
      forecast: fromForecast.get(r.key),
    }));
    // Products with a forecast but no demand yet get a row, so the forecast can be seen and copied.
    const have = new Set(all.map((r) => r.key));
    for (const f of forecast?.rows ?? []) {
      const key = rowKey(f.item.id, f.customer);
      if (!have.has(key)) {
        all.push({
          key,
          item: f.item,
          customer: f.customer,
          cells: new Map(),
          forecast: fromForecast.get(key),
        });
      }
    }
    return all;
  }, [summary, added, forecast]);

  const dirty = Object.keys(edits).length;
  const busy = saving || refreshing;

  function go(nextFrom: string, nextWeeks: GridRange = weeks) {
    const params = new URLSearchParams({ from: formatWeek(nextFrom), weeks: String(nextWeeks) });
    router.push(`${pathname}?${params}`);
  }

  function shown(row: GridRow, periodStart: string) {
    const base = row.cells.get(periodStart);
    return base === undefined ? undefined : fromBase(base, row, packOf(row));
  }

  async function toggleForecast() {
    if (forecast) {
      setForecast(null);
      return;
    }
    setForecastBusy(true);
    try {
      setForecast(
        await unwrap(
          browserApi().v1.workspaces[":slug"].demand.forecast.$get({
            param: { slug },
            query: { from, to: addWeeks(from, weeks - 1), byCustomer: "true" },
          }),
        ),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setForecastBusy(false);
    }
  }

  async function copyForecast() {
    setForecastBusy(true);
    try {
      const res = await unwrap(
        browserApi().v1.workspaces[":slug"].demand.forecast.apply.$post({
          param: { slug },
          json: { from, to: addWeeks(from, weeks - 1), byCustomer: true },
        }),
      );
      toast.success(
        res.created
          ? `Copied the forecast into ${res.created} empty weeks${res.skipped.length ? ` (${res.skipped.length} left as they were)` : ""}`
          : "Nothing to copy: every forecast week already has demand",
      );
      startRefresh(() => {
        setForecast(null);
        router.refresh();
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setForecastBusy(false);
    }
  }

  function edit(row: GridRow, periodStart: string, text: string) {
    const key = cellKey(row.key, periodStart);
    const original = shown(row, periodStart);
    setEdits(({ [key]: _old, ...rest }) =>
      text.trim() === (original === undefined ? "" : formatNumber(original))
        ? rest
        : { ...rest, [key]: text },
    );
  }

  function addRow(e: FormEvent) {
    e.preventDefault();
    const product = products.find((p) => p.id === newItem);
    if (!product) return;
    const customer = normalizeCustomer(newCustomer);
    const key = rowKey(product.id, customer);
    if (rows.some((r) => r.key === key)) {
      toast.info(`${product.code}${customer ? ` for ${customer}` : ""} is already in the plan`);
      return;
    }
    setAdded((list) => [...list, { key, item: product, customer, cells: new Map() }]);
    setNewItem(NO_ITEM);
    setNewCustomer("");
  }

  async function save() {
    const lines: {
      itemId: string;
      period: string;
      quantity: number | null;
      unit?: string;

      customer?: string;
    }[] = [];
    const bad: string[] = [];
    for (const row of rows) {
      for (const { periodStart } of summary.weeks) {
        const text = edits[cellKey(row.key, periodStart)];
        if (text === undefined) continue;
        const original = shown(row, periodStart);
        const base = {
          itemId: row.item.id,
          period: periodStart,
          ...(row.customer ? { customer: row.customer } : {}),
        };
        if (text.trim() === "") {
          if (original !== undefined) lines.push({ ...base, quantity: null });
          continue;
        }
        const quantity = parseQuantityText(text);
        if (quantity === null) bad.push(`${row.item.code} ${formatWeek(periodStart)}: "${text}"`);
        else if (quantity !== original)
          lines.push({
            ...base,
            quantity: roundQuantity(quantity),
            unit: packOf(row)?.name ?? row.item.unit,
          });
      }
    }
    if (bad.length) {
      toast.error(`Not a quantity of 0 or more: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""}`);
      return;
    }
    if (lines.length === 0) {
      setEdits({});
      return;
    }
    setSaving(true);
    try {
      const res = await unwrap(
        browserApi().v1.workspaces[":slug"].demand.lines.$put({ param: { slug }, json: { lines } }),
      );
      const parts = [
        res.created && `${res.created} added`,
        res.updated && `${res.updated} changed`,
        res.removed && `${res.removed} removed`,
      ].filter(Boolean);
      toast.success(parts.length ? `Demand saved: ${parts.join(", ")}` : "Nothing changed");
      startRefresh(() => {
        setEdits({});
        router.refresh();
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const thisWeek = weekStart(useWorkspaceToday());
  const usedItems = new Set(rows.map((r) => r.item.id));

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <DemandNav slug={slug} current="plan" />
          <h2 className="text-xl font-semibold tracking-tight">Demand plan</h2>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setPacking(true)}>
              <Boxes data-icon="inline-start" /> Units of sale
            </Button>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp data-icon="inline-start" /> Import CSV
            </Button>
            {dirty > 0 && (
              <Button variant="ghost" onClick={() => setEdits({})} disabled={busy}>
                Discard
              </Button>
            )}
            <Button onClick={() => void save()} disabled={busy || dirty === 0}>
              {busy && <Spinner data-icon="inline-start" />} Save changes{dirty ? ` (${dirty})` : ""}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Earlier weeks"
          disabled={dirty > 0}
          title={dirty ? "Save or discard your changes first" : undefined}
          onClick={() => go(addWeeks(from, -weeks))}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Later weeks"
          disabled={dirty > 0}
          title={dirty ? "Save or discard your changes first" : undefined}
          onClick={() => go(addWeeks(from, weeks))}
        >
          <ChevronRight />
        </Button>
        <Button variant="outline" disabled={dirty > 0 || from === thisWeek} onClick={() => go(thisWeek)}>
          This week
        </Button>
        <Select
          value={String(weeks)}
          disabled={dirty > 0}
          onValueChange={(v) => go(from, Number(v) as GridRange)}
        >
          <SelectTrigger className="w-32" aria-label="Weeks shown">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {GRID_RANGES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} weeks
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {summary.weeks[0]?.week} to {summary.weeks.at(-1)?.week}
        </span>
        <Button
          variant={forecast ? "secondary" : "outline"}
          aria-pressed={!!forecast}
          disabled={forecastBusy || dirty > 0}
          title={dirty ? "Save or discard your changes first" : undefined}
          onClick={() => void toggleForecast()}
        >
          {forecastBusy ? <Spinner data-icon="inline-start" /> : <LineChart data-icon="inline-start" />}
          {forecast ? "Hide forecast" : "Show forecast"}
        </Button>
        {forecast && canWrite && (
          <Button variant="outline" disabled={forecastBusy || dirty > 0} onClick={() => void copyForecast()}>
            Copy forecast into empty weeks
          </Button>
        )}
      </div>

      {forecast && (
        <p className="text-sm text-muted-foreground">
          Forecast in grey: {forecast.method} Hover a figure to see how it was worked out. Copying fills only
          weeks that have no demand yet and records them with the source &quot;Forecast&quot;.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {products.length === 0
            ? "No demand yet. Add finished goods or work in progress on the Items page first."
            : canWrite
              ? "No demand in these weeks. Add a product below, or import a CSV file."
              : "No demand in these weeks."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-56 bg-card pl-4">Product</TableHead>
                <TableHead className="min-w-28">Customer</TableHead>
                {summary.weeks.map((w) => (
                  <TableHead
                    key={w.periodStart}
                    className={`text-right ${w.periodStart === thisWeek ? "text-foreground" : ""}`}
                  >
                    <WeekHeading periodStart={w.periodStart} />
                  </TableHead>
                ))}
                <TableHead className="pr-4 text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                let total = 0;
                return (
                  <TableRow key={row.key}>
                    <TableCell className="sticky left-0 z-10 bg-card pl-4">
                      <span className="font-medium">{row.item.name}</span>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{row.item.code}</span>
                      {(packsOf.get(row.item.id)?.length ?? 0) > 0 && canWrite ? (
                        <select
                          className="ml-2 rounded border bg-background px-1 text-xs text-muted-foreground"
                          aria-label={`Unit for ${row.item.code}`}
                          value={rowUnits[row.key] ?? ""}
                          disabled={busy || dirty > 0}
                          onChange={(e) => setRowUnits((u) => ({ ...u, [row.key]: e.target.value }))}
                        >
                          <option value="">{units[row.item.unit].label}</option>
                          {packsOf.get(row.item.id)!.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name} ({formatNumber(p.size)})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {packOf(row)?.name ?? units[row.item.unit].label}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className={row.customer ? "" : "text-muted-foreground"}>
                      {row.customer ?? "Any"}
                    </TableCell>
                    {summary.weeks.map(({ periodStart, week }) => {
                      const key = cellKey(row.key, periodStart);
                      const original = shown(row, periodStart);
                      const value = edits[key] ?? (original === undefined ? "" : formatNumber(original));
                      const f = row.forecast?.get(periodStart);
                      const guess = f ? formatNumber(fromBase(f.base, row, packOf(row))) : undefined;
                      total += parseQuantityText(value) ?? 0;
                      return (
                        <TableCell key={periodStart} className="p-1 text-right">
                          {canWrite ? (
                            <Input
                              className={`h-8 w-20 text-right tabular-nums ${key in edits ? "bg-label-yellow-bg" : ""}`}
                              inputMode="decimal"
                              aria-label={`${row.item.code}${row.customer ? ` ${row.customer}` : ""} ${week}`}
                              value={value}
                              placeholder={guess}
                              title={f?.explanation}
                              disabled={busy}
                              onChange={(e) => edit(row, periodStart, e.target.value)}
                            />
                          ) : (
                            <span className="px-2 tabular-nums" title={f?.explanation}>
                              {value ||
                                (guess ? <span className="text-muted-foreground/60">{guess}</span> : "—")}
                            </span>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="pr-4 text-right font-medium tabular-nums">
                      {formatNumber(roundQuantity(total))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {canWrite && products.length > 0 && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={addRow}>
          <Select value={newItem} onValueChange={setNewItem}>
            <SelectTrigger className="w-72" aria-label="Product to add">
              <SelectValue placeholder="Add a product…" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · {itemTypeLabels[p.type]}
                      {usedItems.has(p.id) ? " · in the plan" : ""}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            className="w-48"
            placeholder="Customer (optional)"
            aria-label="Customer"
            maxLength={120}
            value={newCustomer}
            onChange={(e) => setNewCustomer(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={!newItem}>
            <Plus data-icon="inline-start" /> Add row
          </Button>
        </form>
      )}

      {packing && (
        <PackUnitsDialog
          slug={slug}
          products={products}
          packUnits={packUnits}
          onClose={() => setPacking(false)}
        />
      )}
      {importing && <ImportDialog slug={slug} onClose={() => setImporting(false)} />}
    </div>
  );
}
