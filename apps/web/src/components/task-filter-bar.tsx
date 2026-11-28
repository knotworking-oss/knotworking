"use client";

import {
  priorities,
  priorityLabels,
  taskFilterSchema,
  workflowStateTypes,
  type TaskFilter,
  type TaskFilterExpression,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Plus, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useWorkspace } from "@/lib/workspace-store";
import { useSearchParam } from "./view-switcher";

const fieldNames = {
  stateType: "Status",
  assigneeId: "Assignee",
  priority: "Priority",
  labelId: "Label",
  milestoneId: "Milestone",
  dueDate: "Due on or before",
} as const;
type Field = keyof typeof fieldNames;

const stateNames = {
  backlog: "Backlog",
  unstarted: "To do",
  started: "In progress",
  completed: "Completed",
  canceled: "Canceled",
} as const;

const selectClass = "h-8 max-w-48 rounded-md border bg-background px-2 text-sm";

export function TaskFilterBar({
  filter,
  clearParam = null,
  actions,
}: {
  filter?: TaskFilter;
  clearParam?: string | null;
  actions?: ReactNode;
}) {
  const setParam = useSearchParam();
  const { idx } = useWorkspace();
  const [field, setField] = useState<Field>("stateType");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const conditions = filter ? ("and" in filter.expression ? filter.expression.and : [filter.expression]) : [];
  const options =
    field === "stateType"
      ? workflowStateTypes.map((type) => ({ id: type, name: stateNames[type] }))
      : field === "assigneeId"
        ? [{ id: "unassigned", name: "Unassigned" }, ...idx.boot.users]
        : field === "priority"
          ? priorities.map((priority) => ({ id: String(priority), name: priorityLabels[priority] }))
          : field === "milestoneId"
            ? [{ id: "unassigned", name: "No milestone" }, ...idx.milestones.values()]
            : idx.boot.labels;

  function write(next: TaskFilterExpression[]) {
    if (next.length === 0) {
      setParam("filter", clearParam);
      setError(undefined);
      return;
    }
    const checked = taskFilterSchema.safeParse({
      version: 1,
      expression: next.length === 1 ? next[0] : { and: next },
    });
    const encoded = checked.success ? JSON.stringify(checked.data) : "";
    if (!checked.success || encoded.length > 8192) {
      setError("This view has reached its filter limit.");
      return;
    }
    setParam("filter", encoded);
    setError(undefined);
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!value) return;
    const draft = {
      field,
      op: field === "dueDate" ? "lte" : "eq",
      value: field === "priority" ? Number(value) : value === "unassigned" ? null : value,
    };
    const checked = taskFilterSchema.safeParse({ version: 1, expression: draft });
    if (checked.success) {
      write([...conditions, checked.data.expression]);
      setValue("");
    }
  }

  function describe(condition: TaskFilterExpression) {
    if ("and" in condition || "or" in condition) return "Nested conditions";
    const { field, op, value } = condition;
    const label = field in fieldNames ? fieldNames[field as Field] : field;
    switch (condition.field) {
      case "stateType":
        return `${label} ${op === "ne" ? "≠" : ""} ${stateNames[condition.value]}`;
      case "assigneeId":
        return `${label} ${op === "ne" ? "≠" : ""} ${condition.value ? (idx.users.get(condition.value)?.name ?? condition.value) : "Unassigned"}`;
      case "priority":
        return `${label} ${op === "ne" ? "≠" : ""} ${priorityLabels[condition.value]}`;
      case "labelId":
        return `${label} ${op === "ne" ? "≠" : ""} ${idx.labels.get(condition.value)?.name ?? condition.value}`;
      case "milestoneId":
        return `${label} ${op === "ne" ? "≠" : ""} ${condition.value ? (idx.milestones.get(condition.value)?.name ?? condition.value) : "No milestone"}`;
      case "dueDate":
        return `Due date ${op} ${value ?? "unset"}`;
      default:
        return `${label} ${op} ${value ?? "unset"}`;
    }
  }

  return (
    <section aria-label="Task filters" className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
      {conditions.map((condition, index) => (
        <Button
          type="button"
          key={index}
          variant="secondary"
          size="sm"
          onClick={() => write(conditions.filter((_, i) => i !== index))}
        >
          {describe(condition)} <X aria-label="Remove" />
        </Button>
      ))}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <select
          className={selectClass}
          aria-label="Filter field"
          value={field}
          onChange={(event) => {
            setField(event.target.value as Field);
            setValue("");
          }}
        >
          {Object.entries(fieldNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {field === "dueDate" ? (
          <Input
            className="h-8 w-auto"
            aria-label="Filter date"
            type="date"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : (
          <select
            className={selectClass}
            aria-label="Filter value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            <option value="">Choose value</option>
            {options.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <Button type="submit" variant="ghost" size="sm" disabled={!value}>
          <Plus /> Add filter
        </Button>
      </form>
      {conditions.length > 0 && (
        <Button type="button" variant="ghost" size="sm" onClick={() => write([])}>
          Clear filters
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {actions}
    </section>
  );
}
