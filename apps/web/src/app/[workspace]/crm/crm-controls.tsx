"use client";

import {
  crmActivityCreateSchema,
  crmActivityKindLabels,
  crmActivityKinds,
  crmLeadConvertSchema,
  crmLeadCreateSchema,
  crmLeadUpdateSchema,
  crmOpportunityCreateSchema,
  crmOpportunityUpdateSchema,
  CRM_MAX_STAGES,
  crmStagesSaveSchema,
  newId,
  type CrmHandoffInput,
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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { CrmActivity, CrmLead, CrmOpportunity, CrmStage } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { SalesPicker } from "../sales/sales-picker";

const selectClass = "border-input bg-background h-9 rounded-md border px-2 text-sm";
const crmApi = () => browserApi().v1.workspaces[":slug"].crm;

/** Runs a CRM call with a toast, refreshing the page on success. */
function useSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function run(call: () => Promise<unknown>, success: string, after?: () => void) {
    setPending(true);
    try {
      await call();
      after?.();
      router.refresh();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setPending(false);
    }
  }
  return { pending, run, router };
}

function FormDialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      {open && (
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
        </DialogContent>
      )}
    </Dialog>
  );
}

function OwnerField({ id, defaultValue }: { id: string; defaultValue?: string | null }) {
  const { idx } = useWorkspace();
  return (
    <Field>
      <FieldLabel htmlFor={id}>Owner</FieldLabel>
      <select id={id} name="owner" className={selectClass} defaultValue={defaultValue ?? ""}>
        <option value="">No owner</option>
        {idx.boot.users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

const firstIssue = (issues: { message: string }[], fallback: string) => issues[0]?.message ?? fallback;

// ─── Leads ──────────────────────────────────────────────────────────────────

export function LeadEditor({ lead }: { lead?: CrmLead }) {
  const { slug, can, viewer } = useWorkspace();
  const [commandId, setCommandId] = useState<string | null>(null);
  const { pending, run, router } = useSubmit();
  if (viewer.role === "guest" || !can("crm", "write")) return null;
  if (lead?.status === "converted") return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = {
      name: form.get("name"),
      company: form.get("company"),
      email: form.get("email"),
      phone: form.get("phone"),
      source: form.get("source"),
      notes: form.get("notes"),
      ownerId: form.get("owner") || null,
    };
    if (lead) {
      const parsed = crmLeadUpdateSchema.safeParse({ ...fields, expectedRevision: lead.revision });
      if (!parsed.success) return void toast.error(firstIssue(parsed.error.issues, "Check the lead"));
      await run(
        () => unwrap(crmApi().leads[":id"].$patch({ param: { slug, id: lead.id }, json: parsed.data })),
        "Lead saved",
        () => setCommandId(null),
      );
      return;
    }
    const parsed = crmLeadCreateSchema.safeParse({ ...fields, commandId });
    if (!parsed.success) return void toast.error(firstIssue(parsed.error.issues, "Check the lead"));
    let created: { id: string } | undefined;
    const ok = await run(
      async () => {
        created = await unwrap(crmApi().leads.$post({ param: { slug }, json: parsed.data }));
      },
      "Lead added",
      () => setCommandId(null),
    );
    if (ok && created) router.push(`/${slug}/crm/leads/${created.id}`);
  }

  return (
    <>
      <Button size="sm" variant={lead ? "outline" : "default"} onClick={() => setCommandId(newId())}>
        {lead ? "Edit lead" : "New lead"}
      </Button>
      <FormDialog
        open={commandId !== null}
        onClose={() => setCommandId(null)}
        title={lead ? "Edit lead" : "New lead"}
        description="The person to talk to and where the lead came from."
      >
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="lead-name">Contact name</FieldLabel>
              <Input id="lead-name" name="name" required maxLength={160} defaultValue={lead?.name} />
            </Field>
            <Field>
              <FieldLabel htmlFor="lead-company">Company (optional)</FieldLabel>
              <Input id="lead-company" name="company" maxLength={160} defaultValue={lead?.company} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="lead-email">Email</FieldLabel>
                <Input id="lead-email" name="email" type="email" defaultValue={lead?.email ?? ""} />
              </Field>
              <Field>
                <FieldLabel htmlFor="lead-phone">Phone</FieldLabel>
                <Input id="lead-phone" name="phone" maxLength={80} defaultValue={lead?.phone ?? ""} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="lead-source">Source</FieldLabel>
                <Input
                  id="lead-source"
                  name="source"
                  maxLength={80}
                  placeholder="Referral, website, event…"
                  defaultValue={lead?.source ?? ""}
                />
              </Field>
              <OwnerField id="lead-owner" defaultValue={lead ? lead.ownerId : viewer.id} />
            </div>
            <Field>
              <FieldLabel htmlFor="lead-notes">Notes</FieldLabel>
              <Textarea id="lead-notes" name="notes" maxLength={4000} defaultValue={lead?.notes} />
            </Field>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save lead"}
            </Button>
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}

export function LeadActions({ lead }: { lead: CrmLead }) {
  const { slug, can, viewer } = useWorkspace();
  const [dialog, setDialog] = useState<"disqualify" | "convert" | null>(null);
  const { pending, run } = useSubmit();
  if (viewer.role === "guest" || !can("crm", "write") || lead.status === "converted") return null;

  const setStatus = (status: "new" | "contacted" | "qualified", label: string) =>
    run(
      () =>
        unwrap(
          crmApi().leads[":id"].$patch({
            param: { slug, id: lead.id },
            json: { expectedRevision: lead.revision, status },
          }),
        ),
      label,
    );

  return (
    <>
      {lead.status === "new" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setStatus("contacted", "Marked contacted")}
        >
          Mark contacted
        </Button>
      )}
      {(lead.status === "new" || lead.status === "contacted") && (
        <Button size="sm" disabled={pending} onClick={() => setStatus("qualified", "Lead qualified")}>
          Qualify
        </Button>
      )}
      {lead.status === "disqualified" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setStatus("contacted", "Lead reopened")}
        >
          Reopen lead
        </Button>
      )}
      {lead.status === "qualified" && can("customers") && (
        <Button size="sm" onClick={() => setDialog("convert")}>
          Convert to customer
        </Button>
      )}
      {lead.status !== "disqualified" && (
        <Button size="sm" variant="outline" onClick={() => setDialog("disqualify")}>
          Disqualify
        </Button>
      )}
      <FormDialog open={dialog === "disqualify"} onClose={() => setDialog(null)} title="Disqualify lead">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const statusReason = String(new FormData(event.currentTarget).get("reason") ?? "");
            void run(
              () =>
                unwrap(
                  crmApi().leads[":id"].$patch({
                    param: { slug, id: lead.id },
                    json: { expectedRevision: lead.revision, status: "disqualified", statusReason },
                  }),
                ),
              "Lead disqualified",
              () => setDialog(null),
            );
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="lead-reason">Reason</FieldLabel>
              <Textarea id="lead-reason" name="reason" required maxLength={2000} />
            </Field>
            <Button type="submit" disabled={pending}>
              Disqualify
            </Button>
          </FieldGroup>
        </form>
      </FormDialog>
      {dialog === "convert" && <ConvertLeadDialog lead={lead} onClose={() => setDialog(null)} />}
    </>
  );
}

