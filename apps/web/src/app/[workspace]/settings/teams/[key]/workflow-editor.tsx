"use client";

import { sortKeyForMove, workflowStateTypes, type WorkflowStateType } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { WorkflowState } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { stateTypeInfo } from "@/lib/workflow";

interface Props {
  slug: string;
  teamId: string;
  /** In workflow order. */
  states: WorkflowState[];
  /** Live tasks per state id. */
  taskCounts: Record<string, number>;
  canManage: boolean;
}

export function WorkflowEditor({ slug, teamId, states, taskCounts, canManage }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<WorkflowState | "new" | null>(null);
  const [deleting, setDeleting] = useState<WorkflowState | null>(null);
  const api = () => browserApi().v1.workspaces[":slug"];

  /** Moves a state one place up or down by giving it a key between its new neighbours. */
  async function move(index: number, by: -1 | 1) {
    const state = states[index]!;
    const rest = states.filter((s) => s.id !== state.id);
    const at = index + by;
    const sortOrder = sortKeyForMove(rest[at - 1]?.sortOrder, rest[at]?.sortOrder);
    try {
      await unwrap(api().states[":id"].$patch({ param: { slug, id: state.id }, json: { sortOrder } }));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workflow</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="divide-y rounded-lg border">
          {states.map((s, i) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2">
              <StatusIcon type={s.type} progress={0.5} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{s.name}</span>
                {s.description && (
                  <span className="truncate text-xs text-muted-foreground">{s.description}</span>
                )}
              </div>
              <Badge variant="outline" className="text-muted-foreground">
                {stateTypeInfo[s.type].label}
              </Badge>
              <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
                {taskCounts[s.id] ?? 0} {(taskCounts[s.id] ?? 0) === 1 ? "task" : "tasks"}
              </span>
              {canManage && (
                <div className="flex items-center">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${s.name} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${s.name} down`}
                    disabled={i === states.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => setEditing(s)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${s.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleting(s)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {canManage && (
          <div>
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <Plus /> Add state
            </Button>
          </div>
        )}
      </CardContent>

      <StateDialog
        slug={slug}
        teamId={teamId}
        state={editing === "new" ? null : editing}
        open={editing !== null}
        taskCount={editing && editing !== "new" ? (taskCounts[editing.id] ?? 0) : 0}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <DeleteStateDialog
        slug={slug}
        state={deleting}
        others={states.filter((s) => s.id !== deleting?.id)}
        taskCount={deleting ? (taskCounts[deleting.id] ?? 0) : 0}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </Card>
  );
}

function StateDialog({
  slug,
  teamId,
  state,
  open,
  taskCount,
  onOpenChange,
}: {
  slug: string;
  teamId: string;
  state: WorkflowState | null;
  open: boolean;
  taskCount: number;
  onOpenChange: (open: boolean) => void;
}) {
  // Remount per state so the form starts from its values.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && (
          <StateForm
            key={state?.id ?? "new"}
            slug={slug}
            teamId={teamId}
            state={state}
            taskCount={taskCount}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StateForm({
  slug,
  teamId,
  state,
  taskCount,
  onDone,
}: {
  slug: string;
  teamId: string;
  state: WorkflowState | null;
  taskCount: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(state?.name ?? "");
  const [type, setType] = useState<WorkflowStateType>(state?.type ?? "started");
  const [description, setDescription] = useState(state?.description ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const api = browserApi().v1.workspaces[":slug"];
    const body = { name, type, description: description.trim() || null };
    try {
      if (state) await unwrap(api.states[":id"].$patch({ param: { slug, id: state.id }, json: body }));
      else await unwrap(api.teams[":id"].states.$post({ param: { slug, id: teamId }, json: body }));
      toast.success(state ? "State updated" : `${name} added`);
      router.refresh();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const retyped = state && state.type !== type && taskCount > 0;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>{state ? `Edit ${state.name}` : "Add workflow state"}</DialogTitle>
        <DialogDescription>
          {state
            ? "Rename it or move it to another category."
            : "New states are placed with others of their category."}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="state-name">Name</FieldLabel>
          <Input
            id="state-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="In review"
            required
            maxLength={80}
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel>Category</FieldLabel>
          <Select value={type} onValueChange={(v) => setType(v as WorkflowStateType)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {workflowStateTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  <StatusIcon type={t} /> {stateTypeInfo[t].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            {stateTypeInfo[type].help}.
            {retyped &&
              ` ${taskCount} ${taskCount === 1 ? "task" : "tasks"} in this state will be updated to match.`}
          </FieldDescription>
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="state-description">Description (optional)</FieldLabel>
          <Input
            id="state-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            aria-invalid={!!error}
          />
          {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
        </Field>
      </FieldGroup>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline" type="button">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending && <Spinner />} {state ? "Save" : "Add state"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteStateDialog({
  slug,
  state,
  others,
  taskCount,
  onOpenChange,
}: {
  slug: string;
  state: WorkflowState | null;
  others: WorkflowState[];
  taskCount: number;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<string>("");
  const [pending, setPending] = useState(false);
  // Default to a state of the same category, else the first one.
  const fallback = (others.find((s) => s.type === state?.type) ?? others[0])?.id ?? "";
  const moveTo = target && others.some((s) => s.id === target) ? target : fallback;

  async function remove() {
    if (!state) return;
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].states[":id"].$delete({
          param: { slug, id: state.id },
          query: { moveTasksTo: taskCount > 0 ? moveTo : undefined },
        }),
      );
      toast.success(`${state.name} deleted`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {state?.name}?</DialogTitle>
          <DialogDescription>
            {taskCount > 0
              ? `${taskCount} ${taskCount === 1 ? "task is" : "tasks are"} still in this state. Choose where they should go.`
              : "No tasks are in this state."}
          </DialogDescription>
        </DialogHeader>
        {taskCount > 0 && (
          <Field>
            <FieldLabel>Move tasks to</FieldLabel>
            <Select value={moveTo} onValueChange={setTarget}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {others.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <StatusIcon type={s.type} /> {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" disabled={pending || (taskCount > 0 && !moveTo)} onClick={remove}>
            {pending && <Spinner />} {taskCount > 0 ? "Move tasks and delete" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
