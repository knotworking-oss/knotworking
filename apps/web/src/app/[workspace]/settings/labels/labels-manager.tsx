"use client";

import type { TagColorName } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { ColorPicker } from "@knotworking/ui/components/color-picker";
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
import { LabelBadge } from "@knotworking/ui/components/label-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

interface LabelRow {
  id: string;
  name: string;
  color: TagColorName;
  teamId: string | null;
  taskCount: number;
}

interface Props {
  slug: string;
  canManage: boolean;
  labels: LabelRow[];
  teams: { id: string; name: string; icon: string | null }[];
}

const WORKSPACE = "__workspace__";

export function LabelsManager({ slug, canManage, labels, teams }: Props) {
  const [editing, setEditing] = useState<LabelRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<LabelRow | null>(null);
  const scopeName = (l: LabelRow) =>
    l.teamId ? (teams.find((t) => t.id === l.teamId)?.name ?? "Team") : "Everyone";

  return (
    <div className="workspace-content flex flex-col gap-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Labels</h2>
          {!canManage && (
            <p className="text-sm text-muted-foreground">Only owners and admins can change labels.</p>
          )}
        </div>
        {canManage && (
          <Button onClick={() => setEditing("new")}>
            <Plus /> New label
          </Button>
        )}
      </div>

      {labels.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No labels yet.
        </p>
      ) : (
        <Card className="gap-0 py-0">
          {labels.map((l) => (
            <div key={l.id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
              <div className="flex-1">
                <LabelBadge color={l.color}>{l.name}</LabelBadge>
              </div>
              <span className="text-xs text-muted-foreground">{scopeName(l)}</span>
              <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
                {l.taskCount} {l.taskCount === 1 ? "task" : "tasks"}
              </span>
              {canManage && (
                <div className="flex items-center">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${l.name}`}
                    onClick={() => setEditing(l)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${l.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleting(l)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          {editing !== null && (
            <LabelForm
              key={editing === "new" ? "new" : editing.id}
              slug={slug}
              label={editing === "new" ? null : editing}
              teams={teams}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <DeleteLabelDialog slug={slug} label={deleting} onOpenChange={(o) => !o && setDeleting(null)} />
    </div>
  );
}

function LabelForm({
  slug,
  label,
  teams,
  onDone,
}: {
  slug: string;
  label: LabelRow | null;
  teams: Props["teams"];
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState<TagColorName>(label?.color ?? "gray");
  const [scope, setScope] = useState(label?.teamId ?? WORKSPACE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const api = browserApi().v1.workspaces[":slug"].labels;
    try {
      if (label) await unwrap(api[":id"].$patch({ param: { slug, id: label.id }, json: { name, color } }));
      else {
        await unwrap(
          api.$post({ param: { slug }, json: { name, color, teamId: scope === WORKSPACE ? null : scope } }),
        );
      }
      toast.success(label ? "Label updated" : `${name} created`);
      router.refresh();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>{label ? "Edit label" : "New label"}</DialogTitle>
        <DialogDescription>
          {label ? "Changes show up on every task that has this label." : "Labels can be added to any task."}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="label-name">Name</FieldLabel>
          <Input
            id="label-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={64}
            autoFocus
            aria-invalid={!!error}
          />
          {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel>Color</FieldLabel>
          <ColorPicker value={color} onValueChange={setColor} />
        </Field>
        {!label && (
          <Field>
            <FieldLabel>Available to</FieldLabel>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={WORKSPACE}>Everyone (workspace-wide)</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.icon} {t.name} only
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>This can&apos;t be changed later.</FieldDescription>
          </Field>
        )}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          Preview <LabelBadge color={color}>{name.trim() || "Label"}</LabelBadge>
        </div>
      </FieldGroup>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline" type="button">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending && <Spinner />} {label ? "Save" : "Create label"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteLabelDialog({
  slug,
  label,
  onOpenChange,
}: {
  slug: string;
  label: LabelRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function remove() {
    if (!label) return;
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].labels[":id"].$delete({ param: { slug, id: label.id } }),
      );
      toast.success(`${label.name} deleted`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={label !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {label?.name}?</DialogTitle>
          <DialogDescription>
            {label && label.taskCount > 0
              ? `It will be removed from ${label.taskCount} ${label.taskCount === 1 ? "task" : "tasks"}. The tasks themselves stay.`
              : "No tasks use this label."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={remove}>
            {pending && <Spinner />} Delete label
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
