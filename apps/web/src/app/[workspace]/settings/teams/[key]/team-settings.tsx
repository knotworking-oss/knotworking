"use client";

import { teamFeatures, type TagColorName, type TeamFeature } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@knotworking/ui/components/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { UserAvatar } from "@knotworking/ui/components/user-avatar";
import { Archive, UserMinus, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Team, WorkflowState } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { WorkflowEditor } from "./workflow-editor";

interface Person {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

interface Props {
  slug: string;
  canManage: boolean;
  team: Team;
  states: WorkflowState[];
  taskCounts: Record<string, number>;
  people: Person[];
  memberIds: string[];
}

export function TeamSettings({ slug, canManage, team, states, taskCounts, people, memberIds }: Props) {
  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg border bg-background text-xl">
          {team.icon ?? team.name[0]}
        </span>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{team.name}</h2>
          {!canManage && (
            <p className="text-sm text-muted-foreground">Only owners and admins can change this team.</p>
          )}
        </div>
      </div>

      <GeneralCard slug={slug} team={team} canManage={canManage} />
      <PlannerFeaturesCard
        key={JSON.stringify(team.features)}
        slug={slug}
        team={team}
        canManage={canManage}
      />
      <MembersCard slug={slug} teamId={team.id} people={people} memberIds={memberIds} canManage={canManage} />
      <WorkflowEditor
        slug={slug}
        teamId={team.id}
        states={states}
        taskCounts={taskCounts}
        canManage={canManage}
      />
      {canManage && (
        <ArchiveCard
          slug={slug}
          team={team}
          taskCount={Object.values(taskCounts).reduce((a, b) => a + b, 0)}
        />
      )}
    </div>
  );
}

const featureLabels: Record<TeamFeature, string> = {
  cycles: "Cycles",
  triage: "Triage",
  estimates: "Point estimates",
  shortReferences: "Short task references",
};

function PlannerFeaturesCard({ slug, team, canManage }: { slug: string; team: Team; canManage: boolean }) {
  const router = useRouter();
  const [features, setFeatures] = useState(team.features ?? []);
  const [saving, setSaving] = useState(false);
  const dirty = teamFeatures.some(
    (feature) => features.includes(feature) !== (team.features ?? []).includes(feature),
  );

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].teams[":id"].$patch({
          param: { slug, id: team.id },
          json: { features },
        }),
      );
      toast.success("Planner features saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Planner features</CardTitle>
        <CardDescription>
          Short references apply to new tasks. Other preferences take effect as their features become
          available.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col items-start gap-3">
          {teamFeatures.map((feature) => (
            <label key={feature} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={features.includes(feature)}
                disabled={!canManage || saving}
                onChange={(event) =>
                  setFeatures(
                    event.target.checked
                      ? [...features, feature]
                      : features.filter((item) => item !== feature),
                  )
                }
              />
              {featureLabels[feature]}
            </label>
          ))}
          {canManage && (
            <Button type="submit" size="sm" disabled={!dirty || saving}>
              Save planner features
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function GeneralCard({ slug, team, canManage }: { slug: string; team: Team; canManage: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(team.name);
  const [key, setKey] = useState(team.key);
  const [icon, setIcon] = useState(team.icon ?? "");
  const [color, setColor] = useState<TagColorName>(team.color);
  const [description, setDescription] = useState(team.description ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== team.name ||
    key !== team.key ||
    icon !== (team.icon ?? "") ||
    color !== team.color ||
    description !== (team.description ?? "");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const saved = await unwrap(
        browserApi().v1.workspaces[":slug"].teams[":id"].$patch({
          param: { slug, id: team.id },
          json: { name, key, color, icon: icon.trim() || null, description: description.trim() || null },
        }),
      );
      toast.success("Team saved");
      // The key is part of the address.
      if (saved.key !== team.key) router.replace(`/${slug}/settings/teams/${saved.key}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem_6rem]">
              <Field>
                <FieldLabel htmlFor="team-name">Name</FieldLabel>
                <Input
                  id="team-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  disabled={!canManage}
                />
              </Field>
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="team-key">Key</FieldLabel>
                <Input
                  id="team-key"
                  value={key}
                  className="font-mono uppercase"
                  onChange={(e) => setKey(e.target.value.toUpperCase())}
                  required
                  maxLength={10}
                  disabled={!canManage}
                  aria-invalid={!!error}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="team-icon">Icon</FieldLabel>
                <Input
                  id="team-icon"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  maxLength={8}
                  disabled={!canManage}
                />
              </Field>
            </div>
            {error && <FieldDescription className="text-destructive">{error}</FieldDescription>}
            <Field>
              <FieldLabel htmlFor="team-description">Description</FieldLabel>
              <Textarea
                id="team-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={500}
                disabled={!canManage}
              />
            </Field>
            <Field>
              <FieldLabel>Color</FieldLabel>
              <ColorPicker value={color} onValueChange={setColor} disabled={!canManage} />
            </Field>
          </FieldGroup>
          {canManage && (
            <div>
              <Button type="submit" disabled={pending || !dirty || !name.trim()}>
                {pending && <Spinner />} Save changes
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function MembersCard({
  slug,
  teamId,
  people,
  memberIds,
  canManage,
}: {
  slug: string;
  teamId: string;
  people: Person[];
  memberIds: string[];
  canManage: boolean;
}) {
  const router = useRouter();
  const members = people.filter((p) => memberIds.includes(p.id));
  const others = people.filter((p) => !memberIds.includes(p.id));
  const api = () => browserApi().v1.workspaces[":slug"].teams[":id"].members;

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          {members.length} {members.length === 1 ? "person" : "people"} on this team.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {members.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No one is on this team yet.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {members.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <UserAvatar name={p.name} src={p.avatarUrl} className="size-7" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {p.email && <span className="truncate text-xs text-muted-foreground">{p.email}</span>}
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${p.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      run(() =>
                        unwrap(api()[":userId"].$delete({ param: { slug, id: teamId, userId: p.id } })),
                      )
                    }
                  >
                    <UserMinus />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={others.length === 0}>
                  <UserPlus /> Add member
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
                {others.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() =>
                      run(() => unwrap(api().$post({ param: { slug, id: teamId }, json: { userId: p.id } })))
                    }
                  >
                    <UserAvatar name={p.name} src={p.avatarUrl} className="size-5" /> {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ArchiveCard({ slug, team, taskCount }: { slug: string; team: Team; taskCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function archive() {
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].teams[":id"].$patch({
          param: { slug, id: team.id },
          json: { archived: true },
        }),
      );
      toast.success(`${team.name} archived`);
      router.replace(`/${slug}/settings/teams`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Archive team</CardTitle>
        <CardDescription>
          Hides the team and its {taskCount} {taskCount === 1 ? "task" : "tasks"} everywhere. Nothing is
          deleted, and you can restore the team from the Teams page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <Archive /> Archive {team.name}
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {team.name}?</DialogTitle>
            <DialogDescription>
              The team disappears from the sidebar and its tasks no longer appear in task lists or search. The
              key {team.key} stays reserved until the team is restored.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" disabled={pending} onClick={archive}>
              {pending && <Spinner />} Archive team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
