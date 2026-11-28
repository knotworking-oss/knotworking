"use client";

import {
  automationPipelineSchema,
  biDashboardViewParamsSchema,
  biPeriodPresets,
  biQuerySpecSchema,
  newId,
  pipelineCapabilities,
  pipelineEventKinds,
  pipelineEvents,
  type PipelineEventKind,
  type AutomationPipelineInput,
  type BiPeriodPreset,
  type PipelineKind,
  type PipelineSchedule,
  type PipelineStep,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { ArrowDown, ArrowUp, Play, Plus, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { getAutomationPipelines, getPipelineOptions } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

type Options = Awaited<ReturnType<typeof getPipelineOptions>>;
type Data = Awaited<ReturnType<typeof getAutomationPipelines>>;
type Choice = { id: string; name: string };
type Editable = { id?: string; definition: AutomationPipelineInput };

const api = () => browserApi().v1.workspaces[":slug"].automation;
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const label = (key: string) => key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

function Select({
  title,
  value,
  choices,
  onChange,
  empty,
  required,
}: {
  title: string;
  value: string;
  choices: readonly Choice[];
  onChange: (value: string) => void;
  empty?: string;
  required?: boolean;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      {title}
      <select
        className={selectClass}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      >
        {empty !== undefined && <option value="">{empty}</option>}
        {value && !choices.some((choice) => choice.id === value) && (
          <option value={value}>Unavailable</option>
        )}
        {choices.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Choices({
  title,
  choices,
  values,
  onChange,
}: {
  title: string;
  choices: readonly Choice[];
  values: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{title}</legend>
      <div className="flex max-h-36 flex-wrap gap-x-4 gap-y-2 overflow-y-auto rounded-md border p-2">
        {choices.map(({ id, name }) => (
          <label key={id} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={values.includes(id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...values, id] : values.filter((value) => value !== id))
              }
            />
            {name}
          </label>
        ))}
        {!choices.length && <span className="text-sm text-muted-foreground">No options available</span>}
      </div>
    </fieldset>
  );
}

function ScheduleEditor({
  value,
  onChange,
}: {
  value: PipelineSchedule | null;
  onChange: (schedule: PipelineSchedule | null) => void;
}) {
  function changeFrequency(frequency: string) {
    const time = value?.time ?? "07:00";
    switch (frequency) {
      case "daily":
        return onChange({ frequency, time });
      case "weekly":
        return onChange({ frequency, time, weekdays: [1, 2, 3, 4, 5] });
      case "monthly":
        return onChange({ frequency, time, day: 1 });
      default:
        return onChange(null);
    }
  }
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          title="Schedule"
          value={value?.frequency ?? ""}
          onChange={changeFrequency}
          empty="Manual only"
          choices={["daily", "weekly", "monthly"].map((id) => ({ id, name: label(id) }))}
        />
        {value && (
          <label className="grid gap-1 text-sm font-medium">
            Local time
            <Input
              type="time"
              required
              value={value.time}
              onChange={(e) => onChange({ ...value, time: e.target.value })}
            />
          </label>
        )}
        {value?.frequency === "monthly" && (
          <label className="grid gap-1 text-sm font-medium">
            Day of month
            <Input
              type="number"
              min={1}
              max={31}
              required
              value={value.day || ""}
              onChange={(e) => onChange({ ...value, day: Number(e.target.value) })}
            />
          </label>
        )}
      </div>
      {value?.frequency === "weekly" && (
        <Choices
          title="Days"
          choices={weekdays.map((name, i) => ({ id: String(i + 1), name }))}
          values={value.weekdays.map(String)}
          onChange={(days) => onChange({ ...value, weekdays: days.map(Number) })}
        />
      )}
    </div>
  );
}

function JsonConfig({
  title,
  value,
  onApply,
}: {
  title: string;
  value: unknown;
  onApply: (raw: unknown) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const shown = text ?? JSON.stringify(value ?? {}, null, 2);
  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground">{title}</summary>
      <div className="mt-2 grid gap-2">
        <Textarea
          aria-label={title}
          className="min-h-24 font-mono text-xs"
          value={shown}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={text === null}
            onClick={() => {
              try {
                onApply(JSON.parse(shown));
                setText(null);
                setError("");
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Apply
          </Button>
          {text !== null && (
            <span className="text-xs text-muted-foreground">Changes apply after selecting Apply.</span>
          )}
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

function QueryEditor({
  step,
  options,
  onChange,
}: {
  step: Extract<PipelineStep, { kind: "bi.query" }>;
  options: Options;
  onChange: (step: PipelineStep) => void;
}) {
  const dataset = options.datasets.find((d) => d.id === step.query.dataset);
  const dimensions = dataset?.dimensions.map(({ id, label: name }) => ({ id, name })) ?? [];
  return (
    <div className="grid gap-3">
      <Select
        title="Dataset"
        value={step.query.dataset}
        required
        empty="Choose a dataset"
        choices={options.datasets.map(({ id, label: name }) => ({ id, name }))}
        onChange={(id) =>
          onChange({ ...step, query: { dataset: id, measures: [], filters: [], sort: [], groupBy: [] } })
        }
      />
      {dataset && (
        <>
          <Choices
            title="Measures"
            choices={dataset.measures.map(({ id, label: name }) => ({ id, name }))}
            values={step.query.measures}
            onChange={(measures) => onChange({ ...step, query: { ...step.query, measures } })}
          />
          <Choices
            title="Group by"
            choices={dimensions}
            values={step.query.groupBy.map(({ dim }) => dim)}
            onChange={(dims) =>
              onChange({ ...step, query: { ...step.query, groupBy: dims.map((dim) => ({ dim })) } })
            }
          />
          {dataset.defaultDate && (
            <Select
              title="Reporting period"
              value={step.query.period?.preset ?? ""}
              empty="All dates"
              choices={biPeriodPresets.map((id) => ({ id, name: label(id) }))}
              onChange={(preset) =>
                onChange({
                  ...step,
                  query: { ...step.query, period: preset ? { preset: preset as BiPeriodPreset } : undefined },
                })
              }
            />
          )}
        </>
      )}
      <JsonConfig
        title="Advanced query filters, sorting and comparison"
        value={step.query}
        onApply={(raw) => onChange({ ...step, query: biQuerySpecSchema.parse(raw) })}
      />
    </div>
  );
}

function StepFields({
  step,
  earlier,
  options,
  onChange,
}: {
  step: PipelineStep;
  earlier: PipelineStep[];
  options: Options;
  onChange: (step: PipelineStep) => void;
}): ReactNode {
  const { idx } = useWorkspace();
  const people = idx.boot.users;
  switch (step.kind) {
    case "stock.position":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            title="Location"
            value={step.locationId ?? ""}
            choices={options.locations}
            empty="All locations"
            onChange={(id) => onChange({ ...step, locationId: id || null })}
          />
          <label className="grid gap-1 text-sm font-medium">
            Maximum items shown
            <Input
              type="number"
              min={1}
              max={100}
              required
              value={step.limit || ""}
              onChange={(e) => onChange({ ...step, limit: Number(e.target.value) })}
            />
          </label>
        </div>
      );
    case "quality.audit_requirements":
      return null;
    case "governance.standard_gaps":
      return (
        <Select
          title="Standard"
          value={step.standardId}
          choices={options.standards}
          required
          empty="Choose a standard"
          onChange={(standardId) => onChange({ ...step, standardId })}
        />
      );
    case "bi.query":
      return <QueryEditor step={step} options={options} onChange={onChange} />;
    case "bi.snapshot":
    case "bi.dashboard_draft":
      return (
        <div className="grid gap-3">
          <Select
            title="Source dashboard"
            value={step.dashboardId}
            choices={options.dashboards}
            required
            empty="Choose a dashboard"
            onChange={(dashboardId) => onChange({ ...step, dashboardId })}
          />
          <JsonConfig
            title="Dashboard view parameters"
            value={step.params}
            onApply={(raw) => onChange({ ...step, params: biDashboardViewParamsSchema.parse(raw) })}
          />
        </div>
      );
    case "tasks.follow_up": {
      const sources = earlier.filter((previous) => pipelineCapabilities[previous.kind].metrics.length);
      const source = sources.find((previous) => previous.id === step.condition.stepId);
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            title="Task team"
            value={step.teamId}
            choices={idx.boot.teams}
            required
            empty="Choose a team"
            onChange={(teamId) => onChange({ ...step, teamId })}
          />
          <Select
            title="Task assignee"
            value={step.assigneeId ?? ""}
            choices={people}
            empty="Unassigned"
            onChange={(id) => onChange({ ...step, assigneeId: id || null })}
          />
          <Select
            title="When a previous step"
            value={step.condition.stepId}
            required
            empty="Choose a step"
            choices={sources.map(({ id, title: name }) => ({ id, name }))}
            onChange={(stepId) => {
              const previous = sources.find(({ id }) => id === stepId);
              onChange({
                ...step,
                condition: {
                  ...step.condition,
                  stepId,
                  metric: previous ? (pipelineCapabilities[previous.kind].metrics[0] ?? "") : "",
                },
              });
            }}
          />
          <Select
            title="Metric"
            value={step.condition.metric}
            required
            empty="Choose a metric"
            choices={(source ? pipelineCapabilities[source.kind].metrics : []).map((id) => ({
              id,
              name: label(id),
            }))}
            onChange={(metric) => onChange({ ...step, condition: { ...step.condition, metric } })}
          />
          <Select
            title="Comparison"
            value={step.condition.operator}
            choices={[
              { id: "gt", name: "Greater than" },
              { id: "gte", name: "At least" },
              { id: "lt", name: "Less than" },
              { id: "lte", name: "At most" },
              { id: "eq", name: "Equal to" },
            ]}
            onChange={(operator) =>
              onChange({
                ...step,
                condition: { ...step.condition, operator: operator as typeof step.condition.operator },
              })
            }
          />
          <label className="grid gap-1 text-sm font-medium">
            Value
            <Input
              type="number"
              step="any"
              required
              value={Number.isNaN(step.condition.value) ? "" : step.condition.value}
              onChange={(e) =>
                onChange({ ...step, condition: { ...step.condition, value: e.target.valueAsNumber } })
              }
            />
          </label>
        </div>
      );
    }
    case "automation.notify":
      return (
        <Choices
          title="Recipients"
          choices={people}
          values={step.recipients}
          onChange={(recipients) => onChange({ ...step, recipients })}
        />
      );
  }
}

function newStep(kind: PipelineKind, userId: string): PipelineStep {
  const base = { id: newId(), title: pipelineCapabilities[kind].label };
  switch (kind) {
    case "stock.position":
      return { ...base, kind, locationId: null, limit: 30 };
    case "quality.audit_requirements":
      return { ...base, kind };
    case "governance.standard_gaps":
      return { ...base, kind, standardId: "" };
    case "bi.query":
      return { ...base, kind, query: { dataset: "", measures: [], groupBy: [], filters: [], sort: [] } };
    case "bi.snapshot":
    case "bi.dashboard_draft":
      return { ...base, kind, dashboardId: "" };
    case "tasks.follow_up":
      return {
        ...base,
        kind,
        teamId: "",
        assigneeId: null,
        condition: { stepId: "", metric: "", operator: "gt", value: 0 },
      };
    case "automation.notify":
      return { ...base, kind, recipients: [userId] };
  }
}

function Editor({
  item,
  options,
  userId,
  onClose,
}: {
  item: Editable;
  options: Options;
  userId: string;
  onClose: () => void;
}) {
  const { slug, can } = useWorkspace();
  const router = useRouter();
  const [draft, setDraft] = useState(item.definition);
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editorId = useId();
  const kinds = (Object.keys(pipelineCapabilities) as PipelineKind[]).filter((key) => {
    const capability = pipelineCapabilities[key];
    return (
      can(capability.module, capability.level) &&
      (key !== "tasks.follow_up" ||
        draft.steps.some((step) => pipelineCapabilities[step.kind].metrics.length))
    );
  });
  const updateSteps = (steps: PipelineStep[]) => setDraft({ ...draft, steps });
  function move(index: number, direction: number) {
    const steps = [...draft.steps];
    const other = index + direction;
    [steps[index], steps[other]] = [steps[other]!, steps[index]!];
    updateSteps(steps);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = automationPipelineSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(". "));
      return;
    }
    setError("");
    setBusy(true);
    try {
      await (item.id
        ? unwrap(api().pipelines[":id"].$put({ param: { slug, id: item.id }, json: parsed.data }))
        : unwrap(api().pipelines.$post({ param: { slug }, json: parsed.data })));
      router.refresh();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{item.id ? "Edit pipeline" : "New pipeline"}</DialogTitle>
          <DialogDescription>
            Steps run in order. Notifications send after the other steps finish.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <fieldset disabled={busy} className="space-y-4">
            <label htmlFor={editorId} className="grid gap-1 text-sm font-medium">
              Name
              <Input
                id={editorId}
                required
                maxLength={120}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <ScheduleEditor
              value={draft.schedule}
              onChange={(schedule) => setDraft({ ...draft, schedule })}
            />
            <Choices
              title="Module events"
              choices={pipelineEventKinds
                .filter((id) => can(pipelineEvents[id].module))
                .map((id) => ({ id, name: pipelineEvents[id].label }))}
              values={draft.eventTriggers}
              onChange={(ids) => setDraft({ ...draft, eventTriggers: ids as PipelineEventKind[] })}
            />
            {(draft.schedule || draft.eventTriggers.length > 0) && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                Automatic runs enabled
              </label>
            )}
            <div className="space-y-3">
              {draft.steps.map((step, index) => (
                <section key={step.id} className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-medium">{pipelineCapabilities[step.kind].label}</h3>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Move step up"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Move step down"
                        disabled={index === draft.steps.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove step"
                        onClick={() => updateSteps(draft.steps.filter((item) => item.id !== step.id))}
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                  <label className="grid gap-1 text-sm font-medium">
                    {step.kind === "tasks.follow_up"
                      ? "Task title"
                      : step.kind === "bi.dashboard_draft"
                        ? "Draft title"
                        : "Section title"}
                    <Input
                      required
                      maxLength={120}
                      value={step.title}
                      onChange={(e) =>
                        updateSteps(
                          draft.steps.map((item) =>
                            item.id === step.id ? { ...step, title: e.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <StepFields
                    step={step}
                    earlier={draft.steps.slice(0, index)}
                    options={options}
                    onChange={(next) =>
                      updateSteps(draft.steps.map((item) => (item.id === step.id ? next : item)))
                    }
                  />
                </section>
              ))}
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Select
                    title="Step type"
                    value={kind}
                    empty="Choose a step"
                    choices={kinds.map((id) => ({ id, name: pipelineCapabilities[id].label }))}
                    onChange={setKind}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!kind || draft.steps.length >= 12}
                  onClick={() => {
                    updateSteps([...draft.steps, newStep(kind as PipelineKind, userId)]);
                    setKind("");
                  }}
                >
                  <Plus /> Add step
                </Button>
              </div>
            </div>
          </fieldset>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save pipeline
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function scheduleText({ schedule, enabled, eventTriggers }: AutomationPipelineInput) {
  if (!schedule)
    return eventTriggers.length ? (enabled ? "On module events" : "Paused · Module events") : "Manual";
  const state = enabled ? "" : "Paused · ";
  switch (schedule.frequency) {
    case "daily":
      return `${state}Daily at ${schedule.time}`;
    case "weekly":
      return `${state}${schedule.weekdays.map((day) => weekdays[day - 1]).join(", ")} at ${schedule.time}`;
    case "monthly":
      return `${state}Day ${schedule.day} each month at ${schedule.time}`;
  }
}

export function PipelineView({
  data,
  options,
  userId,
}: {
  data: Data;
  options: Options | null;
  userId: string;
}) {
  const { slug, can } = useWorkspace();
  const router = useRouter();
  const [editor, setEditor] = useState<Editable | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const requests = useRef(new Map<string, string>());

  function useMorningTemplate() {
    if (!options) return;
    const steps = [newStep("stock.position", userId), newStep("quality.audit_requirements", userId)];
    if (can("governance") && options.standards[0])
      steps.push({
        id: newId(),
        kind: "governance.standard_gaps",
        title: "Standard gaps",
        standardId: options.standards.length === 1 ? options.standards[0].id : "",
      });
    steps.push(newStep("automation.notify", userId));
    setEditor({
      definition: {
        name: "Morning Operations Brief",
        enabled: false,
        schedule: { frequency: "weekly", weekdays: [1, 2, 3, 4, 5], time: "07:00" },
        eventTriggers: [],
        steps,
      },
    });
  }

  async function run(id: string) {
    setBusy(id);
    const commandId = requests.current.get(id) ?? newId();
    requests.current.set(id, commandId);
    try {
      const result = await unwrap(
        api().pipelines[":id"].run.$post({ param: { slug, id }, json: { commandId } }),
      );
      requests.current.delete(id);
      router.push(`/${slug}/automation/runs/${result.id}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function archive(id: string) {
    if (!window.confirm("Archive this pipeline? Its past reports will remain available.")) return;
    setBusy(id);
    try {
      await unwrapEmpty(api().pipelines[":id"].$delete({ param: { slug, id } }));
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-7">
      {options && (
        <section className="space-y-3" aria-label="Pipelines">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Pipelines</h2>
            <div className="flex flex-wrap gap-2">
              {can("stock") && can("quality") && (
                <Button size="sm" variant="outline" onClick={useMorningTemplate}>
                  Morning Operations Brief
                </Button>
              )}
              <Button
                size="sm"
                onClick={() =>
                  setEditor({
                    definition: { name: "", enabled: false, schedule: null, eventTriggers: [], steps: [] },
                  })
                }
              >
                <Plus /> New pipeline
              </Button>
            </div>
          </div>
          <div className="divide-y rounded-lg border">
            {data.pipelines.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No pipelines yet.</p>
            )}
            {data.pipelines.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div>
                  <p className="font-medium">{item.definition.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {scheduleText(item.definition)}
                    {item.definition.schedule && item.definition.eventTriggers.length
                      ? " · Module events"
                      : ""}{" "}
                    · {item.definition.steps.length} steps
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void run(item.id)}
                  >
                    <Play /> Run now
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditor(item)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void archive(item.id)}
                  >
                    Archive
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="space-y-3" aria-label="Pipeline reports">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Pipeline reports</h2>
          <Button size="sm" variant="ghost" onClick={() => router.refresh()}>
            <RefreshCw /> Refresh
          </Button>
        </div>
        <div className="divide-y rounded-lg border">
          {data.runs.length === 0 && <p className="p-4 text-sm text-muted-foreground">No reports yet.</p>}
          {data.runs.map((run) => (
            <Link
              key={run.id}
              href={`/${slug}/automation/runs/${run.id}`}
              className="flex items-center justify-between gap-3 p-3 text-sm hover:bg-muted/50"
            >
              <span>
                <strong>{run.name}</strong>{" "}
                <span className="text-muted-foreground">· {formatLongDate(run.asAt)}</span>
              </span>
              <span>{label(run.status)}</span>
            </Link>
          ))}
        </div>
      </section>
      {editor && options && (
        <Editor item={editor} options={options} userId={userId} onClose={() => setEditor(null)} />
      )}
    </div>
  );
}
