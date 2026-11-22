"use client";

import { unitsForItem, units, type UnitCode } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
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
import { CalendarX, Plus, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import { formatPrice } from "@/components/purchasing-badges";
import { useWorkspaceCurrency } from "@/lib/workspace-time";
import { stackedTable } from "@/components/stacked-table";
import type { SupplierPriceRow } from "@/lib/api";
import { unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { NONE, parseNumber, purchasingApi, type OrderOptions } from "../purchasing-forms";

/**
 * Supplier price lists: what each supplier charges for an item, with effective dates. A price in
 * force is the default for a new order line from that supplier; ending one (an effective-to date)
 * keeps the history. Lines already on orders keep the price they were given.
 */
export function PricesBoard({
  slug,
  supplierId,
  page,
  options,
}: {
  slug: string;
  supplierId: string | null;
  page: { prices: SupplierPriceRow[]; total: number; limit: number; offset: number };
  options: OrderOptions;
}) {
  const currency = useWorkspaceCurrency();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("purchasing", "write");
  const [dialog, setDialog] = useState<
    { kind: "add" } | { kind: "end" | "delete"; price: SupplierPriceRow } | null
  >(null);
  const { prices, total, limit, offset } = page;
  const go = (next: { supplierId?: string | null; offset?: number }) => {
    const params = new URLSearchParams();
    const supplier = next.supplierId === undefined ? supplierId : next.supplierId;
    if (supplier) params.set("supplier", supplier);
    if (next.offset) params.set("offset", String(next.offset));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Supplier price lists</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "price" : "prices"}
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setDialog({ kind: "add" })}>
            <Plus data-icon="inline-start" /> Add a price
          </Button>
        )}
      </div>
      {options.suppliers.length > 0 && (
        <Select
          value={supplierId ?? NONE}
          onValueChange={(v) => go({ supplierId: v === NONE ? null : v, offset: 0 })}
        >
          <SelectTrigger aria-label="Supplier" className="w-56">
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

      {prices.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {supplierId ? "No prices for this supplier yet." : "No supplier prices yet."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Supplier</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prices.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-4" data-primary>
                    {p.supplier.name}
                  </TableCell>
                  <TableCell data-label="Item">
                    <span className="font-medium">{p.item.name}</span>{" "}
                    <span className="font-mono text-xs text-muted-foreground">{p.item.code}</span>
                  </TableCell>
                  <TableCell data-label="Price" className="text-right tabular-nums">
                    {formatPrice(p.unitPrice, currency)} / {units[p.unit].label}
                  </TableCell>
                  <TableCell data-label="From">{formatLongDate(p.effectiveFrom)}</TableCell>
                  <TableCell data-label="To">
                    {p.effectiveTo ? formatLongDate(p.effectiveTo) : "Until replaced"}{" "}
                    {p.inForce && (
                      <Badge className="border-transparent bg-label-green-bg text-label-green">
                        In force
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell data-label="Notes" className="whitespace-normal text-muted-foreground">
                    {p.notes ?? ""}
                  </TableCell>
                  <TableCell className="pr-4 text-right whitespace-nowrap">
                    {canWrite && (
                      <>
                        {(p.effectiveTo === null || p.inForce) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDialog({ kind: "end", price: p })}
                          >
                            <CalendarX data-icon="inline-start" /> End
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove price"
                          onClick={() => setDialog({ kind: "delete", price: p })}
                        >
                          <Trash2 />
                        </Button>
                      </>
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
          {offset + 1}–{Math.min(offset + prices.length, total)} of {total}
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

      {dialog?.kind === "add" && (
        <AddPriceDialog
          slug={slug}
          options={options}
          supplierId={supplierId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "end" && (
        <EndPriceDialog slug={slug} price={dialog.price} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <DeletePriceDialog slug={slug} price={dialog.price} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function AddPriceDialog({
  slug,
  options,
  supplierId: initialSupplier,
  onClose,
}: {
  slug: string;
  options: OrderOptions;
  supplierId: string | null;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [supplierId, setSupplierId] = useState(initialSupplier ?? options.suppliers[0]?.id ?? NONE);
  const [itemId, setItemId] = useState(options.items[0]?.id ?? NONE);
  const item = options.items.find((i) => i.id === itemId);
  const [unit, setUnit] = useState<UnitCode | null>(null);
  const unitChoices: UnitCode[] = item ? unitsForItem(item) : [];
  const chosenUnit = unit && unitChoices.includes(unit) ? unit : (item?.unit ?? "kg");
  const [price, setPrice] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const value = parseNumber(price);
  const invalid =
    supplierId === NONE ||
    itemId === NONE ||
    value === null ||
    value < 0 ||
    !from ||
    (to !== "" && to < from);
  return (
    <HaccpDialog
      title="Add a supplier price"
      description="The price applies from the date given until it is replaced or ended. Only one price per supplier and item can start on a given day."
      submitLabel="Add price"
      disabled={invalid}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi().prices.$post({
            param: { slug },
            json: {
              supplierId,
              itemId,
              unit: chosenUnit,
              unitPrice: value!,
              effectiveFrom: from,
              effectiveTo: to || null,
              notes: notes.trim() || null,
            },
          }),
        );
        return "Price added";
      }}
    >
      <SelectField
        id="price-supplier"
        label="Supplier"
        value={supplierId}
        onChange={setSupplierId}
        options={
          options.suppliers.length
            ? options.suppliers.map((s) => [s.id, s.name] as const)
            : [[NONE, "No suppliers"]]
        }
      />
      <SelectField
        id="price-item"
        label="Item"
        value={itemId}
        onChange={(v) => {
          setItemId(v);
          setUnit(null);
        }}
        options={
          options.items.length
            ? options.items.map((i) => [i.id, `${i.code} ${i.name}`] as const)
            : [[NONE, "No items"]]
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="price-value">Price</FieldLabel>
          <Input
            id="price-value"
            inputMode="decimal"
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <SelectField
          id="price-unit"
          label="Per"
          value={chosenUnit}
          onChange={(v) => setUnit(v as UnitCode)}
          options={(unitChoices.length ? unitChoices : [chosenUnit]).map((u) => [u, units[u].label] as const)}
        />
        <Field>
          <FieldLabel htmlFor="price-from">Effective from</FieldLabel>
          <Input
            id="price-from"
            type="date"
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="price-to">Effective to</FieldLabel>
          <Input id="price-to" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          <FieldDescription>Optional; the last day it applies.</FieldDescription>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="price-notes">Notes</FieldLabel>
        <Input id="price-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </HaccpDialog>
  );
}

function EndPriceDialog({
  slug,
  price: p,
  onClose,
}: {
  slug: string;
  price: SupplierPriceRow;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  const today = useWorkspaceToday();
  const [to, setTo] = useState(p.effectiveTo && p.effectiveTo >= p.effectiveFrom ? p.effectiveTo : today);
  return (
    <HaccpDialog
      title={`End the price of ${p.item.name}`}
      description={`${p.supplier.name}: ${formatPrice(p.unitPrice, currency)} / ${units[p.unit].label} from ${formatLongDate(p.effectiveFrom)}. After the date you give, a new order line from this supplier no longer takes this price; orders already raised keep theirs.`}
      submitLabel="End price"
      disabled={!to || to < p.effectiveFrom}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi().prices[":id"].$patch({
            param: { slug, id: p.id },
            json: { effectiveTo: to },
          }),
        );
        return "Price ended";
      }}
    >
      <Field>
        <FieldLabel htmlFor="end-to">Last day it applies</FieldLabel>
        <Input
          id="end-to"
          type="date"
          required
          min={p.effectiveFrom}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function DeletePriceDialog({
  slug,
  price: p,
  onClose,
}: {
  slug: string;
  price: SupplierPriceRow;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  return (
    <HaccpDialog
      title="Remove this price"
      description="For a price entered in error; to stop using a price, end it instead so the history stays. Lines already on orders keep the price they were given."
      submitLabel="Remove price"
      onClose={onClose}
      onSubmit={async () => {
        await unwrapEmpty(purchasingApi().prices[":id"].$delete({ param: { slug, id: p.id } }));
        return "Price removed";
      }}
    >
      <p className="text-sm text-muted-foreground">
        {p.supplier.name}, {p.item.name}: {formatPrice(p.unitPrice, currency)} / {units[p.unit].label} from{" "}
        {formatLongDate(p.effectiveFrom)}.
      </p>
    </HaccpDialog>
  );
}
