"use client";

import type { TagColorName } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { ColorPicker } from "@knotworking/ui/components/color-picker";
import { ColorDot } from "@knotworking/ui/components/label-badge";
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
import { Spinner } from "@knotworking/ui/components/spinner";
import { ArchiveRestore, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

interface TeamRow {
  id: string;
  key: string;
  name: string;
  icon: string | null;
  color: TagColorName;
  description: string | null;
  memberCount: number;
  stateCount: number;
}

interface Props {
  slug: string;
  canManage: boolean;
  teams: TeamRow[];
  archived: { id: string; key: string; name: string; icon: string | null }[];
}

/** "Customer Success" → "CUS" */
const suggestKey = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 3);

export function TeamsManager({ slug, canManage, teams, archived }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  async function restore(id: string, name: string) {
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].teams[":id"].$patch({
          param: { slug, id },
          json: { archived: false },
        }),
      );
      toast.success(`${name} is back`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Teams</h2>
          {!canManage && (
            <p className="text-sm text-muted-foreground">Only owners and admins can change teams.</p>
          )}
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus /> New team
          </Button>
        )}
      </div>

      <Card className="gap-0 py-0">
        {teams.map((t) => (
          <Link
            key={t.id}
            href={`/${slug}/settings/teams/${t.key}`}
            className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/50"
          >
            <span className="flex size-8 items-center justify-center rounded-lg border bg-background text-base">
              {t.icon ?? <ColorDot color={t.color} className="size-3" />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">
                {t.name} <span className="font-mono text-xs font-normal text-muted-foreground">{t.key}</span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {t.memberCount} {t.memberCount === 1 ? "member" : "members"} · {t.stateCount} workflow states
                {t.description ? ` · ${t.description}` : ""}
              </span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
        {teams.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No teams yet.</p>}
      </Card>

      {archived.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Archived teams</h3>
          <Card className="gap-0 py-0">
            {archived.map((t) => (
              <div key={t.id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
                <span className="w-6 text-center text-muted-foreground">{t.icon ?? "•"}</span>
                <span className="flex-1 truncate text-muted-foreground">
                  {t.name} <span className="font-mono text-xs">{t.key}</span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => restore(t.id, t.name)}>
                  <ArchiveRestore /> Restore
                </Button>
              </div>
            ))}
          </Card>
        </section>
      )}

      <NewTeamDialog slug={slug} open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewTeamDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState<TagColorName>("gray");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const team = await unwrap(
        browserApi().v1.workspaces[":slug"].teams.$post({
          param: { slug },
          json: { name, key, color, icon: icon.trim() || null },
        }),
      );
      toast.success(`${team.name} created`);
      onOpenChange(false);
      router.push(`/${slug}/settings/teams/${team.key}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New team</DialogTitle>
            <DialogDescription>
              Starts with the standard workflow (Backlog, Todo, In Progress, In Review, Done, Canceled). You
              can change it afterwards.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="team-name">Name</FieldLabel>
              <Input
                id="team-name"
                value={name}
                placeholder="Customer success"
                required
                maxLength={80}
                autoFocus
                onChange={(e) => {
                  setName(e.target.value);
                  if (!keyEdited) setKey(suggestKey(e.target.value));
                }}
              />
            </Field>
            <div className="grid grid-cols-[1fr_auto] gap-4">
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="team-key">Key</FieldLabel>
                <Input
                  id="team-key"
                  value={key}
                  className="font-mono uppercase"
                  placeholder="CUS"
                  required
                  maxLength={10}
                  aria-invalid={!!error}
                  onChange={(e) => {
                    setKey(e.target.value.toUpperCase());
                    setKeyEdited(true);
                  }}
                />
                <FieldDescription className={error ? "text-destructive" : undefined}>
                  {error ?? "Used in the team's web address."}
                </FieldDescription>
              </Field>
              <Field className="w-24">
                <FieldLabel htmlFor="team-icon">Icon</FieldLabel>
                <Input
                  id="team-icon"
                  value={icon}
                  placeholder="🎧"
                  maxLength={8}
                  onChange={(e) => setIcon(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Color</FieldLabel>
              <ColorPicker value={color} onValueChange={setColor} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !name.trim() || key.length < 2}>
              {pending && <Spinner />} Create team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
