"use client";

import {
  automationRuleSchema,
  automationTriggers,
  type AutomationAction,
  type AutomationRuleInput,
  type AutomationTrigger,
  type AutomationWebhookInput,
  type CustomFieldValue,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { CircleHelp, PencilLine, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { HaccpDialog } from "@/components/haccp-forms";
import { TaskFilterControls } from "@/components/task-filter-bar";
import type { getAutomation, getAutomationWebhooks, getTaskCustomFields } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatDateTime, formatShortDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

type Data = Awaited<ReturnType<typeof getAutomation>>;
type Rules = Data["rules"];
type WebhookData = Awaited<ReturnType<typeof getAutomationWebhooks>>;
type Hook = WebhookData["webhooks"][number];
type CustomField = Awaited<ReturnType<typeof getTaskCustomFields>>["fields"][number];
const api = () => browserApi().v1.workspaces[":slug"].automation;
const triggerLabels: Record<AutomationTrigger, string> = {
  task_created: "Task created",
  state_changed: "Status changed",
  assignee_changed: "Assignee changed",
  label_added: "Label added",
  due_date_passed: "Due date passed",
};
const actionLabels: Record<AutomationAction["kind"], string> = {
  set_state: "Set status",
  assign: "Change assignee",
  add_label: "Add label",
  set_field: "Set custom field",
  create_subtask: "Create subtask",
  comment: "Add comment",
  notify: "Notify a person",
  call_webhook: "Send webhook",
};
const actionDefaults: { [Kind in AutomationAction["kind"]]: Extract<AutomationAction, { kind: Kind }> } = {
  set_state: { kind: "set_state", stateId: "" },
  assign: { kind: "assign", assigneeId: null },
  add_label: { kind: "add_label", labelId: "" },
  set_field: { kind: "set_field", fieldId: "", value: null },
  create_subtask: { kind: "create_subtask", title: "" },
  comment: { kind: "comment", text: "" },
  notify: { kind: "notify", userId: "", text: "" },
  call_webhook: { kind: "call_webhook", webhookId: "" },
};
const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const rowClass = "flex flex-wrap items-center justify-between gap-3 border-b px-3 py-3 last:border-b-0";

function SelectField({
  label,
  value,
  onChange,
  options,
  empty,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { id: string; name: string }[];
  empty?: string;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={selectClass}
      >
        {empty !== undefined && <option value="">{empty}</option>}
        {value && !options.some((item) => item.id === value) && <option value={value}>Unavailable</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function CustomValueField({
  field,
  value,
  onChange,
}: {
  field: CustomField;
  value: CustomFieldValue;
  onChange: (value: CustomFieldValue) => void;
}) {
  const { idx } = useWorkspace();
  if (field.type === "checkbox")
    return (
      <SelectField
        label="Value"
        value={value === null ? "" : String(value)}
        empty="Clear"
        onChange={(next) => onChange(next ? next === "true" : null)}
        options={[
          { id: "true", name: "Checked" },
          { id: "false", name: "Unchecked" },
        ]}
      />
    );
  if (field.type === "person" || field.type === "single_select")
    return (
      <SelectField
        label="Value"
        value={typeof value === "string" ? value : ""}
        empty="Clear"
        onChange={(next) => onChange(next || null)}
        options={
          field.type === "person"
            ? idx.boot.users
            : field.options.map(({ id, label }) => ({ id, name: label }))
        }
      />
    );
  if (field.type === "multi_select")
    return (
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Values</legend>
        {field.options.map(({ id, label }) => {
          const selected = Array.isArray(value) ? value : [];
          return (
            <label key={id} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, id]
                    : selected.filter((existing) => existing !== id);
                  onChange(next.length ? next : null);
                }}
              />
              {label}
            </label>
          );
        })}
      </fieldset>
    );
  return (
    <Field>
      <FieldLabel>
        Value
        <Input
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          step={field.type === "number" ? "any" : undefined}
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? null
                : field.type === "number"
                  ? Number(event.target.value)
                  : event.target.value,
            )
          }
          placeholder="Leave blank to clear"
        />
      </FieldLabel>
    </Field>
  );
}

