"use client";

import type { CustomFieldTarget, CustomFieldValue } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const recordApi = () => browserApi().v1.workspaces[":slug"].tasks["custom-fields"][":target"][":id"].values;
const readFields = (slug: string, target: CustomFieldTarget, id: string) =>
  unwrap(recordApi().$get({ param: { slug, target, id } }));
type Field = Awaited<ReturnType<typeof readFields>>["fields"][number];

const inputClass = "min-h-8 min-w-0 rounded-md border bg-background px-2 text-sm";

export function CustomFieldValues({ target, id }: { target: CustomFieldTarget; id: string }) {
  const { slug, sync, canEditTasks } = useWorkspace();
  const [fields, setFields] = useState<Field[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(
    () =>
      sync.onChanges((changes) => {
        if (
          changes.some(
            (change) =>
              change.entity === "custom_field_definition" ||
              ((change.entity === "custom_field_value" || change.entity === target) &&
                change.entityId === id),
          )
        )
          setRevision((value) => value + 1);
      }),
    [sync, id, target],
  );
  useEffect(() => {
    let active = true;
    readFields(slug, target, id).then(
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
  }, [slug, target, id, revision]);
  if (!fields.length && !error) return null;

  return (
    <section aria-label="Custom fields" className="grid gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">Custom fields</h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {fields.map((field) => (
        <FieldValue
          key={`${field.id}:${JSON.stringify(field.value)}`}
          field={field}
          editable={canEditTasks}
          onSave={async (value) => {
            const saved = await unwrap(
              recordApi()[":fieldId"].$put({
                param: { slug, target, id, fieldId: field.id },
                json: { value },
              }),
            );
            setFields((previous) =>
              previous.map((item) => (item.id === field.id ? { ...item, value: saved.value } : item)),
            );
            sync.pull();
          }}
        />
      ))}
    </section>
  );
}

function FieldValue({
  field,
  editable,
  onSave,
}: {
  field: Field;
  editable: boolean;
  onSave: (value: CustomFieldValue) => Promise<void>;
}) {
  const { idx } = useWorkspace();
  const [draft, setDraft] = useState<string | string[]>(() =>
    Array.isArray(field.value) ? field.value : field.value === null ? "" : String(field.value),
  );
  const [busy, setBusy] = useState(false);
  const selected = Array.isArray(draft) ? draft : [];
  const scalar = typeof draft === "string" ? draft : "";
  const optionName = (id: string) =>
    field.options.find((option) => option.id === id)?.label ?? "Unknown option";
  if (!editable) {
    let display = field.value === null ? "—" : String(field.value);
    if (field.type === "person" && typeof field.value === "string")
      display = idx.users.get(field.value)?.name ?? "Former member";
    if (field.type === "single_select" && typeof field.value === "string") display = optionName(field.value);
    if (Array.isArray(field.value)) display = field.value.map(optionName).join(", ") || "—";
    if (field.type === "checkbox" && typeof field.value === "boolean") display = field.value ? "Yes" : "No";
    return (
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="min-w-32 text-muted-foreground">{field.name}</span>
        <span>{display}</span>
      </div>
    );
  }
  const value =
    field.type === "multi_select"
      ? selected.length
        ? selected
        : null
      : !scalar.trim()
        ? null
        : field.type === "checkbox"
          ? scalar === "true"
          : field.type === "number"
            ? Number(scalar)
            : scalar;
  const changed = JSON.stringify(value) !== JSON.stringify(field.value);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!changed) return;
    setBusy(true);
    try {
      await onSave(value);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const options =
    field.type === "person"
      ? idx.boot.users.map((person) => ({ id: person.id, label: person.name }))
      : field.type === "checkbox"
        ? [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ]
        : field.options;
  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2">
      {field.type === "multi_select" ? (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-3">
          <legend className="text-sm text-muted-foreground">{field.name}</legend>
          {field.options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={(event) =>
                  setDraft(
                    event.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : (
        <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="min-w-32 text-muted-foreground">{field.name}</span>
          {field.type === "single_select" || field.type === "person" || field.type === "checkbox" ? (
            <select className={inputClass} value={scalar} onChange={(event) => setDraft(event.target.value)}>
              <option value="">Unset</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              className="w-48"
              type={field.type === "text" ? "text" : field.type}
              step={field.type === "number" ? "any" : undefined}
              value={scalar}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </label>
      )}
      {changed && (
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          Save
        </Button>
      )}
    </form>
  );
}
