"use client";

import {
  downtimeReasonInfo,
  downtimeReasons,
  rejectReasonLabels,
  rejectReasons,
  units,
  type DowntimeReason,
  type RejectReason,
  type UnitCode,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
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
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

/**
 * Dialogs for factory performance (3.5.2): recording downtime, rejects and labour, and voiding a
 * record with a reason. Each request carries a command id, so a retried submit records once.
 */

function FormDialog({
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
  onSubmit: (commandId: string) => Promise<string>;
  onClose: () => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  // One id per dialog: a double submit or a retry after a lost response records once.
  const [commandId] = useState(() => crypto.randomUUID());
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      toast.success(await onSubmit(commandId));
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
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">{children}</FieldGroup>
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

const production = () => browserApi().v1.workspaces[":slug"].production;

export function DowntimeDialog({
  slug,
  lines,
  lineId: initialLine,
  date: initialDate,
  batch,
  onClose,
}: {
  slug: string;
  lines: { id: string; name: string }[];
  lineId?: string;
  date: string;
  batch?: { id: string; batchCode: string };
  onClose: () => void;
}) {
  const [lineId, setLineId] = useState(initialLine ?? lines[0]?.id ?? "");
  const [date, setDate] = useState(initialDate);
  const [minutes, setMinutes] = useState("");
  const [reason, setReason] = useState<DowntimeReason>("breakdown");
  const [note, setNote] = useState("");
  const group = (category: "planned" | "unplanned") =>
    downtimeReasons.filter((r) => downtimeReasonInfo[r].category === category);
  return (
    <FormDialog
      title={batch ? `Downtime during ${batch.batchCode}` : "Record downtime"}
      description="Time the line didn't run. Planned reasons reduce planned production time; unplanned ones reduce availability."
      submitLabel="Record"
      onClose={onClose}
      onSubmit={async (commandId) => {
        await unwrap(
          production().downtime.$post({
            param: { slug },
            json: {
              commandId,
              lineId,
              date,
              minutes: Number(minutes),
              reason,
              ...(batch ? { batchId: batch.id } : {}),
              note: note.trim(),
            },
          }),
        );
        return "Downtime recorded";
      }}
    >
      {!batch && (
        <Field>
          <FieldLabel id="dt-line">Line</FieldLabel>
          <Select value={lineId} onValueChange={setLineId}>
            <SelectTrigger aria-labelledby="dt-line" className="w-full">
              <SelectValue placeholder="Choose a line" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {lines.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="dt-date">Day</FieldLabel>
          <Input id="dt-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="dt-minutes">Minutes</FieldLabel>
          <Input
            id="dt-minutes"
            type="number"
            min="1"
            max="1440"
            step="1"
            required
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel id="dt-reason">Reason</FieldLabel>
        <Select value={reason} onValueChange={(v) => setReason(v as DowntimeReason)}>
          <SelectTrigger aria-labelledby="dt-reason" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["unplanned", "planned"] as const).map((cat) => (
              <SelectGroup key={cat}>
                <SelectLabel>{cat === "planned" ? "Planned" : "Unplanned"}</SelectLabel>
                {group(cat).map((r) => (
                  <SelectItem key={r} value={r}>
                    {downtimeReasonInfo[r].label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="dt-note">Note (optional)</FieldLabel>
        <Textarea id="dt-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

export function RejectDialog({
  slug,
  batch,
  unitChoices,
  onClose,
}: {
  slug: string;
  batch: { id: string; batchCode: string };
  unitChoices: UnitCode[];
  onClose: () => void;
}) {
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState<UnitCode>(unitChoices[0] ?? "each");
  const [reason, setReason] = useState<RejectReason>("setup_waste");
  const [note, setNote] = useState("");
  return (
    <FormDialog
      title={`Rejects from ${batch.batchCode}`}
      description="Output the batch rejected. Rejects are never put into stock; they count against quality."
      submitLabel="Record"
      onClose={onClose}
      onSubmit={async (commandId) => {
        await unwrap(
          production().batches[":id"].rejects.$post({
            param: { slug, id: batch.id },
            json: { commandId, quantity: Number(quantity), unit, reason, note: note.trim() },
          }),
        );
        return "Rejects recorded";
      }}
    >
      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <Field>
          <FieldLabel htmlFor="rj-qty">Quantity</FieldLabel>
          <Input
            id="rj-qty"
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
          <FieldLabel id="rj-unit">Unit</FieldLabel>
          <Select value={unit} onValueChange={(v) => setUnit(v as UnitCode)}>
            <SelectTrigger aria-labelledby="rj-unit" className="w-full">
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
        <FieldLabel id="rj-reason">Reason</FieldLabel>
        <Select value={reason} onValueChange={(v) => setReason(v as RejectReason)}>
          <SelectTrigger aria-labelledby="rj-reason" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {rejectReasons.map((r) => (
                <SelectItem key={r} value={r}>
                  {rejectReasonLabels[r]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="rj-note">Note (optional)</FieldLabel>
        <Textarea id="rj-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

export function LabourDialog({
  slug,
  batch,
  onClose,
}: {
  slug: string;
  batch: { id: string; batchCode: string };
  onClose: () => void;
}) {
  const [people, setPeople] = useState("");
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  return (
    <FormDialog
      title={`Labour on ${batch.batchCode}`}
      description="People who worked on the batch and for how long. Compared with standard labour (standard hours × the recipe's crew)."
      submitLabel="Record"
      onClose={onClose}
      onSubmit={async (commandId) => {
        await unwrap(
          production().batches[":id"].labour.$post({
            param: { slug, id: batch.id },
            json: { commandId, people: Number(people), minutes: Number(minutes), note: note.trim() },
          }),
        );
        return "Labour recorded";
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="lb-people">People</FieldLabel>
          <Input
            id="lb-people"
            type="number"
            min="1"
            max="500"
            step="1"
            required
            value={people}
            onChange={(e) => setPeople(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="lb-minutes">Minutes</FieldLabel>
          <Input
            id="lb-minutes"
            type="number"
            min="1"
            max="1440"
            step="1"
            required
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="lb-note">Note (optional)</FieldLabel>
        <Textarea id="lb-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

export type VoidTarget = { kind: "downtime" | "reject" | "labour"; id: string; label: string };

export function VoidDialog({
  slug,
  target,
  onClose,
}: {
  slug: string;
  target: VoidTarget;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title={`Void ${target.label}`}
      description="The record stays as history with your reason, and stops counting."
      submitLabel="Void"
      onClose={onClose}
      onSubmit={async (commandId) => {
        const json = { commandId, reason: reason.trim() };
        const param = { slug, id: target.id };
        if (target.kind === "downtime")
          await unwrap(production().downtime[":id"].void.$post({ param, json }));
        else if (target.kind === "reject")
          await unwrap(production().rejects[":id"].void.$post({ param, json }));
        else await unwrap(production().labour[":id"].void.$post({ param, json }));
        return "Voided";
      }}
    >
      <Field>
        <FieldLabel htmlFor="void-reason">Reason</FieldLabel>
        <Textarea
          id="void-reason"
          required
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
