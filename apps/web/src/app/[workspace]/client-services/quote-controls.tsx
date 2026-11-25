"use client";

import {
  formatMinutes,
  newId,
  serviceQuoteCreateSchema,
  type ServiceQuoteDecisionInput,
} from "@knotworking/core";
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
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { ServiceQuote } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { SalesPicker } from "../sales/sales-picker";

const selectClass = "border-input bg-background h-9 rounded-md border px-2 text-sm";

export function ServiceQuoteEditor({ quote }: { quote?: ServiceQuote }) {
  const { can, viewer } = useWorkspace();
  const [commandId, setCommandId] = useState<string | null>(null);
  if (viewer.role === "guest" || !can("client_services", "write")) return null;
  return (
    <>
      <Button size="sm" variant={quote ? "outline" : "default"} onClick={() => setCommandId(newId())}>
        {quote ? "Edit draft" : "New service quote"}
      </Button>
      <Dialog
        open={commandId !== null}
        onOpenChange={(open) => {
          if (!open) setCommandId(null);
        }}
      >
        {commandId && <QuoteForm quote={quote} commandId={commandId} onClose={() => setCommandId(null)} />}
      </Dialog>
    </>
  );
}

function QuoteForm({
  quote,
  commandId,
  onClose,
}: {
  quote?: ServiceQuote;
  commandId: string;
  onClose: () => void;
}) {
  const { slug, idx } = useWorkspace();
  const router = useRouter();
  const [hourly, setHourly] = useState(quote ? quote.quotedMinutes !== null : false);
  const [customer, setCustomer] = useState({
    id: quote?.customerId ?? "",
    label: quote?.recipient.name ?? "",
  });
  const [pending, setPending] = useState(false);
  const currency = quote?.currency ?? idx.boot.workspace.currency;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = serviceQuoteCreateSchema.safeParse({
      commandId,
      customerId: customer.id,
      currency,
      title: form.get("title"),
      scope: form.get("scope"),
      unitPrice: Number(form.get("rate")),
      deliveryDate: form.get("date") || null,
      quotedMinutes: hourly ? Number(form.get("hours")) * 60 + Number(form.get("minutes")) : null,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Check the quote details");
      return;
    }
    setPending(true);
    try {
      const endpoint = browserApi().v1.workspaces[":slug"]["client-services"];
      const saved = await unwrap(
        quote
          ? endpoint[":id"].$patch({
              param: { slug, id: quote.id },
              json: { ...parsed.data, expectedRevision: quote.revision },
            })
          : endpoint.$post({ param: { slug }, json: parsed.data }),
      );
      onClose();
      if (!quote) router.push(`/${slug}/client-services/${saved.id}`);
      router.refresh();
      toast.success("Service quote saved");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{quote ? "Edit service quote" : "New service quote"}</DialogTitle>
        <DialogDescription>
          Set the scope and agree a fixed fee or an hourly rate with a time limit.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit}>
        <FieldGroup>
          <SalesPicker
            slug={slug}
            kind="customers"
            value={customer.id}
            label={customer.label}
            onChange={(id, label) => setCustomer({ id, label })}
          />
          <Field>
            <FieldLabel htmlFor="quote-title">Service title</FieldLabel>
            <Input id="quote-title" name="title" required maxLength={160} defaultValue={quote?.title} />
          </Field>
          <Field>
            <FieldLabel htmlFor="quote-scope">Scope and deliverables</FieldLabel>
            <Textarea id="quote-scope" name="scope" required maxLength={4000} defaultValue={quote?.scope} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="quote-basis">Billing basis</FieldLabel>
              <select
                id="quote-basis"
                className={selectClass}
                value={hourly ? "hourly" : "fixed"}
                onChange={(event) => setHourly(event.currentTarget.value === "hourly")}
              >
                <option value="fixed">Fixed fee</option>
                <option value="hourly">Hourly</option>
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="quote-rate">
                {hourly ? "Hourly rate" : "Fixed fee"} ({currency})
              </FieldLabel>
              <Input
                id="quote-rate"
                name="rate"
                type="number"
                min="0"
                step="any"
                required
                defaultValue={quote?.unitPrice}
              />
            </Field>
          </div>
          {hourly && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="quote-hours">Quoted hours</FieldLabel>
                <Input
                  id="quote-hours"
                  name="hours"
                  type="number"
                  min="0"
                  defaultValue={Math.floor((quote?.quotedMinutes ?? 0) / 60)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="quote-minutes">Additional minutes</FieldLabel>
                <Input
                  id="quote-minutes"
                  name="minutes"
                  type="number"
                  min="0"
                  max="59"
                  defaultValue={(quote?.quotedMinutes ?? 0) % 60}
                  required
                />
              </Field>
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="quote-date">Target delivery date (optional)</FieldLabel>
            <Input id="quote-date" name="date" type="date" defaultValue={quote?.deliveryDate ?? ""} />
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save draft"}
          </Button>
        </FieldGroup>
      </form>
    </DialogContent>
  );
}

const labels = {
  issue: "Issue quote",
  accept: "Record acceptance",
  deliver: "Sign off delivery",
  cancel: "Cancel quote",
} as const;
const nextAction = { draft: "issue", issued: "accept", accepted: "deliver" } as const;

export function ServiceQuoteActions({ quote }: { quote: ServiceQuote }) {
  const { slug, can, viewer, idx } = useWorkspace();
  const router = useRouter();
  const [choice, setChoice] = useState<{ action: keyof typeof labels; commandId: string } | null>(null);
  const [pending, setPending] = useState(false);
  const action =
    quote.status === "delivered" || quote.status === "cancelled" ? null : nextAction[quote.status];
  const maxMinutes = Math.min(quote.quotedMinutes ?? 0, quote.loggedMinutes ?? 0);
  const hourlyDelivery = choice?.action === "deliver" && quote.quotedMinutes !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!choice) return;
    const form = new FormData(event.currentTarget);
    const common = {
      commandId: choice.commandId,
      expectedRevision: quote.revision,
      reason: String(form.get("reason")),
    };
    const json: ServiceQuoteDecisionInput =
      choice.action === "accept"
        ? { ...common, action: "accept", teamId: String(form.get("team")), leadId: String(form.get("lead")) }
        : choice.action === "deliver"
          ? {
              ...common,
              action: "deliver",
              approvedMinutes: hourlyDelivery ? Number(form.get("minutes")) : null,
            }
          : { ...common, action: choice.action };
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"]["client-services"][":id"].decision.$post({
          param: { slug, id: quote.id },
          json,
        }),
      );
      setChoice(null);
      router.refresh();
      toast.success("Decision recorded");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      {quote.status === "draft" && <ServiceQuoteEditor quote={quote} />}
      <Button size="sm" variant="outline" onClick={() => window.print()}>
        Print quote
      </Button>
      {action &&
        can("client_services", "manage") &&
        ([action, "cancel"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={value === "cancel" ? "outline" : "default"}
            disabled={value === "accept" && !can("tasks", "write")}
            title={
              value === "accept" && !can("tasks", "write")
                ? "Tasks write access is required to create the delivery project"
                : undefined
            }
            onClick={() => setChoice({ action: value, commandId: newId() })}
          >
            {labels[value]}
          </Button>
        ))}
      <Dialog
        open={choice !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setChoice(null);
        }}
      >
        {choice && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{labels[choice.action]}</DialogTitle>
              <DialogDescription>
                {choice.action === "accept"
                  ? "Record the customer's acceptance and create a delivery project."
                  : "Record your decision on this revision."}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit}>
              <FieldGroup>
                {choice.action === "accept" && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="service-team">Delivery team</FieldLabel>
                      <select id="service-team" name="team" required className={selectClass}>
                        {idx.boot.teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="service-lead">Project lead</FieldLabel>
                      <select
                        id="service-lead"
                        name="lead"
                        required
                        defaultValue={viewer.id}
                        className={selectClass}
                      >
                        {idx.boot.users.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
                {hourlyDelivery && (
                  <Field>
                    <FieldLabel htmlFor="service-approved-minutes">Approved billable minutes</FieldLabel>
                    <Input
                      id="service-approved-minutes"
                      name="minutes"
                      type="number"
                      min={1}
                      max={maxMinutes}
                      defaultValue={maxMinutes || ""}
                      required
                    />
                    <p className="text-sm text-muted-foreground">
                      {formatMinutes(quote.loggedMinutes ?? 0)} logged. Up to {formatMinutes(maxMinutes)} can
                      be approved.
                    </p>
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="service-reason">
                    {choice.action === "deliver" ? "Delivery evidence" : "Reason or reference"}
                  </FieldLabel>
                  <Textarea id="service-reason" name="reason" required maxLength={2000} />
                </Field>
                <Button type="submit" disabled={pending || (hourlyDelivery && !maxMinutes)}>
                  {labels[choice.action]}
                </Button>
              </FieldGroup>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
