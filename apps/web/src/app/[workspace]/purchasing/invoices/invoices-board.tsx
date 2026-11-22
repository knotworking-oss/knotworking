"use client";

import { useWorkspaceCurrency } from "@/lib/workspace-time";
import type { InvoiceTolerances } from "@knotworking/core";
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
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Plus, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog } from "@/components/haccp-forms";
import { InvoiceStatusBadge, MatchStatusBadge } from "@/components/invoice-badges";
import { formatPrice } from "@/components/purchasing-badges";
import { stackedTable } from "@/components/stacked-table";
import type { PurchaseInvoiceRow } from "@/lib/api";
import { unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { NONE, parseNumber, purchasingApi, type SupplierOption } from "../purchasing-forms";
import { InvoiceDialog } from "./invoice-dialog";

export type InvoiceFilter = "current" | "draft" | "approved" | "superseded" | "all";

const filterLabels: Record<InvoiceFilter, string> = {
  current: "Current",
  draft: "Drafts",
  approved: "Approved",
  superseded: "Superseded",
  all: "All",
};

/** The supplier invoice register: filter, search, page; each row opens the invoice and its match. */
export function InvoicesBoard({
  slug,
  status,
  q,
  supplierId,
  orderId,
  page,
  suppliers,
  tolerances,
}: {
  slug: string;
  status: InvoiceFilter;
  q: string;
  supplierId: string | null;
  orderId: string | null;
  page: { invoices: PurchaseInvoiceRow[]; total: number; limit: number; offset: number };
  suppliers: SupplierOption[];
  tolerances: InvoiceTolerances;
}) {
  const currency = useWorkspaceCurrency();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [dialog, setDialog] = useState<"create" | "tolerances" | null>(null);
  const [search, setSearch] = useState(q);
  const go = (next: {
    status?: InvoiceFilter;
    supplierId?: string | null;
    orderId?: string | null;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    const supplier = next.supplierId === undefined ? supplierId : next.supplierId;
    const order = next.orderId === undefined ? orderId : next.orderId;
    if (s !== "current") params.set("status", s);
    if (search.trim()) params.set("q", search.trim());
    if (supplier) params.set("supplier", supplier);
    if (order) params.set("order", order);
    if (next.offset) params.set("offset", String(next.offset));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };
  const { invoices, total, limit, offset } = page;
  const orderRef = orderId
    ? invoices.flatMap((i) => i.orders).find((o) => o.id === orderId)?.reference
    : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Supplier invoices</h2>
          <p className="text-sm text-muted-foreground">
            Tolerance {tolerances.pricePercent}% and {formatPrice(tolerances.priceAmount, currency)} on price,{" "}
            {tolerances.quantityPercent}% and {formatPrice(tolerances.quantityAmount, currency)} on quantity ·{" "}
            {total} {total === 1 ? "invoice" : "invoices"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can("purchasing", "manage") && (
            <Button variant="outline" onClick={() => setDialog("tolerances")}>
              <SlidersHorizontal data-icon="inline-start" /> Tolerances
            </Button>
          )}
          {can("purchasing", "write") && (
            <Button onClick={() => setDialog("create")}>
              <Plus data-icon="inline-start" /> Enter invoice
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={(v) => go({ status: v as InvoiceFilter, offset: 0 })}>
          <TabsList className="max-w-full overflow-x-auto">
            {(Object.keys(filterLabels) as InvoiceFilter[]).map((f) => (
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
            aria-label="Search invoices"
            placeholder="Search invoice number, supplier"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        {suppliers.length > 0 && (
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
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {orderId && (
          <Button variant="outline" size="sm" onClick={() => go({ orderId: null, offset: 0 })}>
            Order {orderRef ?? ""} <X data-icon="inline-end" />
          </Button>
        )}
      </div>

      {invoices.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {q || supplierId || orderId ? "No invoices match." : "No supplier invoices yet."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Invoice</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Orders</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Match</TableHead>
                <TableHead className="pr-4 text-right">Gross</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="pl-4" data-primary>
                    <Link
                      href={`/${slug}/purchasing/invoices/${i.id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {i.invoiceNumber}
                    </Link>
                  </TableCell>
                  <TableCell data-label="Supplier">{i.supplier.name}</TableCell>
                  <TableCell data-label="Date">{formatLongDate(i.invoiceDate)}</TableCell>
                  <TableCell data-label="Orders" className="font-mono text-xs">
                    {i.orders.map((o) => o.reference).join(", ") || "—"}
                  </TableCell>
                  <TableCell data-label="Status">
                    <InvoiceStatusBadge status={i.status} version={i.version} />
                  </TableCell>
                  <TableCell data-label="Match">
                    <MatchStatusBadge status={i.matchStatus} />
                  </TableCell>
                  <TableCell data-label="Gross" className="pr-4 text-right tabular-nums">
                    {formatPrice(i.gross, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {total > limit && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          {offset + 1}–{Math.min(offset + invoices.length, total)} of {total}
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
      {dialog === "create" && (
        <InvoiceDialog
          slug={slug}
          suppliers={suppliers}
          {...(orderId ? { initialOrderId: orderId } : {})}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "tolerances" && (
        <TolerancesDialog slug={slug} tolerances={tolerances} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/** The workspace's match tolerances: a person with manage access sets them. */
function TolerancesDialog({
  slug,
  tolerances,
  onClose,
}: {
  slug: string;
  tolerances: InvoiceTolerances;
  onClose: () => void;
}) {
  const [values, setValues] = useState({
    pricePercent: String(tolerances.pricePercent),
    priceAmount: String(tolerances.priceAmount),
    quantityPercent: String(tolerances.quantityPercent),
    quantityAmount: String(tolerances.quantityAmount),
  });
  const parsed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, parseNumber(v)])) as Record<
    keyof typeof values,
    number | null
  >;
  const bad = Object.values(parsed).some((v) => v === null || v < 0);
  const field = (name: keyof typeof values, label: string) => (
    <Field>
      <FieldLabel htmlFor={`tol-${name}`}>{label}</FieldLabel>
      <Input
        id={`tol-${name}`}
        inputMode="decimal"
        value={values[name]}
        onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
      />
    </Field>
  );
  return (
    <HaccpDialog
      title="Match tolerances"
      description="A difference is within tolerance when it is within both the percentage and the amount; anything beyond is a mismatch, which needs a reason to approve. Amounts are the value of the difference. 0 and 0 accept exact matches only."
      submitLabel="Save"
      disabled={bad}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi()["invoice-settings"].$put({
            param: { slug },
            json: {
              pricePercent: parsed.pricePercent!,
              priceAmount: parsed.priceAmount!,
              quantityPercent: parsed.quantityPercent!,
              quantityAmount: parsed.quantityAmount!,
            },
          }),
        );
        return "Tolerances saved";
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {field("pricePercent", "Price: % of the order price")}
        {field("priceAmount", "Price: amount")}
        {field("quantityPercent", "Quantity: % over received")}
        {field("quantityAmount", "Quantity: amount")}
      </div>
      <FieldDescription>
        Invoicing less than was received is never a mismatch: the rest can come on a later invoice.
      </FieldDescription>
    </HaccpDialog>
  );
}
