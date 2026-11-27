"use client";

import {
  priorities,
  priorityLabels,
  TASK_BULK_LIMIT,
  type TaskBulkInput,
  type TaskBulkPatch,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { createContext, useContext, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { TaskSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

type Selection = {
  enabled: boolean;
  has: (id: string) => boolean;
  toggle: (id: string, range?: boolean) => void;
};
const BulkSelection = createContext<Selection | null>(null);
type Field = "stateId" | "assigneeId" | "priority" | "projectId" | "labelIds" | "delete";
const selectClass = "h-8 max-w-48 rounded-md border bg-background px-2 text-sm";

export function BulkTaskSelection({ tasks, children }: { tasks: TaskSummary[]; children: ReactNode }) {
  const { slug, idx, canEditTasks, sync } = useWorkspace();
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | undefined>(undefined);
  const [field, setField] = useState<Field>("priority");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const picked = tasks.filter((task) => selected.includes(task.id));
  const ids = picked.map((task) => task.id);
  const teams = new Set(picked.map((task) => task.teamId));
  const teamId = teams.size === 1 ? picked[0]?.teamId : undefined;

  function toggle(id: string, range = false) {
    if (!canEditTasks || busy) return;
    setEnabled(true);
    const all = tasks.map((task) => task.id);
    const start = anchor.current ? all.indexOf(anchor.current) : -1;
    const end = all.indexOf(id);
    const next =
      range && start >= 0 && end >= 0
        ? [...new Set([...ids, ...all.slice(Math.min(start, end), Math.max(start, end) + 1)])]
        : ids.includes(id)
          ? ids.filter((item) => item !== id)
          : [...ids, id];
    if (next.length > TASK_BULK_LIMIT) {
      toast.error(`Select at most ${TASK_BULK_LIMIT} tasks`);
      return;
    }
    anchor.current = id;
    setSelected(next);
  }

  async function apply() {
    if (!ids.length || busy) return;
    let input: TaskBulkInput;
    if (field === "delete") {
      if (!window.confirm(`Delete ${ids.length} selected tasks?`)) return;
      input = { action: "delete", ids };
    } else {
      if (!value || (field === "stateId" && !teamId)) return;
      const patch: TaskBulkPatch =
        field === "priority"
          ? { priority: Number(value) as TaskBulkPatch["priority"] }
          : field === "labelIds"
            ? { labelIds: value === "none" ? [] : [value] }
            : field === "stateId"
              ? { stateId: value }
              : { [field]: value === "none" ? null : value };
      input = { action: "update", ids, patch };
    }
    setBusy(true);
    try {
      await unwrap(browserApi().v1.workspaces[":slug"].tasks.bulk.$post({ param: { slug }, json: input }));
      toast.success(`${ids.length} tasks ${input.action === "delete" ? "deleted" : "updated"}`);
      setSelected([]);
      setEnabled(false);
      setValue("");
      anchor.current = undefined;
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const options =
    field === "priority"
      ? priorities.map((priority) => ({ id: String(priority), name: priorityLabels[priority] }))
      : field === "stateId"
        ? idx.boot.workflowStates.filter((state) => state.teamId === teamId)
        : field === "assigneeId"
          ? [{ id: "none", name: "Unassigned" }, ...idx.boot.users]
          : field === "projectId"
            ? [{ id: "none", name: "No project" }, ...idx.boot.projects]
            : [{ id: "none", name: "Clear labels" }, ...idx.boot.labels];

  return (
    <BulkSelection.Provider value={canEditTasks ? { enabled, has: (id) => ids.includes(id), toggle } : null}>
      {canEditTasks && tasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
          {enabled ? (
            <>
              <span className="text-sm" aria-live="polite">
                {ids.length} selected
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEnabled(false);
                  setSelected([]);
                  anchor.current = undefined;
                }}
              >
                Cancel
              </Button>
              <select
                aria-label="Bulk action"
                className={selectClass}
                value={field}
                onChange={(event) => {
                  setField(event.target.value as Field);
                  setValue("");
                }}
              >
                <option value="priority">Set priority</option>
                <option value="stateId" disabled={!teamId}>
                  Set status (one team)
                </option>
                <option value="assigneeId">Set assignee</option>
                <option value="projectId">Set project</option>
                <option value="labelIds">Replace labels</option>
                <option value="delete">Delete</option>
              </select>
              {field !== "delete" && (
                <select
                  aria-label="Bulk action value"
                  className={selectClass}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                >
                  <option value="">Choose value</option>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              )}
              <Button
                type="button"
                size="sm"
                disabled={
                  busy || !ids.length || (field !== "delete" && !value) || (field === "stateId" && !teamId)
                }
                onClick={() => void apply()}
              >
                {busy ? "Applying…" : "Apply"}
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setEnabled(true)}>
              Select tasks
            </Button>
          )}
        </div>
      )}
      {children}
    </BulkSelection.Provider>
  );
}

export function useBulkTaskRow(id: string) {
  const selection = useContext(BulkSelection);
  return {
    selecting: selection?.enabled ?? false,
    onClick(event: MouseEvent<HTMLAnchorElement>) {
      if (!selection || !(selection.enabled || event.shiftKey)) return;
      event.preventDefault();
      selection.toggle(id, event.shiftKey);
    },
    onKeyDown(event: React.KeyboardEvent<HTMLAnchorElement>) {
      if (selection?.enabled && event.key.toLowerCase() === "x") {
        event.preventDefault();
        selection.toggle(id, event.shiftKey);
      }
    },
    toggle: selection?.enabled ? () => selection.toggle(id) : undefined,
  };
}

export function BulkTaskCheckbox({ task }: { task: TaskSummary }) {
  const selection = useContext(BulkSelection);
  if (!selection?.enabled) return null;
  return (
    <input
      type="checkbox"
      className="pointer-events-auto relative z-10 size-4 shrink-0"
      checked={selection.has(task.id)}
      aria-label={`Select ${task.title}`}
      onClick={(event) => {
        event.preventDefault();
        selection.toggle(task.id, event.shiftKey);
      }}
      readOnly
    />
  );
}
