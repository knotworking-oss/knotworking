"use client";

import { newId, taskDatesInOrder, textToDoc, type Priority } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@knotworking/ui/components/dialog";
import { Kbd } from "@knotworking/ui/components/kbd";
import { Label } from "@knotworking/ui/components/label";
import { PropertyMenu } from "@knotworking/ui/components/property-menu";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Switch } from "@knotworking/ui/components/switch";
import { ChevronRight } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { isOverlayOpen, isTypingTarget } from "@/lib/keyboard";
import { useWorkspace } from "@/lib/workspace-store";
import {
  AssigneeChip,
  AssigneePicker,
  DueDateChip,
  DueDatePicker,
  LabelsChip,
  LabelsPicker,
  PriorityChip,
  PriorityPicker,
  ProjectChip,
  ProjectPicker,
  StartDateChip,
  StartDatePicker,
  StatusChip,
  StatusPicker,
} from "./task-pickers";

/** Values a "new task" entry point can preset (e.g. the column it was opened from). */
export interface NewTaskDefaults {
  teamId?: string;
  stateId?: string;
  /** State category, resolved to the team's first state of that type (cross-team views). */
  stateType?: string;
  assigneeId?: string | null;
  projectId?: string | null;
  sectionId?: string | null;
  parentId?: string | null;
  priority?: Priority;
}

interface Draft {
  teamId: string;
  stateId: string;
  priority: Priority;
  assigneeId: string | null;
  labelIds: string[];
  projectId: string | null;
  sectionId: string | null;
  startDate: string | null;
  dueDate: string | null;
  parentId: string | null;
}

const Ctx = createContext<(defaults?: NewTaskDefaults) => void>(() => {});

/** Opens the new-task dialog, optionally with preset values. */
export const useNewTask = () => useContext(Ctx);

/** Mounts the new-task dialog and the `C` shortcut for the workspace. */
export function NewTaskProvider({ children }: { children: ReactNode }) {
  const { idx, viewer, canEditTasks: canEdit } = useWorkspace();
  const [defaults, setDefaults] = useState<NewTaskDefaults | null>(null);
  const lastTeam = useRef<string | null>(null);
  const pathname = usePathname();

  const open = useCallback(
    (d: NewTaskDefaults = {}) => {
      if (!canEdit) return;
      setDefaults(d);
    },
    [canEdit],
  );

  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      if (isOverlayOpen()) return;
      e.preventDefault();
      setDefaults({});
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canEdit]);

  const myTeams = new Set(idx.boot.teamMembers.filter((m) => m.userId === viewer.id).map((m) => m.teamId));
  // The team being viewed (team page, or a task's page) comes first.
  const routeKey = /^\/[^/]+\/(?:team\/([^/]+)|task\/([A-Za-z][A-Za-z0-9]*)-\d+)/.exec(pathname);
  const routeTeam = routeKey
    ? idx.teamsByKey.get((routeKey[1] ?? routeKey[2])!.toUpperCase())?.id
    : undefined;
  const defaultTeam =
    routeTeam ??
    (lastTeam.current && idx.teams.has(lastTeam.current) ? lastTeam.current : undefined) ??
    idx.boot.teams.find((t) => myTeams.has(t.id))?.id ??
    idx.boot.teams[0]?.id;

  return (
    <Ctx.Provider value={open}>
      {children}
      {defaults && defaultTeam && (
        <NewTaskDialog
          defaults={defaults}
          fallbackTeamId={defaultTeam}
          onTeamUsed={(id) => (lastTeam.current = id)}
          onClose={() => setDefaults(null)}
        />
      )}
    </Ctx.Provider>
  );
}

