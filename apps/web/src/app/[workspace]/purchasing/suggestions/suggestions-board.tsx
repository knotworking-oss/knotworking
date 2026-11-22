"use client";

import { useWorkspaceCurrency } from "@/lib/workspace-time";
import {
  canOrderFromSupplier,
  notPurchasableReasonLabels,
  supplierApprovalLabels,
  units,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
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
import { CircleCheck, FilePlus2, Info } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SupplierApprovalBadge } from "@/components/item-badges";
import { formatPrice } from "@/components/purchasing-badges";
import { stackedTable } from "@/components/stacked-table";
import { formatAmount } from "@/components/stock-badges";
import type { PurchaseOrderRow, PurchaseSuggestion, PurchaseSuggestions } from "@/lib/api";
import { errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import {
  NONE,
  parseNumber,
  purchasingApi,
  type OrderOptions,
  type SupplierOption,
} from "../purchasing-forms";

interface RowState {
  include: boolean;
  quantity: string;
  price: string;
  expectedOn: string;
  /** The supplier to order from: the suggested one, or picked for the no-supplier group. */
  supplierId: string;
}

const formatQty = (n: number) => String(Math.round(n * 10_000) / 10_000);

const initialRow = (s: PurchaseSuggestion): RowState => ({
  // Already on a draft for at least what is needed: left out until someone ticks it.
  include: s.onDraft.base < s.toOrder.base,
  quantity: formatQty(s.quantity),
  price: s.unitPrice === null ? "" : String(s.unitPrice),
  expectedOn: s.expectedOn ?? "",
  supplierId: s.supplierId ?? NONE,
});

/** The proposal: editable per row, then created as draft orders in one go. */
export function SuggestionsBoard({
  slug,
  data,
  options,
}: {
  slug: string;
  data: PurchaseSuggestions;
  options: OrderOptions;
}) {
  const [created, setCreated] = useState<PurchaseOrderRow[] | null>(null);
  // Re-initialise the rows when the data changes (after creating drafts, `onDraft` moves).
  const version = JSON.stringify(
    data.groups.map((g) => g.suggestions.map((s) => [s.item.id, s.onDraft.base])),
  );
  return (
    <div className="flex flex-col gap-4">
      {created && (
        <Alert>
          <CircleCheck />
          <AlertTitle>
            {created.length} draft order{created.length === 1 ? "" : "s"} created
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-0.5">
              {created.map((o) => (
                <li key={o.id}>
                  <Link href={`/${slug}/purchasing/orders/${o.id}`} className="font-mono hover:underline">
                    {o.reference}
                  </Link>{" "}
                  {o.supplier.name} · {o.linesCount} line{o.linesCount === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
            <Link href={`/${slug}/purchasing?status=draft`} className="underline underline-offset-4">
              Review and send the drafts
            </Link>
          </AlertDescription>
        </Alert>
      )}
      <SuggestionsForm key={version} slug={slug} data={data} options={options} onCreated={setCreated} />
    </div>
  );
}

function SuggestionsForm({
  slug,
  data,
  options,
  onCreated,
}: {
  slug: string;
  data: PurchaseSuggestions;
  options: OrderOptions;
  onCreated: (orders: PurchaseOrderRow[]) => void;
}) {
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("purchasing", "write");
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(data.groups.flatMap((g) => g.suggestions.map((s) => [s.item.id, initialRow(s)]))),
  );
  const [locationId, setLocationId] = useState(
    options.locations.length === 1 ? options.locations[0]!.id : NONE,
  );
  const [pending, setPending] = useState(false);
  const update = (itemId: string, patch: Partial<RowState>) =>
    setRows((all) => ({ ...all, [itemId]: { ...all[itemId]!, ...patch } }));

  const all = data.groups.flatMap((g) => g.suggestions);
  const included = all.filter((s) => rows[s.item.id]!.include);
  const unassigned = included.filter((s) => rows[s.item.id]!.supplierId === NONE);
  const badQuantity = included.some((s) => !(parseNumber(rows[s.item.id]!.quantity)! > 0));
  const supplierCount = new Set(included.map((s) => rows[s.item.id]!.supplierId)).size;

  async function create() {
    // One order per supplier, in the order the groups are listed.
    const bySupplier = new Map<string, PurchaseSuggestion[]>();
    for (const s of included) {
      const supplierId = rows[s.item.id]!.supplierId;
      bySupplier.set(supplierId, [...(bySupplier.get(supplierId) ?? []), s]);
    }
    const orders = [...bySupplier].map(([supplierId, suggestions]) => {
      const dates = suggestions.map((s) => rows[s.item.id]!.expectedOn).filter(Boolean);
      const expectedOn = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
      return {
        supplierId,
        expectedOn,
        ...(locationId !== NONE ? { deliveryLocationId: locationId } : {}),
        lines: suggestions.map((s) => {
          const r = rows[s.item.id]!;
          return {
            itemId: s.item.id,
            quantity: parseNumber(r.quantity)!,
            unit: s.unit,
            unitPrice: parseNumber(r.price),
            ...(r.expectedOn && r.expectedOn !== expectedOn ? { expectedOn: r.expectedOn } : {}),
          };
        }),
      };
    });
    setPending(true);
    try {
      const result = await unwrap(purchasingApi().suggestions.$post({ param: { slug }, json: { orders } }));
      toast.success(`${result.orders.length} draft order${result.orders.length === 1 ? "" : "s"} created`);
      onCreated(result.orders);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {data.groups.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing to order for batches between {formatLongDate(data.from)} and {formatLongDate(data.to)}
          {data.covered.length ? ": sent orders cover every shortfall." : ": stock covers what is planned."}
        </p>
      ) : (
        data.groups.map((g) => (
          <SupplierGroup
            key={g.supplier?.id ?? NONE}
            supplier={g.supplier}
            suggestions={g.suggestions}
            rows={rows}
            update={update}
            suppliers={options.suppliers}
            canWrite={canWrite}
          />
        ))
      )}

      {canWrite && data.groups.length > 0 && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t bg-background py-3">
          <span className="mr-auto text-sm text-muted-foreground">
            {included.length === 0
              ? "Tick the lines to order."
              : unassigned.length
                ? `Choose a supplier for ${unassigned.map((s) => s.item.name).join(", ")}.`
                : `${included.length} line${included.length === 1 ? "" : "s"} → ${supplierCount} draft order${supplierCount === 1 ? "" : "s"}`}
          </span>
          {options.locations.length > 0 && (
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger aria-label="Deliver to" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={NONE}>Deliver to: not set</SelectItem>
                  {options.locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      Deliver to {l.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          <Button
            disabled={pending || included.length === 0 || unassigned.length > 0 || badQuantity}
            onClick={() => void create()}
          >
            {pending ? <Spinner data-icon="inline-start" /> : <FilePlus2 data-icon="inline-start" />}
            Create draft orders
          </Button>
        </div>
      )}

      {data.notPurchasable.length > 0 && (
        <Alert>
          <Info />
          <AlertTitle>Short, but not bought</AlertTitle>
          <AlertDescription>
            <p>
              These are in the shortfall but can&apos;t go on a purchase order: plan the production of what is
              made in house, and replace archived items in the recipe.
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {data.notPurchasable.map((r) => (
                <li key={r.item.id}>
                  <span className="font-medium text-foreground">{r.item.name}</span>{" "}
                  <span className="font-mono text-xs">{r.item.code}</span> · {formatAmount(r.shortfall)} short
                  · {notPurchasableReasonLabels[r.reason]}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {data.covered.length > 0 && (
        <Card className="gap-0 pb-0">
          <CardHeader className="pb-4">
            <CardTitle>Covered by sent orders</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto border-t">
            <Table className={stackedTable}>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Item</TableHead>
                  <TableHead className="text-right">Shortfall</TableHead>
                  <TableHead className="text-right">On order</TableHead>
                  <TableHead className="pr-4">Needed by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.covered.map((s) => (
                  <TableRow key={s.item.id}>
                    <TableCell className="pl-4" data-primary>
                      <ItemName suggestion={s} />
                    </TableCell>
                    <TableCell data-label="Shortfall" className="text-right tabular-nums">
                      {formatAmount(s.shortfall)}
                    </TableCell>
                    <TableCell data-label="On order" className="text-right tabular-nums">
                      {formatAmount(s.onOrder)}
                    </TableCell>
                    <TableCell data-label="Needed by" className="pr-4">
                      {s.neededBy ? formatLongDate(s.neededBy) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ItemName({ suggestion: s }: { suggestion: PurchaseSuggestion }) {
  return (
    <>
      <span className="font-medium">{s.item.name}</span>{" "}
      <span className="font-mono text-xs text-muted-foreground">{s.item.code}</span>
      {s.incomplete && (
        <div className="text-xs text-muted-foreground">
          A batch&apos;s quantity couldn&apos;t be converted
        </div>
      )}
    </>
  );
}

function SupplierGroup({
  supplier,
  suggestions,
  rows,
  update,
  suppliers,
  canWrite,
}: {
  supplier: PurchaseSuggestions["groups"][number]["supplier"];
  suggestions: PurchaseSuggestion[];
  rows: Record<string, RowState>;
  update: (itemId: string, patch: Partial<RowState>) => void;
  suppliers: SupplierOption[];
  canWrite: boolean;
}) {
  const currency = useWorkspaceCurrency();
  const included = suggestions.filter((s) => rows[s.item.id]!.include);
  let value = 0;
  let complete = true;
  for (const s of included) {
    const r = rows[s.item.id]!;
    const price = parseNumber(r.price);
    if (price === null) complete = false;
    else value += (parseNumber(r.quantity) ?? 0) * price;
  }
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle className="flex flex-wrap items-center gap-2">
          {supplier ? (
            <>
              {supplier.name}
              {supplier.approvalStatus !== "approved" && (
                <SupplierApprovalBadge status={supplier.approvalStatus} />
              )}
            </>
          ) : (
            "Choose a supplier"
          )}
        </CardTitle>
        {included.length > 0 && (
          <CardDescription>
            {`${included.length} ticked · value ${formatPrice(value, currency)}${complete ? "" : "+"}`}
          </CardDescription>
        )}
      </CardHeader>
      <div className="overflow-x-auto border-t">
        <Table className={stackedTable}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pl-4">
                <span className="sr-only">Order</span>
              </TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="w-24 text-right">Shortfall</TableHead>
              <TableHead className="w-24 text-right">On order</TableHead>
              <TableHead className="w-24 text-right">On draft</TableHead>
              <TableHead className="w-32">Needed by</TableHead>
              {!supplier && <TableHead className="w-48">Supplier</TableHead>}
              <TableHead className="w-36">Order</TableHead>
              <TableHead className="w-40">Price</TableHead>
              <TableHead className="w-40 pr-4">Expected</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suggestions.map((s) => {
              const r = rows[s.item.id]!;
              const unit = units[s.unit].label;
              // Linked suppliers that can be ordered from; every orderable one when none is linked.
              const linked = s.suppliers.filter((x) => canOrderFromSupplier(x.approvalStatus));
              const choices = linked.length
                ? linked
                : suppliers.filter((x) => canOrderFromSupplier(x.approvalStatus));
              const off = !r.include;
              return (
                <TableRow key={s.item.id} className={off ? "text-muted-foreground" : undefined}>
                  <TableCell className="pl-4" data-select>
                    <Checkbox
                      aria-label={`Order ${s.item.name}`}
                      checked={r.include}
                      disabled={!canWrite}
                      onCheckedChange={(on) => update(s.item.id, { include: on === true })}
                    />
                  </TableCell>
                  <TableCell className="whitespace-normal" data-primary>
                    <ItemName suggestion={s} />
                  </TableCell>
                  <TableCell data-label="Shortfall" className="text-right tabular-nums">
                    {formatAmount(s.shortfall)}
                  </TableCell>
                  <TableCell data-label="On order" className="text-right tabular-nums">
                    {s.onOrder.base > 0 ? formatAmount(s.onOrder) : "—"}
                  </TableCell>
                  <TableCell
                    data-label="On draft"
                    className={`text-right tabular-nums ${s.onDraft.base > 0 ? "text-label-orange" : ""}`}
                  >
                    {s.onDraft.base > 0 ? formatAmount(s.onDraft) : "—"}
                  </TableCell>
                  <TableCell data-label="Needed by">
                    {s.neededBy ? formatLongDate(s.neededBy) : "—"}
                  </TableCell>
                  {!supplier && (
                    <TableCell data-label="Supplier">
                      <Select
                        value={r.supplierId}
                        onValueChange={(v) => update(s.item.id, { supplierId: v })}
                        disabled={off || !canWrite}
                      >
                        <SelectTrigger aria-label={`Supplier for ${s.item.name}`} className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {r.supplierId === NONE && <SelectItem value={NONE}>Choose…</SelectItem>}
                            {choices.map((x) => (
                              <SelectItem key={x.id} value={x.id}>
                                {x.name}
                                {x.approvalStatus !== "approved" &&
                                  ` · ${supplierApprovalLabels[x.approvalStatus]}`}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  )}
                  <TableCell data-label="Order">
                    <span className="inline-flex items-center gap-1.5">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        aria-label={`Quantity of ${s.item.name} (${unit})`}
                        className="h-8 w-24 text-right"
                        disabled={off || !canWrite}
                        value={r.quantity}
                        onChange={(e) => update(s.item.id, { quantity: e.target.value })}
                      />
                      <span className="text-xs">{unit}</span>
                    </span>
                  </TableCell>
                  <TableCell data-label="Price">
                    <span className="inline-flex items-center gap-1.5">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        placeholder="Unknown"
                        aria-label={`Price of ${s.item.name} per ${unit}`}
                        className="h-8 w-24 text-right"
                        disabled={off || !canWrite}
                        value={r.price}
                        onChange={(e) => update(s.item.id, { price: e.target.value })}
                      />
                      <span className="text-xs">/ {unit}</span>
                    </span>
                  </TableCell>
                  <TableCell data-label="Expected" className="pr-4">
                    <Input
                      type="date"
                      aria-label={`Expected date for ${s.item.name}`}
                      className="h-8 w-36"
                      disabled={off || !canWrite}
                      value={r.expectedOn}
                      onChange={(e) => update(s.item.id, { expectedOn: e.target.value })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
