"use client";

import { useWorkspaceCurrency } from "@/lib/workspace-time";
import { RecordAttachments, RecordFilesButton } from "@/components/record-attachments";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { Alert, AlertDescription } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
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
import {
  Ban,
  PackageCheck,
  Pencil,
  Printer,
  ReceiptText,
  Mail,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Lock,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HaccpDialog } from "@/components/haccp-forms";
import { SupplierApprovalBadge } from "@/components/item-badges";
import {
  formatLineAmount,
  lineTitle,
  lineUnitLabel,
  formatPrice,
  LineReceiptStateBadge,
  OverdueBadge,
  PurchaseOrderStateBadge,
  ReceiptOutcomeBadge,
} from "@/components/purchasing-badges";
import { stackedTable } from "@/components/stacked-table";
import type { PurchaseDeliveryReceipt, PurchaseOrderDetail } from "@/lib/api";
import { ApiError, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { OrderDialog } from "../../order-dialog";
import { purchasingApi, Row, type OrderOptions } from "../../purchasing-forms";
import { ReceiveDialog } from "./receive-dialog";
import { useFormatDateTime } from "@/lib/workspace-time";

type DialogKind = "edit" | "send" | "receive" | "close" | "cancel" | "delete" | "approve" | "email";

/** One purchase order: header, lines against what arrived, deliveries, and the actions its state allows. */
export function OrderDetailView({
  slug,
  order: o,
  options,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  options: OrderOptions;
}) {
  const currency = useWorkspaceCurrency();
  const time = useFormatDateTime();
  const { can } = useWorkspace();
  const canWrite = can("purchasing", "write");
  const canSend = can("purchasing", "manage");
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [voiding, setVoiding] = useState<PurchaseDeliveryReceipt | null>(null);
  const draft = o.status === "draft";
  const sent = o.status === "sent";
  // Everything has arrived: closing is the next step (more can still be received: over-delivery).
  const done = o.state === "received";
  const anyAccepted = o.lines.some((l) => l.received.base > 0);
  const deliveries = o.deliveries;
  const anyReversed = deliveries.some((d) => d.receipts.some((r) => r.reversed));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {o.supplier.name}
            <PurchaseOrderStateBadge state={o.state} />
            {o.overdue && <OverdueBadge />}
          </h2>
          <p className="text-sm text-muted-foreground">
            {o.orderedOn ? `Ordered ${formatLongDate(o.orderedOn)}` : "Not sent yet"}
            {o.nextExpectedOn ? ` · expected ${formatLongDate(o.nextExpectedOn)}` : ""} · {o.linesCount} line
            {o.linesCount === 1 ? "" : "s"}
            {o.linesCount > 0 && (
              <>
                {" "}
                · value {formatPrice(o.value, currency)}
                {o.valueComplete ? "" : " (some lines have no price)"}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/${slug}/purchasing/orders/${o.id}/print`}>
              <Printer data-icon="inline-start" /> Print
            </Link>
          </Button>
          {(sent || o.status === "closed") && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/${slug}/purchasing/invoices?order=${o.id}&status=all`}>
                <ReceiptText data-icon="inline-start" /> Invoices
              </Link>
            </Button>
          )}
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {(draft || sent) && (
              <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
                <Pencil data-icon="inline-start" /> Edit
              </Button>
            )}
            {sent && (
              <Button variant={done ? "default" : "outline"} size="sm" onClick={() => setDialog("close")}>
                <Lock data-icon="inline-start" /> Close
              </Button>
            )}
            {(draft || (sent && !anyAccepted)) && (
              <Button variant="outline" size="sm" onClick={() => setDialog("cancel")}>
                <Ban data-icon="inline-start" /> Cancel order
              </Button>
            )}
            {draft && (
              <Button variant="outline" size="sm" onClick={() => setDialog("delete")}>
                <Trash2 data-icon="inline-start" /> Delete draft
              </Button>
            )}
            {draft && canSend && (o.sendApproval.state === "needed" || o.sendApproval.state === "stale") && (
              <Button variant="outline" size="sm" onClick={() => setDialog("approve")}>
                <ShieldCheck data-icon="inline-start" /> Approve to send
              </Button>
            )}
            {sent && canSend && (
              <Button variant="outline" size="sm" onClick={() => setDialog("email")}>
                <Mail data-icon="inline-start" /> Email supplier
              </Button>
            )}
            {draft && canSend && (
              <Button size="sm" onClick={() => setDialog("send")}>
                <Send data-icon="inline-start" /> Send
              </Button>
            )}
            {sent && (
              <Button variant={done ? "outline" : "default"} size="sm" onClick={() => setDialog("receive")}>
                <PackageCheck data-icon="inline-start" /> Receive delivery
              </Button>
            )}
          </div>
        )}
      </div>

      {draft && (o.sendApproval.state === "needed" || o.sendApproval.state === "stale") && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {o.sendApproval.state === "stale"
              ? "This order is worth more than it was approved for."
              : `This order is above the approval threshold (${formatPrice(o.sendApproval.threshold ?? 0, currency)}).`}{" "}
            A manager other than whoever raised it has to approve it before it can be sent.
          </AlertDescription>
        </Alert>
      )}
      {o.supplierQuality && o.supplierQuality.open > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {o.supplier.name} has {o.supplierQuality.open} open non-conformance
            {o.supplierQuality.open === 1 ? "" : "s"}
            {o.supplierQuality.suggest
              ? ` (${o.supplierQuality.reasons.join(", ")}): consider reviewing its approval`
              : ""}
            . This is a warning only; nothing is blocked.{" "}
            <Link className="underline" href={`/${slug}/quality/nonconformances`}>
              Quality records
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {o.emails.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Emailed to supplier:{" "}
          {o.emails
            .map((e) => `${e.status === "sent" ? "sent" : "failed"} to ${e.toEmail} (${time(e.createdAt)})`)
            .join("; ")}
        </p>
      )}
      {o.supplier.approvalStatus !== "approved" && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {o.supplier.approvalStatus === "pending"
              ? `${o.supplier.name} is pending approval: deliveries go into quarantine until QA releases them.`
              : `${o.supplier.name} is ${o.supplier.approvalStatus}: the order can't be sent or received until the supplier is approved again.`}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Order</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
            <Row label="Supplier">
              <span className="inline-flex flex-wrap items-center gap-2">
                <Link href={`/${slug}/suppliers`} className="hover:underline">
                  {o.supplier.name}
                </Link>
                {o.supplier.code && (
                  <span className="font-mono text-xs text-muted-foreground">{o.supplier.code}</span>
                )}
                <SupplierApprovalBadge status={o.supplier.approvalStatus} />
              </span>
            </Row>
            <Row label="Supplier's reference">{o.supplierReference ?? "—"}</Row>
            <Row label="Expected">{o.expectedOn ? formatLongDate(o.expectedOn) : "Per line"}</Row>
            {options.stock && <Row label="Deliver to">{o.deliveryLocation?.name ?? "—"}</Row>}
            <Row label="Drafted">
              {time(o.createdAt)} by {o.createdByName ?? "—"}
            </Row>
            {o.sentAt && (
              <Row label="Sent">
                {time(o.sentAt)} by {o.sentByName ?? "—"}
                {o.sendControlsOverride && (
                  <div className="text-xs text-muted-foreground">
                    Sent despite open supplier control issues: {o.sendControlsOverride.reason} (overrode:{" "}
                    {o.sendControlsOverride.issues.join("; ")})
                  </div>
                )}
              </Row>
            )}
            {o.closedAt && (
              <Row label="Closed">
                {time(o.closedAt)} by {o.closedByName ?? "—"} · {o.closeReason}
              </Row>
            )}
            {o.cancelledAt && (
              <Row label="Cancelled">
                {time(o.cancelledAt)} by {o.cancelledByName ?? "—"} · {o.cancelReason}
              </Row>
            )}
            {o.notes && <Row label="Notes">{o.notes}</Row>}
          </dl>
        </CardContent>
      </Card>

      <Card className="gap-0 pb-0">
        <CardHeader className="pb-4">
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        {o.lines.length === 0 ? (
          <CardContent className="pb-6">
            <p className="text-sm text-muted-foreground">No lines yet. Edit the order to add some.</p>
          </CardContent>
        ) : (
          <div className="overflow-x-auto border-t">
            <Table className={stackedTable}>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Item</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                  <TableHead className="text-right">Outstanding</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead className="pr-4">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.lines.map((l) => (
                  <TableRow key={l.id} className="align-top">
                    <TableCell className="pl-4 whitespace-normal" data-primary>
                      <span className="text-muted-foreground tabular-nums">{l.lineNo}.</span>{" "}
                      <span className="font-medium">{lineTitle(l)}</span>{" "}
                      {l.item && (
                        <span className="font-mono text-xs text-muted-foreground">{l.item.code}</span>
                      )}
                      {l.kind === "non_stock" && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Non-stock{l.nominalCode ? ` · nominal code ${l.nominalCode}` : ""}
                        </div>
                      )}
                      {l.kind === "stock" && !l.supplierListed && (
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-label-orange">
                          <TriangleAlert className="size-3" /> Not listed as supplied by {o.supplier.name}
                        </div>
                      )}
                      {l.notes && <div className="text-xs text-muted-foreground">{l.notes}</div>}
                    </TableCell>
                    <TableCell data-label="Ordered" className="text-right tabular-nums">
                      {formatLineAmount(l.ordered, l.unit)}
                    </TableCell>
                    <TableCell data-label="Received" className="text-right tabular-nums">
                      {l.received.base > 0 ? formatLineAmount(l.received, l.unit) : "—"}
                    </TableCell>
                    <TableCell
                      data-label="Rejected"
                      className={`text-right tabular-nums ${l.rejected.base > 0 ? "text-label-red" : ""}`}
                    >
                      {l.rejected.base > 0 ? formatLineAmount(l.rejected, l.unit) : "—"}
                    </TableCell>
                    <TableCell data-label="Outstanding" className="text-right tabular-nums">
                      {l.outstanding.base > 0 && o.status !== "cancelled" ? (
                        <span
                          className={o.status === "closed" ? "text-muted-foreground" : undefined}
                          title={o.status === "closed" ? "Closed short: no longer expected" : undefined}
                        >
                          {formatLineAmount(l.outstanding, l.unit)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell data-label="Price" className="text-right tabular-nums">
                      {l.unitPrice === null ? (
                        <span className="text-muted-foreground">Unknown</span>
                      ) : (
                        `${formatPrice(l.unitPrice, currency)}${lineUnitLabel(l) ? ` / ${lineUnitLabel(l)}` : ""}`
                      )}
                    </TableCell>
                    <TableCell data-label="Value" className="text-right tabular-nums">
                      {l.lineValue === null ? "—" : formatPrice(l.lineValue, currency)}
                    </TableCell>
                    <TableCell data-label="Expected">
                      <span className={l.overdue ? "text-label-red" : undefined}>
                        {l.effectiveExpectedOn ? formatLongDate(l.effectiveExpectedOn) : "—"}
                      </span>
                      {l.promiseMoved && l.promisedOn && (
                        <div
                          className="text-xs text-muted-foreground"
                          title="The date promised when the order was sent: supplier performance measures against it"
                        >
                          Promised {formatLongDate(l.promisedOn)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell data-label="State" className="pr-4">
                      <span className="inline-flex flex-wrap gap-1">
                        <LineReceiptStateBadge state={l.state} />
                        {l.overdue && <OverdueBadge />}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter className="max-md:hidden">
                <TableRow>
                  <TableCell className="pl-4" colSpan={6}>
                    Total
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPrice(o.value, currency)}
                    {!o.valueComplete && <span className="text-muted-foreground">+</span>}
                  </TableCell>
                  <TableCell colSpan={2} className="pr-4 text-xs font-normal text-muted-foreground">
                    {o.valueComplete ? "" : "Some lines have no price"}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deliveries</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing received yet.</p>
          ) : (
            [...deliveries].reverse().map((d) => (
              <div key={d.deliveryId} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {formatLongDate(d.receivedOn)}
                    {d.deliveryReference && (
                      <span className="font-normal text-muted-foreground"> · note {d.deliveryReference}</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Recorded {time(d.createdAt)} by {d.actorName ?? "—"}
                  </span>
                </div>
                {d.notes && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{d.notes}</p>}
                {d.receipts[0] && (
                  <div>
                    {/* A delivery's files hang on its first receipt row. */}
                    <RecordFilesButton
                      entityType="purchase_receipt"
                      entityId={d.receipts[0].id}
                      title="Delivery files"
                      description={`${formatLongDate(d.receivedOn)}${d.deliveryReference ? `, note ${d.deliveryReference}` : ""}: delivery note, photos of the load.`}
                      label="Delivery note and photos"
                    />
                  </div>
                )}
                <ul className="flex flex-col divide-y text-sm">
                  {d.receipts.map((r) => {
                    const line = o.lines.find((l) => l.id === r.lineId);
                    const amount = line
                      ? formatLineAmount(r.quantity, line.unit)
                      : formatLineAmount(r.quantity, null);
                    const name = line ? lineTitle(line) : (r.item?.name ?? "");
                    const struck = r.reversed || r.voided;
                    return (
                      <li
                        key={r.id}
                        className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 ${struck ? "text-muted-foreground" : ""}`}
                      >
                        <ReceiptOutcomeBadge outcome={r.outcome} reversed={r.reversed} voided={r.voided} />
                        <span className={struck ? "line-through" : undefined}>
                          <span className="tabular-nums">{amount}</span> {name}{" "}
                          <span className="text-xs text-muted-foreground">line {r.lineNo}</span>
                        </span>
                        {r.lotId && (
                          <Link
                            href={`/${slug}/stock/lots/${r.lotId}`}
                            className="font-mono text-xs hover:underline"
                          >
                            lot {r.lotCode}
                          </Link>
                        )}
                        {r.reason && (
                          <span className="text-xs text-muted-foreground">Reason: {r.reason}</span>
                        )}
                        {r.overDeliveryReason && (
                          <span className="text-xs text-muted-foreground">
                            Over-delivery: {r.overDeliveryReason}
                          </span>
                        )}
                        {r.reversed && (
                          <span className="text-xs">Reversed on the lot page; no longer counted</span>
                        )}
                        {r.voided && (
                          <span className="text-xs">
                            Voided{r.voidedByName ? ` by ${r.voidedByName}` : ""}
                            {r.voidedAt ? ` (${time(r.voidedAt)})` : ""}: {r.voidReason}; no longer counted
                          </span>
                        )}
                        {(r.outcome === "rejected" || r.kind === "non_stock") && !r.voided && canSend && (
                          <Button variant="ghost" size="sm" onClick={() => setVoiding(r)}>
                            <Ban data-icon="inline-start" />{" "}
                            {r.outcome === "rejected" ? "Void refusal" : "Void receipt"}
                          </Button>
                        )}
                        {/* Photos of this line only; the delivery's own files are above. */}
                        <span className="ml-auto">
                          <RecordFilesButton
                            entityType="purchase_receipt_line"
                            entityId={r.id}
                            title={`Photos: ${name}`}
                            description={`Line ${r.lineNo ?? ""} of the delivery on ${formatLongDate(d.receivedOn)}: photos of this item as it arrived.`}
                            label="Photos"
                          />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
          {anyReversed && (
            <p className="text-xs text-muted-foreground">
              Struck-through receipts were reversed in stock and are left out of what was received.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <RecordAttachments key={o.status} entityType="purchase_order" entityId={o.id} />
        </CardContent>
      </Card>

      {dialog === "edit" && (
        <OrderDialog slug={slug} options={options} order={o} onClose={() => setDialog(null)} />
      )}
      {dialog === "send" && <SendDialog slug={slug} order={o} onClose={() => setDialog(null)} />}
      {dialog === "approve" && <ApproveDialog slug={slug} order={o} onClose={() => setDialog(null)} />}
      {dialog === "email" && <EmailDialog slug={slug} order={o} onClose={() => setDialog(null)} />}
      {dialog === "receive" && (
        <ReceiveDialog
          slug={slug}
          order={o}
          locations={options.locations}
          stock={options.stock}
          onClose={() => setDialog(null)}
        />
      )}
      {(dialog === "close" || dialog === "cancel") && (
        <ReasonDialog slug={slug} order={o} kind={dialog} onClose={() => setDialog(null)} />
      )}
      {voiding && (
        <VoidReceiptDialog slug={slug} order={o} receipt={voiding} onClose={() => setVoiding(null)} />
      )}
      {dialog === "delete" && <DeleteDialog slug={slug} order={o} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SendDialog({
  slug,
  order: o,
  onClose,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [orderedOn, setOrderedOn] = useState(today);
  const [supplierReference, setSupplierReference] = useState(o.supplierReference ?? "");
  // Set when the supplier's open control issues block sending (enforcement `block`).
  const [blockedBy, setBlockedBy] = useState<string[] | null>(null);
  const [override, setOverride] = useState("");
  const missingDate = o.lines.some((l) => !l.effectiveExpectedOn);
  const problem =
    o.lines.length === 0
      ? "Add at least one line before sending."
      : missingDate
        ? "Give the order an expected delivery date (or one on every line) before sending."
        : null;
  return (
    <HaccpDialog
      title={`Send ${o.reference}`}
      description={`Records that the order went to ${o.supplier.name}: a commitment to buy. Your name and the time are recorded. Lines and dates can still be changed afterwards; the supplier can't.`}
      submitLabel="Mark as sent"
      disabled={problem !== null}
      onClose={onClose}
      onSubmit={async () => {
        try {
          await unwrap(
            purchasingApi().orders[":id"].send.$post({
              param: { slug, id: o.id },
              json: {
                orderedOn,
                supplierReference: supplierReference.trim() || null,
                ...(blockedBy ? { controlsOverride: override.trim() } : {}),
              },
            }),
          );
        } catch (err) {
          // Show the issues and ask for an override reason; the error message is toasted too.
          if (err instanceof ApiError && err.code === "supplier_controls_open")
            setBlockedBy((err.details as { issues?: string[] } | undefined)?.issues ?? []);
          throw err;
        }
        return `${o.reference} sent`;
      }}
    >
      {problem && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor="send-on">Ordered on</FieldLabel>
        <Input
          id="send-on"
          type="date"
          required
          max={today}
          value={orderedOn}
          onChange={(e) => setOrderedOn(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="send-ref">Supplier&apos;s reference</FieldLabel>
        <Input
          id="send-ref"
          maxLength={120}
          placeholder="Their order confirmation number"
          value={supplierReference}
          onChange={(e) => setSupplierReference(e.target.value)}
        />
        <FieldDescription>Optional; it can be added later.</FieldDescription>
      </Field>
      {blockedBy && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            <div>{o.supplier.name} has open supplier control issues:</div>
            <ul className="list-disc pl-5">
              {blockedBy.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {blockedBy && (
        <Field>
          <FieldLabel htmlFor="send-override">Send anyway because</FieldLabel>
          <Textarea
            id="send-override"
            required
            maxLength={2000}
            placeholder="e.g. Urgent: the line stops without it"
            value={override}
            onChange={(e) => setOverride(e.target.value)}
          />
          <FieldDescription>Recorded on the order with these issues.</FieldDescription>
        </Field>
      )}
    </HaccpDialog>
  );
}

function ApproveDialog({
  slug,
  order: o,
  onClose,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  onClose: () => void;
}) {
  const currency = useWorkspaceCurrency();
  const [note, setNote] = useState("");
  return (
    <HaccpDialog
      title={`Approve ${o.reference} for sending`}
      description={`Worth ${formatPrice(o.value, currency)}. Your name and the time are recorded; the approval covers this value and goes stale if the order grows.`}
      submitLabel="Approve"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi().orders[":id"].approve.$post({
            param: { slug, id: o.id },
            json: { note: note.trim() || null },
          }),
        );
        return `${o.reference} approved for sending`;
      }}
    >
      <Field>
        <FieldLabel htmlFor="approve-note">Note</FieldLabel>
        <Textarea
          id="approve-note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function EmailDialog({
  slug,
  order: o,
  onClose,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  onClose: () => void;
}) {
  const [to, setTo] = useState(o.supplier.email ?? "");
  const [message, setMessage] = useState("");
  return (
    <HaccpDialog
      title={`Email ${o.reference} to ${o.supplier.name}`}
      description="Sends a summary of the order (no links) and logs it on the order."
      submitLabel="Send email"
      disabled={!to.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const res = await unwrap(
          purchasingApi().orders[":id"].email.$post({
            param: { slug, id: o.id },
            json: { to: to.trim(), message: message.trim() || null },
          }),
        );
        if (!res.emailed) throw new Error(res.mailError ?? "The email wasn't sent");
        return `${o.reference} emailed to ${res.to}`;
      }}
    >
      <Field>
        <FieldLabel htmlFor="email-to">To</FieldLabel>
        <Input id="email-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="email-message">Covering note</FieldLabel>
        <Textarea
          id="email-message"
          rows={2}
          maxLength={1000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

function ReasonDialog({
  slug,
  order: o,
  kind,
  onClose,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  kind: "close" | "cancel";
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const close = kind === "close";
  const outstanding = o.lines.filter((l) => l.outstanding.base > 0).length;
  return (
    <HaccpDialog
      title={`${close ? "Close" : "Cancel"} ${o.reference}`}
      description={
        close
          ? `Nothing more is expected from ${o.supplier.name}.${outstanding ? ` ${outstanding} line${outstanding === 1 ? " is" : "s are"} still short and will count as not delivered in full.` : ""} Deliveries already received stay.`
          : "The order is called off: nothing was or will be received against it. It stays on record."
      }
      submitLabel={close ? "Close order" : "Cancel order"}
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const api = purchasingApi().orders[":id"];
        const request = { param: { slug, id: o.id }, json: { reason: reason.trim() } };
        await unwrap(close ? api.close.$post(request) : api.cancel.$post(request));
        return `${o.reference} ${close ? "closed" : "cancelled"}`;
      }}
    >
      <Field>
        <FieldLabel htmlFor="reason">Why</FieldLabel>
        <Textarea
          id="reason"
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

function VoidReceiptDialog({
  slug,
  order: o,
  receipt: r,
  onClose,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  receipt: PurchaseDeliveryReceipt;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <HaccpDialog
      title={
        r.outcome === "rejected"
          ? `Void the refusal of ${r.item?.name ?? "this line"}`
          : `Void the receipt of line ${r.lineNo}`
      }
      description={
        r.outcome === "rejected"
          ? `For a refusal recorded in error on ${o.reference}. It stays on the order, struck through, and no longer counts against ${o.supplier.name} in supplier performance. Record the right delivery separately.`
          : `For a non-stock receipt recorded in error on ${o.reference}. It stays on the order, struck through, and no longer counts as received, in invoice matching or in supplier performance. Record the right delivery separately.`
      }
      submitLabel={r.outcome === "rejected" ? "Void refusal" : "Void receipt"}
      disabled={!reason.trim()}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          purchasingApi().orders[":id"].receipts[":receiptId"].void.$post({
            param: { slug, id: o.id, receiptId: r.id },
            json: { reason: reason.trim() },
          }),
        );
        return "Refusal voided";
      }}
    >
      <Field>
        <FieldLabel htmlFor="void-receipt-reason">Why it was recorded in error</FieldLabel>
        <Textarea
          id="void-receipt-reason"
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
  order: o,
  onClose,
}: {
  slug: string;
  order: PurchaseOrderDetail;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <HaccpDialog
      title={`Delete ${o.reference}`}
      description="The draft is removed. Its reference is not reused."
      submitLabel="Delete draft"
      onClose={onClose}
      onSubmit={async () => {
        await unwrapEmpty(purchasingApi().orders[":id"].$delete({ param: { slug, id: o.id } }));
        router.push(`/${slug}/purchasing?status=draft`);
        return `${o.reference} deleted`;
      }}
    >
      <p className="text-sm text-muted-foreground">
        {o.linesCount} line{o.linesCount === 1 ? "" : "s"} for {o.supplier.name}.
      </p>
    </HaccpDialog>
  );
}
