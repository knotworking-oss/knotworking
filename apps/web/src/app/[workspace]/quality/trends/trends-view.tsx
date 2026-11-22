"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SelectField } from "@/components/haccp-forms";
import type { ComplaintTrends } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { qualityApi, type ItemOption } from "../quality-forms";

const monthLabel = (period: string) =>
  new Date(`${period}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
const rate = (n: number | null) =>
  n === null ? "–" : n.toLocaleString(undefined, { maximumFractionDigits: 1 });

type Cell = { period: string; complaints: number; units: number; perMillion: number | null };

/** A row of monthly figures: complaints per million units, with the counts underneath. */
function RateRow({
  name,
  sub,
  months,
  total,
}: {
  name: string;
  sub?: string;
  months: Cell[];
  total: Omit<Cell, "period">;
}) {
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="font-medium">{name}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </TableCell>
      {months.map((m) => (
        <TableCell
          key={m.period}
          className="text-right tabular-nums"
          title={`${m.complaints} complaints, ${m.units} units`}
        >
          {rate(m.perMillion)}
          <div className="text-xs text-muted-foreground">{m.complaints}</div>
        </TableCell>
      ))}
      <TableCell className="text-right font-medium tabular-nums">
        {rate(total.perMillion)}
        <div className="text-xs font-normal text-muted-foreground">{total.complaints}</div>
      </TableCell>
    </TableRow>
  );
}

function RateTable({ trends, children }: { trends: ComplaintTrends; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4" />
            {trends.periods.map((p) => (
              <TableHead key={p} className="text-right">
                {monthLabel(p)}
              </TableHead>
            ))}
            <TableHead className="text-right">Period</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/** Complaints per million units sold: overall (with a bar chart), per product and per category. */
export function TrendsView({
  slug,
  trends,
  items,
}: {
  slug: string;
  trends: ComplaintTrends;
  items: ItemOption[];
}) {
  const { can } = useWorkspace();
  const max = Math.max(1, ...trends.overall.months.map((m) => m.perMillion ?? 0));
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold tracking-tight">Complaint trends</h2>
      <Card>
        <CardHeader>
          <CardTitle>All products</CardTitle>
          <CardDescription>Complaints per million units, last {trends.periods.length} months</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            className="flex h-32 items-end gap-1"
            role="img"
            aria-label="Complaints per million units by month"
          >
            {trends.overall.months.map((m) => (
              <div key={m.period} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <div
                  className="w-full rounded-t bg-primary/70"
                  style={{ height: `${((m.perMillion ?? 0) / max) * 100}%`, minHeight: m.perMillion ? 2 : 0 }}
                  title={`${monthLabel(m.period)}: ${rate(m.perMillion)} per million (${m.complaints} complaints, ${m.units} units)`}
                />
                <span className="text-[10px] text-muted-foreground">{monthLabel(m.period)}</span>
              </div>
            ))}
          </div>
          <RateTable trends={trends}>
            <RateRow name="All complaints" months={trends.overall.months} total={trends.overall.total} />
          </RateTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>By product</CardTitle>
        </CardHeader>
        <CardContent>
          {trends.products.length === 0 ? (
            <p className="text-sm text-muted-foreground">No complaints or sales figures in this period.</p>
          ) : (
            <RateTable trends={trends}>
              {trends.products.map((p) => (
                <RateRow
                  key={p.item.id}
                  name={p.item.name}
                  sub={p.item.code}
                  months={p.months}
                  total={p.total}
                />
              ))}
            </RateTable>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>By category</CardTitle>
        </CardHeader>
        <CardContent>
          {trends.categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No complaints in this period.</p>
          ) : (
            <RateTable trends={trends}>
              {trends.categories.map((c) => (
                <RateRow key={c.category} name={c.label} months={c.months} total={c.total} />
              ))}
            </RateTable>
          )}
        </CardContent>
      </Card>
      {can("quality", "write") && <VolumeForm slug={slug} items={items} />}
    </div>
  );
}

function VolumeForm({ slug, items }: { slug: string; items: ItemOption[] }) {
  const router = useRouter();
  const today = useWorkspaceToday();
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [units, setUnits] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Units sold</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid items-end gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            try {
              await unwrap(
                qualityApi()["sales-volumes"].$put({
                  param: { slug },
                  json: { itemId, period: `${month}-01`, units: Number(units) },
                }),
              );
              toast.success("Saved");
              setUnits("");
              router.refresh();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <SelectField
            id="v-item"
            label="Product"
            value={itemId}
            onChange={setItemId}
            options={items.map((i) => [i.id, `${i.code} ${i.name}`] as const)}
          />
          <label className="flex flex-col gap-1 text-sm">
            Month
            <Input type="month" required value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Units
            <Input
              type="number"
              min={0}
              step="any"
              required
              value={units}
              onChange={(e) => setUnits(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={saving || !itemId || units === ""}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
