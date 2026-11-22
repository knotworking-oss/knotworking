"use client";

import {
  lotStatuses,
  lotStatusLabels,
  stockMovementTypeLabels,
  unitCodes,
  units,
  type LotStatus,
  type UnitCode,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { ArrowLeftRight, Printer, ShieldCheck, SlidersHorizontal, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { SupplierApprovalBadge } from "@/components/item-badges";
import { ExpiryBadge, formatAmount, LotStatusBadge } from "@/components/stock-badges";
import { ReleaseChecklist } from "@/components/release-check";
import type {
  LotRelease,
  LotReleaseCheck,
  LotReleaseExceptionRequest,
  StockLocation,
  StockLotDetail,
} from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

type Movement = StockLotDetail["movements"][number];
type Action =
  | { kind: "transfer" | "waste" | "adjust" }
  | { kind: "status" }
  | { kind: "reverse"; movement: Movement }
  | { kind: "reject-exception"; request: LotReleaseExceptionRequest };

/** Consumption and production movements are posted, and corrected, by production batch records. */
const fromBatch = (m: Movement) => m.type === "consumption" || m.type === "production";

/** A lot: what it is, where it is, and every movement in its ledger (the traceability view). */
export function LotDetail({
  slug,
  lot,
  locations,
  releaseCheck,
  releases,
  exceptionRequests,
  children,
}: {
  slug: string;
  lot: StockLotDetail;
  locations: StockLocation[];
  /** What a release would be checked against, and the releases made so far. */
  releaseCheck: LotReleaseCheck;
  releases: LotRelease[];
  /** Release exception requests: one manager asks, another approves. */
  exceptionRequests: LotReleaseExceptionRequest[];
  /** Extra sections from other modules (the production trace). */
  children?: ReactNode;
}) {
  const dateTime = useFormatDateTime();
  const { can } = useWorkspace();
  const canWrite = can("stock", "write");
  const canManage = can("stock", "manage");
  const [action, setAction] = useState<Action | null>(null);
  const hasStock = lot.balances.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            <span className="font-mono">{lot.lotCode}</span>
            <LotStatusBadge status={lot.status} />
          </h2>
          <p className="text-sm text-muted-foreground">
            {lot.item.name} <span className="font-mono text-xs">{lot.item.code}</span> · on hand{" "}
            <span className="font-medium text-foreground tabular-nums">{formatAmount(lot.onHand)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/${slug}/stock/lots/print?ids=${lot.id}`}>
              <Printer data-icon="inline-start" /> Print barcode
            </Link>
          </Button>
          {canWrite && (
            <>
              <Button variant="outline" disabled={!hasStock} onClick={() => setAction({ kind: "transfer" })}>
                <ArrowLeftRight data-icon="inline-start" /> Transfer
              </Button>
              <Button variant="outline" disabled={!hasStock} onClick={() => setAction({ kind: "waste" })}>
                <Trash2 data-icon="inline-start" /> Waste
              </Button>
            </>
          )}
          {canManage && (
            <>
              <Button variant="outline" onClick={() => setAction({ kind: "adjust" })}>
                <SlidersHorizontal data-icon="inline-start" /> Adjust
              </Button>
              <Button variant="outline" onClick={() => setAction({ kind: "status" })}>
                <ShieldCheck data-icon="inline-start" /> Change status
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Lot</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Received">{lot.receivedOn}</Row>
              <Row label="Expiry">
                <ExpiryBadge expiresOn={lot.expiresOn} expiryType={lot.expiryType} />
              </Row>
              <Row label="Supplier">
                {lot.supplier ? (
                  <span className="flex flex-wrap items-center gap-2">
                    {lot.supplier.name}
                    <SupplierApprovalBadge status={lot.supplier.approvalStatus} />
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Row>
              <Row label="Supplier lot">
                {lot.supplierLotCode ? (
                  <span className="font-mono text-xs">{lot.supplierLotCode}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Row>
              {lot.statusChangedAt && (
                <Row label="Status">
                  {lotStatusLabels[lot.status]} by {lot.statusChangedByName ?? "someone"},{" "}
                  {dateTime(lot.statusChangedAt)}
                  {lot.statusNote && <span className="block text-muted-foreground">{lot.statusNote}</span>}
                </Row>
              )}
              {lot.notes && <Row label="Notes">{lot.notes}</Row>}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Where it is</CardTitle>
          </CardHeader>
          <CardContent>
            {hasStock ? (
              <ul className="flex flex-col divide-y text-sm">
                {lot.balances.map((b) => (
                  <li key={b.locationId} className="flex justify-between py-2">
                    <span>{b.locationName}</span>
                    <span className="tabular-nums">{formatAmount(b.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing left of this lot.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Movements</h3>
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">When</TableHead>
                <TableHead>Movement</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Reason / reference</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lot.movements.map((m) => (
                <TableRow key={m.id} className={m.reversed ? "text-muted-foreground" : undefined}>
                  <TableCell className="pl-4 whitespace-nowrap">{dateTime(m.occurredAt)}</TableCell>
                  <TableCell>
                    {m.reversesMovementId ? "Reversal: " : ""}
                    {stockMovementTypeLabels[m.type]}
                    {m.reversed && <span className="ml-1 text-xs">(reversed)</span>}
                  </TableCell>
                  <TableCell>{m.locationName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.amount.display > 0 ? "+" : ""}
                    {formatAmount(m.amount)}
                  </TableCell>
                  <TableCell>{m.actorName ?? "—"}</TableCell>
                  <TableCell className="max-w-xs whitespace-normal">
                    {[m.reason, m.reference].filter(Boolean).join(" · ") || "—"}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canManage && !m.reversed && !m.reversesMovementId && !fromBatch(m) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAction({ kind: "reverse", movement: m })}
                      >
                        <Undo2 data-icon="inline-start" /> Reverse
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      <ReleaseSection
        slug={slug}
        lot={lot}
        check={releaseCheck}
        releases={releases}
        requests={exceptionRequests}
        canManage={canManage}
        onReject={(request) => setAction({ kind: "reject-exception", request })}
      />

      {children}

      {action?.kind === "status" && (
        <StatusDialog
          slug={slug}
          lot={lot}
          check={releaseCheck}
          pendingException={exceptionRequests.some((r) => r.status === "pending")}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "reject-exception" && (
        <RejectExceptionDialog
          slug={slug}
          lot={lot}
          request={action.request}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "reverse" && (
        <ReverseDialog slug={slug} lot={lot} movement={action.movement} onClose={() => setAction(null)} />
      )}
      {(action?.kind === "transfer" || action?.kind === "waste" || action?.kind === "adjust") && (
        <MovementDialog
          kind={action.kind}
          slug={slug}
          lot={lot}
          locations={locations}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Shared shell: a form dialog that posts, toasts, closes and refreshes. */
function ActionDialog({
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: () => Promise<string>;
  onClose: () => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      toast.success(await onSubmit());
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LocationSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: { id: string; name: string; detail?: string }[];
}) {
  return (
    <Field>
      <FieldLabel id={`${id}-label`}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-labelledby={`${id}-label`} className="w-full">
          <SelectValue placeholder="Choose a location" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
                {o.detail && <span className="text-xs text-muted-foreground"> · {o.detail}</span>}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

const copy = {
  transfer: {
    title: "Transfer stock",
    description: "Move part of this lot to another location.",
    submit: "Transfer",
  },
  waste: {
    title: "Record waste",
    description: "Stock thrown away. It leaves the ledger for good, so say why.",
    submit: "Record waste",
  },
  adjust: {
    title: "Adjust stock",
    description: "A signed correction: positive adds stock, negative removes it. Say why.",
    submit: "Adjust",
  },
} as const;

/** Transfer, waste or adjust a quantity of the lot. */
function MovementDialog({
  kind,
  slug,
  lot,
  locations,
  onClose,
}: {
  kind: "transfer" | "waste" | "adjust";
  slug: string;
  lot: StockLotDetail;
  locations: StockLocation[];
  onClose: () => void;
}) {
  const sources = lot.balances.map((b) => ({
    id: b.locationId,
    name: b.locationName,
    detail: formatAmount(b.amount),
  }));
  // Adjustments may also add stock at a location that holds none of this lot.
  const adjustable = [
    ...sources,
    ...locations.filter((l) => !sources.some((s) => s.id === l.id)).map((l) => ({ id: l.id, name: l.name })),
  ];
  const [from, setFrom] = useState(sources[0]?.id ?? adjustable[0]?.id ?? "");
  const [to, setTo] = useState(locations.find((l) => l.id !== from)?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState<UnitCode>(lot.item.unit);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const dimension = units[lot.item.unit].dimension;
  const unitChoices = unitCodes.filter((u) => units[u].dimension === dimension);
  const stock = browserApi().v1.workspaces[":slug"].stock;

  async function submit() {
    const common = {
      lotId: lot.id,
      quantity: Number(quantity),
      unit,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
    };
    if (kind === "transfer") {
      await unwrap(
        stock.transfers.$post({
          param: { slug },
          json: {
            ...common,
            fromLocationId: from,
            toLocationId: to,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        }),
      );
      return "Stock transferred";
    }
    const json = { ...common, locationId: from, reason: reason.trim() };
    if (kind === "waste") await unwrap(stock.waste.$post({ param: { slug }, json }));
    else await unwrap(stock.adjustments.$post({ param: { slug }, json }));
    return kind === "waste" ? "Waste recorded" : "Adjustment posted";
  }

  return (
    <ActionDialog
      title={copy[kind].title}
      description={copy[kind].description}
      submitLabel={copy[kind].submit}
      onSubmit={submit}
      onClose={onClose}
    >
      <LocationSelect
        id="movement-from"
        label={kind === "transfer" ? "From" : "Location"}
        value={from}
        onChange={setFrom}
        options={kind === "adjust" ? adjustable : sources}
      />
      {kind === "transfer" && (
        <LocationSelect
          id="movement-to"
          label="To"
          value={to}
          onChange={setTo}
          options={locations.filter((l) => l.id !== from)}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field>
          <FieldLabel htmlFor="movement-quantity">Quantity</FieldLabel>
          <Input
            id="movement-quantity"
            type="number"
            inputMode="decimal"
            step="any"
            min={kind === "adjust" ? undefined : "0"}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          {kind === "adjust" && <FieldDescription>Negative to remove stock.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel id="movement-unit-label">Unit</FieldLabel>
          <Select value={unit} onValueChange={(v) => setUnit(v as UnitCode)}>
            <SelectTrigger aria-labelledby="movement-unit-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {unitChoices.map((u) => (
                  <SelectItem key={u} value={u}>
                    {units[u].label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="movement-reason">Reason{kind === "transfer" ? " (optional)" : ""}</FieldLabel>
        <Textarea
          id="movement-reason"
          maxLength={500}
          required={kind !== "transfer"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="movement-reference">Reference (optional)</FieldLabel>
        <Input
          id="movement-reference"
          maxLength={120}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </Field>
    </ActionDialog>
  );
}

/**
 * Quarantine, release or reject: a QA sign-off, recorded with who and when. A blocked release
 * becomes a request for a release exception, which another stock manager approves.
 */
function StatusDialog({
  slug,
  lot,
  check,
  pendingException,
  onClose,
}: {
  slug: string;
  lot: StockLotDetail;
  check: LotReleaseCheck;
  pendingException: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<LotStatus>(lot.status === "available" ? "quarantine" : "available");
  const [note, setNote] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [exceptionEvidence, setExceptionEvidence] = useState("");
  const releasing = status === "available" && lot.status !== "available";
  const exception = releasing && check.blocked;
  return (
    <ActionDialog
      title="Change lot status"
      description={
        exception
          ? "This release is blocked. You can request a release exception: another person with stock manage access must approve it before the lot is released."
          : "Only available lots are picked. Your name and the time are recorded with the note."
      }
      submitLabel={exception ? "Request exception" : "Save status"}
      onClose={onClose}
      onSubmit={async () => {
        const lots = browserApi().v1.workspaces[":slug"].stock.lots[":id"];
        if (exception) {
          await unwrap(
            lots["release-exceptions"].$post({
              param: { slug, id: lot.id },
              json: {
                note: note.trim(),
                reason: exceptionReason.trim(),
                evidence: exceptionEvidence.trim(),
              },
            }),
          );
          return "Exception requested: another stock manager must approve it";
        }
        await unwrap(lots.status.$post({ param: { slug, id: lot.id }, json: { status, note: note.trim() } }));
        return `Lot ${lot.lotCode} is now ${lotStatusLabels[status].toLowerCase()}`;
      }}
    >
      <Field>
        <FieldLabel id="lot-status-label">Status</FieldLabel>
        <Select value={status} onValueChange={(v) => setStatus(v as LotStatus)}>
          <SelectTrigger aria-labelledby="lot-status-label" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {lotStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {lotStatusLabels[s]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {releasing && (
        <div className="rounded-md border p-3">
          <p className="mb-2 text-sm font-medium">
            {check.blocked ? "This release is blocked" : "Release checks are met"}
          </p>
          <ReleaseChecklist slug={slug} checks={check.checks.filter((c) => c.status !== "info")} />
        </div>
      )}
      {exception && pendingException && (
        <p className="text-sm text-muted-foreground">
          An exception for this lot is already waiting for approval. Approve or reject it under QA release.
        </p>
      )}
      <Field>
        <FieldLabel htmlFor="lot-status-note">{exception ? "Release note" : "Note"}</FieldLabel>
        <Textarea
          id="lot-status-note"
          required
          maxLength={2000}
          placeholder="e.g. Micro results clear, released"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {exception && (
        <>
          <Field>
            <FieldLabel htmlFor="lot-exception-reason">Why release it anyway</FieldLabel>
            <Textarea
              id="lot-exception-reason"
              required
              maxLength={2000}
              placeholder="e.g. Customer accepted positive release pending the micro result"
              value={exceptionReason}
              onChange={(e) => setExceptionReason(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="lot-exception-evidence">Evidence</FieldLabel>
            <Textarea
              id="lot-exception-evidence"
              required
              maxLength={2000}
              placeholder="What supports it: a document reference, a retest, an approval"
              value={exceptionEvidence}
              onChange={(e) => setExceptionEvidence(e.target.value)}
            />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}

/** Rejects another manager's exception request, or withdraws your own: a reason is recorded. */
function RejectExceptionDialog({
  slug,
  lot,
  request,
  onClose,
}: {
  slug: string;
  lot: StockLotDetail;
  request: LotReleaseExceptionRequest;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      title="Reject release exception"
      description="The lot stays on hold. If you requested it yourself, this withdraws it."
      submitLabel="Reject"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          browserApi().v1.workspaces[":slug"].stock.lots[":id"]["release-exceptions"][
            ":requestId"
          ].reject.$post({ param: { slug, id: lot.id, requestId: request.id }, json: { note: note.trim() } }),
        );
        return "Exception request closed";
      }}
    >
      <Field>
        <FieldLabel htmlFor="exception-reject-note">Why</FieldLabel>
        <Textarea
          id="exception-reject-note"
          required
          maxLength={2000}
          placeholder="e.g. Wait for the micro result"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </ActionDialog>
  );
}

/** A pending release exception: what was asked, by whom, against which blockers. */
function PendingException({
  slug,
  lot,
  request,
  canManage,
  onReject,
}: {
  slug: string;
  lot: StockLotDetail;
  request: LotReleaseExceptionRequest;
  canManage: boolean;
  onReject: () => void;
}) {
  const router = useRouter();
  const dateTime = useFormatDateTime();
  const [pending, setPending] = useState(false);
  async function approve() {
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].stock.lots[":id"]["release-exceptions"][
          ":requestId"
        ].approve.$post({
          param: { slug, id: lot.id, requestId: request.id },
          json: {},
        }),
      );
      toast.success(`Lot ${lot.lotCode} released by exception`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
      router.refresh();
    }
  }
  return (
    <Card className="gap-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Badge variant="destructive">Exception requested</Badge>
          {request.requestedByName ?? "Someone"} · {dateTime(request.requestedAt)}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={onReject}>
              Reject
            </Button>
            <Button size="sm" disabled={pending} onClick={() => void approve()}>
              {pending && <Spinner data-icon="inline-start" />} Approve and release
            </Button>
          </div>
        )}
      </div>
      <div className="text-sm">{request.note}</div>
      <div className="text-xs text-muted-foreground">
        Reason: {request.reason} · Evidence: {request.evidence} · Blocked by:{" "}
        {request.checks
          .filter((c) => c.status === "block")
          .map((c) => c.label)
          .join(", ")}
      </div>
      <p className="text-xs text-muted-foreground">
        Another person with stock manage access approves it (the requester only when nobody else can).
        Approval is refused if something new blocks the release since it was requested.
      </p>
    </Card>
  );
}

/** The lot's release: what a release is checked against now, and the releases made so far. */
function ReleaseSection({
  slug,
  lot,
  check,
  releases,
  requests,
  canManage,
  onReject,
}: {
  slug: string;
  lot: StockLotDetail;
  check: LotReleaseCheck;
  releases: LotRelease[];
  requests: LotReleaseExceptionRequest[];
  canManage: boolean;
  onReject: (request: LotReleaseExceptionRequest) => void;
}) {
  const pendingRequest = requests.find((r) => r.status === "pending");
  const dateTime = useFormatDateTime();
  if (lot.status === "available" && releases.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="font-medium">QA release</h3>
          <p className="text-sm text-muted-foreground">
            {check.rule
              ? `Checked against the item's release rule (v${check.ruleVersion}) and the checks that always apply.`
              : "This item has no release rule; the checks that always apply are shown."}{" "}
            <Link href={`/${slug}/stock/release-rules`} className="hover:underline">
              Release rules
            </Link>
          </p>
        </div>
        {lot.status !== "available" && (
          <Badge variant={check.blocked ? "destructive" : "secondary"}>
            {check.blocked ? "Release blocked" : "Ready to release"}
          </Badge>
        )}
      </div>
      {pendingRequest && (
        <PendingException
          slug={slug}
          lot={lot}
          request={pendingRequest}
          canManage={canManage}
          onReject={() => onReject(pendingRequest)}
        />
      )}
      {lot.status !== "available" && (
        <Card className="p-4">
          <ReleaseChecklist slug={slug} checks={check.checks} />
        </Card>
      )}
      {releases.length > 0 && (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Released</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead className="pr-4">Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {releases.map((r) => (
                <TableRow key={r.id} className="align-top">
                  <TableCell className="pl-4">{dateTime(r.releasedAt)}</TableCell>
                  <TableCell>{r.releasedByName ?? "—"}</TableCell>
                  <TableCell>{r.ruleVersion ? `v${r.ruleVersion}` : "None"}</TableCell>
                  <TableCell className="max-w-md pr-4 whitespace-normal">
                    {r.exception && (
                      <Badge variant="destructive" className="mb-1">
                        Exception
                      </Badge>
                    )}
                    <div>{r.note}</div>
                    {r.exception && (
                      <div className="text-xs text-muted-foreground">
                        Requested by {r.exceptionRequestedByName ?? "—"}
                        {r.exceptionSelfApproved
                          ? " and approved by them as the only stock manager"
                          : `, approved by ${r.releasedByName ?? "—"}`}{" "}
                        · Reason: {r.exceptionReason} · Evidence: {r.exceptionEvidence} · Blocked by:{" "}
                        {r.checks
                          .filter((c) => c.status === "block")
                          .map((c) => c.label)
                          .join(", ")}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}

/** Appends the opposite of a movement (both rows of a transfer). */
function ReverseDialog({
  slug,
  lot,
  movement,
  onClose,
}: {
  slug: string;
  lot: StockLotDetail;
  movement: Movement;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      title="Reverse movement"
      description={`${stockMovementTypeLabels[movement.type]} of ${formatAmount(movement.amount)} at ${movement.locationName}. The original stays in the ledger; a reversing movement is added${movement.transferId ? " for both sides of the transfer" : ""}.`}
      submitLabel="Reverse"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          browserApi().v1.workspaces[":slug"].stock.movements[":id"].reverse.$post({
            param: { slug, id: movement.id },
            json: { reason: reason.trim() },
          }),
        );
        return `Movement on lot ${lot.lotCode} reversed`;
      }}
    >
      <Field>
        <FieldLabel htmlFor="reverse-reason">Reason</FieldLabel>
        <Textarea
          id="reverse-reason"
          required
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </ActionDialog>
  );
}
