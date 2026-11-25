"use client";

import { purchaseCreditLineReasonLabels, units } from "@knotworking/core";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { BadgeCheck, Ban, Pencil, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog } from "@/components/haccp-forms";
import { CreditNoteStatusBadge } from "@/components/invoice-badges";
import { formatPrice } from "@/components/purchasing-badges";
import { useWorkspaceCurrency } from "@/lib/workspace-time";
import { stackedTable } from "@/components/stacked-table";
import type { PurchaseCreditNoteDetail } from "@/lib/api";
import { unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";
import { purchasingApi, Row, type SupplierOption } from "../../purchasing-forms";
import { CreditNoteDialog } from "../credit-note-dialog";

type DialogKind = "edit" | "approve" | "void" | "delete";

/** One supplier credit note: its lines against the invoice, and the actions its status allows. */
export function CreditNoteDetailView({
  slug,
  creditNote: cn,
  suppliers,
}: {
  slug: string;
  creditNote: PurchaseCreditNoteDetail;
  suppliers: SupplierOption[];
}) {
  const currency = useWorkspaceCurrency();
  const time = useFormatDateTime();
  const { can } = useWorkspace();
  const canWrite = can("purchasing", "write");
  // Approving and voiding are a signed-in person's acts, with manage access.
  const canDecide = can("purchasing", "manage");
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const draft = cn.status === "draft";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {cn.supplier.name}
            <CreditNoteStatusBadge status={cn.status} />
          </h2>
          <p className="text-sm text-muted-foreground">
            Credit note {cn.creditNoteNumber} of {formatLongDate(cn.creditDate)} · gross{" "}
            {formatPrice(cn.gross, currency)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && draft && (
            <>
              <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
                <Pencil data-icon="inline-start" /> Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDialog("delete")}>
                <Trash2 data-icon="inline-start" /> Delete draft
              </Button>
            </>
          )}
          {canDecide && draft && (
            <Button size="sm" onClick={() => setDialog("approve")}>
              <BadgeCheck data-icon="inline-start" /> Approve
            </Button>
          )}
          {canDecide && cn.status === "approved" && (
            <Button variant="outline" size="sm" onClick={() => setDialog("void")}>
              <Ban data-icon="inline-start" /> Void
            </Button>
          )}
        </div>
      </div>

      {cn.status === "voided" && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            Voided {cn.voidedAt ? time(cn.voidedAt) : ""} by {cn.voidedByName ?? "—"}: {cn.voidReason}. It no
            longer counts anywhere; its number can be used again.
          </AlertDescription>
        </Alert>
      )}
      {cn.invoice.status === "superseded" && cn.status !== "voided" && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            The invoice it credits has been superseded by a correction, so this credit note can no longer be
            approved.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Credit note</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <Row label="Supplier">{cn.supplier.name}</Row>
            <Row label="Credit note number">{cn.creditNoteNumber}</Row>
            <Row label="Invoice credited">
              <Link
                href={`/${slug}/purchasing/invoices/${cn.invoice.id}`}
                className="font-mono text-xs hover:underline"
              >
                {cn.invoice.invoiceNumber}
                {cn.invoice.version > 1 ? ` (version ${cn.invoice.version})` : ""}
              </Link>
            </Row>
            <Row label="Entered">
              {time(cn.createdAt)} by {cn.createdByName ?? "—"}
            </Row>
            {cn.approvedAt && (
              <Row label="Approved">
                {time(cn.approvedAt)} by {cn.approvedByName ?? "—"}
              </Row>
            )}
            {cn.notes && <Row label="Notes">{cn.notes}</Row>}
          </dl>
        </CardContent>
      </Card>

      <Card className="gap-0 pb-0">
        <CardHeader className="pb-4">
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        {cn.lines.length === 0 ? (
          <CardContent className="pb-6">
            <p className="text-sm text-muted-foreground">No lines yet. Edit the credit note to add some.</p>
          </CardContent>
        ) : (
          <Table className={stackedTable}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Credits</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Per unit</TableHead>
                <TableHead>Invoiced</TableHead>
                <TableHead className="pr-4 text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cn.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="pl-4" data-primary>
                    {l.invoiceLine ? (
                      <>
                        <div className="font-medium">
                          {l.invoiceLine.item
                            ? `${l.invoiceLine.item.code} ${l.invoiceLine.item.name}`
                            : (l.invoiceLine.description ?? "Item")}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Invoice line {l.invoiceLine.lineNo}
                          {l.invoiceLine.orderReference ? `· ${l.invoiceLine.orderReference}` : ""}
                        </div>
                      </>
                    ) : (
                      <div className="font-medium">{l.description}</div>
                    )}
                  </TableCell>
                  <TableCell data-label="Reason">
                    {l.reason ? purchaseCreditLineReasonLabels[l.reason] : "Charge"}
                  </TableCell>
                  <TableCell data-label="Quantity" className="text-right tabular-nums">
                    {l.quantity} {l.unit ? units[l.unit].label : (l.unitLabel ?? "")}
                  </TableCell>
                  <TableCell data-label="Per unit" className="text-right tabular-nums">
                    {formatPrice(l.unitPrice, currency)}
                  </TableCell>
                  <TableCell data-label="Invoiced" className="tabular-nums">
                    {l.invoiceLine
                      ? `${l.invoiceLine.quantity} × ${formatPrice(l.invoiceLine.unitPrice, currency)}`
                      : "—"}
                  </TableCell>
                  <TableCell data-label="Value" className="pr-4 text-right tabular-nums">
                    {formatPrice(l.value, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={5} className="pl-4 text-right">
                  Net · VAT · gross
                </TableCell>
                <TableCell className="pr-4 text-right tabular-nums">
                  {formatPrice(cn.net, currency)} · {formatPrice(cn.vat, currency)} ·{" "}
                  {formatPrice(cn.gross, currency)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </Card>

      {dialog === "edit" && (
        <CreditNoteDialog slug={slug} suppliers={suppliers} creditNote={cn} onClose={() => setDialog(null)} />
      )}
      {dialog === "approve" && <ApproveDialog slug={slug} creditNote={cn} onClose={() => setDialog(null)} />}
      {dialog === "void" && <VoidDialog slug={slug} creditNote={cn} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog slug={slug} creditNote={cn} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ApproveDialog({
  slug,
  creditNote: cn,
  onClose,
}: {
  slug: string;
  creditNote: PurchaseCreditNoteDetail;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  return (
    <HaccpDialog
      title={`Approve credit note ${cn.creditNoteNumber}`}
      description={`Approves a credit of ${formatPrice(cn.gross, currency)} from ${cn.supplier.name}. Your name and the time are recorded and it can't change afterwards. Its credits lower the cost of the lots received against the credited invoice lines; a wrong one is voided and entered again.`}
      submitLabel="Approve"
      disabled={cn.lines.length === 0}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(purchasingApi()["credit-notes"][":id"].approve.$post({ param: { slug, id: cn.id } }));
        return `Credit note ${cn.creditNoteNumber} approved`;
      }}
    >
      <p className="text-sm text-muted-foreground">
        {cn.linesCount} line{cn.linesCount === 1 ? "" : "s"} against invoice {cn.invoice.invoiceNumber}.
      </p>
    </HaccpDialog>
  );
}

function VoidDialog({
  slug,
  creditNote: cn,
  onClose,
}: {
  slug: string;
  creditNote: PurchaseCreditNoteDetail;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <HaccpDialog
      title={`Void credit note ${cn.creditNoteNumber}`}
      description="For a credit note entered in error. It stays on record with who voided it and why, no longer counts in costing, and its number can be used again."
      submitLabel="Void credit note"
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi()["credit-notes"][":id"].void.$post({
            param: { slug, id: cn.id },
            json: { reason: reason.trim() },
          }),
        );
        return `Credit note ${cn.creditNoteNumber} voided`;
      }}
    >
      <Field>
        <FieldLabel htmlFor="void-reason">Why</FieldLabel>
        <Textarea
          id="void-reason"
          required
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function DeleteDialog({
  slug,
  creditNote: cn,
  onClose,
}: {
  slug: string;
  creditNote: PurchaseCreditNoteDetail;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <HaccpDialog
      title={`Delete credit note ${cn.creditNoteNumber}`}
      description="The draft is removed."
      submitLabel="Delete draft"
      onClose={onClose}
      onSubmit={async () => {
        await unwrapEmpty(purchasingApi()["credit-notes"][":id"].$delete({ param: { slug, id: cn.id } }));
        router.push(`/${slug}/purchasing/credit-notes`);
        return `Credit note ${cn.creditNoteNumber} deleted`;
      }}
    >
      <p className="text-sm text-muted-foreground">
        {cn.linesCount} line{cn.linesCount === 1 ? "" : "s"} from {cn.supplier.name}.
      </p>
    </HaccpDialog>
  );
}
