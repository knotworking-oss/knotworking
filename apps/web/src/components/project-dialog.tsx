"use client";

import {
  newId,
  projectHealthLabels,
  projectHealths,
  projectStatusLabels,
  projectStatuses,
  type ProjectHealth,
  type ProjectStatus,
  type ProjectUpdateInput,
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
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import { PropertyMenu, type PropertyOption } from "@knotworking/ui/components/property-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Textarea } from "@knotworking/ui/components/textarea";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { UserRound, UsersRound } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useWorkspace, type ProjectRow } from "@/lib/workspace-store";

const NONE = "__none__";

interface Draft {
  name: string;
  description: string;
  status: ProjectStatus;
  health: ProjectHealth | null;
  leadId: string | null;
  startDate: string;
  targetDate: string;
  teamIds: string[];
}

/**
 * Create a project, or edit `project`. The change is applied optimistically by
 * the workspace store, so the dialog closes straight away; a failure rolls the
 * change back with a toast.
 */
export function ProjectDialog({
  project,
  onClose,
  onSaved,
}: {
  project?: ProjectRow;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { idx, viewer, createProject, updateProject } = useWorkspace();
  const formId = useId();
  const currentTeamIds = project
    ? idx.boot.projectTeams.filter((l) => l.projectId === project.id).map((l) => l.teamId)
    : [];
  const [draft, setDraft] = useState<Draft>(() => ({
    name: project?.name ?? "",
    description: project?.description ?? "",
    status: project?.status ?? "planned",
    health: project?.health ?? null,
    leadId: project ? project.leadId : viewer.id,
    startDate: project?.startDate ?? "",
    targetDate: project?.targetDate ?? "",
    teamIds: currentTeamIds,
  }));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const datesInvalid = Boolean(draft.startDate && draft.targetDate && draft.targetDate < draft.startDate);
  const canSave = draft.name.trim().length > 0 && !datesInvalid;

  const users = [...idx.boot.users].sort((a, b) =>
    a.id === viewer.id ? -1 : b.id === viewer.id ? 1 : a.name.localeCompare(b.name),
  );
  const leadOptions: PropertyOption[] = [
    { value: NONE, label: "No lead", icon: <UserRound className="text-muted-foreground" /> },
    ...users.map((u) => ({
      value: u.id,
      label: u.id === viewer.id ? `${u.name} (you)` : u.name,
      keywords: [u.email].filter(Boolean),
      icon: <UserAvatar name={u.name} src={u.avatarUrl} className="size-5" />,
    })),
  ];
  const teamOptions: PropertyOption[] = idx.boot.teams.map((t) => ({
    value: t.id,
    label: t.name,
    keywords: [t.key],
    icon: <span className="w-4 text-center">{t.icon}</span>,
  }));
  const lead = draft.leadId ? idx.users.get(draft.leadId) : undefined;
  const teamNames = draft.teamIds.map((id) => idx.teams.get(id)?.name).filter(Boolean);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSave) return;
    const name = draft.name.trim();
    const description = draft.description.trim() || null;
    const startDate = draft.startDate || null;
    const targetDate = draft.targetDate || null;

    if (!project) {
      const id = newId();
      onClose();
      const ok = await createProject({
        id,
        name,
        description,
        status: draft.status,
        health: draft.health,
        leadId: draft.leadId,
        startDate,
        targetDate,
        teamIds: draft.teamIds,
      });
      if (ok) {
        toast.success("Project created", { description: name });
        onSaved?.(id);
      }
      return;
    }

    // Only send what changed.
    const patch: ProjectUpdateInput = {};
    if (name !== project.name) patch.name = name;
    if (description !== project.description) patch.description = description;
    if (draft.status !== project.status) patch.status = draft.status;
    if (draft.health !== project.health) patch.health = draft.health;
    if (draft.leadId !== project.leadId) patch.leadId = draft.leadId;
    if (startDate !== project.startDate) patch.startDate = startDate;
    if (targetDate !== project.targetDate) patch.targetDate = targetDate;
    const sameTeams =
      draft.teamIds.length === currentTeamIds.length &&
      draft.teamIds.every((id) => currentTeamIds.includes(id));
    if (!sameTeams) patch.teamIds = draft.teamIds;
    onClose();
    if (Object.keys(patch).length === 0) return;
    if (await updateProject(project.id, patch)) {
      toast.success("Project updated", { description: name });
      onSaved?.(project.id);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>{project ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>
            {project
              ? "Changes are visible to everyone in the workspace."
              : "Group tasks from one or more teams under a shared goal."}
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-name`}>Name</Label>
            <Input
              id={`${formId}-name`}
              autoFocus
              required
              maxLength={256}
              placeholder="e.g. Winter product launch"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-description`}>Description</Label>
            <Textarea
              id={`${formId}-description`}
              maxLength={2000}
              rows={3}
              placeholder="What is this project about?"
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-status`}>Status</Label>
              <Select value={draft.status} onValueChange={(v) => set("status", v as ProjectStatus)}>
                <SelectTrigger id={`${formId}-status`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projectStatuses.map((s) => (
                    <SelectItem key={s} value={s}>
                      {projectStatusLabels[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-health`}>Health</Label>
              <Select
                value={draft.health ?? NONE}
                onValueChange={(v) => set("health", v === NONE ? null : (v as ProjectHealth))}
              >
                <SelectTrigger id={`${formId}-health`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not set</SelectItem>
                  {projectHealths.map((h) => (
                    <SelectItem key={h} value={h}>
                      {projectHealthLabels[h]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Lead</Label>
              <PropertyMenu
                options={leadOptions}
                value={draft.leadId ?? NONE}
                onValueChange={(v) => set("leadId", v === NONE ? null : v)}
                placeholder="Choose a lead…"
              >
                <Button type="button" variant="outline" className="justify-start font-normal">
                  {lead ? (
                    <UserAvatar name={lead.name} src={lead.avatarUrl} className="size-5" />
                  ) : (
                    <UserRound className="text-muted-foreground" />
                  )}
                  <span className="truncate">{lead?.name ?? "No lead"}</span>
                </Button>
              </PropertyMenu>
            </div>
            <div className="grid gap-1.5">
              <Label>Teams</Label>
              <PropertyMenu
                multiple
                options={teamOptions}
                value={draft.teamIds}
                onValueChange={(v) => set("teamIds", v)}
                placeholder="Link teams…"
                emptyText="No teams"
              >
                <Button type="button" variant="outline" className="justify-start font-normal">
                  <UsersRound className="text-muted-foreground" />
                  <span className="truncate">{teamNames.length ? teamNames.join(", ") : "No teams"}</span>
                </Button>
              </PropertyMenu>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-start`}>Start date</Label>
              <Input
                id={`${formId}-start`}
                type="date"
                value={draft.startDate}
                onChange={(e) => set("startDate", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-target`}>Target date</Label>
              <Input
                id={`${formId}-target`}
                type="date"
                value={draft.targetDate}
                min={draft.startDate || undefined}
                aria-invalid={datesInvalid || undefined}
                aria-describedby={datesInvalid ? `${formId}-dates-error` : undefined}
                onChange={(e) => set("targetDate", e.target.value)}
              />
              {datesInvalid && (
                <p id={`${formId}-dates-error`} role="alert" className="text-sm text-destructive">
                  The target date can&apos;t be before the start date.
                </p>
              )}
            </div>
          </div>
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={!canSave}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
