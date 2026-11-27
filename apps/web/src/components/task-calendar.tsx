"use client";

import { Button } from "@knotworking/ui/components/button";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { cn } from "@knotworking/ui/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { TaskSummary } from "@/lib/api";
import {
  datePatch,
  fromDay,
  shiftDates,
  startOfMonthDay,
  startOfWeekDay,
  taskSpan,
  toDay,
} from "@/lib/timeline";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const headingFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const fullDateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone: "UTC" });
const dateFor = (day: number) => new Date(`${fromDay(day)}T12:00:00Z`);

export function taskCalendarDays(anchor: number, mode: "week" | "month") {
  if (mode === "week") {
    const start = startOfWeekDay(anchor);
    return { start, end: start + 6 };
  }
  const month = startOfMonthDay(anchor);
  const next = startOfMonthDay(month + 32);
  return { start: startOfWeekDay(month), end: startOfWeekDay(next - 1) + 6 };
}

export function TaskCalendar({ tasks }: { tasks: TaskSummary[] }) {
  const { slug, idx, canEditTasks, updateTask } = useWorkspace();
  const today = toDay(useWorkspaceToday())!;
  const [position, setPosition] = useState<number>();
  const [mode, setMode] = useState<"week" | "month">("month");
  const [over, setOver] = useState<number>();
  const drag = useRef<{ task: TaskSummary; day: number } | null>(null);
  const anchor = position ?? today;
  const month = startOfMonthDay(anchor);
  const { start, end } = taskCalendarDays(anchor, mode);
  const byDay = useMemo(() => {
    const entries: TaskSummary[][] = Array.from({ length: end - start + 1 }, () => []);
    for (const task of tasks) {
      const span = taskSpan(task);
      if (!span) continue;
      for (let day = Math.max(span.start, start); day <= Math.min(span.end, end); day++) {
        entries[day - start]!.push(task);
      }
    }
    return entries;
  }, [tasks, start, end]);

  function move(direction: -1 | 1) {
    setPosition(
      mode === "week" ? anchor + direction * 7 : startOfMonthDay(month + (direction === -1 ? -1 : 32)),
    );
  }

  function drop(day: number) {
    const selection = drag.current;
    drag.current = null;
    setOver(undefined);
    if (!selection || !canEditTasks) return;
    const task = idx.tasks.get(selection.task.id) ?? selection.task;
    const patch = datePatch(task, shiftDates(task, "move", day - selection.day));
    if (Object.keys(patch).length) void updateTask(task.id, patch);
  }

  return (
    <section className="px-4 py-4" aria-label="Task calendar">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Previous period"
          onClick={() => move(-1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Next period"
          onClick={() => move(1)}
        >
          <ChevronRight />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setPosition(today)}>
          Today
        </Button>
        <h2 className="text-sm font-medium">{headingFormat.format(dateFor(anchor))}</h2>
        <div className="ml-auto flex gap-1" aria-label="Calendar period">
          {(["month", "week"] as const).map((period) => (
            <Button
              type="button"
              key={period}
              variant={mode === period ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={mode === period}
              onClick={() => setMode(period)}
              className="capitalize"
            >
              {period}
            </Button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[42rem] grid-cols-7 overflow-hidden rounded-md border">
          {weekdays.map((label) => (
            <div key={label} className="border-b bg-muted/40 px-2 py-2 text-xs font-medium">
              {label}
            </div>
          ))}
          {byDay.map((items, offset) => {
            const day = start + offset;
            const iso = fromDay(day);
            return (
              <div
                key={day}
                aria-label={fullDateFormat.format(dateFor(day))}
                className={cn(
                  "min-h-24 min-w-0 border-r border-b p-1.5",
                  mode === "month" && startOfMonthDay(day) !== month && "bg-muted/30",
                  over === day && "bg-accent",
                )}
                onDragOver={(event) => {
                  if (drag.current && canEditTasks) {
                    event.preventDefault();
                    setOver(day);
                  }
                }}
                onDrop={(event) => {
                  if (drag.current) {
                    event.preventDefault();
                    drop(day);
                  }
                }}
              >
                <time
                  dateTime={iso}
                  aria-current={day === today ? "date" : undefined}
                  className={cn(
                    "mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs",
                    day === today && "bg-primary text-primary-foreground",
                  )}
                >
                  {Number(iso.slice(-2))}
                </time>
                {items.map((task) => (
                  <Link
                    key={task.id}
                    href={`/${slug}/task/${task.id}`}
                    draggable={canEditTasks}
                    onDragStart={(event) => {
                      if (!canEditTasks) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.setData("text/plain", task.title);
                      event.dataTransfer.effectAllowed = "move";
                      drag.current = { task, day };
                    }}
                    onDragEnd={() => {
                      drag.current = null;
                      setOver(undefined);
                    }}
                    className="mb-1 flex min-w-0 items-center gap-1 rounded bg-secondary px-1.5 py-1 text-xs hover:underline"
                  >
                    <StatusIcon type={idx.states.get(task.stateId)?.type ?? "backlog"} />
                    <span className="truncate">{task.title}</span>
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
