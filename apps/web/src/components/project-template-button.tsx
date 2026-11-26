"use client";

import {
  modules as moduleDefinitions,
  newId,
  ISO_DATE_MAX,
  ISO_DATE_MIN,
  PROJECT_TEMPLATE_MAX_OFFSET_DAYS,
  PROJECT_TEMPLATE_MAX_TASKS,
  projectTemplates,
  projectTemplatesByWorkflow,
  projectTemplateWorkflows,
  type ProjectTemplateId,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
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
import { ClipboardList, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import {
  draftDateIssue,
  draftTaskDate,
  draftTaskOffset,
  draftTasksInput,
  draftTemplateSpan,
  draftTemplateTasks,
  suggestedTemplateModules,
  type DraftTemplateTask,
} from "@/lib/project-template-draft";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";

export function ProjectTemplateButton() {
  const { canEditTasks, idx } = useWorkspace();
  const [commandId, setCommandId] = useState<string | null>(null);
  if (!canEditTasks) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!idx.boot.teams.length}
        onClick={() => setCommandId(newId())}
      >
        <ClipboardList /> Use template
      </Button>
      <Dialog
        open={commandId !== null}
        onOpenChange={(open) => {
          if (!open) setCommandId(null);
        }}
      >
        {commandId && <ProjectTemplateForm commandId={commandId} onClose={() => setCommandId(null)} />}
      </Dialog>
    </>
  );
}

const moduleStateLabel = {
  available: "adds steps",
  no_access: "no access",
  inactive: "not enabled",
} as const;

function ProjectTemplateForm({ commandId, onClose }: { commandId: string; onClose: () => void }) {
  const { slug, viewer, idx, sync, can, modules } = useWorkspace();
  const router = useRouter();
  const today = useWorkspaceToday();
  const [templateId, setTemplateId] = useState<ProjectTemplateId>("employee_onboarding");
  const [milestoneDate, setMilestoneDate] = useState(today);
  const [tasks, setTasks] = useState<DraftTemplateTask[]>(() =>
    draftTemplateTasks("employee_onboarding", (id) => can(id)),
  );
  const [pending, setPending] = useState(false);
  const template = projectTemplates[templateId];
  const span = milestoneDate ? draftTemplateSpan(milestoneDate, tasks) : null;
  const dateIssue = milestoneDate ? draftDateIssue(milestoneDate, tasks) : null;
  const suggested = suggestedTemplateModules(templateId, modules);

  function chooseTemplate(id: ProjectTemplateId) {
    setTemplateId(id);
    setTasks(draftTemplateTasks(id, (moduleId) => can(moduleId)));
  }
  const updateTask = (id: string, patch: Partial<DraftTemplateTask>) =>
    setTasks((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    try {
      const project = await unwrap(
        browserApi().v1.workspaces[":slug"].projects["from-template"].$post({
          param: { slug },
          json: {
            templateId,
            commandId,
            name: String(data.get("name")),
            teamId: String(data.get("team")),
            leadId: String(data.get("lead")),
            startDate: milestoneDate,
            tasks: draftTasksInput(tasks),
          },
        }),
      );
      sync.pull();
      onClose();
      router.push(`/${slug}/projects/${project.id}`);
      toast.success("Project created from template");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Create a project from a template</DialogTitle>
        <DialogDescription>
          Creates an ordinary project and dated tasks for the project lead. Approvals, checks and financial
          steps stay in their own module screens.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="project-template">Template</FieldLabel>
            <select
              id="project-template"
              className={selectClass}
              value={templateId}
              onChange={(event) => chooseTemplate(event.currentTarget.value as ProjectTemplateId)}
            >
              {projectTemplatesByWorkflow().map((group) => (
                <optgroup key={group.workflow} label={projectTemplateWorkflows[group.workflow]}>
                  {group.ids.map((id) => (
                    <option key={id} value={id}>
                      {projectTemplates[id].label} · {projectTemplates[id].audience}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="template-project-name">Project name</FieldLabel>
            <Input
              id="template-project-name"
              name="name"
              required
              maxLength={256}
              placeholder={template.label}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="template-team">Team</FieldLabel>
              <select id="template-team" name="team" required className={selectClass}>
                {idx.boot.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="template-lead">Project lead</FieldLabel>
              <select
                id="template-lead"
                name="lead"
                required
                defaultValue={viewer.id}
                className={selectClass}
              >
                {idx.boot.users.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="template-date">{template.dateLabel} (milestone)</FieldLabel>
            <Input
              id="template-date"
              type="date"
              required
              min={ISO_DATE_MIN}
              max={ISO_DATE_MAX}
              value={milestoneDate}
              aria-invalid={dateIssue ? true : undefined}
              aria-describedby={dateIssue ? "template-date-issue" : undefined}
              onChange={(event) => setMilestoneDate(event.currentTarget.value)}
            />
            {dateIssue && (
              <p id="template-date-issue" className="text-sm text-destructive">
                {dateIssue}
              </p>
            )}
          </Field>

          <section aria-label="Template preview" className="space-y-3 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
              </span>
              {span && (
                <span className="text-muted-foreground">
                  {template.dateLabel} {formatLongDate(milestoneDate)} · runs {formatLongDate(span.start)} to{" "}
                  {formatLongDate(span.target)}
                </span>
              )}
            </div>
            {suggested.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">Suggested modules:</span>
                {suggested.map((module) => (
                  <Badge key={module.id} variant={module.state === "available" ? "secondary" : "outline"}>
                    {moduleDefinitions[module.id].name} · {moduleStateLabel[module.state]}
                  </Badge>
                ))}
              </div>
            )}
            <ul className="space-y-2">
              {tasks.map((task, i) => (
                <li key={task.id} className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`Task ${i + 1} title`}
                    // Its own line on a phone: in the row, the date and badge would squeeze it to nothing.
                    className="w-full min-w-0 sm:w-auto sm:flex-1"
                    required
                    maxLength={512}
                    value={task.title}
                    onChange={(event) => updateTask(task.id, { title: event.currentTarget.value })}
                  />
                  <Input
                    aria-label={`Task ${i + 1} due date`}
                    className="w-40"
                    type="date"
                    required
                    disabled={!milestoneDate}
                    min={ISO_DATE_MIN}
                    max={ISO_DATE_MAX}
                    value={milestoneDate ? draftTaskDate(milestoneDate, task) : ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (!value || !milestoneDate) return;
                      const offset = draftTaskOffset(milestoneDate, value);
                      if (
                        Math.abs(offset) <= PROJECT_TEMPLATE_MAX_OFFSET_DAYS &&
                        !draftDateIssue(milestoneDate, [{ ...task, daysFromStart: offset }])
                      )
                        updateTask(task.id, { daysFromStart: offset });
                    }}
                  />
                  {task.module && (
                    <Badge variant="outline" title="Links to this module">
                      {moduleDefinitions[task.module].name}
                    </Badge>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove task ${i + 1}`}
                    disabled={tasks.length === 1}
                    onClick={() => setTasks((rows) => rows.filter((row) => row.id !== task.id))}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={tasks.length >= PROJECT_TEMPLATE_MAX_TASKS}
              onClick={() =>
                setTasks((rows) => [
                  ...rows,
                  { id: newId(), title: "", daysFromStart: rows.at(-1)?.daysFromStart ?? 0, module: null },
                ])
              }
            >
              <Plus /> Add task
            </Button>
          </section>
          <Button disabled={pending || !milestoneDate || !tasks.length || !!dateIssue} type="submit">
            {pending ? "Creating…" : "Create project"}
          </Button>
        </FieldGroup>
      </form>
    </DialogContent>
  );
}
