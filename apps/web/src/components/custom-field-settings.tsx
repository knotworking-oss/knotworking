"use client";

import {
  customFieldTargets,
  customFieldTypes,
  newId,
  type CustomFieldOption,
  type CustomFieldTarget,
  type CustomFieldType,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Input } from "@knotworking/ui/components/input";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const definitionsApi = () => browserApi().v1.workspaces[":slug"].tasks["custom-fields"];
const readDefinitions = (slug: string) => unwrap(definitionsApi().$get({ param: { slug } }));
type Definition = Awaited<ReturnType<typeof readDefinitions>>["fields"][number];

const types: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  single_select: "Single select",
  multi_select: "Multiple select",
  person: "Person",
  checkbox: "Checkbox",
  url: "URL",
};
const selectClass = "h-8 rounded-md border bg-background px-2 text-sm";

export function CustomFieldSettings() {
  const { slug, idx, sync, can } = useWorkspace();
  const [fields, setFields] = useState<Definition[]>();
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Definition | null>();
  const [removing, setRemoving] = useState<Definition>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canManage = can("tasks", "manage");
  useEffect(
    () =>
      sync.onChanges((changes) => {
        if (changes.some((change) => change.entity === "custom_field_definition"))
          setRevision((value) => value + 1);
      }),
    [sync],
  );
  useEffect(() => {
    let active = true;
    readDefinitions(slug).then(
      (result) => {
        if (!active) return;
        setFields(result.fields);
        setError(undefined);
      },
      (err) => {
        if (active) setError(errorMessage(err));
      },
    );
    return () => {
      active = false;
    };
  }, [slug, revision]);
  function updated() {
    setRevision((value) => value + 1);
    sync.pull();
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      const response = await definitionsApi()[":id"].$delete({ param: { slug, id: removing.id } });
      if (!response.ok) await unwrap(Promise.resolve(response));
      setRemoving(undefined);
      updated();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
      {canManage && (
        <Button size="sm" className="self-end" onClick={() => setEditing(null)}>
          New field
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {fields?.length === 0 && <p className="text-sm text-muted-foreground">No custom fields yet.</p>}
      <ul className="divide-y">
        {fields?.map((field) => (
          <li key={field.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div>
              <p className="font-medium">{field.name}</p>
              <p className="text-xs text-muted-foreground">
                {field.target === "task" ? "Tasks" : "Projects"} · {types[field.type]} ·{" "}
                {field.teamId
                  ? (idx.teams.get(field.teamId)?.name ?? "Archived team")
                  : field.projectId
                    ? (idx.projects.get(field.projectId)?.name ?? "Removed project")
                    : "Workspace"}
              </p>
            </div>
            {canManage && (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(field)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(field)}>
                  Delete
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canManage && editing !== undefined && (
        <DefinitionDialog
          field={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            updated();
          }}
        />
      )}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>This removes the field and all of its stored values.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(undefined)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function DefinitionDialog({
  field,
  onClose,
  onSaved,
}: {
  field: Definition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { slug, idx } = useWorkspace();
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text");
  const [target, setTarget] = useState<CustomFieldTarget>(field?.target ?? "task");
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [options, setOptions] = useState<CustomFieldOption[]>(field?.options ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isSelect = type === "single_select" || type === "multi_select";
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const editable = { name, ...(isSelect ? { options } : {}) };
    try {
      if (field)
        await unwrap(definitionsApi()[":id"].$patch({ param: { slug, id: field.id }, json: editable }));
      else
        await unwrap(
          definitionsApi().$post({
            param: { slug },
            json: {
              ...editable,
              target,
              type,
              teamId: teamId || null,
              projectId: projectId || null,
            },
          }),
        );
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{field ? "Edit custom field" : "New custom field"}</DialogTitle>
          <DialogDescription>Add structured information to tasks or projects.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3 text-sm" onSubmit={save}>
          <label className="grid gap-1">
            Name
            <Input
              autoFocus
              required
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {!field && (
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                Applies to
                <select
                  className={selectClass}
                  value={target}
                  onChange={(event) => setTarget(event.target.value as CustomFieldTarget)}
                >
                  {customFieldTargets.map((key) => (
                    <option key={key} value={key}>
                      {key === "task" ? "Tasks" : "Projects"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                Type
                <select
                  className={selectClass}
                  value={type}
                  onChange={(event) => setType(event.target.value as CustomFieldType)}
                >
                  {customFieldTypes.map((key) => (
                    <option key={key} value={key}>
                      {types[key]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                Team
                <select
                  className={selectClass}
                  value={teamId}
                  disabled={!!projectId}
                  onChange={(event) => setTeamId(event.target.value)}
                >
                  <option value="">Any team</option>
                  {[...idx.teams.values()].map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                Project
                <select
                  className={selectClass}
                  value={projectId}
                  disabled={!!teamId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">Any project</option>
                  {[...idx.projects.values()].map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {isSelect && (
            <fieldset className="grid gap-2">
              <legend className="mb-2">Options</legend>
              {options.map((option, index) => (
                <div className="flex gap-2" key={option.id}>
                  <Input
                    required
                    maxLength={100}
                    aria-label={`Option ${index + 1}`}
                    value={option.label}
                    onChange={(event) =>
                      setOptions(
                        options.map((item) =>
                          item.id === option.id ? { ...item, label: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setOptions(options.filter((item) => item.id !== option.id))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={options.length >= 100}
                onClick={() => setOptions([...options, { id: newId(), label: "" }])}
              >
                Add option
              </Button>
            </fieldset>
          )}
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (isSelect && !options.length)}>
              Save field
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
