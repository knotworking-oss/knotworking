"use client";

import { useWorkspaceCurrency } from "@/lib/workspace-time";
import { units } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
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
import { BadgeCheck, CopyPlus, Pencil, ReceiptText, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog } from "@/components/haccp-forms";
import { RecordAttachments } from "@/components/record-attachments";
import {
  InvoiceStatusBadge,
  MatchIssues,
  MatchStatusBadge,
  MatchVariance,
} from "@/components/invoice-badges";
import { formatPrice } from "@/components/purchasing-badges";
import { stackedTable } from "@/components/stacked-table";
import type { PurchaseInvoiceDetail, PurchaseInvoiceLine } from "@/lib/api";
import { unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";
import { purchasingApi, Row, type SupplierOption } from "../../purchasing-forms";
import { CreditNoteDialog } from "../../credit-notes/credit-note-dialog";
import { InvoiceDialog } from "../invoice-dialog";

type DialogKind = "edit" | "approve" | "delete" | "revise" | "credit";

/** One supplier invoice: header, the three-way match line by line, versions, and its actions. */
export function InvoiceDetailView({
  slug,
  invoice: inv,
  suppliers,
}: {
  slug: string;
  invoice: PurchaseInvoiceDetail;
  suppliers: SupplierOption[];
}) {
  const currency = useWorkspaceCurrency();
  // Times in the workspace's time zone, the same on the server render and in the browser.
  const time = useFormatDateTime();
  const { can } = useWorkspace();
  const canWrite = can("purchasing", "write");
  const canApprove = can("purchasing", "manage");
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const draft = inv.status === "draft";
  const mismatched = inv.lines.filter((l) => l.match?.status === "mismatch");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {inv.supplier.name}
            <InvoiceStatusBadge status={inv.status} version={inv.version} />
            <MatchStatusBadge status={inv.matchStatus} />
          </h2>
          {!draft && inv.matchStatusNow !== inv.matchStatus && (
            <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              Matched as above when approved; the same comparison now:{" "}
              <MatchStatusBadge status={inv.matchStatusNow} />
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Invoice {inv.invoiceNumber} of {formatLongDate(inv.invoiceDate)}
            {inv.dueDate ? ` · due ${formatLongDate(inv.dueDate)}` : ""} · gross{" "}
            {formatPrice(inv.gross, currency)}
          </p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {draft && (
              <>
                <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
                  <Pencil data-icon="inline-start" /> Edit
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDialog("delete")}>
                  <Trash2 data-icon="inline-start" /> Delete draft
                </Button>
              </>
            )}
            {inv.status === "approved" && (
              <Button variant="outline" size="sm" onClick={() => setDialog("credit")}>
                <ReceiptText data-icon="inline-start" /> Credit note
              </Button>
            )}
            {inv.status === "approved" && (
              <Button variant="outline" size="sm" onClick={() => setDialog("revise")}>
                <CopyPlus data-icon="inline-start" /> Correct (new version)
              </Button>
            )}
            {draft && canApprove && (
              <Button size="sm" onClick={() => setDialog("approve")}>
                <BadgeCheck data-icon="inline-start" /> Approve for payment
              </Button>
            )}
          </div>
        )}
      </div>

      {inv.status === "superseded" && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            A later version replaced this one; it is kept as it was approved.{" "}
            {inv.supersededById && (
              <Link className="underline" href={`/${slug}/purchasing/invoices/${inv.supersededById}`}>
                Open the current version
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}
      {mismatched.length > 0 && <MismatchSummary lines={mismatched} draft={draft} />}

      <Card>
        <CardHeader>
          <CardTitle>Invoice</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <Row label="Supplier">{inv.supplier.name}</Row>
            <Row label="Invoice number">
              {inv.invoiceNumber}
              {inv.version > 1 ? ` (version ${inv.version})` : ""}
            </Row>
            <Row label="Orders">
              <span className="inline-flex flex-wrap gap-2">
                {inv.orders.length
                  ? inv.orders.map((o) => (
                      <Link
                        key={o.id}
                        href={`/${slug}/purchasing/orders/${o.id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {o.reference}
                      </Link>
                    ))
                  : "—"}
              </span>
            </Row>
            <Row label="Entered">
              {time(inv.createdAt)} by {inv.createdByName ?? "—"}
            </Row>
            {inv.approvedAt && (
              <Row label="Approved">
                {time(inv.approvedAt)} by {inv.approvedByName ?? "—"} · matched{" "}
                {inv.approvedMatchStatus ? inv.approvedMatchStatus.replace("_", " ") : "—"} then
                {inv.approvalReason ? ` · ${inv.approvalReason}` : ""}
              </Row>
            )}
            {inv.notes && <Row label="Notes">{inv.notes}</Row>}
            <Row label={draft ? "Tolerances" : "Tolerances at approval"}>
              Price {inv.tolerances.pricePercent}% and {formatPrice(inv.tolerances.priceAmount, currency)};
              quantity {inv.tolerances.quantityPercent}% and{" "}
              {formatPrice(inv.tolerances.quantityAmount, currency)}
            </Row>
            {inv.versions.length > 1 && (
              <Row label="Versions">
                <span className="inline-flex flex-wrap gap-3">
                  {inv.versions.map((v) =>
                    v.id === inv.id ? (
                      <span key={v.id} className="font-medium">
                        v{v.version} {v.status}
                      </span>
                    ) : (
                      <Link
                        key={v.id}
                        href={`/${slug}/purchasing/invoices/${v.id}`}
                        className="hover:underline"
                      >
                        v{v.version} {v.status}
                      </Link>
                    ),
                  )}
                </span>
              </Row>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card className="gap-0 pb-0">
        <CardHeader className="pb-4">
          <CardTitle>Three-way match</CardTitle>
        </CardHeader>
        <InvoiceMatchTable lines={inv.lines} net={inv.net} vat={inv.vat} gross={inv.gross} slug={slug} />
      </Card>

      <Card>
        <CardContent>
          <RecordAttachments key={inv.status} entityType="purchase_invoice" entityId={inv.id} />
        </CardContent>
      </Card>

      {dialog === "edit" && (
        <InvoiceDialog slug={slug} suppliers={suppliers} invoice={inv} onClose={() => setDialog(null)} />
      )}
      {dialog === "approve" && <ApproveDialog slug={slug} invoice={inv} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog slug={slug} invoice={inv} onClose={() => setDialog(null)} />}
      {dialog === "credit" && (
        <CreditNoteDialog
          slug={slug}
          suppliers={suppliers}
          invoice={{ id: inv.id, supplierId: inv.supplierId }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "revise" && <ReviseDialog slug={slug} invoice={inv} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** What doesn't match, line by line: the mismatch view at the top of the page. */
export function MismatchSummary({ lines, draft }: { lines: PurchaseInvoiceLine[]; draft: boolean }) {
  const currency = useWorkspaceCurrency();
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>
        {lines.length} line{lines.length === 1 ? " doesn't" : "s don't"} match
      </AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {lines.map((l) => (
            <li key={l.id}>
              Line {l.lineNo}
              {l.orderLine
                ? ` (${l.orderLine.reference} line ${l.orderLine.lineNo}${l.item ? `, ${l.item.name}` : ""})`
                : ""}
              :{" "}
              {l
                .match!.issues.filter(
                  (i) =>
                    i === "no_order_price" ||
                    i === "price_over_tolerance" ||
                    i === "over_invoiced" ||
                    i === "unit_not_convertible",
                )
                .map((i) =>
                  i === "no_order_price"
                    ? "the order line has no price"
                    : i === "unit_not_convertible"
                      ? `${l.item?.name ?? "the item"} can't be converted to ${l.unit ? units[l.unit].label : "the line's unit"} (set its unit weight or density)`
                      : i === "price_over_tolerance"
                        ? `price ${formatPrice(l.unitPrice, currency)} against ${formatPrice(l.orderLine?.unitPrice ?? 0, currency)} ordered`
                        : `${l.quantity} invoiced, ${l.match!.uninvoiced} received and not yet invoiced`,
                )
                .join("; ")}
            </li>
          ))}
        </ul>
        {draft && <p className="mt-1">Approving it needs a reason.</p>}
      </AlertDescription>
    </Alert>
  );
}

