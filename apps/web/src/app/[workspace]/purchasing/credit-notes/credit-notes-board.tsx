"use client";

import { purchaseCreditNoteStatusLabels, type PurchaseCreditNoteListStatus } from "@knotworking/core";
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
import { Plus, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { CreditNoteStatusBadge } from "@/components/invoice-badges";
import { formatPrice } from "@/components/purchasing-badges";
import { useWorkspaceCurrency } from "@/lib/workspace-time";
import { stackedTable } from "@/components/stacked-table";
import type { PurchaseCreditNoteRow } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { NONE, type SupplierOption } from "../purchasing-forms";
import { CreditNoteDialog } from "./credit-note-dialog";

const filterLabels: Record<PurchaseCreditNoteListStatus, string> = {
  current: "Current",
  draft: purchaseCreditNoteStatusLabels.draft,
  approved: purchaseCreditNoteStatusLabels.approved,
  voided: purchaseCreditNoteStatusLabels.voided,
  all: "All",
};

/** The supplier credit note register: filter, search, page; each row opens the credit note. */
export function CreditNotesBoard({
  slug,
  status,
  q,
  supplierId,
  invoiceId,
  page,
  suppliers,
}: {
  slug: string;
  status: PurchaseCreditNoteListStatus;
  q: string;
  supplierId: string | null;
  invoiceId: string | null;
  page: { creditNotes: PurchaseCreditNoteRow[]; total: number; limit: number; offset: number };
  suppliers: SupplierOption[];
}) {
  const currency = useWorkspaceCurrency();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(q);
  const go = (next: {
    status?: PurchaseCreditNoteListStatus;
    supplierId?: string | null;
    invoiceId?: string | null;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    const supplier = next.supplierId === undefined ? supplierId : next.supplierId;
    const invoice = next.invoiceId === undefined ? invoiceId : next.invoiceId;
    if (s !== "current") params.set("status", s);
    if (search.trim()) params.set("q", search.trim());
    if (supplier) params.set("supplier", supplier);
    if (invoice) params.set("invoice", invoice);
    if (next.offset) params.set("offset", String(next.offset));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };
  const { creditNotes, total, limit, offset } = page;
  const invoiceNumber = invoiceId
    ? creditNotes.find((c) => c.invoiceId === invoiceId)?.invoice.invoiceNumber
    : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Supplier credit notes</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "credit note" : "credit notes"}
          </p>
        </div>
        {can("purchasing", "write") && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> Draft credit note
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={status}
          onValueChange={(v) => go({ status: v as PurchaseCreditNoteListStatus, offset: 0 })}
        >
          <TabsList className="max-w-full overflow-x-auto">
            {(Object.keys(filterLabels) as PurchaseCreditNoteListStatus[]).map((f) => (
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
            aria-label="Search credit notes"
            placeholder="Search credit note or invoice number, supplier"
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
        {invoiceId && (
          <Button variant="outline" size="sm" onClick={() => go({ invoiceId: null, offset: 0 })}>
            Invoice {invoiceNumber ?? ""} <X data-icon="inline-end" />
          </Button>
        )}
      </div>

      {creditNotes.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {q || supplierId || invoiceId ? "No credit notes match." : "No supplier credit notes yet."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Credit note</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Gross</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {creditNotes.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4" data-primary>
                    <Link
                      href={`/${slug}/purchasing/credit-notes/${c.id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {c.creditNoteNumber}
                    </Link>
                  </TableCell>
                  <TableCell data-label="Supplier">{c.supplier.name}</TableCell>
                  <TableCell data-label="Date">{formatLongDate(c.creditDate)}</TableCell>
                  <TableCell data-label="Invoice">
                    <Link
                      href={`/${slug}/purchasing/invoices/${c.invoice.id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {c.invoice.invoiceNumber}
                    </Link>
                  </TableCell>
                  <TableCell data-label="Status">
                    <CreditNoteStatusBadge status={c.status} />
                  </TableCell>
                  <TableCell data-label="Gross" className="pr-4 text-right tabular-nums">
                    {formatPrice(c.gross, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {total > limit && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          {offset + 1}–{Math.min(offset + creditNotes.length, total)} of {total}
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
      {creating && <CreditNoteDialog slug={slug} suppliers={suppliers} onClose={() => setCreating(false)} />}
    </div>
  );
}
