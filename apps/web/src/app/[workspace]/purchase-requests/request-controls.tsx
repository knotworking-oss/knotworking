"use client";

import { currencyDigits, newId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function NewPurchaseRequest({ approverIds }: { approverIds: string[] }) {
  const { can, viewer } = useWorkspace();
  const [commandId, setCommandId] = useState<string | null>(null);
  if (viewer.role === "guest" || !can("purchase_requests", "write") || !approverIds.length) return null;
  return (
    <>
      <Button size="sm" onClick={() => setCommandId(newId())}>
        <Plus /> New request
      </Button>
      <Dialog
        open={commandId !== null}
        onOpenChange={(open) => {
          if (!open) setCommandId(null);
        }}
      >
        {commandId && (
          <PurchaseRequestForm
            approverIds={approverIds}
            commandId={commandId}
            onClose={() => setCommandId(null)}
          />
        )}
      </Dialog>
    </>
  );
}

function PurchaseRequestForm({
  approverIds,
  commandId,
  onClose,
}: {
  approverIds: string[];
  commandId: string;
  onClose: () => void;
}) {
  const { slug, idx } = useWorkspace();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [currency] = useState(idx.boot.workspace.currency);
  const approvers = idx.boot.users.filter((user) => approverIds.includes(user.id));
  const step = 10 ** -currencyDigits(currency);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    try {
      const request = await unwrap(
        browserApi().v1.workspaces[":slug"]["purchase-requests"].$post({
          param: { slug },
          json: {
            commandId,
            title: String(data.get("title")),
            reason: String(data.get("reason")),
            amount: String(data.get("amount")),
            currency,
            neededBy: String(data.get("neededBy")) || null,
            approverId: String(data.get("approver")),
          },
        }),
      );
      onClose();
      router.push(`/${slug}/purchase-requests/${request.id}`);
      toast.success("Purchase request submitted");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>New purchase request</DialogTitle>
        <DialogDescription>Send an estimated cost and reason to an approver.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="request-title">What do you need?</FieldLabel>
            <Input id="request-title" name="title" required maxLength={160} />
          </Field>
          <Field>
            <FieldLabel htmlFor="request-reason">Business reason</FieldLabel>
            <Textarea id="request-reason" name="reason" required maxLength={3000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="request-amount">Estimated cost ({currency})</FieldLabel>
              <Input id="request-amount" name="amount" type="number" min={step} step={step} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="request-needed">Needed by (optional)</FieldLabel>
              <Input id="request-needed" name="neededBy" type="date" />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="request-approver">Approver</FieldLabel>
            <select
              id="request-approver"
              name="approver"
              required
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Choose an approver</option>
              {approvers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? "Submitting…" : "Submit for approval"}
          </Button>
        </FieldGroup>
      </form>
    </DialogContent>
  );
}

const decisionLabels = { approved: "Approve", rejected: "Reject", withdrawn: "Withdraw" } as const;
type Decision = keyof typeof decisionLabels;

export function PurchaseRequestDecision({
  id,
  requesterId,
  approverId,
}: {
  id: string;
  requesterId: string | null;
  approverId: string | null;
}) {
  const { slug, viewer, can } = useWorkspace();
  const router = useRouter();
  const [draft, setDraft] = useState<{ status: Decision; commandId: string } | null>(null);
  const [pending, setPending] = useState(false);
  const statuses: Decision[] = [];
  if (viewer.id === approverId && can("purchase_requests", "manage")) statuses.push("approved", "rejected");
  if (viewer.id === requesterId && can("purchase_requests", "write")) statuses.push("withdrawn");
  if (!statuses.length) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"]["purchase-requests"][":id"].decision.$post({
          param: { slug, id },
          json: { ...draft, note: String(new FormData(event.currentTarget).get("note")) },
        }),
      );
      setDraft(null);
      router.refresh();
      toast.success("Decision recorded");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {statuses.map((status) => (
        <Button
          key={status}
          size="sm"
          variant={status === "approved" ? "default" : "outline"}
          onClick={() => setDraft({ status, commandId: newId() })}
        >
          {decisionLabels[status]}
        </Button>
      ))}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDraft(null);
        }}
      >
        {draft && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{decisionLabels[draft.status]} purchase request</DialogTitle>
              <DialogDescription>
                This decision closes the request and is recorded in its history.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="decision-note">
                    {draft.status === "rejected" ? "Reason for rejection" : "Decision note (optional)"}
                  </FieldLabel>
                  <Textarea
                    id="decision-note"
                    name="note"
                    required={draft.status === "rejected"}
                    maxLength={2000}
                  />
                </Field>
                <Button type="submit" disabled={pending}>
                  {decisionLabels[draft.status]} request
                </Button>
              </FieldGroup>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
