"use client";

import type { TaskViewScope, TaskViewSpec } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@knotworking/ui/components/dialog";
import { Input } from "@knotworking/ui/components/input";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { SavedTaskView } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function SaveTaskViewDialog({
  initial,
  teamId,
  spec,
  disabled,
}: {
  initial?: SavedTaskView;
  teamId?: string;
  spec: TaskViewSpec;
  disabled?: boolean;
}) {
  const { slug, can, canEditTasks, viewer } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [scope, setScope] = useState<TaskViewScope>("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mayEdit = canEditTasks && (!initial || initial.ownerId === viewer.id || can("tasks", "manage"));
  if (!mayEdit) return null;

  const api = () => browserApi().v1.workspaces[":slug"].tasks.views;
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const view = initial
        ? await unwrap(api()[":id"].$patch({ param: { slug, id: initial.id }, json: { name, spec } }))
        : await unwrap(
            api().$post({
              param: { slug },
              json: { name, spec, scope, teamId: scope === "team" ? teamId : null },
            }),
          );
      setOpen(false);
      router.push(`/${slug}/my-tasks/views/${view.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial || !window.confirm(`Delete the view “${initial.name}”?`)) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api()[":id"].$delete({ param: { slug, id: initial.id } });
      if (!response.ok) await unwrap(Promise.resolve(response));
      setOpen(false);
      router.push(`/${slug}/my-tasks/views`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(initial?.name ?? "");
          setScope("personal");
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          {initial ? "Edit saved view" : "Save view"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit saved view" : "Save task view"}</DialogTitle>
          <DialogDescription>Save the current filters, layout, and sort order.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm">
            Name
            <Input
              autoFocus
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {!initial && (
            <label className="flex flex-col gap-2 text-sm">
              Visibility
              <select
                value={scope}
                className="h-9 rounded-md border bg-background px-2"
                onChange={(event) => setScope(event.target.value as TaskViewScope)}
              >
                <option value="personal">Personal</option>
                {teamId && <option value="team">Shared on this team</option>}
                {can("tasks", "manage") && <option value="workspace">Shared across the workspace</option>}
              </select>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {initial && (
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
                Delete view
              </Button>
            )}
            <Button type="submit" disabled={!name.trim() || busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