function ActionEditor({
  action,
  teamId,
  hooks,
  customFields,
  onChange,
  onRemove,
}: {
  action: AutomationAction;
  teamId: string | null;
  hooks: Hook[] | null;
  customFields: CustomField[];
  onChange: (action: AutomationAction) => void;
  onRemove: () => void;
}) {
  const { idx } = useWorkspace();
  const selectedField =
    action.kind === "set_field" ? customFields.find((field) => field.id === action.fieldId) : undefined;
  const availableActions = (Object.entries(actionLabels) as [AutomationAction["kind"], string][])
    .filter(
      ([id]) =>
        (id !== "call_webhook" || hooks !== null || action.kind === "call_webhook") &&
        (id !== "set_state" || teamId !== null || action.kind === "set_state"),
    )
    .map(([id, name]) => ({ id, name }));
  let actionFields: ReactNode;
  switch (action.kind) {
    case "set_state":
      actionFields = teamId ? (
        <SelectField
          label="Status"
          value={action.stateId}
          empty="Choose status"
          options={idx.boot.workflowStates.filter((state) => state.teamId === teamId)}
          onChange={(stateId) => onChange({ ...action, stateId })}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Choose a team to set a status.</p>
      );
      break;
    case "assign":
      actionFields = (
        <SelectField
          label="Assignee"
          value={action.assigneeId ?? ""}
          empty="Unassigned"
          options={idx.boot.users}
          onChange={(assigneeId) => onChange({ ...action, assigneeId: assigneeId || null })}
        />
      );
      break;
    case "add_label":
      actionFields = (
        <SelectField
          label="Label"
          value={action.labelId}
          empty="Choose label"
          options={idx.boot.labels}
          onChange={(labelId) => onChange({ ...action, labelId })}
        />
      );
      break;
    case "set_field":
      actionFields = (
        <>
          <SelectField
            label="Custom field"
            value={action.fieldId}
            empty="Choose field"
            options={customFields}
            onChange={(fieldId) => onChange({ ...action, fieldId, value: null })}
          />
          {selectedField && (
            <CustomValueField
              field={selectedField}
              value={action.value}
              onChange={(value) => onChange({ ...action, value })}
            />
          )}
        </>
      );
      break;
    case "create_subtask":
      actionFields = (
        <Field>
          <FieldLabel>
            Subtask title
            <Input
              value={action.title}
              maxLength={512}
              onChange={(event) => onChange({ ...action, title: event.target.value })}
            />
          </FieldLabel>
        </Field>
      );
      break;
    case "comment":
      actionFields = (
        <Field>
          <FieldLabel>
            Comment
            <Textarea
              value={action.text}
              maxLength={1000}
              onChange={(event) => onChange({ ...action, text: event.target.value })}
            />
          </FieldLabel>
        </Field>
      );
      break;
    case "notify":
      actionFields = (
        <>
          <SelectField
            label="Recipient"
            value={action.userId}
            empty="Choose person"
            options={idx.boot.users}
            onChange={(userId) => onChange({ ...action, userId })}
          />
          <Field>
            <FieldLabel>
              Message
              <Textarea
                value={action.text}
                maxLength={1000}
                onChange={(event) => onChange({ ...action, text: event.target.value })}
              />
            </FieldLabel>
          </Field>
        </>
      );
      break;
    case "call_webhook":
      actionFields = (
        <SelectField
          label="Webhook"
          value={action.webhookId}
          empty="Choose webhook"
          options={hooks ?? []}
          onChange={(webhookId) => onChange({ ...action, webhookId })}
        />
      );
      break;
  }
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-end gap-2">
        <SelectField
          label="Action"
          value={action.kind}
          options={availableActions}
          onChange={(kind) => onChange(actionDefaults[kind as AutomationAction["kind"]])}
        />
        <Button type="button" size="icon" variant="ghost" aria-label="Remove action" onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {actionFields}
    </div>
  );
}

