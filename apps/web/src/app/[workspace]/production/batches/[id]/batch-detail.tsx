"use client";

import { newId } from "@knotworking/core";

import { useWorkspaceToday } from "@/lib/workspace-time";
import {
  classifyExpiry,
  expiryTypeLabels,
  expiryTypes,
  lotStatusLabels,
  productionRecordKindLabels,
  reservationReleaseReasonLabels,
  unitCodes,
  units,
  type ExpiryType,
  type StockAmount,
  type UnitCode,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
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
import {
  Ban,
  BadgeCheck,
  Lock,
  LockOpen,
  ScanLine,
  PackageMinus,
  PackagePlus,
  Pencil,
  Play,
  Printer,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { BatchStatusBadge } from "@/components/production-badges";
import { RecipeVersionBadge } from "@/components/recipe-badges";
import { ExpiryBadge, formatAmount, LotStatusBadge } from "@/components/stock-badges";
import type { ProductionBatchDetail, ProductionLine, StockLocation } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useFormatDateTime } from "@/lib/workspace-time";

type Batch = ProductionBatchDetail;
type BatchRecord = Batch["records"][number];
type Output = Batch["outputs"][number];
type Reservation = Batch["reservations"][number];
type Action =
  | { kind: "edit" | "consume" | "output" | "complete" | "cancel" | "reserve" }
  | { kind: "unreserve"; reservation: Reservation }
  | { kind: "reverse"; record: BatchRecord }
  | { kind: "release"; lot: Output };

const NONE = "none";

const batchApi = (slug: string, id: string) => ({
  route: browserApi().v1.workspaces[":slug"].production.batches[":id"],
  param: { slug, id },
});

const unitsLike = (unit: UnitCode) => unitCodes.filter((u) => units[u].dimension === units[unit].dimension);

/**
 * A production batch: what it is made to (recipe version), what it needs against what it has
 * consumed, what it produced, and its append-only batch record. Completing it is the sign-off.
 */
export function BatchDetail({
  slug,
  batch,
  locations,
  lines,
  currentVersion,
  openDeviations,
  readiness,
}: {
  slug: string;
  batch: Batch;
  locations: StockLocation[];
  /** Active production lines, for assigning the batch. */
  lines: ProductionLine[];
  /** Open HACCP corrective actions on this batch; 0 for people who can't read haccp. Warns, never blocks. */
  openDeviations: number;
  readiness: {
    checked: boolean;
    ready: boolean | null;
    issues: { code: string; count: number; message: string }[];
  };
  /** The recipe's approved version, when the batch is planned on a superseded one. */
  currentVersion: { id: string; versionNumber: number } | null;
}) {
  const dateTime = useFormatDateTime();
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("production", "write");
  const canManage = can("production", "manage");
  // Releasing a lot is the stock module's QA sign-off: `manage` on stock, a signed-in person.
  const canRelease = can("stock", "manage");
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const open = batch.status === "planned" || batch.status === "in_progress";
  const running = batch.status === "in_progress";
  const superseded = batch.recipeVersion?.status !== "approved";

  async function run(label: string, request: () => Promise<unknown>) {
    setBusy(true);
    try {
      await request();
      toast.success(label);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const { route, param } = batchApi(slug, batch.id);
  const start = () => run(`Batch ${batch.batchCode} started`, () => unwrap(route.start.$post({ param })));
  const moveToCurrent = () =>
    currentVersion &&
    run(`Batch moved to version ${currentVersion.versionNumber}`, () =>
      unwrap(route.$patch({ param, json: { recipeVersionId: currentVersion.id } })),
    );

  const outstanding = batch.materials.filter((m) => m.inRecipe && (m.outstanding?.display ?? 0) > 0);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            <span className="font-mono">{batch.batchCode}</span>
            <BatchStatusBadge status={batch.status} />
          </h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link href={`/${slug}/recipes/${batch.recipe.id}`} className="text-foreground hover:underline">
              {batch.recipe.name}
            </Link>
            <span className="font-mono text-xs">{batch.recipe.code}</span>
            {batch.recipeVersion && (
              <RecipeVersionBadge
                status={batch.recipeVersion.status}
                versionNumber={batch.recipeVersion.versionNumber}
              />
            )}
            · makes {batch.outputItem.name}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/${slug}/production/batches/${batch.id}/print`}>
              <Printer data-icon="inline-start" /> Print record
            </Link>
          </Button>
          {canWrite && batch.status === "planned" && (
            <Button disabled={busy || superseded} onClick={() => void start()}>
              <Play data-icon="inline-start" /> Start
            </Button>
          )}
          {canWrite && open && (
            <Button variant="outline" onClick={() => setAction({ kind: "reserve" })}>
              <Lock data-icon="inline-start" /> Reserve stock
            </Button>
          )}
          {canWrite && running && (
            <>
              <Button variant="outline" onClick={() => setAction({ kind: "consume" })}>
                <PackageMinus data-icon="inline-start" /> Record consumption
              </Button>
              <Button variant="outline" onClick={() => setAction({ kind: "output" })}>
                <PackagePlus data-icon="inline-start" /> Record output
              </Button>
            </>
          )}
          {canManage && running && (
            <Button onClick={() => setAction({ kind: "complete" })}>
              <BadgeCheck data-icon="inline-start" /> Complete
            </Button>
          )}
          {canWrite && open && (
            <Button variant="outline" onClick={() => setAction({ kind: "edit" })}>
              <Pencil data-icon="inline-start" /> Edit
            </Button>
          )}
          {open && (batch.status === "planned" ? canWrite : canManage) && (
            <Button variant="ghost" onClick={() => setAction({ kind: "cancel" })}>
              <Ban data-icon="inline-start" /> Cancel batch
            </Button>
          )}
        </div>
      </div>

      {batch.status === "planned" && superseded && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Version {batch.recipeVersion?.versionNumber} has been superseded</AlertTitle>
          <AlertDescription>
            A batch can only start on the recipe&apos;s approved version.
            {currentVersion && canWrite && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 w-fit"
                disabled={busy}
                onClick={() => void moveToCurrent()}
              >
                <RefreshCw data-icon="inline-start" /> Move to version {currentVersion.versionNumber}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {open && batch.lineCheck && batch.lineCheck.warnings.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Check the line schedule</AlertTitle>
          <AlertDescription>
            {batch.lineCheck.warnings.join(". ")}.{" "}
            <Link
              className="underline underline-offset-2"
              href={`/${slug}/production/schedule?from=${batch.plannedOn}`}
            >
              See the schedule
            </Link>
            . This does not stop you.
          </AlertDescription>
        </Alert>
      )}

      {readiness.checked && readiness.issues.length > 0 && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>Food safety readiness needs attention</AlertTitle>
          <AlertDescription>
            <ul>
              {readiness.issues.map((issue) => (
                <li key={issue.code}>
                  {issue.message} ({issue.count})
                </li>
              ))}
            </ul>
            <p>
              Review these before completing the batch or releasing its output. Sign-off remains available.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {open && batch.calendarWarning && !batch.lineCheck && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Planned on a non-working day</AlertTitle>
          <AlertDescription>{batch.calendarWarning.message}. This does not stop you.</AlertDescription>
        </Alert>
      )}

      {running && openDeviations > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>
            {openDeviations === 1 ? "1 open deviation" : `${openDeviations} open deviations`} on this batch
          </AlertTitle>
          <AlertDescription>
            Food safety corrective actions are still open.{" "}
            <Link className="underline underline-offset-2" href={`/${slug}/haccp/deviations`}>
              See deviations
            </Link>
            . You can still complete the batch.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Batch</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Planned on">{batch.plannedOn}</Row>
              <Row label="Size">
                <span className="tabular-nums">
                  {batch.batches !== null && `${batch.batches} batches · `}
                  {formatAmount(batch.planned)}
                </span>
              </Row>
              <Row label="Produced">
                <span className="tabular-nums">{formatAmount(batch.produced)}</span>
                {batch.planned.display > 0 && batch.produced.display > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({Math.round((batch.produced.base / batch.planned.base) * 100)}% of plan)
                  </span>
                )}
              </Row>
              <Row label="Line">
                {batch.line ? (
                  <span>
                    {batch.line.name}
                    {batch.lineCheck && (
                      <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                        {batch.lineCheck.hours !== null ? `${batch.lineCheck.hours} h · ` : ""}
                        day {batch.lineCheck.dayHours} of {batch.lineCheck.capacityHours} h
                      </span>
                    )}
                  </span>
                ) : (
                  <Muted>Not on a line</Muted>
                )}
              </Row>
              <Row label="Output to">{batch.outputLocation?.name ?? <Muted>Not chosen yet</Muted>}</Row>
              <Row label="Planned by">{batch.createdByName ?? <Muted>—</Muted>}</Row>
              {batch.startedAt && (
                <Row label="Started">{`${batch.startedByName ?? "Someone"}, ${dateTime(batch.startedAt)}`}</Row>
              )}
              {batch.completedAt && (
                <Row label="Signed off">
                  {batch.completedByName ?? "Someone"}, {dateTime(batch.completedAt)}
                  {batch.completionNote && (
                    <span className="block text-muted-foreground">{batch.completionNote}</span>
                  )}
                </Row>
              )}
              {batch.cancelledAt && (
                <Row label="Cancelled">
                  {batch.cancelledByName ?? "Someone"}, {dateTime(batch.cancelledAt)}
                  {batch.cancelReason && (
                    <span className="block text-muted-foreground">{batch.cancelReason}</span>
                  )}
                </Row>
              )}
              {batch.notes && <Row label="Notes">{batch.notes}</Row>}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Produced lots</CardTitle>
          </CardHeader>
          <CardContent>
            {batch.outputs.length ? (
              <ul className="flex flex-col divide-y text-sm">
                {batch.outputs.map((o) => (
                  <li key={o.lotId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/${slug}/stock/lots/${o.lotId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {o.lotCode}
                      </Link>
                      <LotStatusBadge status={o.status} />
                      <ExpiryBadge expiresOn={o.expiresOn} expiryType={o.expiryType} />
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">{formatAmount(o.produced)}</span>
                      {canRelease && o.status === "quarantine" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setAction({ kind: "release", lot: o })}
                        >
                          <ShieldCheck data-icon="inline-start" /> Release
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
            )}
            {batch.outputs.length > 0 && (
              <p className="mt-3 text-xs">
                <Link
                  className="underline underline-offset-2"
                  href={`/${slug}/stock/lots/print?ids=${batch.outputs.map((o) => o.lotId).join(",")}`}
                >
                  Print lot barcodes
                </Link>
              </p>
            )}
            {batch.outputs.some((o) => o.status === "quarantine") && (
              <p className="mt-3 text-xs text-muted-foreground">
                Produced lots wait in quarantine until QA releases them
                {canRelease ? "" : " (needs manage access to stock)"}.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Materials</h3>
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Ingredient</TableHead>
                <TableHead>Per batch</TableHead>
                <TableHead className="text-right">Required</TableHead>
                <TableHead className="text-right">Consumed</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="pr-4 text-right">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.materials.map((m) => (
                <TableRow key={m.item.id}>
                  <TableCell className="pl-4">
                    {m.item.name}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{m.item.code}</span>
                    {!m.inRecipe && (
                      <span className="ml-2 text-xs text-muted-foreground">(not on this version)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {m.lines.map((l) => `${l.quantity} ${units[l.unit].label}`).join(" + ") || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.required ? formatAmount(m.required) : <Muted>Can&apos;t convert</Muted>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(m.consumed)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.reserved.base > 0 ? formatAmount(m.reserved) : <Muted>—</Muted>}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {m.outstanding ? formatAmount(m.outstanding) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      {batch.reservations.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Reserved stock</h3>
          <Card className="overflow-x-auto py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Lot</TableHead>
                  <TableHead>Ingredient</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Still held</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {batch.reservations.map((r) => (
                  <TableRow
                    key={r.id}
                    className={r.status === "released" ? "text-muted-foreground" : undefined}
                  >
                    <TableCell className="pl-4">
                      <Link
                        href={`/${slug}/stock/lots/${r.lotId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {r.lotCode}
                      </Link>
                      {r.status === "active" && !r.lotUsable && (
                        <span className="ml-2 text-xs text-destructive">can&apos;t be used now</span>
                      )}
                    </TableCell>
                    <TableCell>{r.item.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(r.reserved)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(r.held)}</TableCell>
                    <TableCell>
                      {r.status === "active"
                        ? "Held"
                        : `Released (${reservationReleaseReasonLabels[r.releaseReason ?? "manual"].toLowerCase()})`}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && r.status === "active" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAction({ kind: "unreserve", reservation: r })}
                        >
                          <LockOpen data-icon="inline-start" /> Release
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Batch record</h3>
        {batch.records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {batch.status === "planned"
              ? "Start the batch to record what it consumes and produces."
              : "Nothing recorded."}
          </p>
        ) : (
          <Card className="overflow-x-auto py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">When</TableHead>
                  <TableHead>Line</TableHead>
                  <TableHead>Lot</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {batch.records.map((r) => (
                  <TableRow key={r.id} className={r.reversed ? "text-muted-foreground" : undefined}>
                    <TableCell className="pl-4 whitespace-nowrap">{dateTime(r.occurredAt)}</TableCell>
                    <TableCell>
                      {r.reversesRecordId ? "Reversal: " : ""}
                      {productionRecordKindLabels[r.kind]} {r.item.name}
                      {r.reversed && <span className="ml-1 text-xs">(reversed)</span>}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/${slug}/stock/lots/${r.lotId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {r.lotCode}
                      </Link>
                    </TableCell>
                    <TableCell>{r.locationName}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(r.amount)}</TableCell>
                    <TableCell>{r.actorName ?? "—"}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal">{r.note ?? "—"}</TableCell>
                    <TableCell className="pr-4 text-right">
                      {!r.reversed && !r.reversesRecordId && (running ? canWrite : canManage) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAction({ kind: "reverse", record: r })}
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
        )}
      </section>

      {action?.kind === "edit" && (
        <EditDialog
          slug={slug}
          batch={batch}
          locations={locations}
          lines={lines}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "reserve" && (
        <ReserveDialog slug={slug} batch={batch} onClose={() => setAction(null)} />
      )}
      {action?.kind === "unreserve" && (
        <ActionDialog
          title={`Release reservation of lot ${action.reservation.lotCode}`}
          description={`${formatAmount(action.reservation.held)} of ${action.reservation.item.name} goes back to free stock.`}
          submitLabel="Release"
          onClose={() => setAction(null)}
          onSubmit={async (form) => {
            const note = String(form.get("note") ?? "").trim();
            await unwrap(
              browserApi().v1.workspaces[":slug"].production.reservations[":id"].release.$post({
                param: { slug, id: action.reservation.id },
                json: note ? { note } : {},
              }),
            );
            return "Reservation released";
          }}
        >
          <Field>
            <FieldLabel htmlFor="unreserve-note">Note (optional)</FieldLabel>
            <Textarea id="unreserve-note" name="note" maxLength={500} />
          </Field>
        </ActionDialog>
      )}
      {action?.kind === "consume" && (
        <ConsumeDialog slug={slug} batch={batch} onClose={() => setAction(null)} />
      )}
      {action?.kind === "output" && (
        <OutputDialog slug={slug} batch={batch} locations={locations} onClose={() => setAction(null)} />
      )}
      {action?.kind === "complete" && (
        <ActionDialog
          title={`Complete batch ${batch.batchCode}`}
          description="Your sign-off closes the batch record. Your name and the time are recorded; later corrections need manage access."
          submitLabel="Complete and sign off"
          onClose={() => setAction(null)}
          onSubmit={async (form) => {
            const note = String(form.get("note") ?? "").trim();
            const done = await unwrap(route.complete.$post({ param, json: note ? { note } : {} }));
            const open = done.haccpWarning?.openDeviations ?? 0;
            if (open > 0) {
              toast.warning(
                `Completed with ${open === 1 ? "1 open deviation" : `${open} open deviations`}: close the corrective actions in Food safety`,
              );
            }
            return `Batch ${batch.batchCode} completed`;
          }}
        >
          {outstanding.length > 0 && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Less consumed than the recipe needs</AlertTitle>
              <AlertDescription>
                {outstanding
                  .map((m) => `${m.item.name}: ${formatAmount(m.outstanding!)} outstanding`)
                  .join("; ")}
              </AlertDescription>
            </Alert>
          )}
          {openDeviations > 0 && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>
                {openDeviations === 1 ? "1 deviation is" : `${openDeviations} deviations are`} still open
              </AlertTitle>
              <AlertDescription>
                Food safety corrective actions on this batch have not been closed. This does not stop you
                completing the batch.
              </AlertDescription>
            </Alert>
          )}
          <Field>
            <FieldLabel htmlFor="complete-note">Note (optional)</FieldLabel>
            <Textarea
              id="complete-note"
              name="note"
              maxLength={2000}
              placeholder="e.g. Checks passed, yield as expected"
            />
          </Field>
        </ActionDialog>
      )}
      {action?.kind === "cancel" && (
        <ActionDialog
          title={`Cancel batch ${batch.batchCode}`}
          description={
            running
              ? "Ingredients already consumed stay consumed. Reverse any output first; reverse consumption to return unused stock."
              : "The batch stays on record as cancelled."
          }
          submitLabel="Cancel batch"
          onClose={() => setAction(null)}
          onSubmit={async (form) => {
            await unwrap(
              route.cancel.$post({ param, json: { reason: String(form.get("reason") ?? "").trim() } }),
            );
            return `Batch ${batch.batchCode} cancelled`;
          }}
        >
          <Field>
            <FieldLabel htmlFor="cancel-reason">Reason</FieldLabel>
            <Textarea id="cancel-reason" name="reason" required maxLength={500} />
          </Field>
        </ActionDialog>
      )}
      {action?.kind === "release" && (
        <ActionDialog
          title={`Release lot ${action.lot.lotCode}`}
          description={`QA sign-off: the ${formatAmount(action.lot.produced)} this batch produced becomes available to pick. Your name and the time are recorded with the note, as on the lot's page.`}
          submitLabel="Release lot"
          onClose={() => setAction(null)}
          onSubmit={async (form) => {
            await unwrap(
              browserApi().v1.workspaces[":slug"].stock.lots[":id"].status.$post({
                param: { slug, id: action.lot.lotId },
                json: { status: "available", note: String(form.get("note") ?? "").trim() },
              }),
            );
            return `Lot ${action.lot.lotCode} released`;
          }}
        >
          <Field>
            <FieldLabel htmlFor="release-note">Note</FieldLabel>
            <Textarea
              id="release-note"
              name="note"
              required
              maxLength={2000}
              placeholder="e.g. Micro results clear, released"
            />
          </Field>
        </ActionDialog>
      )}
      {action?.kind === "reverse" && (
        <ActionDialog
          title="Reverse batch record line"
          description={`${productionRecordKindLabels[action.record.kind]} ${formatAmount(action.record.amount)} of lot ${action.record.lotCode} at ${action.record.locationName}. The line stays on record; a reversing line and stock movement are added.`}
          submitLabel="Reverse"
          onClose={() => setAction(null)}
          onSubmit={async (form) => {
            await unwrap(
              route.records[":recordId"].reverse.$post({
                param: { ...param, recordId: action.record.id },
                json: { reason: String(form.get("reason") ?? "").trim() },
              }),
            );
            return "Line reversed";
          }}
        >
          <Field>
            <FieldLabel htmlFor="reverse-reason">Reason</FieldLabel>
            <Textarea id="reverse-reason" name="reason" required maxLength={500} />
          </Field>
        </ActionDialog>
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

const Muted = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

/** Shared shell: a form dialog that posts, toasts, closes and refreshes. */
function ActionDialog({
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
  wide = false,
  disabled = false,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (form: FormData) => Promise<string>;
  onClose: () => void;
  wide?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    try {
      toast.success(await onSubmit(form));
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
      <DialogContent className={wide ? "sm:max-w-3xl" : "sm:max-w-lg"}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="max-h-[60vh] overflow-y-auto py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || disabled}>
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
  locations,
  allowNone,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  locations: StockLocation[];
  allowNone?: string;
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
            {allowNone && <SelectItem value={NONE}>{allowNone}</SelectItem>}
            {locations.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Reschedule or resize a planned batch; output location and notes until it closes. */
function EditDialog({
  slug,
  batch,
  locations,
  lines,
  onClose,
}: {
  slug: string;
  batch: Batch;
  locations: StockLocation[];
  lines: ProductionLine[];
  onClose: () => void;
}) {
  const planned = batch.status === "planned";
  const [plannedOn, setPlannedOn] = useState(batch.plannedOn);
  const [batches, setBatches] = useState(batch.batches !== null ? String(batch.batches) : "");
  const [locationId, setLocationId] = useState(batch.outputLocation?.id ?? NONE);
  const [notes, setNotes] = useState(batch.notes ?? "");
  const [lineId, setLineId] = useState(batch.line?.id ?? NONE);
  const { route, param } = batchApi(slug, batch.id);
  return (
    <ActionDialog
      title={`Edit batch ${batch.batchCode}`}
      description={
        planned
          ? "Reschedule, resize or change where the output goes."
          : "A started batch keeps its date and size."
      }
      submitLabel="Save"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          route.$patch({
            param,
            json: {
              ...(planned && plannedOn !== batch.plannedOn ? { plannedOn } : {}),
              ...(planned && batches && Number(batches) !== batch.batches
                ? { batches: Number(batches) }
                : {}),
              outputLocationId: locationId === NONE ? null : locationId,
              ...((batch.line?.id ?? NONE) !== lineId ? { lineId: lineId === NONE ? null : lineId } : {}),
              notes: notes.trim(),
            },
          }),
        );
        return `Batch ${batch.batchCode} saved`;
      }}
    >
      {planned && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="edit-date">Planned on</FieldLabel>
            <Input
              id="edit-date"
              type="date"
              required
              value={plannedOn}
              onChange={(e) => setPlannedOn(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-batches">Batches</FieldLabel>
            <Input
              id="edit-batches"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={batches}
              onChange={(e) => setBatches(e.target.value)}
            />
          </Field>
        </div>
      )}
      <LocationSelect
        id="edit-location"
        label="Output location"
        value={locationId}
        onChange={setLocationId}
        locations={locations}
        allowNone="Decide later"
      />
      {(lines.length > 0 || batch.line) && (
        <Field>
          <FieldLabel id="edit-line-label">Production line</FieldLabel>
          <Select value={lineId} onValueChange={setLineId}>
            <SelectTrigger aria-labelledby="edit-line-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>Not on a line</SelectItem>
                {lines.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>Overloading a line only warns; it never stops you.</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="edit-notes">Notes</FieldLabel>
        <Textarea id="edit-notes" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </ActionDialog>
  );
}

interface LotRow {
  key: string;
  itemId: string;
  itemUnit: UnitCode;
  lotId: string;
  lotCode: string;
  locationId: string;
  locationName: string;
  expiresOn: string | null;
  expiryType: ExpiryType | null;
  available: StockAmount;
  /** Past a use-by date: the API refuses it. */
  blocked: boolean;
  quantity: string;
}

/**
 * Record what the batch consumed. Lists the released lots of each ingredient, prefilled with the
 * first-expired-first-out suggestion for what is still outstanding; edit the quantities to match
 * what was actually used.
 */
function ConsumeDialog({ slug, batch, onClose }: { slug: string; batch: Batch; onClose: () => void }) {
  /** Use-by dates are checked against today in the workspace's time zone. */
  const today = useWorkspaceToday();
  const [rows, setRows] = useState<LotRow[] | null>(null);
  const { route, param } = batchApi(slug, batch.id);
  const materials = batch.materials.filter((m) => m.inRecipe);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const api = browserApi().v1.workspaces[":slug"];
        const [pick, ...lotLists] = await Promise.all([
          unwrap(route.pick.$get({ param })),
          ...materials.map((m) =>
            unwrap(
              api.stock.lots.$get({
                param: { slug },
                query: { itemId: m.item.id, status: "available", limit: "200" },
              }),
            ),
          ),
        ]);
        const suggested = new Map(
          pick.materials.flatMap((m) =>
            m.allocations.map((a) => [`${a.lotId}:${a.locationId}`, a.amount.display]),
          ),
        );
        const next = materials.flatMap((m, i) =>
          lotLists[i]!.lots.flatMap((lot) =>
            lot.balances.map((b): LotRow => {
              const key = `${lot.id}:${b.locationId}`;
              return {
                key,
                itemId: m.item.id,
                itemUnit: m.item.unit,
                lotId: lot.id,
                lotCode: lot.lotCode,
                locationId: b.locationId,
                locationName: b.locationName,
                expiresOn: lot.expiresOn,
                expiryType: lot.expiryType,
                available: b.amount,
                blocked: lot.expiryType === "use_by" && classifyExpiry(lot.expiresOn, today) === "expired",
                quantity: suggested.has(key) ? String(suggested.get(key)) : "",
              };
            }),
          ),
        );
        if (live) setRows(next);
      } catch (err) {
        toast.error(errorMessage(err));
        if (live) setRows([]);
      }
    })();
    return () => {
      live = false;
    };
    // Loaded once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<string | null>(null);
  const [commandId] = useState(() => newId());

  /**
   * A keyboard-wedge scanner types the lot code and presses Enter, so Enter here looks the code up
   * (never submits the form) and picks that lot: its quantity is filled with what the ingredient
   * still needs, up to what is at the location, and suggestions for other lots of the item clear.
   */
  async function scan() {
    const wanted = code.trim();
    if (!wanted || !rows) return;
    setScanning(true);
    try {
      const res = await unwrap(route.scan.$get({ param, query: { code: wanted } }));
      const usable = res.matches.filter((m) => !m.problem);
      const hit = usable[0] ?? null;
      if (!hit) {
        const first = res.matches[0];
        toast.error(
          !first
            ? `No lot has the code "${wanted}"`
            : first.problem === "not_in_recipe"
              ? `Lot ${first.lotCode} is ${first.item.name}, which is not an ingredient of this batch`
              : first.problem === "lot_not_available"
                ? `Lot ${first.lotCode} is ${lotStatusLabels[first.status].toLowerCase()}, not released`
                : first.problem === "lot_expired"
                  ? `Lot ${first.lotCode} is past its use-by date`
                  : `Lot ${first.lotCode} has no stock`,
        );
      } else {
        const target = rows.filter((r) => r.lotId === hit.lotId);
        if (target.length === 0) {
          toast.error(`Lot ${hit.lotCode} is not in the list below`);
        } else {
          const need = hit.outstanding?.display ?? target[0]!.available.display;
          setRows(
            (list) =>
              list?.map((r) => {
                if (r.itemId !== hit.item.id) return r;
                if (r.key === target[0]!.key)
                  return { ...r, quantity: String(Math.min(need, r.available.display)) };
                return { ...r, quantity: "" };
              }) ?? null,
          );
          setScanned(target[0]!.key);
          toast.success(`Lot ${hit.lotCode}: ${hit.item.name}`);
        }
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setScanning(false);
      setCode("");
    }
  }

  const lines = (rows ?? []).filter((r) => Number(r.quantity) > 0);
  const setQuantity = (key: string, quantity: string) =>
    setRows((list) => list?.map((r) => (r.key === key ? { ...r, quantity } : r)) ?? null);

  return (
    <ActionDialog
      title="Record consumption"
      description="Quantities actually used, per lot and location, in each ingredient's own unit. Prefilled first expired, first out for what is still outstanding."
      submitLabel={`Record ${lines.length || ""} line${lines.length === 1 ? "" : "s"}`}
      wide
      disabled={lines.length === 0}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          route.consumption.$post({
            param,
            json: {
              commandId,
              lines: lines.map((r) => ({
                lotId: r.lotId,
                locationId: r.locationId,
                quantity: Number(r.quantity),
                unit: r.itemUnit,
              })),
            },
          }),
        );
        return `Consumption recorded on ${batch.batchCode}`;
      }}
    >
      {rows !== null && (
        <Field>
          <FieldLabel htmlFor="consume-scan">Scan a lot code</FieldLabel>
          <div className="flex items-center gap-2">
            <ScanLine className="size-4 text-muted-foreground" aria-hidden />
            <Input
              id="consume-scan"
              autoFocus
              autoComplete="off"
              disabled={scanning}
              placeholder="Scan the lot label, or type a code and press Enter"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void scan();
                }
              }}
            />
          </div>
          <FieldDescription>
            Picks that lot and fills in what the ingredient still needs. Change the quantity if you used less.
          </FieldDescription>
        </Field>
      )}
      {rows === null ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        materials.map((m) => {
          const mine = rows.filter((r) => r.itemId === m.item.id);
          return (
            <div key={m.item.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{m.item.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {m.outstanding ? `${formatAmount(m.outstanding)} outstanding` : ""}
                </span>
              </div>
              {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground">No released stock of this ingredient.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {mine.map((r) => (
                    <li
                      key={r.key}
                      className={`grid grid-cols-[1fr_8rem] items-center gap-3 text-sm ${scanned === r.key ? "rounded-md bg-muted px-2 py-1" : ""}`}
                    >
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="font-mono text-xs">{r.lotCode}</span>
                        <span className="text-muted-foreground">{r.locationName}</span>
                        <ExpiryBadge expiresOn={r.expiresOn} expiryType={r.expiryType} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatAmount(r.available)} there
                        </span>
                      </span>
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`Quantity of lot ${r.lotCode} at ${r.locationName}`}
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min="0"
                          max={r.available.display}
                          disabled={r.blocked}
                          value={r.quantity}
                          onChange={(e) => setQuantity(r.key, e.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">{units[r.itemUnit].label}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </ActionDialog>
  );
}

/**
 * Record what the batch produced: a new lot (in quarantine until released) or more of one still in
 * quarantine. A lot QA has released or rejected takes no more output (`409 lot_released`).
 */
function OutputDialog({
  slug,
  batch,
  locations,
  onClose,
}: {
  slug: string;
  batch: Batch;
  locations: StockLocation[];
  onClose: () => void;
}) {
  const remaining = Math.max(batch.planned.display - batch.produced.display, 0);
  const [quantity, setQuantity] = useState(remaining ? String(remaining) : "");
  const [unit, setUnit] = useState<UnitCode>(batch.outputItem.unit);
  const [locationId, setLocationId] = useState(batch.outputLocation?.id ?? locations[0]?.id ?? "");
  const open = batch.outputs.filter((o) => o.status === "quarantine");
  const [target, setTarget] = useState(open[0]?.lotId ?? NONE);
  const [lotCode, setLotCode] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [expiryType, setExpiryType] = useState<ExpiryType>("use_by");
  const [commandId] = useState(() => newId());
  const { route, param } = batchApi(slug, batch.id);
  const newLot = target === NONE;
  return (
    <ActionDialog
      title="Record output"
      description={`${batch.outputItem.name} made by this batch. A new lot starts in quarantine until QA releases it.`}
      submitLabel="Record output"
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          route.output.$post({
            param,
            json: {
              commandId,
              quantity: Number(quantity),
              unit,
              locationId,
              ...(newLot
                ? {
                    ...(lotCode.trim() ? { lotCode: lotCode.trim() } : {}),
                    ...(expiresOn ? { expiresOn, expiryType } : {}),
                  }
                : { lotId: target }),
            },
          }),
        );
        return `Output recorded on ${batch.batchCode}`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field>
          <FieldLabel htmlFor="output-quantity">Quantity</FieldLabel>
          <Input
            id="output-quantity"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel id="output-unit-label">Unit</FieldLabel>
          <Select value={unit} onValueChange={(v) => setUnit(v as UnitCode)}>
            <SelectTrigger aria-labelledby="output-unit-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {unitsLike(batch.outputItem.unit).map((u) => (
                  <SelectItem key={u} value={u}>
                    {units[u].label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <LocationSelect
        id="output-location"
        label="Location"
        value={locationId}
        onChange={setLocationId}
        locations={locations}
      />
      <Field>
        <FieldLabel id="output-lot-label">Lot</FieldLabel>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger aria-labelledby="output-lot-label" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NONE}>A new lot</SelectItem>
              {batch.outputs.map((o) => (
                <SelectItem key={o.lotId} value={o.lotId} disabled={o.status !== "quarantine"}>
                  Add to {o.lotCode}
                  {o.status !== "quarantine" ? ` (${lotStatusLabels[o.status].toLowerCase()})` : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {open.length < batch.outputs.length && (
          <FieldDescription>
            Only lots still in quarantine take more output: QA has already decided on the others.
          </FieldDescription>
        )}
      </Field>
      {newLot && (
        <>
          <Field>
            <FieldLabel htmlFor="output-code">Lot code (optional)</FieldLabel>
            <Input
              id="output-code"
              maxLength={60}
              placeholder={batch.batchCode}
              value={lotCode}
              onChange={(e) => setLotCode(e.target.value)}
            />
            <FieldDescription>Defaults to the batch code.</FieldDescription>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="output-expires">Expiry date (optional)</FieldLabel>
              <Input
                id="output-expires"
                type="date"
                value={expiresOn}
                onChange={(e) => setExpiresOn(e.target.value)}
              />
              {!expiresOn && (
                <FieldDescription>
                  Without one, the item&apos;s shelf life sets a best-before date.
                </FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel id="output-expiry-type-label">Expiry type</FieldLabel>
              <Select
                value={expiryType}
                onValueChange={(v) => setExpiryType(v as ExpiryType)}
                disabled={!expiresOn}
              >
                <SelectTrigger aria-labelledby="output-expiry-type-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {expiryTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {expiryTypeLabels[t]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </>
      )}
    </ActionDialog>
  );
}

/**
 * Reserve stock for a planned or in-progress batch: pick lots and quantities per ingredient (only
 * what is not already reserved can be taken), or reserve everything still needed, first expired
 * first out. Reserving never blocks consumption and is released as the batch uses it.
 */
function ReserveDialog({ slug, batch, onClose }: { slug: string; batch: Batch; onClose: () => void }) {
  const router = useRouter();
  const today = useWorkspaceToday();
  type Row = {
    lotId: string;
    itemId: string;
    itemUnit: UnitCode;
    lotCode: string;
    expiresOn: string | null;
    expiryType: ExpiryType | null;
    free: StockAmount;
    blocked: boolean;
    quantity: string;
  };
  const [rows, setRows] = useState<Row[] | null>(null);
  const [auto, setAuto] = useState(false);
  const materials = batch.materials.filter((m) => m.inRecipe);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const api = browserApi().v1.workspaces[":slug"];
        const lotLists = await Promise.all(
          materials.map((m) =>
            unwrap(
              api.stock.lots.$get({
                param: { slug },
                query: { itemId: m.item.id, status: "available", limit: "200" },
              }),
            ),
          ),
        );
        const held = await Promise.all(
          materials.map((m) =>
            unwrap(api.production.reservations.$get({ param: { slug }, query: { itemId: m.item.id } })),
          ),
        );
        const heldBy = new Map<string, number>();
        for (const { reservations } of held)
          for (const r of reservations) heldBy.set(r.lotId, (heldBy.get(r.lotId) ?? 0) + r.held.base);
        const next = materials.flatMap((m, i) =>
          lotLists[i]!.lots.flatMap((lot): Row[] => {
            const freeBase = Math.max(lot.onHand.base - (heldBy.get(lot.id) ?? 0), 0);
            if (freeBase <= 0) return [];
            return [
              {
                lotId: lot.id,
                itemId: m.item.id,
                itemUnit: m.item.unit,
                lotCode: lot.lotCode,
                expiresOn: lot.expiresOn,
                expiryType: lot.expiryType,
                free: {
                  ...lot.onHand,
                  base: freeBase,
                  display: lot.onHand.base ? (freeBase / lot.onHand.base) * lot.onHand.display : 0,
                },
                blocked: lot.expiryType === "use_by" && classifyExpiry(lot.expiresOn, today) === "expired",
                quantity: "",
              },
            ];
          }),
        );
        if (live) setRows(next);
      } catch (err) {
        toast.error(errorMessage(err));
        if (live) setRows([]);
      }
    })();
    return () => {
      live = false;
    };
    // Loaded once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const route = browserApi().v1.workspaces[":slug"].production.batches[":id"].reservations;
  const param = { slug, id: batch.id };
  const lines = (rows ?? []).filter((r) => Number(r.quantity) > 0);

  async function reserveAll() {
    setAuto(true);
    try {
      const res = await unwrap(route.$post({ param, json: { allOutstanding: true } }));
      const short = res.shortfalls.length;
      if (short > 0)
        toast.warning(`Reserved what is free; ${short} ingredient${short === 1 ? " is" : "s are"} short`);
      else toast.success("Everything outstanding is reserved");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAuto(false);
    }
  }

  return (
    <ActionDialog
      title={`Reserve stock for ${batch.batchCode}`}
      description="Set stock aside so other batches don't count on it. Only released lots that are not already reserved are listed."
      submitLabel={`Reserve ${lines.length || ""} line${lines.length === 1 ? "" : "s"}`}
      wide
      disabled={lines.length === 0}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          route.$post({
            param,
            json: {
              lines: lines.map((r) => ({ lotId: r.lotId, quantity: Number(r.quantity), unit: r.itemUnit })),
            },
          }),
        );
        return `Stock reserved for ${batch.batchCode}`;
      }}
    >
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        disabled={auto}
        onClick={() => void reserveAll()}
      >
        {auto ? <Spinner data-icon="inline-start" /> : <Lock data-icon="inline-start" />}
        Reserve everything outstanding, first expired first out
      </Button>
      {rows === null ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        materials.map((m) => {
          const mine = rows.filter((r) => r.itemId === m.item.id);
          return (
            <div key={m.item.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{m.item.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {m.outstanding ? `${formatAmount(m.outstanding)} outstanding` : ""}
                  {m.reserved.base > 0 ? ` · ${formatAmount(m.reserved)} reserved` : ""}
                </span>
              </div>
              {mine.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No unreserved released stock of this ingredient.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {mine.map((r) => (
                    <li key={r.lotId} className="grid grid-cols-[1fr_8rem] items-center gap-3 text-sm">
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="font-mono text-xs">{r.lotCode}</span>
                        <ExpiryBadge expiresOn={r.expiresOn} expiryType={r.expiryType} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatAmount(r.free)} free
                        </span>
                      </span>
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`Quantity of lot ${r.lotCode} to reserve`}
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min="0"
                          max={r.free.display}
                          disabled={r.blocked}
                          value={r.quantity}
                          onChange={(e) =>
                            setRows(
                              (list) =>
                                list?.map((x) =>
                                  x.lotId === r.lotId ? { ...x, quantity: e.target.value } : x,
                                ) ?? null,
                            )
                          }
                        />
                        <span className="text-xs text-muted-foreground">{units[r.itemUnit].label}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </ActionDialog>
  );
}
