"use client";

import {
  formatMinutes,
  parseDuration,
  TASK_ESTIMATE_MAX_MINUTES,
  TIME_ENTRY_MAX_MINUTES,
  TIME_ENTRY_NOTE_MAX,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
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
import { Input } from "@knotworking/ui/components/input";
import { TimerButton, TimeSummary, useElapsed } from "@knotworking/ui/components/time-tracking";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { TaskSummary } from "@/lib/api";
import { formatShortDate } from "@/lib/format";
import type { TimeEntry } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { MemberAvatar } from "@/components/member-avatar";

export interface TimeEntryValues {
  minutes: number;
  entryDate: string;
  note: string | null;
}

/**
 * Duration, day and note for a time entry, used to log time and to edit an entry. Durations
 * accept "1h 30m", "1.5h", "90" or "1:30". Has no store access, so it can be showcased.
 */
export function TimeEntryForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  disabled,
}: {
  initial?: Partial<TimeEntryValues>;
  submitLabel: string;
  /** Resolves true when saved (the form then clears itself unless it is editing). */
  onSubmit: (values: TimeEntryValues) => Promise<boolean | void>;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  const today = useWorkspaceToday();
  const [duration, setDuration] = useState(initial?.minutes ? formatMinutes(initial.minutes) : "");
  const [entryDate, setEntryDate] = useState(initial?.entryDate ?? today);
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const minutes = parseDuration(duration);
    if (minutes === null) return setError("Enter a duration like 1h 30m, 45m or 1.5h");
    if (minutes > TIME_ENTRY_MAX_MINUTES) return setError("One entry can be at most 24 hours");
    if (!entryDate) return setError("Pick a day");
    setError(null);
    setBusy(true);
    try {
      const saved = await onSubmit({ minutes, entryDate, note: note.trim() || null });
      if (saved === true && !initial) {
        setDuration("");
        setNote("");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5" aria-label={submitLabel}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Duration"
          placeholder="1h 30m"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="h-8 w-24"
          disabled={disabled || busy}
          aria-invalid={error !== null}
        />
        <Input
          aria-label="Day"
          type="date"
          value={entryDate}
          onChange={(e) => setEntryDate(e.target.value)}
          className="h-8 w-36"
          disabled={disabled || busy}
        />
        <Input
          aria-label="Note"
          placeholder="What did you work on? (optional)"
          value={note}
          maxLength={TIME_ENTRY_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          className="h-8 min-w-40 flex-1"
          disabled={disabled || busy}
        />
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={disabled || busy || !duration.trim()}>
          {submitLabel}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

/** Time estimate field: a duration saved on blur or Enter; empty clears it. */
function EstimateInput({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (minutes: number | null) => void;
  disabled?: boolean;
}) {
  const shown = value ? formatMinutes(value) : "";
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);

  const save = () => {
    if (!text.trim()) return value !== null && onChange(null);
    const minutes = parseDuration(text);
    if (minutes === null || minutes > TASK_ESTIMATE_MAX_MINUTES) {
      toast.error("Enter a time estimate like 4h or 90m (up to 1,000 hours)");
      return setText(shown);
    }
    if (minutes !== value) onChange(minutes);
    else setText(shown);
  };

  return (
    <Input
      aria-label="Time estimate"
      placeholder="None"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setText(shown);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className="h-8 w-24"
    />
  );
}

/**
 * The task page's Time section: time estimate, logged total, the viewer's timer, a form to
 * log time and the entries. Live from the workspace store (entries sync like tasks).
 */
export function TaskTime({
  initial,
  initialEntries = [],
}: {
  initial: TaskSummary;
  initialEntries?: TimeEntry[];
}) {
  const {
    tasks,
    idx,
    viewer,
    canEditTime: canEdit,
    updateTask,
    timeEntries,
    runningTimer,
    logTime,
    updateTimeEntry,
    deleteTimeEntry,
    startTimer,
    stopTimer,
  } = useWorkspace();
  const task = tasks.find((t) => t.id === initial.id) ?? initial;
  const entries = [
    ...new Map(
      [...initialEntries, ...timeEntries.filter((e) => e.taskId === task.id)].map((entry) => [
        entry.id,
        entry,
      ]),
    ).values(),
  ].sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt));
  const logged = entries.reduce((total, entry) => total + (entry.minutes ?? 0), 0);
  const timerHere = runningTimer?.taskId === task.id ? runningTimer : undefined;
  const timerElsewhere =
    runningTimer && !timerHere ? tasks.find((t) => t.id === runningTimer.taskId) : undefined;
  const isAdmin = viewer.role === "owner" || viewer.role === "admin";
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [deleting, setDeleting] = useState<TimeEntry | null>(null);

  if (!canEdit && entries.length === 0 && !task.estimateMinutes) return null;

  return (
    <section className="mt-4 flex flex-col gap-3" aria-label="Time">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Time</h2>
        <TimeSummary logged={logged} estimate={task.estimateMinutes} />
        {canEdit && (
          <div className="ml-auto flex items-center gap-2">
            {timerElsewhere && (
              <span className="max-w-48 truncate text-xs text-muted-foreground" title={timerElsewhere.title}>
                Timer running on {timerElsewhere.title}
              </span>
            )}
            <TimerButton
              runningSince={timerHere?.startedAt}
              onStart={() => void startTimer(task.id)}
              onStop={() => void stopTimer()}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="w-20 shrink-0 text-muted-foreground">Estimate</span>
        {canEdit ? (
          <EstimateInput
            value={task.estimateMinutes}
            onChange={(estimateMinutes) => void updateTask(task.id, { estimateMinutes })}
          />
        ) : (
          <span>{task.estimateMinutes ? formatMinutes(task.estimateMinutes) : "None"}</span>
        )}
      </div>

      {canEdit && <TimeEntryForm submitLabel="Log time" onSubmit={(values) => logTime(task.id, values)} />}

      {entries.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {entries.map((entry) => {
            const user = entry.userId ? idx.users.get(entry.userId) : undefined;
            const mine = entry.userId === viewer.id;
            return (
              <li key={entry.id} className="group/entry flex items-center gap-3 px-3 py-2">
                <MemberAvatar
                  userId={entry.userId}
                  name={user?.name ?? "Former member"}
                  src={user?.avatarUrl}
                  className="size-5"
                />
                <span className="w-28 shrink-0 truncate">{user?.name ?? "Former member"}</span>
                <span className="w-20 shrink-0 font-medium tabular-nums">
                  {entry.minutes === null ? (
                    <Running since={entry.startedAt} />
                  ) : (
                    formatMinutes(entry.minutes)
                  )}
                </span>
                <span className="w-14 shrink-0 text-xs text-muted-foreground">
                  {formatShortDate(entry.entryDate)}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.note}</span>
                {canEdit && (mine || isAdmin) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Time entry actions"
                        className="text-muted-foreground opacity-0 group-hover/entry:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      {entry.minutes !== null && (
                        <DropdownMenuItem onSelect={() => setEditing(entry)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(entry)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit time entry</DialogTitle>
            <DialogDescription>Change the duration, the day or the note.</DialogDescription>
          </DialogHeader>
          {editing && (
            <TimeEntryForm
              initial={{
                minutes: editing.minutes ?? undefined,
                entryDate: editing.entryDate,
                note: editing.note,
              }}
              submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={async (values) => {
                const id = editing.id;
                setEditing(null);
                return updateTimeEntry(id, values);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this time entry?</DialogTitle>
            <DialogDescription>
              {deleting?.minutes
                ? `${formatMinutes(deleting.minutes)} will no longer count towards this task.`
                : "The running timer will be discarded."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) void deleteTimeEntry(deleting.id);
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Running({ since }: { since: string | null }) {
  const elapsed = useElapsed(since);
  return <span className="text-primary">{elapsed ?? "Running"}</span>;
}
