"use client";

import { scheduleFrequencyUnits, type ScheduleFrequencyUnit } from "@knotworking/core";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import type { ReactNode } from "react";
import { SelectField } from "@/components/haccp-forms";
import { browserApi } from "@/lib/auth-client";
import { useFormatDateTime } from "@/lib/workspace-time";

export { HaccpDialog as SiteDialog, SelectField } from "@/components/haccp-forms";

export const maintenanceApi = () => browserApi().v1.workspaces[":slug"].maintenance;
export const checklistApi = () => browserApi().v1.workspaces[":slug"].checklists;
export const siteApi = () => browserApi().v1.workspaces[":slug"].site;

export const NONE = "none";
/** A timestamp in the workspace's zone ("—" when empty), so server and browser render the same. */
export function useDateTime() {
  const format = useFormatDateTime();
  return (iso: string | null | undefined) => (iso ? format(iso) : "—");
}

const unitLabels: Record<ScheduleFrequencyUnit, string> = {
  hour: "hours",
  day: "days",
  week: "weeks",
  month: "months",
};

/** "Every N hours/days/weeks/months" as form state (strings) and as the API takes it. */
export interface FrequencyState {
  every: string;
  unit: ScheduleFrequencyUnit;
}
export const frequencyBody = (f: FrequencyState) => ({ every: Number(f.every), unit: f.unit });

export function FrequencyField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: FrequencyState;
  onChange: (value: FrequencyState) => void;
}) {
  return (
    <div className="flex items-end gap-2">
      <Field className="w-28">
        <FieldLabel htmlFor={`${id}-every`}>{label}</FieldLabel>
        <Input
          id={`${id}-every`}
          type="number"
          min={1}
          max={1000}
          step={1}
          required
          value={value.every}
          onChange={(e) => onChange({ ...value, every: e.target.value })}
        />
      </Field>
      <div className="flex-1">
        <SelectField
          id={`${id}-unit`}
          label="Unit"
          value={value.unit}
          onChange={(unit) => onChange({ ...value, unit: unit as ScheduleFrequencyUnit })}
          options={scheduleFrequencyUnits.map((u) => [u, unitLabels[u]] as const)}
        />
      </div>
    </div>
  );
}

/** A labelled single-line input. */
export function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  required,
  description,
  placeholder,
  step,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date" | "datetime-local";
  required?: boolean;
  description?: ReactNode;
  placeholder?: string;
  step?: string;
  className?: string;
}) {
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        required={required}
        step={step}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

/** A labelled multi-line input. */
export function TextAreaField({
  id,
  label,
  value,
  onChange,
  required,
  description,
  rows = 3,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  description?: ReactNode;
  rows?: number;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        required={required}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

/** A form value that is blank until typed: `undefined` for the API when empty. */
export const text = (value: string) => (value.trim() === "" ? undefined : value.trim());
/** A datetime-local value as an ISO string with an offset, or `undefined` when blank. */
export const localToIso = (value: string) => (value ? new Date(value).toISOString() : undefined);