function NewTaskDialog({
  defaults,
  fallbackTeamId,
  onTeamUsed,
  onClose,
}: {
  defaults: NewTaskDefaults;
  fallbackTeamId: string;
  onTeamUsed: (teamId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { idx, slug, createTask } = useWorkspace();
  const parent = defaults.parentId ? idx.boot.tasks.find((i) => i.id === defaults.parentId) : undefined;

  const initialStateFor = useCallback(
    (teamId: string, d: NewTaskDefaults = {}) => {
      const states = idx.boot.workflowStates.filter((s) => s.teamId === teamId);
      return (
        states.find((s) => s.id === d.stateId)?.id ??
        states.find((s) => s.type === d.stateType)?.id ??
        states.find((s) => s.type === "unstarted")?.id ??
        states[0]?.id ??
        ""
      );
    },
    [idx.boot.workflowStates],
  );

  const [draft, setDraft] = useState<Draft>(() => {
    const teamId =
      parent?.teamId ??
      (defaults.teamId && idx.teams.has(defaults.teamId) ? defaults.teamId : fallbackTeamId);
    return {
      teamId,
      stateId: initialStateFor(teamId, defaults),
      priority: defaults.priority ?? 0,
      assigneeId: defaults.assigneeId ?? null,
      labelIds: [],
      projectId: defaults.projectId ?? parent?.projectId ?? null,
      sectionId: defaults.sectionId ?? null,
      startDate: null,
      dueDate: null,
      parentId: parent?.id ?? null,
    };
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [createMore, setCreateMore] = useState(false);
  const [pending, setPending] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const team = idx.teams.get(draft.teamId);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!title.trim() || pending) return;
    if (!taskDatesInOrder(draft)) {
      toast.error("The start date can't be after the due date.");
      return;
    }
    setPending(true);
    const created = await createTask({
      id: newId(),
      title: title.trim(),
      ...(description.trim() ? { description: textToDoc(description) } : {}),
      ...draft,
      stateId: draft.stateId || undefined,
    });
    setPending(false);
    if (!created) return;
    onTeamUsed(draft.teamId);
    toast.success("Task created", {
      description: created.title,
      action: { label: "View", onClick: () => router.push(`/${slug}/task/${created.id}`) },
    });
    if (createMore) {
      setTitle("");
      setDescription("");
      titleRef.current?.focus();
    } else {
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-2xl"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      >
        <form onSubmit={submit} className="flex flex-col">
          <div className="flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
            <PropertyMenu
              options={idx.boot.teams.map((t) => ({
                value: t.id,
                label: t.name,
                keywords: [t.key],
                icon: <span className="w-4 text-center">{t.icon}</span>,
              }))}
              value={draft.teamId}
              onValueChange={(teamId) =>
                setDraft((d) => ({
                  ...d,
                  teamId,
                  // Workflow states belong to a team; keep the category when switching.
                  stateId: initialStateFor(teamId, { stateType: idx.states.get(d.stateId)?.type }),
                  parentId: null,
                }))
              }
              placeholder="Choose team…"
            >
              <Button type="button" variant="outline" size="xs" disabled={Boolean(parent)}>
                <span>{team?.icon}</span> {team?.key}
              </Button>
            </PropertyMenu>
            <ChevronRight className="size-3.5" />
            <DialogTitle className="text-sm font-normal text-foreground">
              {parent ? `New subtask of “${parent.title}”` : "New task"}
            </DialogTitle>
            <DialogDescription className="sr-only">Create a task. Press Cmd+Enter to save.</DialogDescription>
          </div>

          <div className="flex flex-col gap-1 px-4 pt-3">
            <input
              ref={titleRef}
              autoFocus
              aria-label="Task title"
              placeholder="Task title"
              maxLength={512}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/70"
            />
            <textarea
              aria-label="Description"
              placeholder="Add description…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="field-sizing-content max-h-[40vh] min-h-24 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 [&_button]:border-solid [&_button]:border-border">
            <StatusPicker teamId={draft.teamId} value={draft.stateId} onChange={(v) => set("stateId", v)}>
              <StatusChip stateId={draft.stateId} />
            </StatusPicker>
            <PriorityPicker value={draft.priority} onChange={(v) => set("priority", v)}>
              <PriorityChip priority={draft.priority} />
            </PriorityPicker>
            <AssigneePicker value={draft.assigneeId} onChange={(v) => set("assigneeId", v)}>
              <AssigneeChip userId={draft.assigneeId} />
            </AssigneePicker>
            <LabelsPicker value={draft.labelIds} onChange={(v) => set("labelIds", v)}>
              <LabelsChip labelIds={draft.labelIds} />
            </LabelsPicker>
            <ProjectPicker
              value={draft.projectId}
              onChange={(projectId) => setDraft((current) => ({ ...current, projectId, sectionId: null }))}
            >
              <ProjectChip projectId={draft.projectId} />
            </ProjectPicker>
            {draft.projectId && (
              <select
                className="h-8 max-w-40 rounded-md border bg-background px-2 text-xs"
                aria-label="Project section"
                value={draft.sectionId ?? ""}
                onChange={(event) => set("sectionId", event.target.value || null)}
              >
                <option value="">No section</option>
                {[...idx.sections.values()]
                  .filter((section) => section.projectId === draft.projectId)
                  .map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                    </option>
                  ))}
              </select>
            )}
            <StartDatePicker
              value={draft.startDate}
              max={draft.dueDate}
              onChange={(v) => set("startDate", v)}
            >
              <StartDateChip startDate={draft.startDate} />
            </StartDatePicker>
            <DueDatePicker value={draft.dueDate} min={draft.startDate} onChange={(v) => set("dueDate", v)}>
              <DueDateChip dueDate={draft.dueDate} />
            </DueDatePicker>
          </div>

          <div className="flex items-center justify-end gap-3 border-t px-4 py-3">
            <Label className="text-sm font-normal text-muted-foreground">
              <Switch checked={createMore} onCheckedChange={setCreateMore} size="sm" />
              Create more
            </Label>
            <Button type="submit" size="sm" disabled={!title.trim() || pending}>
              {pending && <Spinner />} Create task{" "}
              <Kbd className="hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">⌘↵</Kbd>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