function ConvertLeadDialog({ lead, onClose }: { lead: CrmLead; onClose: () => void }) {
  const { slug, can } = useWorkspace();
  const canCreate = can("customers", "write");
  const [mode, setMode] = useState<"new" | "existing">(canCreate ? "new" : "existing");
  const [customer, setCustomer] = useState({ id: "", label: "" });
  const [commandId] = useState(newId);
  const { pending, run } = useSubmit();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = crmLeadConvertSchema.safeParse({
      commandId,
      expectedRevision: lead.revision,
      customer:
        mode === "existing"
          ? { mode, customerId: customer.id }
          : {
              mode,
              code: form.get("code"),
              name: form.get("customerName"),
              address: form.get("address"),
              contactName: form.get("contactName") || null,
              email: form.get("email"),
              phone: form.get("phone") || null,
            },
    });
    if (!parsed.success)
      return void toast.error(
        mode === "existing" && !customer.id
          ? "Choose a customer"
          : firstIssue(parsed.error.issues, "Check the customer details"),
      );
    await run(
      () => unwrap(crmApi().leads[":id"].convert.$post({ param: { slug, id: lead.id }, json: parsed.data })),
      "Lead converted",
      onClose,
    );
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title="Convert to customer"
      description="Add the lead to the customer register, or link it to a customer already there. Its opportunities move to that customer."
    >
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="convert-mode">Customer</FieldLabel>
            <select
              id="convert-mode"
              className={selectClass}
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value as "new" | "existing")}
            >
              {canCreate && <option value="new">New customer</option>}
              <option value="existing">Existing customer</option>
            </select>
          </Field>
          {mode === "existing" ? (
            <SalesPicker
              slug={slug}
              kind="customers"
              value={customer.id}
              label={customer.label}
              onChange={(id, label) => setCustomer({ id, label })}
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
                <Field>
                  <FieldLabel htmlFor="convert-code">Code</FieldLabel>
                  <Input id="convert-code" name="code" required maxLength={40} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="convert-name">Name</FieldLabel>
                  <Input
                    id="convert-name"
                    name="customerName"
                    required
                    maxLength={200}
                    defaultValue={lead.company || lead.name}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="convert-address">Address</FieldLabel>
                <Textarea id="convert-address" name="address" required maxLength={2000} />
              </Field>
              <Field>
                <FieldLabel htmlFor="convert-contact">Contact</FieldLabel>
                <Input id="convert-contact" name="contactName" maxLength={200} defaultValue={lead.name} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="convert-email">Email</FieldLabel>
                  <Input id="convert-email" name="email" type="email" defaultValue={lead.email ?? ""} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="convert-phone">Phone</FieldLabel>
                  <Input id="convert-phone" name="phone" maxLength={80} defaultValue={lead.phone ?? ""} />
                </Field>
              </div>
            </>
          )}
          <Button type="submit" disabled={pending}>
            Convert lead
          </Button>
        </FieldGroup>
      </form>
    </FormDialog>
  );
}

