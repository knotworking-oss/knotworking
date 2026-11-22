"use client";

import { useWorkspaceCurrency } from "@/lib/workspace-time";
import type { PurchaseOrderSettings } from "@knotworking/core";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Plus, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  formatPrice,
  OverdueBadge,
  PurchaseOrderStateBadge,
  ReceivedProgress,
} from "@/components/purchasing-badges";
import { stackedTable } from "@/components/stacked-table";
import { ExportCsvButton } from "@/components/export-csv-button";
import type { PurchaseOrderRow } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { collectPages, purchaseOrdersCsv } from "@/lib/csv-export";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { OrderDialog } from "./order-dialog";
import { NONE, type OrderOptions } from "./purchasing-forms";
import { OrderSettingsDialog } from "./settings-dialog";

export type OrderFilter = "open" | "draft" | "received" | "closed" | "cancelled" | "all";

const filterLabels: Record<OrderFilter, string> = {
  open: "Open",
  draft: "Drafts",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
  all: "All",
};

const emptyText: Record<OrderFilter, string> = {
  open: "No orders waiting for goods.",
  draft: "No draft orders.",
  received: "No orders received in full yet.",
  closed: "No closed orders.",
  cancelled: "No cancelled orders.",
  all: "No purchase orders yet.",
};

/** The purchase order register: filter, search, page; each row opens the order. */
export function OrdersBoard({
  slug,
  status,
  q,
  supplierId,
  page,
  options,
  settings,
}: {
  slug: string;
  status: OrderFilter;
  q: string;
  supplierId: string | null;
  page: { orders: PurchaseOrderRow[]; total: number; limit: number; offset: number };
  options: OrderOptions;
  settings: PurchaseOrderSettings;
}) {
  const currency = useWorkspaceCurrency();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [controls, setControls] = useState(false);
  const [search, setSearch] = useState(q);
  const go = (next: { status?: OrderFilter; q?: string; supplierId?: string | null; offset?: number }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    const text = next.q ?? search;
    const supplier = next.supplierId === undefined ? supplierId : next.supplierId;
    if (s !== "open") params.set("status", s);
    if (text.trim()) params.set("q", text.trim());
    if (supplier) params.set("supplier", supplier);
    if (next.offset) params.set("offset", String(next.offset));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };
  const { orders, total, limit, offset } = page;
  const filtered = Boolean(q || supplierId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Purchase orders</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "order" : "orders"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ExportCsvButton
            name="Purchase orders"
            size="default"
            rows={async () =>
              purchaseOrdersCsv(
                await collectPages(async (offset) => {
                  const r = await unwrap(
                    browserApi().v1.workspaces[":slug"].purchasing.orders.$get({
                      param: { slug },
                      query: {
                        status,
                        ...(q ? { q } : {}),
                        ...(supplierId ? { supplierId } : {}),
                        limit: "500",
                        offset: String(offset),
                      },
                    }),
                  );
                  return { rows: r.orders, total: r.total };
                }),
              )
            }
          />
          {can("purchasing", "manage") && (
            <Button variant="outline" onClick={() => setControls(true)}>
              <SlidersHorizontal data-icon="inline-start" /> Order controls
            </Button>
          )}
          {can("purchasing", "write") && (
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" /> New order
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={(v) => go({ status: v as OrderFilter, offset: 0 })}>
          <TabsList className="max-w-full overflow-x-auto">
            {(Object.keys(filterLabels) as OrderFilter[]).map((f) => (
              <TabsTrigger key={f} value={f}>
                {filterLabels[f]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <form
          className="min-w-48 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go({ offset: 0 });
          }}
        >
          <Input
            type="search"
            aria-label="Search purchase orders"
            placeholder="Search reference, supplier, supplier's reference"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        {options.suppliers.length > 0 && (
          <Select
            value={supplierId ?? NONE}
            onValueChange={(v) => go({ supplierId: v === NONE ? null : v, offset: 0 })}
          >
            <SelectTrigger aria-label="Supplier" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>All suppliers</SelectItem>
                {options.suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>

      {orders.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filtered ? "No orders match." : emptyText[status]}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Reference</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Received</TableHead>
                <TableHead className="pr-4 text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="pl-4" data-primary>
                    <Link
                      href={`/${slug}/purchasing/orders/${o.id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {o.reference}
                    </Link>
                    {o.supplierReference && (
                      <div className="text-xs text-muted-foreground">Theirs: {o.supplierReference}</div>
                    )}
                  </TableCell>
                  <TableCell data-label="Supplier">{o.supplier.name}</TableCell>
                  <TableCell data-label="Expected">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className={o.overdue ? "text-label-red" : undefined}>
                        {o.nextExpectedOn ? formatLongDate(o.nextExpectedOn) : "—"}
                      </span>
                      {o.overdue && <OverdueBadge />}
                    </span>
                  </TableCell>
                  <TableCell data-label="State">
                    <PurchaseOrderStateBadge state={o.state} />
                  </TableCell>
                  <TableCell data-label="Received">
                    {o.status === "draft" || o.status === "cancelled" ? (
                      <span className="text-xs text-muted-foreground">
                        {o.linesCount} line{o.linesCount === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <ReceivedProgress received={o.receivedLines} total={o.linesCount} />
                    )}
                  </TableCell>
                  <TableCell data-label="Value" className="pr-4 text-right tabular-nums">
                    {o.linesCount === 0 ? (
                      "—"
                    ) : (
                      <span title={o.valueComplete ? undefined : "Some lines have no price"}>
                        {formatPrice(o.value, currency)}
                        {!o.valueComplete && <span className="text-muted-foreground">+</span>}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {total > limit && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          {offset + 1}–{Math.min(offset + orders.length, total)} of {total}
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => go({ offset: Math.max(0, offset - limit) })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => go({ offset: offset + limit })}
          >
            Next
          </Button>
        </div>
      )}
      {controls && <OrderSettingsDialog slug={slug} settings={settings} onClose={() => setControls(false)} />}
      {creating && <OrderDialog slug={slug} options={options} onClose={() => setCreating(false)} />}
    </div>
  );
}