function RuleDialog({
  rule,
  hooks,
  customFields,
  onClose,
}: {
  rule?: Rules[number];
  hooks: Hook[] | null;
  customFields: CustomField[];
  onClose: () => void;
}) {
  const { slug, idx } = useWorkspace();
  const [draft, setDraft] = useState<AutomationRuleInput>(
    rule
      ? {
          name: rule.name,
          teamId: rule.teamId,
          trigger: rule.trigger,
          filter: rule.filter,
          actions: rule.actions,
          enabled: rule.enabled,
        }
      : { name: "", teamId: null, trigger: "task_created", filter: null, actions: [], enabled: true },
  );
  const [testTaskId, setTestTaskId] = useState("");
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const parsed = automationRuleSchema.safeParse(draft);
  const patch = (fields: Partial<AutomationRuleInput>) => {
    setPreview("");
    setDraft((current) => ({ ...current, ...fields }));
  };
  async function previewRule() {
    if (!parsed.success || !testTaskId) return;
    setPreviewing(true);
    setPreview("");
    try {
      const result = await unwrap(
        api()["dry-run"].$post({ param: { slug }, json: { taskId: testTaskId, rule: parsed.data } }),
      );
      setPreview(
        result.matches
          ? `Matches. Would run ${result.actions.map((action) => actionLabels[action.kind].toLowerCase()).join(", ")}.`
          : "The task does not match these conditions.",
      );
    } catch (error) {
      setPreview(errorMessage(error));
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <HaccpDialog
      title={rule ? "Edit automation rule" : "New automation rule"}
      description="Choose an event, optional conditions, and the actions to run in order."
      submitLabel="Save rule"
      disabled={!parsed.success}
      onClose={onClose}
      onSubmit={async () => {
        const json = automationRuleSchema.parse(draft);
        if (rule) await unwrap(api().rules[":id"].$put({ param: { slug, id: rule.id }, json }));
        else await unwrap(api().rules.$post({ param: { slug }, json }));
        return "Rule saved";
      }}
    >
      <Field>
        <FieldLabel>
          Name
          <Input
            value={draft.name}
            required
            maxLength={1000}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </FieldLabel>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Team"
          value={draft.teamId ?? ""}
          empty="All teams"
          options={idx.boot.teams}
          onChange={(teamId) =>
            patch({
              teamId: teamId || null,
              actions: draft.actions.map((action) =>
                action.kind === "set_state" ? { ...action, stateId: "" } : action,
              ),
            })
          }
        />
        <SelectField
          label="When"
          value={draft.trigger}
          options={automationTriggers.map((id) => ({ id, name: triggerLabels[id] }))}
          onChange={(trigger) => patch({ trigger: trigger as AutomationTrigger })}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Only when</legend>
        <TaskFilterControls
          embedded
          filter={draft.filter ?? undefined}
          onChange={(filter) => patch({ filter: filter ?? null })}
        />
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Then</legend>
        {draft.actions.map((action, index) => (
          <ActionEditor
            key={index}
            action={action}
            teamId={draft.teamId}
            hooks={hooks}
            customFields={customFields}
            onChange={(next) => patch({ actions: draft.actions.map((old, i) => (i === index ? next : old)) })}
            onRemove={() => patch({ actions: draft.actions.filter((_, i) => i !== index) })}
          />
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={draft.actions.length >= 10}
          onClick={() => patch({ actions: [...draft.actions, actionDefaults.comment] })}
        >
          <Plus /> Add action
        </Button>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />{" "}
        Enable rule
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Dry run</legend>
        <div className="flex items-end gap-2">
          <SelectField
            label="Test task"
            value={testTaskId}
            empty="Choose recent task"
            options={idx.boot.tasks
              .filter((task) => !draft.teamId || task.teamId === draft.teamId)
              .map((task) => ({ id: task.id, name: task.title }))}
            onChange={(id) => {
              setTestTaskId(id);
              setPreview("");
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!parsed.success || !testTaskId || previewing}
            onClick={() => void previewRule()}
          >
            <CircleHelp /> Preview
          </Button>
        </div>
        {preview && (
          <p role="status" className="text-sm text-muted-foreground">
            {preview}
          </p>
        )}
      </fieldset>
    </HaccpDialog>
  );
}

function HookDialog({
  hook,
  onClose,
  onSecret,
}: {
  hook?: Hook;
  onClose: () => void;
  onSecret: (secret: string) => void;
}) {
  const { slug } = useWorkspace();
  const [draft, setDraft] = useState<AutomationWebhookInput>(
    hook
      ? {
          name: hook.name,
          url: hook.url,
          events: hook.events,
          filter: hook.filter,
          enabled: hook.enabled,
        }
      : { name: "", url: "", events: [], filter: null, enabled: true },
  );
  const [rotate, setRotate] = useState(false);
  return (
    <HaccpDialog
      title={hook ? "Edit webhook" : "New webhook"}
      description="Deliver signed task events to a public HTTPS endpoint."
      submitLabel="Save webhook"
      disabled={!draft.name.trim() || !draft.url.trim()}
      onClose={onClose}
      onSubmit={async () => {
        const saved = hook
          ? await unwrap(
              api().webhooks[":id"].$put({
                param: { slug, id: hook.id },
                json: { ...draft, rotateSecret: rotate },
              }),
            )
          : await unwrap(api().webhooks.$post({ param: { slug }, json: draft }));
        if (saved.secret) onSecret(saved.secret);
        return "Webhook saved";
      }}
    >
      <Field>
        <FieldLabel>
          Name
          <Input
            value={draft.name}
            required
            maxLength={1000}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </FieldLabel>
      </Field>
      <Field>
        <FieldLabel>
          HTTPS URL
          <Input
            value={draft.url}
            type="url"
            required
            maxLength={2048}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          />
        </FieldLabel>
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Subscribed events</legend>
        <p className="text-sm text-muted-foreground">Leave all unchecked to send from rules only.</p>
        {automationTriggers.map((trigger) => (
          <label key={trigger} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.events.includes(trigger)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  events: event.target.checked
                    ? [...draft.events, trigger]
                    : draft.events.filter((item) => item !== trigger),
                })
              }
            />
            {triggerLabels[trigger]}
          </label>
        ))}
      </fieldset>
      {draft.events.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Subscription conditions</legend>
          <TaskFilterControls
            embedded
            filter={draft.filter ?? undefined}
            onChange={(filter) => setDraft({ ...draft, filter: filter ?? null })}
          />
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />{" "}
        Enable webhook
      </label>
      {hook && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rotate} onChange={(event) => setRotate(event.target.checked)} />{" "}
          Generate a new signing secret
        </label>
      )}
    </HaccpDialog>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      <div className="rounded-md border text-sm">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="p-3 text-muted-foreground">{children}</p>;
}

export function AutomationView({
  data,
  hooks,
  customFields,
}: {
  data: Data;
  hooks: WebhookData | null;
  customFields: CustomField[];
}) {
  const { slug, idx, can, canEditTasks } = useWorkspace();
  const router = useRouter();
  const timeZone = idx.boot.workspace.timeZone;
  const [rule, setRule] = useState<Rules[number] | "new" | null>(null);
  const [hook, setHook] = useState<Hook | "new" | null>(null);
  const [secret, setSecret] = useState<string>();
  const [deletion, setDeletion] = useState<{ id: string; name: string; kind: "rule" | "webhook" } | null>(
    null,
  );
  const canManage = can("automation", "manage") && canEditTasks;
  return (
    <div className="space-y-6">
      <Section title="Recurring tasks">
        {data.recurrences.length === 0 && <Empty>Set a schedule with Repeat on any task.</Empty>}
        {data.recurrences.map((schedule) => (
          <div key={schedule.id} className={rowClass}>
            <Link className="font-medium hover:underline" href={`/${slug}/task/${schedule.sourceTaskId}`}>
              {schedule.title}
            </Link>
            <span className={schedule.lastError ? "text-destructive" : "text-muted-foreground"}>
              {schedule.lastError ??
                (schedule.enabled ? `Next due ${formatShortDate(schedule.nextOn, timeZone)}` : "Paused")}
            </span>
          </div>
        ))}
      </Section>
      <Section
        title="Rules"
        action={
          canManage && (
            <Button size="sm" onClick={() => setRule("new")}>
              <Plus /> New rule
            </Button>
          )
        }
      >
        {data.rules.length === 0 && <Empty>No rules yet.</Empty>}
        {data.rules.map((item) => (
          <div key={item.id} className={rowClass}>
            <div>
              <div className="font-medium">{item.name}</div>
              <div className="text-muted-foreground">
                {triggerLabels[item.trigger]} ·{" "}
                {item.teamId ? (idx.teams.get(item.teamId)?.name ?? "Archived team") : "All teams"} ·{" "}
                {item.enabled ? "Enabled" : "Disabled"}
              </div>
            </div>
            {canManage && (
              <div className="flex gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${item.name}`}
                  onClick={() => setRule(item)}
                >
                  <PencilLine />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${item.name}`}
                  onClick={() => setDeletion({ ...item, kind: "rule" })}
                >
                  <Trash2 />
                </Button>
              </div>
            )}
          </div>
        ))}
      </Section>
      <Section
        title="Recent rule runs"
        action={
          <Button variant="ghost" size="sm" onClick={() => router.refresh()}>
            <RefreshCw /> Refresh history
          </Button>
        }
      >
        {data.runs.length === 0 && <Empty>No runs yet.</Empty>}
        {data.runs.map((run) => (
          <div key={run.id} className={rowClass}>
            <div>
              <p className="font-medium">{run.ruleName}</p>
              <Link className="text-muted-foreground hover:underline" href={`/${slug}/task/${run.taskId}`}>
                {run.taskTitle}
              </Link>
            </div>
            <div className="text-right">
              <p className="capitalize">{run.status}</p>
              <time dateTime={run.finishedAt ?? run.createdAt} className="text-muted-foreground">
                {formatDateTime(run.finishedAt ?? run.createdAt, timeZone)}
              </time>
              {run.result && <p className="text-muted-foreground">{run.result}</p>}
            </div>
          </div>
        ))}
      </Section>
      {hooks && (
        <>
          <Section
            title="Webhooks"
            action={
              <Button size="sm" onClick={() => setHook("new")}>
                <Plus /> New webhook
              </Button>
            }
          >
            {secret && (
              <div className="space-y-2 border-b bg-muted p-3">
                <p role="status" className="font-medium">
                  Copy the signing secret now. It is shown once.
                </p>
                <code className="break-all">{secret}</code>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(secret)
                        .then(() => toast.success("Signing secret copied"))
                        .catch((error) => toast.error(errorMessage(error)))
                    }
                  >
                    Copy secret
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSecret(undefined)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            )}
            {hooks.webhooks.length === 0 && <Empty>No webhook endpoints yet.</Empty>}
            {hooks.webhooks.map((item) => (
              <div key={item.id} className={rowClass}>
                <div className="min-w-0 break-all">
                  <div className="font-medium">{item.name}</div>
                  <div className="text-muted-foreground">
                    {item.url} · {item.enabled ? "Enabled" : "Disabled"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${item.name}`}
                    onClick={() => setHook(item)}
                  >
                    <PencilLine />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${item.name}`}
                    onClick={() => setDeletion({ ...item, kind: "webhook" })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </Section>
          <Section title="Recent webhook deliveries">
            {hooks.deliveries.length === 0 && <Empty>No deliveries yet.</Empty>}
            {hooks.deliveries.map((delivery) => (
              <div key={delivery.id} className={rowClass}>
                <div>
                  <p className="font-medium">{delivery.name}</p>
                  <p className="text-muted-foreground">{triggerLabels[delivery.trigger]}</p>
                </div>
                <div className="text-right">
                  <p className="capitalize">
                    {delivery.status}
                    {delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ""}
                  </p>
                  <p className="text-muted-foreground">
                    {delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"}
                  </p>
                  <time dateTime={delivery.createdAt} className="text-muted-foreground">
                    {formatDateTime(delivery.createdAt, timeZone)}
                  </time>
                </div>
              </div>
            ))}
          </Section>
        </>
      )}
      {rule && (
        <RuleDialog
          rule={rule === "new" ? undefined : rule}
          hooks={hooks?.webhooks ?? null}
          customFields={customFields}
          onClose={() => setRule(null)}
        />
      )}
      {hook && (
        <HookDialog
          hook={hook === "new" ? undefined : hook}
          onClose={() => setHook(null)}
          onSecret={setSecret}
        />
      )}
      {deletion && (
        <HaccpDialog
          title={`Delete ${deletion.kind}?`}
          description={`“${deletion.name}” will stop processing new events.`}
          submitLabel="Delete"
          onClose={() => setDeletion(null)}
          onSubmit={async () => {
            const param = { slug, id: deletion.id };
            await unwrapEmpty(
              deletion.kind === "rule"
                ? api().rules[":id"].$delete({ param })
                : api().webhooks[":id"].$delete({ param }),
            );
            return deletion.kind === "rule" ? "Rule deleted" : "Webhook deleted";
          }}
        >
          {null}
        </HaccpDialog>
      )}
    </div>
  );
}
