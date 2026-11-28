"use client";

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
import { Check, Diamond, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { ProjectMilestone } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatShortDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";

export function ProjectMilestones({ projectId }: { projectId: string }) {
  const { idx, canEditTasks } = useWorkspace();
  const milestones = (idx.boot.projectMilestones ?? []).filter((row) => row.projectId === projectId);
  if (!canEditTasks && !milestones.length) return null;
  return (
    <section className="border-b px-6 py-4" aria-label="Milestones">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Milestones</h2>
        {canEditTasks && <MilestoneForm projectId={projectId} />}
      </div>
      {milestones.length > 0 && (
        <ul className="divide-y">
          {milestones.map((row) => {
            const progress = idx.boot.closedWindow?.milestoneCounts?.[row.id] ?? { completed: 0, total: 0 };
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                {row.completedAt ? <Check className="size-4" /> : <Diamond className="size-4" />}
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.targetDate && (
                  <time dateTime={row.targetDate} className="text-xs text-muted-foreground">
                    {formatShortDate(row.targetDate)}
                  </time>
                )}
                <span className="text-xs text-muted-foreground">
                  {progress.completed}/{progress.total} tasks
                </span>
                {canEditTasks && <MilestoneForm projectId={projectId} row={row} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function MilestoneForm({ projectId, row }: { projectId: string; row?: ProjectMilestone }) {
  const { slug, sync } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [completed, setCompleted] = useState(false);
  const [saving, setSaving] = useState(false);
  const api = () => browserApi().v1.workspaces[":slug"].projects[":id"].milestones;
  const project = { slug, id: projectId };

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const json = { name, targetDate: date || null };
    try {
      if (row)
        await unwrap(
          api()[":milestoneId"].$patch({
            param: { ...project, milestoneId: row.id },
            json: { ...json, completed },
          }),
        );
      else await unwrap(api().$post({ param: project, json }));
      setOpen(false);
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!row || !window.confirm(`Delete milestone “${row.name}”?`)) return;
    setSaving(true);
    try {
      const response = await api()[":milestoneId"].$delete({ param: { ...project, milestoneId: row.id } });
      if (!response.ok) await unwrap(Promise.resolve(response));
      setOpen(false);
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(row?.name ?? "");
          setDate(row?.targetDate ?? "");
          setCompleted(Boolean(row?.completedAt));
        }
      }}
    >
      <DialogTrigger asChild>
        {row ? (
          <Button type="button" variant="ghost" size="sm" aria-label={`Edit ${row.name}`}>
            Edit
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm">
            <Plus /> Add milestone
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{row ? "Edit milestone" : "Add milestone"}</DialogTitle>
          <DialogDescription>Track a deliverable and its target date for this project.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm">
            Name
            <Input required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            Target date
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          {row && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />{" "}
              Completed
            </label>
          )}
          <DialogFooter>
            {row && (
              <Button variant="destructive" type="button" disabled={saving} onClick={() => void remove()}>
                Delete
              </Button>
            )}
            <Button type="submit" disabled={!name.trim() || saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
