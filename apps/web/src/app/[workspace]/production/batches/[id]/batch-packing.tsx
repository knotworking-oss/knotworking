"use client";

import {
  detectorTestPieceLabels,
  detectorTestPieces,
  lineClearanceItems,
  lineClearanceLabels,
  packingCheckLabels,
  type DetectorTestPiece,
  type LineClearanceItem,
  type PackingCheckKind,
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
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { CircleCheck, CircleX, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { BatchPacking } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useFormatDateTime } from "@/lib/workspace-time";
import { useWorkspace } from "@/lib/workspace-store";

type Run = NonNullable<BatchPacking["open"]>;
const production = () => browserApi().v1.workspaces[":slug"].production;
const NONE = "none";

/**
 * Packing (3.5.3): the run pins the approved label and specification the packs carry and the codes
 * they must show; checks are recorded against it and closing reconciles packaging. Checks are
 * append-only: voided with a reason.
 */
export function BatchPackingPanel({ slug, packing }: { slug: string; packing: BatchPacking }) {
  const { can } = useWorkspace();
  const canWrite = can("production", "write");
  const dateTime = useFormatDateTime();
  const [dialog, setDialog] = useState<
    | { kind: "open" }
    | { kind: "check"; check: PackingCheckKind; run: Run }
    | { kind: "close"; run: Run }
    | { kind: "void"; id: string; label: string }
    | { kind: "scale"; run: Run }
    | null
  >(null);
  if (packing.status === "planned" || packing.status === "cancelled") {
    if (packing.runs.length === 0) return null;
  }
  const open = packing.open;
  return (
    <div className="workspace-content pb-8">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Packing</CardTitle>
          {canWrite && !open && packing.status === "in_progress" && (
            <Button size="sm" onClick={() => setDialog({ kind: "open" })}>
              <Plus data-icon="inline-start" /> Start packing
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-6 text-sm">
          {packing.runs.length === 0 && (
            <p className="text-muted-foreground">
              Not packed yet. Starting packing pins the approved label the packs carry and the codes they must
              show.
            </p>
          )}
          {packing.runs.map((run) => (
            <section key={run.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={run.status === "open" ? "default" : "outline"}>
                    {run.status === "open" ? "Packing" : "Closed"}
                  </Badge>
                  <span className="text-muted-foreground">
                    Started {dateTime(run.openedAt)}
                    {run.openedByName && ` by ${run.openedByName}`}
                    {run.closedAt &&
                      ` · closed ${dateTime(run.closedAt)}${run.closedByName ? ` by ${run.closedByName}` : ""}`}
                  </span>
                </div>
                {canWrite && run.status === "open" && (
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        "line_clearance",
                        "first_off",
                        "in_run_label",
                        "detector_challenge",
                        "weight_sample",
                      ] as const
                    )
                      .filter((k) => (k === "weight_sample" ? run.nominalQuantity !== null : true))
                      .filter((k) => (k === "detector_challenge" ? run.detectorRequired : true))
                      .map((k) => (
                        <Button
                          key={k}
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "check", check: k, run })}
                        >
                          {packingCheckLabels[k]}
                        </Button>
                      ))}
                    {run.nominalQuantity !== null && (
                      <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "scale", run })}>
                        Weight from scale
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={run.gaps.length > 0}
                      title={run.gaps.length ? run.gaps.join("; ") : undefined}
                      onClick={() => setDialog({ kind: "close", run })}
                    >
                      Close packing
                    </Button>
                  </div>
                )}
              </div>
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Label</dt>
                <dd>
                  {run.labelSummary
                    ? `${run.labelSummary.productName} · ${run.labelSummary.variant} v${run.labelSummary.versionNumber}${run.labelSummary.netQuantity ? ` · ${run.labelSummary.netQuantity}` : ""}${run.labelSummary.gtin ? ` · ${run.labelSummary.gtin}` : ""}`
                    : "None pinned (labels module not used)"}
                </dd>
                {run.specificationSummary && (
                  <>
                    <dt className="text-muted-foreground">Specification</dt>
                    <dd>
                      {run.specificationSummary.code} {run.specificationSummary.title} v
                      {run.specificationSummary.versionNumber}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">Codes</dt>
                <dd className="font-mono text-xs">
                  {run.expectedDateCode} · {run.expectedLotCode}
                </dd>
                {run.nominalQuantity !== null && (
                  <>
                    <dt className="text-muted-foreground">Nominal quantity</dt>
                    <dd>{run.nominalQuantity} g or ml per pack</dd>
                  </>
                )}
                {run.status === "closed" && (
                  <>
                    <dt className="text-muted-foreground">Packs produced</dt>
                    <dd>{run.packsProduced}</dd>
                  </>
                )}
              </dl>
              {run.status === "open" && run.gaps.length > 0 && (
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {run.gaps.map((g) => (
                    <li key={g} className="flex items-center gap-2">
                      <TriangleAlert className="size-4 shrink-0" />
                      {g}
                    </li>
                  ))}
                </ul>
              )}
              {run.checks.length > 0 && (
                <ul className="flex flex-col divide-y rounded-md border">
                  {run.checks.map((c) => (
                    <li
                      key={c.id}
                      className={`flex flex-wrap items-start justify-between gap-2 px-3 py-2 ${c.voidedAt ? "opacity-60" : ""}`}
                    >
                      <span className="flex items-start gap-2">
                        {c.passed ? (
                          <CircleCheck
                            className="mt-0.5 size-4 shrink-0 text-status-completed"
                            aria-label="Passed"
                          />
                        ) : (
                          <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />
                        )}
                        <span className="flex flex-col">
                          <span className={c.voidedAt ? "line-through" : ""}>
                            {c.kindLabel}
                            <span className="text-muted-foreground"> · {dateTime(c.checkedAt)}</span>
                          </span>
                          {c.reasons.map((r) => (
                            <span key={r} className="text-destructive">
                              {r}
                            </span>
                          ))}
                          {c.failureAction && <span>Action: {c.failureAction}</span>}
                          {c.note && <span className="text-muted-foreground">{c.note}</span>}
                          {c.voidedAt && (
                            <span className="text-xs text-muted-foreground">
                              Voided{c.voidedByName ? ` by ${c.voidedByName}` : ""}: {c.voidReason}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {c.recordedByName}
                        {canWrite && run.status === "open" && !c.voidedAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: "void", id: c.id, label: c.kindLabel })}
                          >
                            Void
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {run.reconciliation && run.reconciliation.length > 0 && (
                <table className="w-fit tabular-nums">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="pr-4 font-medium">Packaging</th>
                      <th className="pr-4 text-right font-medium">Issued</th>
                      <th className="pr-4 text-right font-medium">Used</th>
                      <th className="pr-4 text-right font-medium">Wasted</th>
                      <th className="pr-4 text-right font-medium">Returned</th>
                      <th className="text-right font-medium">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.reconciliation.map((l) => (
                      <tr key={l.material}>
                        <td className="pr-4">
                          {l.material}
                          {l.printed && <span className="text-muted-foreground"> (printed)</span>}
                        </td>
                        <td className="pr-4 text-right">{l.issued}</td>
                        <td className="pr-4 text-right">{l.used}</td>
                        <td className="pr-4 text-right">{l.wasted}</td>
                        <td className="pr-4 text-right">{l.returned}</td>
                        <td
                          className={`text-right ${l.variance !== 0 ? "font-medium text-destructive" : ""}`}
                        >
                          {l.variance}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {run.varianceReason && <p>Difference explained: {run.varianceReason}</p>}
            </section>
          ))}
        </CardContent>
      </Card>
      {dialog?.kind === "open" && (
        <OpenDialog slug={slug} packing={packing} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "check" && (
        <CheckDialog slug={slug} run={dialog.run} check={dialog.check} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "scale" && (
        <ScaleWeightDialog slug={slug} run={dialog.run} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "close" && (
        <CloseDialog slug={slug} run={dialog.run} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "void" && (
        <Shell
          title={`Void ${dialog.label}`}
          description="The check stays as history with your reason and stops counting."
          submitLabel="Void"
          onClose={() => setDialog(null)}
          onSubmit={async (commandId, form) => {
            await unwrap(
              production().packing.checks[":id"].void.$post({
                param: { slug, id: dialog.id },
                json: { commandId, reason: String(form.get("reason") ?? "").trim() },
              }),
            );
            return "Check voided";
          }}
        >
          <Field>
            <FieldLabel htmlFor="pk-void">Reason</FieldLabel>
            <Textarea id="pk-void" name="reason" required maxLength={1000} />
          </Field>
        </Shell>
      )}
    </div>
  );
}

function Shell({
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
  wide,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (commandId: string, form: FormData) => Promise<string>;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  // One id per dialog: a double submit or a retry after a lost response records once.
  const [commandId] = useState(() => crypto.randomUUID());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    try {
      toast.success(await onSubmit(commandId, form));
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={wide ? "sm:max-w-2xl" : "sm:max-w-lg"}>
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

function OpenDialog({
  slug,
  packing,
  onClose,
}: {
  slug: string;
  packing: BatchPacking;
  onClose: () => void;
}) {
  const { labels, specifications, defaultLotCode, labelsVisible, labelCount } = packing.candidates;
  // No default among several variants: the wrong one mustn't be pinned by accident.
  const [labelId, setLabelId] = useState(labels.length === 1 ? labels[0]!.id : NONE);
  const [specId, setSpecId] = useState(NONE);
  const [detector, setDetector] = useState(true);
  return (
    <Shell
      title="Start packing"
      description="Pins the approved label and specification these packs carry, and the codes they must show. Only labels approved for the recipe version this batch is made to are offered."
      submitLabel="Start packing"
      onClose={onClose}
      onSubmit={async (commandId, form) => {
        const nominal = String(form.get("nominal") ?? "").trim();
        const lot = String(form.get("lot") ?? "").trim();
        await unwrap(
          production().batches[":id"].packing.$post({
            param: { slug, id: packing.batchId },
            json: {
              commandId,
              labelId: labelId === NONE ? null : labelId,
              ...(specId !== NONE ? { specificationVersionId: specId } : {}),
              expectedDateCode: String(form.get("dateCode") ?? "").trim(),
              ...(lot ? { expectedLotCode: lot } : {}),
              ...(nominal ? { nominalQuantity: Number(nominal) } : {}),
              detectorRequired: detector,
              note: String(form.get("note") ?? "").trim(),
            },
          }),
        );
        return "Packing started";
      }}
    >
      {labelsVisible ? (
        <Field>
          <FieldLabel id="pk-label">Approved label</FieldLabel>
          <Select value={labelId} onValueChange={setLabelId}>
            <SelectTrigger aria-labelledby="pk-label" className="w-full">
              <SelectValue placeholder="Choose the label the packs carry" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {labels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.productName} · {l.variant} v{l.versionNumber}
                    {l.netQuantity ? ` · ${l.netQuantity}` : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {labels.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No approved label for this batch&apos;s recipe version. Approve one under Labels first.
            </p>
          )}
        </Field>
      ) : (
        <p className="text-sm text-muted-foreground">
          {labelCount === 1
            ? "The approved label for this batch's recipe version will be pinned."
            : labelCount === 0
              ? "No approved label for this batch's recipe version yet; someone with Labels access must approve one."
              : "There are several approved labels for this batch: someone with Labels access must choose which the packs carry."}
        </p>
      )}
      {specifications.length > 0 && (
        <Field>
          <FieldLabel id="pk-spec">Specification (optional)</FieldLabel>
          <Select value={specId} onValueChange={setSpecId}>
            <SelectTrigger aria-labelledby="pk-spec" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>None</SelectItem>
                {specifications.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.code} {s.title} v{s.versionNumber}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="pk-date">Date code on packs</FieldLabel>
          <Input id="pk-date" name="dateCode" required maxLength={80} placeholder="BB 24 NOV 2026" />
        </Field>
        <Field>
          <FieldLabel htmlFor="pk-lot">Lot code on packs</FieldLabel>
          <Input id="pk-lot" name="lot" maxLength={80} placeholder={defaultLotCode} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="pk-nominal">
          Nominal quantity per pack, g or ml (optional: turns on weight samples)
        </FieldLabel>
        <Input
          id="pk-nominal"
          name="nominal"
          type="number"
          inputMode="decimal"
          step="any"
          min="5"
          max="50000"
        />
      </Field>
      <Field orientation="horizontal">
        <input
          id="pk-detector"
          type="checkbox"
          checked={detector}
          onChange={(e) => setDetector(e.target.checked)}
        />
        <FieldLabel htmlFor="pk-detector">This line has a metal detector to challenge</FieldLabel>
      </Field>
      <Field>
        <FieldLabel htmlFor="pk-note">Note (optional)</FieldLabel>
        <Textarea id="pk-note" name="note" maxLength={1000} />
      </Field>
    </Shell>
  );
}

function CheckDialog({
  slug,
  run,
  check,
  onClose,
}: {
  slug: string;
  run: Run;
  check: PackingCheckKind;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Record<LineClearanceItem, boolean>>(
    Object.fromEntries(lineClearanceItems.map((i) => [i, false])) as Record<LineClearanceItem, boolean>,
  );
  // Nothing passes by default: each confirmation is an explicit tick.
  const [labelCorrect, setLabelCorrect] = useState(false);
  const [legible, setLegible] = useState(false);
  const [pieces, setPieces] = useState<{ piece: DetectorTestPiece; sizeMm: string; rejected: boolean }[]>(
    detectorTestPieces.map((piece) => ({ piece, sizeMm: "", rejected: false })),
  );
  const description: Record<PackingCheckKind, string> = {
    line_clearance:
      "Before packing: nothing of the previous product, packaging, labels or codes is left on the line.",
    first_off: `The first packs: the approved label, and the codes ${run.expectedDateCode} and ${run.expectedLotCode}.`,
    in_run_label: `During the run: the approved label, and the codes ${run.expectedDateCode} and ${run.expectedLotCode}.`,
    detector_challenge: "Pass each test piece through the detector and record whether it was rejected.",
    weight_sample: `Pack weights in g, one per line or separated by commas. Nominal ${run.nominalQuantity} g.`,
  };
  return (
    <Shell
      wide={check === "detector_challenge"}
      title={packingCheckLabels[check]}
      description={description[check]}
      submitLabel="Record"
      onClose={onClose}
      onSubmit={async (commandId, form) => {
        const common = {
          commandId,
          note: String(form.get("note") ?? "").trim(),
          ...(String(form.get("action") ?? "").trim()
            ? { failureAction: String(form.get("action")).trim() }
            : {}),
        };
        const json =
          check === "line_clearance"
            ? { ...common, kind: check, items }
            : check === "first_off" || check === "in_run_label"
              ? {
                  ...common,
                  kind: check,
                  labelCorrect,
                  legible,
                  dateCodeSeen: String(form.get("dateSeen") ?? "").trim(),
                  lotCodeSeen: String(form.get("lotSeen") ?? "").trim(),
                }
              : check === "detector_challenge"
                ? {
                    ...common,
                    kind: check,
                    detector: String(form.get("detector") ?? "").trim(),
                    pieces: pieces.map((p) => ({
                      piece: p.piece,
                      sizeMm: Number(p.sizeMm),
                      rejected: p.rejected,
                    })),
                  }
                : {
                    ...common,
                    kind: check,
                    readings: String(form.get("readings") ?? "")
                      .split(/[\s,]+/)
                      .filter(Boolean)
                      .map(Number),
                  };
        const result = await unwrap(
          production().packing[":id"].checks.$post({ param: { slug, id: run.id }, json: json as never }),
        );
        const last = result.open?.checks.at(-1);
        return last && !last.passed ? `Recorded as failed: ${last.reasons.join("; ")}` : "Passed";
      }}
    >
      {check === "line_clearance" &&
        lineClearanceItems.map((i) => (
          <Field key={i} orientation="horizontal">
            <input
              id={`lc-${i}`}
              type="checkbox"
              checked={items[i]}
              onChange={(e) => setItems((v) => ({ ...v, [i]: e.target.checked }))}
            />
            <FieldLabel htmlFor={`lc-${i}`}>{lineClearanceLabels[i]}</FieldLabel>
          </Field>
        ))}
      {(check === "first_off" || check === "in_run_label") && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="pk-date-seen">Date code on the pack</FieldLabel>
              <Input id="pk-date-seen" name="dateSeen" required maxLength={80} />
            </Field>
            <Field>
              <FieldLabel htmlFor="pk-lot-seen">Lot code on the pack</FieldLabel>
              <Input id="pk-lot-seen" name="lotSeen" required maxLength={80} />
            </Field>
          </div>
          <Field orientation="horizontal">
            <input
              id="pk-label-ok"
              type="checkbox"
              checked={labelCorrect}
              onChange={(e) => setLabelCorrect(e.target.checked)}
            />
            <FieldLabel htmlFor="pk-label-ok">
              The pack carries the approved label
              {run.labelSummary ? ` (${run.labelSummary.variant} v${run.labelSummary.versionNumber})` : ""}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <input
              id="pk-legible"
              type="checkbox"
              checked={legible}
              onChange={(e) => setLegible(e.target.checked)}
            />
            <FieldLabel htmlFor="pk-legible">Codes are legible and complete</FieldLabel>
          </Field>
        </>
      )}
      {check === "detector_challenge" && (
        <>
          <Field>
            <FieldLabel htmlFor="pk-detector-name">Detector</FieldLabel>
            <Input id="pk-detector-name" name="detector" required maxLength={120} />
          </Field>
          {pieces.map((p, i) => (
            <div key={p.piece} className="grid grid-cols-[8rem_7rem_1fr] items-end gap-3">
              <span className="pb-2">{detectorTestPieceLabels[p.piece]}</span>
              <Field>
                <FieldLabel htmlFor={`pc-${p.piece}`}>Size, mm</FieldLabel>
                <Input
                  id={`pc-${p.piece}`}
                  type="number"
                  step="any"
                  min="0"
                  required
                  value={p.sizeMm}
                  onChange={(e) =>
                    setPieces((v) => v.map((x, j) => (j === i ? { ...x, sizeMm: e.target.value } : x)))
                  }
                />
              </Field>
              <Field orientation="horizontal" className="pb-2">
                <input
                  id={`pr-${p.piece}`}
                  type="checkbox"
                  checked={p.rejected}
                  onChange={(e) =>
                    setPieces((v) => v.map((x, j) => (j === i ? { ...x, rejected: e.target.checked } : x)))
                  }
                />
                <FieldLabel htmlFor={`pr-${p.piece}`}>Rejected</FieldLabel>
              </Field>
            </div>
          ))}
        </>
      )}
      {check === "weight_sample" && (
        <Field>
          <FieldLabel htmlFor="pk-readings">Weights, g</FieldLabel>
          <Textarea id="pk-readings" name="readings" required placeholder="252, 251, 249, 253, 250" />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="pk-action">If it fails: what was done (packs held, line stopped, …)</FieldLabel>
        <Textarea id="pk-action" name="action" maxLength={2000} />
      </Field>
      <Field>
        <FieldLabel htmlFor="pk-check-note">Note (optional)</FieldLabel>
        <Input id="pk-check-note" name="note" maxLength={1000} />
      </Field>
    </Shell>
  );
}

type LineDraft = {
  key: number;
  material: string;
  printed: boolean;
  issued: string;
  used: string;
  wasted: string;
  returned: string;
};

function CloseDialog({ slug, run, onClose }: { slug: string; run: Run; onClose: () => void }) {
  const [lines, setLines] = useState<LineDraft[]>([
    {
      key: 0,
      material: "Labels or printed film",
      printed: true,
      issued: "",
      used: "",
      wasted: "",
      returned: "",
    },
  ]);
  const [next, setNext] = useState(1);
  const n = (v: string) => Number(v || 0);
  const variance = (l: LineDraft) => n(l.issued) - n(l.used) - n(l.wasted) - n(l.returned);
  const unreconciled = lines.some((l) => variance(l) !== 0);
  const update = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <Shell
      wide
      title="Close packing"
      description="Count the packs made and reconcile packaging: issued = used + wasted + returned. Any difference must be explained. A closed run never changes."
      submitLabel="Close packing"
      onClose={onClose}
      onSubmit={async (commandId, form) => {
        await unwrap(
          production().packing[":id"].close.$post({
            param: { slug, id: run.id },
            json: {
              commandId,
              packsProduced: Number(form.get("packs") ?? 0),
              reconciliation: lines.map((l) => ({
                material: l.material.trim(),
                printed: l.printed,
                issued: n(l.issued),
                used: n(l.used),
                wasted: n(l.wasted),
                returned: n(l.returned),
              })),
              ...(String(form.get("variance") ?? "").trim()
                ? { varianceReason: String(form.get("variance")).trim() }
                : {}),
              note: String(form.get("note") ?? "").trim(),
            },
          }),
        );
        return "Packing closed";
      }}
    >
      <Field>
        <FieldLabel htmlFor="pk-packs">Packs of good product made</FieldLabel>
        <Input id="pk-packs" name="packs" type="number" min="0" step="1" required />
      </Field>
      {lines.map((l) => (
        <div key={l.key} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
            <Field>
              <FieldLabel htmlFor={`rc-m-${l.key}`}>Material</FieldLabel>
              <Input
                id={`rc-m-${l.key}`}
                required
                maxLength={120}
                value={l.material}
                onChange={(e) => update(l.key, { material: e.target.value })}
              />
            </Field>
            <Field orientation="horizontal" className="pb-2">
              <input
                id={`rc-p-${l.key}`}
                type="checkbox"
                checked={l.printed}
                onChange={(e) => update(l.key, { printed: e.target.checked })}
              />
              <FieldLabel htmlFor={`rc-p-${l.key}`}>Printed</FieldLabel>
            </Field>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Remove material"
              disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="grid grid-cols-5 items-end gap-2">
            {(["issued", "used", "wasted", "returned"] as const).map((f) => (
              <Field key={f}>
                <FieldLabel htmlFor={`rc-${f}-${l.key}`} className="capitalize">
                  {f}
                </FieldLabel>
                <Input
                  id={`rc-${f}-${l.key}`}
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={l[f]}
                  onChange={(e) => update(l.key, { [f]: e.target.value })}
                />
              </Field>
            ))}
            <span
              className={`pb-2 text-right tabular-nums ${variance(l) !== 0 ? "font-medium text-destructive" : "text-muted-foreground"}`}
            >
              Difference {variance(l)}
            </span>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => {
          setLines((ls) => [
            ...ls,
            { key: next, material: "", printed: false, issued: "", used: "", wasted: "", returned: "" },
          ]);
          setNext((k) => k + 1);
        }}
      >
        <Plus data-icon="inline-start" /> Add material
      </Button>
      {unreconciled && (
        <Field>
          <FieldLabel htmlFor="pk-variance">Explain the difference</FieldLabel>
          <Textarea id="pk-variance" name="variance" required maxLength={2000} />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="pk-close-note">Note (optional)</FieldLabel>
        <Textarea id="pk-close-note" name="note" maxLength={1000} />
      </Field>
    </Shell>
  );
}

type Device = {
  id: string;
  code: string;
  name: string;
  kind: string;
  status: string;
  unit: string | null;
  calibration: { state: string };
};
type Reading = {
  id: string;
  readingId: string;
  takenAt: string;
  value: number;
  late: boolean;
  calibrationState: string;
};

/**
 * A weight sample from a scale's readings (3.5.4): the scale's unused readings since packing
 * started, chosen and recorded as one sample. Only while the scale's calibration is in date.
 */
function ScaleWeightDialog({ slug, run, onClose }: { slug: string; run: Run; onClose: () => void }) {
  const dateTime = useFormatDateTime();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [deviceId, setDeviceId] = useState(NONE);
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const api = browserApi().v1.workspaces[":slug"].production.devices;
  useEffect(() => {
    void unwrap(api.$get({ param: { slug } }))
      .then((r) =>
        setDevices(
          (r.devices as Device[]).filter(
            (d) => d.status === "active" && (d.kind === "scale" || d.kind === "checkweigher"),
          ),
        ),
      )
      .catch((err) => toast.error(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  useEffect(() => {
    setReadings(null);
    setChosen(new Set());
    if (deviceId === NONE) return;
    let live = true;
    void unwrap(
      api[":id"].readings.$get({
        param: { slug, id: deviceId },
        query: { unused: "true", from: new Date(run.openedAt).toISOString(), limit: "100" },
      }),
    )
      .then((r) => live && setReadings(r.readings as unknown as Reading[]))
      .catch((err) => live && toast.error(errorMessage(err)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, slug, run.openedAt]);
  const device = devices?.find((d) => d.id === deviceId);
  const inDate = device?.calibration.state === "in_date";
  return (
    <Shell
      wide
      title="Weight sample from a scale"
      description={`Choose readings the scale sent since packing started. Nominal ${run.nominalQuantity} g; the sample is judged like any weight sample.`}
      submitLabel="Record"
      onClose={onClose}
      onSubmit={async (commandId, form) => {
        if (!device || !inDate) throw new Error("Choose a scale whose calibration is in date");
        if (chosen.size === 0) throw new Error("Choose the readings in the sample");
        const result = await unwrap(
          browserApi().v1.workspaces[":slug"].production.packing[":id"].checks["weight-from-device"].$post({
            param: { slug, id: run.id },
            json: {
              commandId,
              deviceId: device.id,
              readingIds: [...chosen],
              ...(String(form.get("action") ?? "").trim()
                ? { failureAction: String(form.get("action")).trim() }
                : {}),
              note: "",
            },
          }),
        );
        const last = result.open?.checks.at(-1);
        return last && !last.passed ? `Recorded as failed: ${last.reasons.join("; ")}` : "Passed";
      }}
    >
      <Field>
        <FieldLabel id="sc-device">Scale</FieldLabel>
        <Select value={deviceId} onValueChange={setDeviceId}>
          <SelectTrigger aria-labelledby="sc-device" className="w-full">
            <SelectValue placeholder={devices === null ? "Loading…" : "Choose a scale"} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(devices ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.code} {d.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {devices?.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No active scales or checkweighers. Register one under Devices.
          </p>
        )}
        {device && !inDate && (
          <p className="text-xs text-destructive">
            {device.calibration.state === "not_required"
              ? `${device.code} isn't linked to calibrated equipment: link it under Devices before its readings become records.`
              : `${device.code}'s calibration isn't in date (${device.calibration.state.replace("_", " ")}): its readings can't become records.`}
          </p>
        )}
      </Field>
      {readings &&
        (readings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unused readings from this scale since packing started.
          </p>
        ) : (
          <>
            <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border text-sm">
              {readings.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-3 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={`Reading ${r.readingId}`}
                    // Only readings taken while calibration was in date can become records.
                    disabled={r.calibrationState !== "in_date"}
                    checked={chosen.has(r.id)}
                    onChange={(e) =>
                      setChosen((c) => {
                        const next = new Set(c);
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                        return next;
                      })
                    }
                  />
                  <span className="tabular-nums">
                    {r.value} {device?.unit}
                  </span>
                  <span className="text-muted-foreground">{dateTime(r.takenAt)}</span>
                  {r.late && <Badge variant="outline">Sent late</Badge>}
                  {r.calibrationState !== "in_date" && (
                    <Badge variant="outline">Calibration {r.calibrationState.replace("_", " ")}</Badge>
                  )}
                </li>
              ))}
            </ul>
            {readings.length === 100 && (
              <p className="text-xs text-muted-foreground">The latest 100 unused readings are shown.</p>
            )}
          </>
        ))}
      <Field>
        <FieldLabel htmlFor="sc-action">If it fails: what was done</FieldLabel>
        <Textarea id="sc-action" name="action" maxLength={2000} />
      </Field>
    </Shell>
  );
}
