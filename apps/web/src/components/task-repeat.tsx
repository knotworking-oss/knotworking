"use client";

import { addDaysToIsoDate, taskRecurrenceSchema, type RecurrenceSchedule } from "@knotworking/core";
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
import { Repeat } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

type Schedule = { schedule: RecurrenceSchedule; enabled: boolean };
type Recurrence = Schedule & { nextOn: string; lastError: string | null };

export function TaskRepeat({ taskId }: { taskId: string }) {
  const { slug, can, canEditTasks } = useWorkspace();
  const today = useWorkspaceToday();
  const canRead = can("automation");
  const canEdit = canEditTasks && can("automation", "write");
  const [open, setOpen] = useState(false);
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [draft, setDraft] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !canRead) return;
    const controller = new AbortController();
    setRecurrence(null);
    setDraft(null);
    setError(null);
    void unwrap(
      browserApi().v1.workspaces[":slug"].automation.recurrences[":taskId"].$get(
        { param: { slug, taskId } },
        { init: { signal: controller.signal } },
      ),
    ).then(
      ({ recurrence }) => {
        if (controller.signal.aborted) return;
        setRecurrence(recurrence);
        setDraft(
          recurrence ?? {
            enabled: true,
            schedule: {
              frequency: "weekly",
              interval: 1,
              weekdays: [],
              firstOn: addDaysToIsoDate(today, 1),
              timing: "on_schedule",
            },
          },
        );
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      },
    );
    return () => controller.abort();
  }, [canRead, open, slug, taskId, today]);

  if (!canRead) return null;

  function changeSchedule(changes: Partial<RecurrenceSchedule>) {
    setDraft((current) => current && { ...current, schedule: { ...current.schedule, ...changes } });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !draft || saving) return;
    const parsed = taskRecurrenceSchema.safeParse({
      schedule: draft.schedule,
      enabled: draft.enabled,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the repeat schedule");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await unwrap(
        browserApi().v1.workspaces[":slug"].automation.recurrences[":taskId"].$put({
          param: { slug, taskId },
          json: parsed.data,
        }),
      );
      setRecurrence(result.recurrence);
      setDraft(result.recurrence);
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!canEdit || !recurrence || saving) return;
    setSaving(true);
    setError(null);
    try {
      await unwrapEmpty(
        browserApi().v1.workspaces[":slug"].automation.recurrences[":taskId"].$delete({
          param: { slug, taskId },
        }),
      );
      setRecurrence(null);
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const schedule = draft?.schedule;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!saving) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Repeat task">
          <Repeat /> <span className="hidden sm:inline">Repeat</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Repeat task</DialogTitle>
          <DialogDescription>
            Create a new task for each occurrence in the workspace time zone.
          </DialogDescription>
        </DialogHeader>
        {recurrence?.enabled && (
          <p className="text-sm">
            Next scheduled date <strong>{formatLongDate(recurrence.nextOn)}</strong>
          </p>
        )}
        {recurrence?.lastError && <p className="text-sm text-destructive">{recurrence.lastError}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!schedule && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading schedule…
          </p>
        )}
        {schedule && !recurrence && !canEdit && <p className="text-sm">This task has no repeat schedule.</p>}
        {schedule && draft && (canEdit || recurrence) && (
          <form onSubmit={save} className="grid gap-4">
            <fieldset disabled={!canEdit || saving} className="grid gap-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 text-sm font-medium">
                  Frequency
                  <select
                    className={selectClass}
                    value={schedule.frequency}
                    onChange={(event) =>
                      changeSchedule({
                        frequency: event.target.value as RecurrenceSchedule["frequency"],
                        weekdays: [],
                      })
                    }
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Interval (
                  {schedule.frequency === "daily"
                    ? "days"
                    : schedule.frequency === "weekly"
                      ? "weeks"
                      : "months"}
                  )
                  <Input
                    type="number"
                    required
                    min={1}
                    max={365}
                    value={Number.isNaN(schedule.interval) ? "" : schedule.interval}
                    onChange={(event) => changeSchedule({ interval: event.target.valueAsNumber })}
                  />
                </label>
              </div>
              {schedule.frequency === "weekly" && (
                <fieldset className="grid gap-2">
                  <legend className="mb-1.5 text-sm font-medium">Weekdays</legend>
                  <div className="flex flex-wrap gap-x-3 gap-y-2">
                    {weekdays.map((name, index) => {
                      const day = index + 1;
                      const selected = schedule.weekdays.includes(day);
                      return (
                        <label key={day} className="flex items-center gap-1 text-sm">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() =>
                              changeSchedule({
                                weekdays: selected
                                  ? schedule.weekdays.filter((value) => value !== day)
                                  : [...schedule.weekdays, day].sort((a, b) => a - b),
                              })
                            }
                          />
                          {name}
                        </label>
                      );
                    })}
                  </div>
                  {schedule.weekdays.length === 0 && (
                    <p className="text-xs text-muted-foreground">Repeats on the weekday of the first date.</p>
                  )}
                </fieldset>
              )}
              <label className="grid gap-1.5 text-sm font-medium">
                First date
                <Input
                  type="date"
                  required
                  min={schedule.firstOn === recurrence?.schedule.firstOn ? undefined : today}
                  value={schedule.firstOn}
                  onChange={(event) => changeSchedule({ firstOn: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Create next task
                <select
                  className={selectClass}
                  value={schedule.timing}
                  onChange={(event) =>
                    changeSchedule({ timing: event.target.value as RecurrenceSchedule["timing"] })
                  }
                >
                  <option value="on_schedule">On schedule</option>
                  <option value="after_completion">After the previous task closes</option>
                </select>
                {schedule.timing === "after_completion" && (
                  <span className="text-xs font-normal text-muted-foreground">
                    Completion, cancellation, or removal lets the next task be created.
                  </span>
                )}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                Schedule enabled
              </label>
            </fieldset>
            {canEdit && (
              <DialogFooter>
                {recurrence && (
                  <Button type="button" variant="outline" disabled={saving} onClick={() => void remove()}>
                    Remove schedule
                  </Button>
                )}
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save schedule"}
                </Button>
              </DialogFooter>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
