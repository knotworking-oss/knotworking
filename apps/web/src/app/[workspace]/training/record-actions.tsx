"use client";

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
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const records = () => browserApi().v1.workspaces[":slug"].training.records;

/** Signs records off as competent (a manager in person). Resolves to whether it worked. */
export async function signOff(slug: string, recordIds: string[]) {
  try {
    await unwrap(records()["sign-off"].$post({ param: { slug }, json: { recordIds } }));
    toast.success(recordIds.length === 1 ? "Signed off" : `${recordIds.length} people signed off`);
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  }
}

/** Voids a training record made in error, with a reason. It stays on the person's history. */
export function VoidRecordDialog({
  slug,
  recordId,
  summary,
  onClose,
}: {
  slug: string;
  recordId: string;
  summary: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        records()[":id"].void.$post({ param: { slug, id: recordId }, json: { reason: reason.trim() } }),
      );
      toast.success("Record voided");
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
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Void training record</DialogTitle>
            <DialogDescription>
              {summary}. A voided record stays on the person's history, marked, and never counts again. This
              can't be undone.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="void-reason">Why</FieldLabel>
              <Textarea
                id="void-reason"
                required
                rows={2}
                maxLength={2000}
                placeholder="e.g. Recorded against the wrong person"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending || !reason.trim()}>
              {pending && <Spinner data-icon="inline-start" />}
              Void record
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