// ─── Opportunities ──────────────────────────────────────────────────────────

export function OpportunityEditor({
  opportunity,
  lead,
  stages,
}: {
  opportunity?: CrmOpportunity;
  /** Create the opportunity for this lead (its customer once converted). */
  lead?: { id: string; customerId: string | null; label: string };
  stages: Pick<CrmStage, "id" | "name">[];
}) {
  const { slug, can, viewer, idx } = useWorkspace();
  const [commandId, setCommandId] = useState<string | null>(null);
  const [customer, setCustomer] = useState({
    id: opportunity?.customerId ?? lead?.customerId ?? "",
    label: opportunity?.customer?.name ?? "",
  });
  const { pending, run, router } = useSubmit();
  if (viewer.role === "guest" || !can("crm", "write")) return null;
  const closed = opportunity && opportunity.status !== "open";
  const leadId = opportunity ? opportunity.leadId : (lead?.id ?? null);
  // A lead's opportunity takes the lead's customer once it is converted.
  const customerLocked = !opportunity && Boolean(lead?.customerId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = String(form.get("value") ?? "").trim();
    const fields = {
      title: form.get("title"),
      ownerId: form.get("owner") || null,
      value: raw === "" ? null : Number(raw),
      currency: form.get("currency"),
      expectedCloseDate: form.get("close") || null,
      notes: form.get("notes"),
    };
    if (opportunity) {
      const parsed = crmOpportunityUpdateSchema.safeParse({
        ...fields,
        expectedRevision: opportunity.revision,
        ...(!closed && customer.id !== (opportunity.customerId ?? "")
          ? { customerId: customer.id || null }
          : {}),
      });
      if (!parsed.success) return void toast.error(firstIssue(parsed.error.issues, "Check the opportunity"));
      await run(
        () =>
          unwrap(
            crmApi().opportunities[":id"].$patch({ param: { slug, id: opportunity.id }, json: parsed.data }),
          ),
        "Opportunity saved",
        () => setCommandId(null),
      );
      return;
    }
    const parsed = crmOpportunityCreateSchema.safeParse({
      ...fields,
      commandId,
      leadId,
      customerId: customer.id || null,
      stageId: form.get("stage") || undefined,
    });
    if (!parsed.success) return void toast.error(firstIssue(parsed.error.issues, "Check the opportunity"));
    let created: { id: string } | undefined;
    const ok = await run(
      async () => {
        created = await unwrap(crmApi().opportunities.$post({ param: { slug }, json: parsed.data }));
      },
      "Opportunity added",
      () => setCommandId(null),
    );
    if (ok && created) router.push(`/${slug}/crm/opportunities/${created.id}`);
  }

  return (
    <>
      <Button
        size="sm"
        variant={opportunity || lead ? "outline" : "default"}
        onClick={() => setCommandId(newId())}
      >
        {opportunity ? "Edit" : "New opportunity"}
      </Button>
      <FormDialog
        open={commandId !== null}
        onClose={() => setCommandId(null)}
        title={opportunity ? "Edit opportunity" : "New opportunity"}
        description={lead && !opportunity ? `For ${lead.label}` : "A deal you are working towards."}
      >
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="opportunity-title">Title</FieldLabel>
              <Input
                id="opportunity-title"
                name="title"
                required
                maxLength={160}
                defaultValue={opportunity?.title}
              />
            </Field>
            {!customerLocked && !closed && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Customer{leadId ? " (optional until converted)" : ""}</p>
                <SalesPicker
                  slug={slug}
                  kind="customers"
                  value={customer.id}
                  label={customer.label}
                  onChange={(id, label) => setCustomer({ id, label })}
                />
              </div>
            )}
            {!opportunity && (
              <Field>
                <FieldLabel htmlFor="opportunity-stage">Stage</FieldLabel>
                <select id="opportunity-stage" name="stage" className={selectClass}>
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <Field>
                <FieldLabel htmlFor="opportunity-value">Estimated value (optional)</FieldLabel>
                <Input
                  id="opportunity-value"
                  name="value"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={opportunity?.value ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="opportunity-currency">Currency</FieldLabel>
                <Input
                  id="opportunity-currency"
                  name="currency"
                  required
                  maxLength={3}
                  defaultValue={opportunity?.currency ?? idx.boot.workspace.currency}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="opportunity-close">Expected close</FieldLabel>
                <Input
                  id="opportunity-close"
                  name="close"
                  type="date"
                  defaultValue={opportunity?.expectedCloseDate ?? ""}
                />
              </Field>
              <OwnerField
                id="opportunity-owner"
                defaultValue={opportunity ? opportunity.ownerId : viewer.id}
              />
            </div>
            <Field>
              <FieldLabel htmlFor="opportunity-notes">Notes</FieldLabel>
              <Textarea
                id="opportunity-notes"
                name="notes"
                maxLength={4000}
                defaultValue={opportunity?.notes}
              />
            </Field>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save opportunity"}
            </Button>
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}

/** Moves an open opportunity to another stage. */
export function StageSelect({
  opportunity,
  stages,
}: {
  opportunity: { id: string; revision: number; stageId: string; status: string };
  stages: { id: string; name: string }[];
}) {
  const { slug, can } = useWorkspace();
  const { pending, run } = useSubmit();
  if (!can("crm", "write") || opportunity.status !== "open") return null;
  return (
    <select
      aria-label="Move to stage"
      className={`${selectClass} h-8`}
      value={opportunity.stageId}
      disabled={pending}
      onChange={(event) => {
        const stageId = event.currentTarget.value;
        void run(
          () =>
            unwrap(
              crmApi().opportunities[":id"].$patch({
                param: { slug, id: opportunity.id },
                json: { expectedRevision: opportunity.revision, stageId },
              }),
            ),
          "Opportunity moved",
        );
      }}
    >
      {stages.map((stage) => (
        <option key={stage.id} value={stage.id}>
          {stage.name}
        </option>
      ))}
    </select>
  );
}

type QuoteOptions = {
  sales: { id: string; reference: string; status: string; currency: string }[];
  services: { id: string; reference: string; title: string; status: string; currency: string }[];
  nextCursor: { sales: string | null; services: string | null };
};

/**
 * Links the open opportunity to one quote of its customer in Sales or Client services; linking the
 * other kind replaces the current link. The link is fixed once the deal is closed or handed off.
 */
export function QuoteLink({ opportunity }: { opportunity: CrmOpportunity }) {
  const { slug, can } = useWorkspace();
  const [options, setOptions] = useState<QuoteOptions | null>(null);
  const { pending, run } = useSubmit();
  const sales = can("sales");
  const services = can("client_services");
  if (!can("crm", "write") || opportunity.status !== "open" || opportunity.handoff || (!sales && !services))
    return null;
  if (!opportunity.customerId)
    return <p className="text-sm text-muted-foreground">Convert the lead to link a quote.</p>;

  const fetchOptions = (query: { salesBefore?: string; servicesBefore?: string } = {}) =>
    unwrap(
      crmApi().opportunities[":id"]["quote-options"].$get({ param: { slug, id: opportunity.id }, query }),
    );
  async function open() {
    try {
      setOptions(await fetchOptions());
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  /** The next page of one list; the other list stays as it is. */
  async function more(list: "sales" | "services") {
    const cursor = options?.nextCursor[list];
    if (!options || !cursor) return;
    try {
      const page = await fetchOptions(
        list === "sales" ? { salesBefore: cursor } : { servicesBefore: cursor },
      );
      setOptions(
        (current) =>
          current && {
            ...current,
            [list]: [...current[list], ...page[list]],
            nextCursor: { ...current.nextCursor, [list]: page.nextCursor[list] },
          },
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  const link = (json: { salesQuoteId?: string | null; serviceQuoteId?: string | null }, label: string) =>
    run(
      () =>
        unwrap(
          crmApi().opportunities[":id"].$patch({
            param: { slug, id: opportunity.id },
            json: { expectedRevision: opportunity.revision, ...json },
          }),
        ),
      label,
      () => setOptions(null),
    );

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={open}>
        Link a quote
      </Button>
      {opportunity.salesQuoteId && sales && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => link({ salesQuoteId: null }, "Quote unlinked")}
        >
          Unlink Sales quote
        </Button>
      )}
      {opportunity.serviceQuoteId && services && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => link({ serviceQuoteId: null }, "Quote unlinked")}
        >
          Unlink service quote
        </Button>
      )}
      <FormDialog
        open={options !== null}
        onClose={() => setOptions(null)}
        title="Link a quote"
        description={`Quotes for ${opportunity.customer?.name ?? "this customer"} not linked to another opportunity or handed off yet. Linking one replaces the current quote.`}
      >
        {options && (
          <div className="space-y-4 text-sm">
            {/* A link in a module the member can't open can't be replaced by them either. */}
            {sales && !(opportunity.serviceQuoteId && !services) && (
              <section className="space-y-2">
                <h3 className="font-medium">Sales quotes</h3>
                {options.sales.length === 0 && <p className="text-muted-foreground">None available.</p>}
                {options.sales.map((quote) => (
                  <div key={quote.id} className="flex items-center justify-between gap-2">
                    <span>
                      {quote.reference} · {quote.status} · {quote.currency}
                    </span>
                    <Button
                      size="sm"
                      disabled={pending || quote.id === opportunity.salesQuoteId}
                      onClick={() =>
                        link(
                          {
                            salesQuoteId: quote.id,
                            ...(opportunity.serviceQuoteId && { serviceQuoteId: null }),
                          },
                          "Quote linked",
                        )
                      }
                    >
                      Link
                    </Button>
                  </div>
                ))}
                {options.nextCursor.sales && (
                  <Button size="sm" variant="ghost" onClick={() => more("sales")}>
                    Show more Sales quotes
                  </Button>
                )}
                {can("sales", "write") && (
                  <Link href={`/${slug}/sales/new`} className="underline">
                    Draft a new Sales quote
                  </Link>
                )}
              </section>
            )}
            {services && !(opportunity.salesQuoteId && !sales) && (
              <section className="space-y-2">
                <h3 className="font-medium">Service quotes</h3>
                {options.services.length === 0 && <p className="text-muted-foreground">None available.</p>}
                {options.services.map((quote) => (
                  <div key={quote.id} className="flex items-center justify-between gap-2">
                    <span>
                      {quote.reference} · {quote.title} · {quote.status}
                    </span>
                    <Button
                      size="sm"
                      disabled={pending || quote.id === opportunity.serviceQuoteId}
                      onClick={() =>
                        link(
                          {
                            serviceQuoteId: quote.id,
                            ...(opportunity.salesQuoteId && { salesQuoteId: null }),
                          },
                          "Quote linked",
                        )
                      }
                    >
                      Link
                    </Button>
                  </div>
                ))}
                {options.nextCursor.services && (
                  <Button size="sm" variant="ghost" onClick={() => more("services")}>
                    Show more service quotes
                  </Button>
                )}
                {can("client_services", "write") && (
                  <Link href={`/${slug}/client-services`} className="underline">
                    Draft a new service quote
                  </Link>
                )}
              </section>
            )}
          </div>
        )}
      </FormDialog>
    </div>
  );
}

const outcomeLabels = { won: "Mark won", lost: "Mark lost", reopen: "Reopen" } as const;

/** Won or lost with a reason, a correction back to open, and the handoff of a won deal. */
export function OutcomeActions({ opportunity }: { opportunity: CrmOpportunity }) {
  const { slug, can, viewer, idx } = useWorkspace();
  const [choice, setChoice] = useState<{
    action: keyof typeof outcomeLabels | CrmHandoffInput["kind"];
    commandId: string;
    /** What the dialog showed when opened: a handoff is refused if any of it changed since. */
    reviewed?: Pick<CrmHandoffInput, "expectedRevision" | "quoteId" | "quoteRevision">;
  } | null>(null);
  const { pending, run } = useSubmit();
  if (viewer.role === "guest" || !can("crm", "write")) return null;
  const outcomes: (keyof typeof outcomeLabels)[] =
    opportunity.status === "open" ? ["won", "lost"] : opportunity.handoff ? [] : ["reopen"];
  const won = opportunity.status === "won" && !opportunity.handoff;
  const toOrder = won && can("sales", "manage") ? opportunity.salesQuote : null;
  const toProject =
    won && can("client_services", "manage") && can("tasks", "write") ? opportunity.serviceQuote : null;
  const handoff = (action: CrmHandoffInput["kind"], quote: { id: string; revision: number }) =>
    setChoice({
      action,
      commandId: newId(),
      reviewed: { expectedRevision: opportunity.revision, quoteId: quote.id, quoteRevision: quote.revision },
    });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!choice) return;
    const form = new FormData(event.currentTarget);
    const reason = String(form.get("reason") ?? "");
    const { action, commandId, reviewed } = choice;
    const close = () => setChoice(null);
    if ((action === "sales_order" || action === "service_project") && reviewed) {
      const json: CrmHandoffInput =
        action === "sales_order"
          ? { kind: action, commandId, reason, ...reviewed }
          : {
              kind: action,
              commandId,
              reason,
              ...reviewed,
              teamId: String(form.get("team")),
              leadId: String(form.get("lead")),
            };
      await run(
        () =>
          unwrap(crmApi().opportunities[":id"].handoff.$post({ param: { slug, id: opportunity.id }, json })),
        action === "sales_order" ? "Draft order created" : "Delivery project created",
        close,
      );
      return;
    }
    if (action === "sales_order" || action === "service_project") return;
    await run(
      () =>
        unwrap(
          crmApi().opportunities[":id"].outcome.$post({
            param: { slug, id: opportunity.id },
            json: { commandId, expectedRevision: opportunity.revision, outcome: action, reason },
          }),
        ),
      action === "reopen" ? "Opportunity reopened" : `Marked ${action}`,
      close,
    );
  }

  const title =
    choice?.action === "sales_order"
      ? "Create draft order"
      : choice?.action === "service_project"
        ? "Create delivery project"
        : choice
          ? outcomeLabels[choice.action]
          : "";

  return (
    <>
      {outcomes.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={action === "won" ? "default" : "outline"}
          onClick={() => setChoice({ action, commandId: newId() })}
        >
          {outcomeLabels[action]}
        </Button>
      ))}
      {toOrder && (
        <Button size="sm" onClick={() => handoff("sales_order", toOrder)}>
          Create draft order
        </Button>
      )}
      {toProject && (
        <Button size="sm" onClick={() => handoff("service_project", toProject)}>
          Create delivery project
        </Button>
      )}
      <FormDialog
        open={choice !== null}
        onClose={() => !pending && setChoice(null)}
        title={title}
        description={
          choice?.action === "sales_order"
            ? "Converts the linked Sales quote into a draft order. Confirm the order in Sales."
            : choice?.action === "service_project"
              ? "Records the customer's acceptance of the linked service quote and creates its delivery project."
              : "Record why, for the pipeline history."
        }
      >
        <form onSubmit={submit}>
          <FieldGroup>
            {choice?.action === "service_project" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="handoff-team">Delivery team</FieldLabel>
                  <select id="handoff-team" name="team" required className={selectClass}>
                    {idx.boot.teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="handoff-lead">Project lead</FieldLabel>
                  <select
                    id="handoff-lead"
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
            <Field>
              <FieldLabel htmlFor="outcome-reason">Reason</FieldLabel>
              <Textarea id="outcome-reason" name="reason" required maxLength={2000} />
            </Field>
            <Button type="submit" disabled={pending}>
              {title}
            </Button>
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}

// ─── Activities ─────────────────────────────────────────────────────────────

export function ActivityEditor({ leadId, opportunityId }: { leadId?: string; opportunityId?: string }) {
  const { slug, can, viewer } = useWorkspace();
  const [commandId, setCommandId] = useState<string | null>(null);
  const { pending, run } = useSubmit();
  if (viewer.role === "guest" || !can("crm", "write")) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const done = form.get("done") === "on";
    const parsed = crmActivityCreateSchema.safeParse({
      commandId,
      leadId: leadId ?? null,
      opportunityId: opportunityId ?? null,
      kind: form.get("kind"),
      subject: form.get("subject"),
      notes: form.get("notes"),
      dueOn: done ? null : form.get("due") || null,
      ownerId: form.get("owner") || null,
      done,
    });
    if (!parsed.success) return void toast.error(firstIssue(parsed.error.issues, "Check the activity"));
    await run(
      () => unwrap(crmApi().activities.$post({ param: { slug }, json: parsed.data })),
      done ? "Activity logged" : "Follow-up planned",
      () => setCommandId(null),
    );
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setCommandId(newId())}>
        Add activity
      </Button>
      <FormDialog
        open={commandId !== null}
        onClose={() => setCommandId(null)}
        title="Add activity"
        description="Plan a follow-up with a due date, or log something already done."
      >
        <form onSubmit={submit}>
          <FieldGroup>
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
              <Field>
                <FieldLabel htmlFor="activity-kind">Kind</FieldLabel>
                <select id="activity-kind" name="kind" className={selectClass} defaultValue="call">
                  {crmActivityKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {crmActivityKindLabels[kind]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="activity-subject">Subject</FieldLabel>
                <Input id="activity-subject" name="subject" required maxLength={160} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="activity-due">Due</FieldLabel>
                <Input id="activity-due" name="due" type="date" />
              </Field>
              <OwnerField id="activity-owner" defaultValue={viewer.id} />
            </div>
            <Field>
              <FieldLabel htmlFor="activity-notes">Notes</FieldLabel>
              <Textarea id="activity-notes" name="notes" maxLength={4000} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="done" /> Already done (log it)
            </label>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </FieldGroup>
        </form>
      </FormDialog>
    </>
  );
}

export function ActivityList({
  activities,
  showSubject = false,
  emptyText = "No activities yet.",
}: {
  activities: CrmActivity[];
  /** Name the lead or opportunity of each (the follow-ups page). */
  showSubject?: boolean;
  emptyText?: string;
}) {
  const { slug, can, idx } = useWorkspace();
  const { pending, run } = useSubmit();
  if (activities.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  const name = (id: string | null) => idx.boot.users.find((u) => u.id === id)?.name ?? "No owner";
  return (
    <ul className="divide-y rounded-lg border">
      {activities.map((activity) => {
        const done = activity.completedAt !== null;
        const subject = activity.opportunity
          ? {
              href: `/${slug}/crm/opportunities/${activity.opportunity.id}`,
              label: activity.opportunity.title,
            }
          : activity.lead
            ? {
                href: `/${slug}/crm/leads/${activity.lead.id}`,
                label: activity.lead.company || activity.lead.name,
              }
            : null;
        return (
          <li key={activity.id} className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm">
            <div className="min-w-0 space-y-1">
              <p className={done ? "text-muted-foreground line-through" : "font-medium"}>
                {crmActivityKindLabels[activity.kind]} · {activity.subject}
              </p>
              <p className="text-muted-foreground">
                {activity.dueOn ? `Due ${activity.dueOn}` : done ? "Logged" : "No due date"} ·{" "}
                {name(activity.ownerId)}
                {showSubject && subject && (
                  <>
                    {" · "}
                    <Link href={subject.href} className="underline">
                      {subject.label}
                    </Link>
                  </>
                )}
              </p>
              {activity.notes && <p className="break-words whitespace-pre-wrap">{activity.notes}</p>}
            </div>
            {can("crm", "write") && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      unwrap(
                        crmApi().activities[":id"].$patch({
                          param: { slug, id: activity.id },
                          json: { done: !done },
                        }),
                      ),
                    done ? "Follow-up reopened" : "Follow-up done",
                  )
                }
              >
                {done ? "Reopen" : "Done"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── Stages ─────────────────────────────────────────────────────────────────

type DraftStage = { key: string; id?: string; name: string; probability: number };

export function StagesEditor({ stages }: { stages: CrmStage[] }) {
  const { slug, can } = useWorkspace();
  const [rows, setRows] = useState<DraftStage[]>(() =>
    stages.map((s) => ({ key: s.id, id: s.id, name: s.name, probability: s.probability })),
  );
  const { pending, run } = useSubmit();
  const editable = can("crm", "manage");
  const update = (key: string, patch: Partial<DraftStage>) =>
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const move = (index: number, by: number) =>
    setRows((list) => {
      const next = [...list];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });

  async function save() {
    const parsed = crmStagesSaveSchema.safeParse({
      stages: rows.map(({ id, name, probability }) => ({ id, name, probability })),
    });
    if (!parsed.success) return void toast.error(firstIssue(parsed.error.issues, "Check the stages"));
    await run(() => unwrap(crmApi().stages.$put({ param: { slug }, json: parsed.data })), "Stages saved");
  }

  return (
    <div className="space-y-3">
      <ol className="divide-y rounded-lg border">
        {rows.map((row, index) => (
          <li key={row.key} className="flex flex-wrap items-center gap-2 p-3">
            <Input
              aria-label="Stage name"
              className="min-w-40 flex-1"
              value={row.name}
              maxLength={80}
              disabled={!editable}
              onChange={(event) => update(row.key, { name: event.currentTarget.value })}
            />
            <label className="flex items-center gap-1 text-sm text-muted-foreground">
              <Input
                aria-label="Win probability"
                className="w-20"
                type="number"
                min={0}
                max={100}
                value={row.probability}
                disabled={!editable}
                onChange={(event) => update(row.key, { probability: Number(event.currentTarget.value) })}
              />
              %
            </label>
            {editable && (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rows.length === 1}
                  onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}
                >
                  Remove
                </Button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {editable && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={rows.length >= CRM_MAX_STAGES}
            onClick={() => setRows((list) => [...list, { key: newId(), name: "", probability: 50 }])}
          >
            Add stage
          </Button>
          <Button size="sm" disabled={pending} onClick={save}>
            Save stages
          </Button>
        </div>
      )}
    </div>
  );
}
