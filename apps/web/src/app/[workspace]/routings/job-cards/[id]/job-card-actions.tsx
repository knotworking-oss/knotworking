"use client";

import {
  jobCardExceptionKindLabels,
  jobCardExceptionKinds,
  type JobCardExceptionKind,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { CheckCircle2, Clock, PackagePlus, Pause, Play, TriangleAlert, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import type { JobCard } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const cardsApi = () => browserApi().v1.workspaces[":slug"].routings["job-cards"][":id"];

export interface PickLine {
  lotId: string;
  lotCode: string;
  locationId: string;
  locationName: string;
  itemName: string;
  display: number;
  displayUnit: string;
}

type Dialog = "time" | "quantity" | "exception" | "complete" | "materials" | "output" | null;

/** What can be done on an open job card: timers, time, quantities, exceptions, materials, output, completion. */
export function JobCardActions({
  slug,
  card,
  batchRunning,
  pick,
  output = null,
}: {
  slug: string;
  card: JobCard;
  batchRunning: boolean;
  /** Suggested lots for the batch's outstanding materials (empty without Stock or Production write). */
  pick: readonly PickLine[];
  /**
   * For the last operation's output: the batch's output location (`null` when none was chosen)
   * and the active stock locations to choose from.
   */
  output?: {
    locationId: string | null;
    locations: readonly { id: string; name: string }[];
  } | null;
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState<Dialog>(null);
  const [pending, setPending] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [good, setGood] = useState("");
  const [scrap, setScrap] = useState("");
  const [scrapReason, setScrapReason] = useState("");
  const [overPlanned, setOverPlanned] = useState(false);
  const [kind, setKind] = useState<JobCardExceptionKind>("machine");
  const [description, setDescription] = useState("");
  const [lotCode, setLotCode] = useState("");
  const batchLocation = output?.locations.find((l) => l.id === output.locationId);
  const [locationId, setLocationId] = useState(batchLocation?.id ?? output?.locations[0]?.id ?? "");
  const [use, setUse] = useState<Record<string, string>>({});
  const param = { slug, id: card.id };
  const unit = card.outputItem.unit;
  const isOpen = card.status === "pending" || card.status === "in_progress";
  if (!isOpen || !can("routings", "write")) return null;

  async function quick(action: () => Promise<unknown>, message: string) {
    setPending(true);
    try {
      await action();
      toast.success(message);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  const close = () => setOpen(null);
  const remaining = card.sequence.remaining;

  return (
    <div className="flex flex-wrap gap-2">
      {batchRunning && (
        <>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              void quick(() => unwrap(cardsApi().timer.start.$post({ param, json: {} })), "Timer started")
            }
          >
            <Play /> Start timer
          </Button>
          {card.runningTimers > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void quick(() => unwrap(cardsApi().timer.stop.$post({ param })), "Timer stopped")
              }
            >
              <Pause /> Stop my timer
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setOpen("time")}>
            <Clock /> Log time
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOpen("quantity")}>
            <CheckCircle2 /> Report good and scrap
          </Button>
          {can("production", "write") && pick.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setOpen("materials")}>
              <Wrench /> Use materials
            </Button>
          )}
          {can("production", "write") && card.sequence.isLast && (
            <Button size="sm" variant="outline" onClick={() => setOpen("output")}>
              <PackagePlus /> Post output
            </Button>
          )}
        </>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen("exception")}>
        <TriangleAlert /> Raise exception
      </Button>
      {batchRunning && (
        <Button size="sm" variant="secondary" onClick={() => setOpen("complete")}>
          Complete operation
        </Button>
      )}

      {open === "time" && (
        <HaccpDialog
          title="Log time"
          description={`Minutes you worked on ${card.name}.`}
          submitLabel="Log"
          disabled={!(Number(minutes) >= 1)}
          onClose={close}
          onSubmit={async () => {
            await unwrap(
              cardsApi().time.$post({
                param,
                json: { minutes: Math.round(Number(minutes)), note: note.trim() || null },
              }),
            );
            return "Time logged";
          }}
        >
          <Field>
            <FieldLabel htmlFor="jc-minutes">Minutes</FieldLabel>
            <Input
              id="jc-minutes"
              type="number"
              min={1}
              max={1440}
              step={1}
              required
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="jc-time-note">Note (optional)</FieldLabel>
            <Input id="jc-time-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </HaccpDialog>
      )}

      {open === "quantity" && (
        <HaccpDialog
          title="Report good and scrap"
          description={
            remaining
              ? `At most ${remaining.display} ${remaining.displayUnit} more: what operation ${card.sequence.previous?.position} passed as good.`
              : `What this operation finished, and what it scrapped: up to the planned ${card.plannedQuantity.display} ${card.plannedQuantity.displayUnit} in all, unless more was made.`
          }
          submitLabel="Report"
          disabled={!(Number(good) > 0 || Number(scrap) > 0) || (Number(scrap) > 0 && !scrapReason.trim())}
          onClose={close}
          onSubmit={async () => {
            await unwrap(
              cardsApi().quantities.$post({
                param,
                json: {
                  good: Number(good) || 0,
                  scrap: Number(scrap) || 0,
                  unit,
                  scrapReason: scrapReason.trim() || null,
                  ...(overPlanned ? { overPlanned: true } : {}),
                },
              }),
            );
            return "Quantities reported";
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="jc-good">Good ({unit})</FieldLabel>
              <Input
                id="jc-good"
                type="number"
                min={0}
                step="any"
                value={good}
                onChange={(e) => setGood(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="jc-scrap">Scrap ({unit})</FieldLabel>
              <Input
                id="jc-scrap"
                type="number"
                min={0}
                step="any"
                value={scrap}
                onChange={(e) => setScrap(e.target.value)}
              />
            </Field>
          </div>
          {Number(scrap) > 0 && (
            <Field>
              <FieldLabel htmlFor="jc-scrap-reason">Why was it scrapped?</FieldLabel>
              <Input
                id="jc-scrap-reason"
                required
                maxLength={500}
                value={scrapReason}
                onChange={(e) => setScrapReason(e.target.value)}
              />
            </Field>
          )}
          {!card.sequence.previous && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={overPlanned} onCheckedChange={(v) => setOverPlanned(v === true)} />
              More than planned was made (over-production)
            </label>
          )}
        </HaccpDialog>
      )}

      {open === "exception" && (
        <HaccpDialog
          title="Raise an exception"
          description="Something that went wrong at this operation. It must be resolved before the operation completes."
          submitLabel="Raise"
          disabled={!description.trim()}
          onClose={close}
          onSubmit={async () => {
            await unwrap(
              cardsApi().exceptions.$post({ param, json: { kind, description: description.trim() } }),
            );
            return "Exception raised";
          }}
        >
          <SelectField
            id="jc-exception-kind"
            label="Kind"
            value={kind}
            onChange={(v) => setKind(v as JobCardExceptionKind)}
            options={jobCardExceptionKinds.map((k) => [k, jobCardExceptionKindLabels[k]] as const)}
          />
          <Field>
            <FieldLabel htmlFor="jc-exception-description">What happened?</FieldLabel>
            <Textarea
              id="jc-exception-description"
              rows={3}
              required
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </HaccpDialog>
      )}

      {open === "complete" && (
        <HaccpDialog
          title={`Complete ${card.name}`}
          description="Running timers on this operation stop now. The next operation can then complete in turn."
          submitLabel="Complete"
          onClose={close}
          onSubmit={async () => {
            await unwrap(cardsApi().complete.$post({ param, json: { note: note.trim() || null } }));
            return `${card.name} completed`;
          }}
        >
          <Field>
            <FieldLabel htmlFor="jc-complete-note">Note (optional)</FieldLabel>
            <Input
              id="jc-complete-note"
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </HaccpDialog>
      )}

      {open === "materials" && (
        <HaccpDialog
          title="Use materials at this operation"
          description="Posted as the batch's consumption and linked to this job card. Suggested lots are first expired, first out."
          submitLabel="Use"
          wide
          disabled={!Object.values(use).some((v) => Number(v) > 0)}
          onClose={close}
          onSubmit={async () => {
            const lines = pick
              .filter((p) => Number(use[`${p.lotId}:${p.locationId}`]) > 0)
              .map((p) => ({
                lotId: p.lotId,
                locationId: p.locationId,
                quantity: Number(use[`${p.lotId}:${p.locationId}`]),
                unit: p.displayUnit as never,
              }));
            await unwrap(cardsApi().consumption.$post({ param, json: { lines } }));
            return "Materials used";
          }}
        >
          <ul className="space-y-2">
            {pick.map((p) => {
              const key = `${p.lotId}:${p.locationId}`;
              return (
                <li key={key} className="grid items-end gap-2 sm:grid-cols-[1fr_8rem]">
                  <span className="text-sm">
                    {p.itemName} · lot <span className="font-mono">{p.lotCode}</span> · {p.locationName}
                    <span className="block text-xs text-muted-foreground">
                      Suggested {p.display} {p.displayUnit}
                    </span>
                  </span>
                  <Field>
                    <FieldLabel htmlFor={`use-${key}`}>Use ({p.displayUnit})</FieldLabel>
                    <Input
                      id={`use-${key}`}
                      type="number"
                      min={0}
                      step="any"
                      value={use[key] ?? ""}
                      onChange={(e) => setUse((u) => ({ ...u, [key]: e.target.value }))}
                    />
                  </Field>
                </li>
              );
            })}
          </ul>
        </HaccpDialog>
      )}

      {open === "output" && (
        <HaccpDialog
          title="Post the batch's output"
          description={`Into a new lot in quarantine; at most what this operation passed as good (${card.good.display} ${card.good.displayUnit}, ${card.output?.display ?? 0} already posted).`}
          submitLabel="Post"
          disabled={!(Number(good) > 0) || (!!output && !locationId)}
          onClose={close}
          onSubmit={async () => {
            await unwrap(
              cardsApi().output.$post({
                param,
                json: {
                  quantity: Number(good),
                  unit,
                  ...(output && locationId ? { locationId } : {}),
                  ...(lotCode.trim() ? { lotCode: lotCode.trim() } : {}),
                },
              }),
            );
            return "Output posted";
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="jc-output">Quantity ({unit})</FieldLabel>
              <Input
                id="jc-output"
                type="number"
                min={0}
                step="any"
                value={good}
                onChange={(e) => setGood(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="jc-lot-code">Lot code (optional)</FieldLabel>
              <Input
                id="jc-lot-code"
                maxLength={60}
                value={lotCode}
                onChange={(e) => setLotCode(e.target.value)}
              />
              <FieldDescription>Default: the batch code.</FieldDescription>
            </Field>
            {output && (
              <SelectField
                id="jc-output-location"
                label="Location"
                value={locationId}
                onChange={setLocationId}
                options={output.locations.map((l) => [l.id, l.name] as const)}
                description={
                  batchLocation
                    ? "Default: the batch's output location."
                    : "The batch has no active output location: choose where the output goes."
                }
              />
            )}
          </div>
        </HaccpDialog>
      )}
    </div>
  );
}

/** Resolve an open exception (write). */
export function ResolveException({
  slug,
  cardId,
  exceptionId,
}: {
  slug: string;
  cardId: string;
  exceptionId: string;
}) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  if (!can("routings", "write")) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Resolve
      </Button>
      {open && (
        <HaccpDialog
          title="Resolve exception"
          description="What was done about it."
          submitLabel="Resolve"
          disabled={!resolution.trim()}
          onClose={() => setOpen(false)}
          onSubmit={async () => {
            await unwrap(
              cardsApi().exceptions[":exceptionId"].resolve.$post({
                param: { slug, id: cardId, exceptionId },
                json: { resolution: resolution.trim() },
              }),
            );
            return "Exception resolved";
          }}
        >
          <Field>
            <FieldLabel htmlFor="jc-resolution">Resolution</FieldLabel>
            <Textarea
              id="jc-resolution"
              rows={3}
              required
              maxLength={2000}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
          </Field>
        </HaccpDialog>
      )}
    </>
  );
}

/** Void a time log or quantity entry with a reason: a person's correction. */
export function VoidEntry({
  slug,
  cardId,
  kind,
  entryId,
}: {
  slug: string;
  cardId: string;
  kind: "time" | "quantity";
  entryId: string;
}) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!can("routings", "write")) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Void
      </Button>
      {open && (
        <HaccpDialog
          title={kind === "time" ? "Void time log" : "Void quantity entry"}
          description="It stays on the card as history and no longer counts."
          submitLabel="Void"
          disabled={!reason.trim()}
          onClose={() => setOpen(false)}
          onSubmit={async () => {
            const json = { reason: reason.trim() };
            if (kind === "time") {
              await unwrap(
                cardsApi().time[":logId"].void.$post({ param: { slug, id: cardId, logId: entryId }, json }),
              );
            } else {
              await unwrap(
                cardsApi().quantities[":entryId"].void.$post({ param: { slug, id: cardId, entryId }, json }),
              );
            }
            return "Voided";
          }}
        >
          <Field>
            <FieldLabel htmlFor="jc-void-reason">Reason</FieldLabel>
            <Input
              id="jc-void-reason"
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </HaccpDialog>
      )}
    </>
  );
}