/** The invoice's lines with the order, what was received, the variances and each line's match. */
export function InvoiceMatchTable({
  lines,
  net,
  vat,
  gross,
  slug,
}: {
  lines: PurchaseInvoiceLine[];
  net: number;
  vat: number;
  gross: number;
  slug?: string;
}) {
  const currency = useWorkspaceCurrency();
  if (lines.length === 0)
    return (
      <CardContent className="pb-6">
        <p className="text-sm text-muted-foreground">No lines yet. Edit the invoice to add some.</p>
      </CardContent>
    );
  const unit = (l: PurchaseInvoiceLine) => (l.unit ? units[l.unit].label : (l.orderLine?.unitLabel ?? ""));
  return (
    <Table className={stackedTable}>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Line</TableHead>
          <TableHead>Invoiced</TableHead>
          <TableHead>Ordered</TableHead>
          <TableHead>Received</TableHead>
          <TableHead>Price variance</TableHead>
          <TableHead>Quantity variance</TableHead>
          <TableHead>Match</TableHead>
          <TableHead className="pr-4 text-right">Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.id} className={l.match?.status === "mismatch" ? "bg-label-red-bg/40" : undefined}>
            <TableCell className="pl-4" data-primary>
              {l.orderLine ? (
                <>
                  <div className="font-medium">
                    {l.item
                      ? `${l.item.code} ${l.item.name}`
                      : (l.orderLine.description ?? l.description ?? "Item")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {slug ? (
                      <Link
                        href={`/${slug}/purchasing/orders/${l.orderLine.purchaseOrderId}`}
                        className="font-mono hover:underline"
                      >
                        {l.orderLine.reference}
                      </Link>
                    ) : (
                      <span className="font-mono">{l.orderLine.reference}</span>
                    )}{" "}
                    line {l.orderLine.lineNo}
                    {l.orderLine.removed ? " · taken off the order" : ""}
                  </div>
                </>
              ) : (
                <div className="font-medium">{l.description}</div>
              )}
            </TableCell>
            <TableCell data-label="Invoiced" className="tabular-nums">
              {l.quantity} {unit(l)} × {formatPrice(l.unitPrice, currency)}
            </TableCell>
            <TableCell data-label="Ordered" className="tabular-nums">
              {l.orderLine
                ? `${l.orderLine.quantity === null ? "—" : `${l.orderLine.quantity} ${unit(l)}`} × ${l.orderLine.unitPrice === null ? "no price" : formatPrice(l.orderLine.unitPrice, currency)}`
                : "—"}
            </TableCell>
            <TableCell data-label="Received" className="tabular-nums">
              {l.received === null ? (
                l.orderLine ? (
                  <span className="text-xs text-muted-foreground">Doesn&apos;t convert</span>
                ) : (
                  "—"
                )
              ) : (
                <>
                  {l.received} {unit(l)}
                  {(l.invoicedElsewhere ?? 0) > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {l.invoicedElsewhere} already invoiced
                    </div>
                  )}
                </>
              )}
            </TableCell>
            <TableCell data-label="Price variance">
              {l.match ? (
                <MatchVariance
                  value={l.match.priceVariance}
                  percent={l.match.priceVariancePercent}
                  decimals={8}
                />
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell data-label="Quantity variance">
              {l.match ? (
                <MatchVariance value={l.match.quantityVariance} percent={l.match.quantityVariancePercent} />
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell data-label="Match">
              {l.match ? (
                <div className="flex flex-col gap-1">
                  <MatchStatusBadge status={l.match.status} />
                  <MatchIssues issues={l.match.issues} />
                  {l.now && l.now.match.status !== l.match.status && (
                    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                      <span>
                        Now
                        {l.now.received !== null && l.now.received !== l.received
                          ? ` (${l.now.received} ${unit(l)} received)`
                          : ""}
                        :
                      </span>
                      <MatchStatusBadge status={l.now.match.status} />
                    </div>
                  )}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">Charge</span>
              )}
            </TableCell>
            <TableCell data-label="Value" className="pr-4 text-right tabular-nums">
              {formatPrice(l.value, currency)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={7} className="pl-4 text-right">
            Net · VAT · gross
          </TableCell>
          <TableCell className="pr-4 text-right tabular-nums">
            {formatPrice(net, currency)} · {formatPrice(vat, currency)} · {formatPrice(gross, currency)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function ApproveDialog({
  slug,
  invoice: inv,
  onClose,
}: {
  slug: string;
  invoice: PurchaseInvoiceDetail;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  const [reason, setReason] = useState("");
  const mismatch = inv.matchStatus === "mismatch";
  // Charges alone have nothing to match against; the server asks for a reason for those too.
  const chargesOnly = inv.lines.length > 0 && inv.lines.every((l) => l.kind !== "order");
  const needsReason = mismatch || chargesOnly;
  return (
    <HaccpDialog
      title={`Approve invoice ${inv.invoiceNumber}`}
      description={`Approves ${formatPrice(inv.gross, currency)} to ${inv.supplier.name} for payment. Your name and the time are recorded, and the invoice can't change afterwards (a correction is a new version). Its prices become the cost of the lots received against these order lines.`}
      submitLabel="Approve for payment"
      disabled={inv.lines.length === 0 || (needsReason && !reason.trim())}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi().invoices[":id"].approve.$post({
            param: { slug, id: inv.id },
            json: { reason: reason.trim() || null },
          }),
        );
        return `Invoice ${inv.invoiceNumber} approved`;
      }}
    >
      <p className="flex items-center gap-2 text-sm">
        Match now: <MatchStatusBadge status={inv.matchStatus} />
      </p>
      <Field>
        <FieldLabel htmlFor="approve-reason">
          {mismatch ? "Why pay it anyway" : chargesOnly ? "Why pay it" : "Note (optional)"}
        </FieldLabel>
        <Textarea
          id="approve-reason"
          rows={2}
          maxLength={1000}
          required={needsReason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {mismatch && (
          <FieldDescription>
            The invoice doesn&apos;t match its orders and deliveries beyond the tolerances; the reason is kept
            with the approval.
          </FieldDescription>
        )}
        {!mismatch && chargesOnly && (
          <FieldDescription>
            The invoice has only charges, with no order lines to match; the reason is kept with the approval.
          </FieldDescription>
        )}
      </Field>
    </HaccpDialog>
  );
}

function ReviseDialog({
  slug,
  invoice: inv,
  onClose,
}: {
  slug: string;
  invoice: PurchaseInvoiceDetail;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  const router = useRouter();
  return (
    <HaccpDialog
      title={`Correct invoice ${inv.invoiceNumber}`}
      description="Approved invoices don't change. This starts a new draft version with the same lines to correct (a credit or a re-issued invoice). This version stays approved, and in costing, until the new one is approved; then it is marked superseded. Both are kept."
      submitLabel="Draft a new version"
      onClose={onClose}
      onSubmit={async () => {
        const next = await unwrap(
          purchasingApi().invoices[":id"].revise.$post({ param: { slug, id: inv.id } }),
        );
        router.push(`/${slug}/purchasing/invoices/${next.id}`);
        return `Version ${next.version} drafted`;
      }}
    >
      <p className="text-sm text-muted-foreground">
        {inv.linesCount} line{inv.linesCount === 1 ? "" : "s"}, gross {formatPrice(inv.gross, currency)}.
      </p>
    </HaccpDialog>
  );
}

function DeleteDialog({
  slug,
  invoice: inv,
  onClose,
}: {
  slug: string;
  invoice: PurchaseInvoiceDetail;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <HaccpDialog
      title={`Delete invoice ${inv.invoiceNumber}`}
      description="The draft is removed."
      submitLabel="Delete draft"
      onClose={onClose}
      onSubmit={async () => {
        await unwrapEmpty(purchasingApi().invoices[":id"].$delete({ param: { slug, id: inv.id } }));
        router.push(`/${slug}/purchasing/invoices`);
        return `Invoice ${inv.invoiceNumber} deleted`;
      }}
    >
      <p className="text-sm text-muted-foreground">
        {inv.linesCount} line{inv.linesCount === 1 ? "" : "s"} from {inv.supplier.name}.
      </p>
    </HaccpDialog>
  );
}
