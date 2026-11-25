"use client";

import { newId, projectTemplateIds, projectTemplates } from "@knotworking/core";
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
import { ClipboardList } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

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

function ProjectTemplateForm({ commandId, onClose }: { commandId: string; onClose: () => void }) {
  const { slug, viewer, idx, sync } = useWorkspace();
  const router = useRouter();
  const [templateId, setTemplateId] = useState<(typeof projectTemplateIds)[number]>("employee_onboarding");
  const [pending, setPending] = useState(false);
  const template = projectTemplates[templateId];

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
            startDate: String(data.get("startDate")),
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
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Create a project from a template</DialogTitle>
        <DialogDescription>
          Tasks start assigned to the project lead. You can reassign them after creation.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="project-template">Template</FieldLabel>
            <select
              id="project-template"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={templateId}
              onChange={(event) => setTemplateId(event.currentTarget.value as typeof templateId)}
            >
              {projectTemplateIds.map((id) => (
                <option key={id} value={id}>
                  {projectTemplates[id].label}
                </option>
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
              <select
                id="template-team"
                name="team"
                required
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
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
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
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
            <FieldLabel htmlFor="template-date">{template.dateLabel}</FieldLabel>
            <Input id="template-date" type="date" name="startDate" required />
          </Field>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">Preview {template.tasks.length} tasks</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {template.tasks.map((task) => (
                <li key={task.title}>{task.title}</li>
              ))}
            </ul>
          </details>
          <Button disabled={pending} type="submit">
            {pending ? "Creating…" : "Create project"}
          </Button>
        </FieldGroup>
      </form>
    </DialogContent>
  );
}
