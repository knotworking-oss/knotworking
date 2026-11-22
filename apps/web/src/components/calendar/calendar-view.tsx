"use client";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { cn } from "@knotworking/ui/lib/utils";
import { CalendarCog, CalendarPlus, ChevronLeft, ChevronRight, Plug } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
  addDays,
  dateOnlyToLocal,
  formatTime,
  formatWeekday,
  formatWeekRange,
  HOUR_PX,
  isoDate,
  parseIsoDate,
  sameDay,
  startOfDay,
  startOfWeek,
} from "@/lib/calendar-dates";
import { EventSheet } from "./event-sheet";
import { MeetingDialog, type MeetingDraft } from "./meeting-dialog";
import type { CalendarConnection, CalendarItem, Meeting, Member, PersonalEvent } from "./types";

interface Props {
  slug: string;
  week: string;
  meetings: Meeting[];
  events: PersonalEvent[];
  connections: CalendarConnection[];
  available: ("google" | "microsoft")[];
  members: Member[];
  currentUser: { id: string; role: string };
  documents: { id: string; title: string }[];
  /** True when the URL named the week; otherwise it's the server's UTC guess. */
  explicitWeek: boolean;
}

/** All-day items are dates (UTC midnight) shown on the same local date; timed items are instants. */
function span(startsAt: string, endsAt: string, allDay: boolean) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return allDay ? { start: dateOnlyToLocal(start), end: dateOnlyToLocal(end) } : { start, end };
}

export function CalendarView(props: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [selected, setSelected] = useState<CalendarItem | null>(null);
  const [draft, setDraft] = useState<MeetingDraft | null>(null);
  useEffect(() => setMounted(true), []);

  // The week is interpreted in the viewer's own time zone.
  const weekStart = useMemo(() => startOfWeek(parseIsoDate(props.week) ?? new Date()), [props.week]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const go = (d: Date) => router.push(`${pathname}?week=${isoDate(startOfWeek(d))}`);

  // Without ?week the server guessed the week in UTC; if the viewer's local week differs
  // (e.g. Sunday evening in the Americas), reload the right range.
  useEffect(() => {
    if (props.explicitWeek) return;
    const local = isoDate(startOfWeek(new Date()));
    if (local !== props.week) router.replace(`${pathname}?week=${local}`);
  }, [props.explicitWeek, props.week, pathname, router]);

  const items: CalendarItem[] = useMemo(
    () => [
      ...props.meetings.map((m) => ({
        key: `m:${m.id}`,
        title: m.title,
        ...span(m.startsAt, m.endsAt, m.allDay),
        allDay: m.allDay,
        cancelled: m.status === "cancelled",
        tone: "meeting" as const,
        meeting: m,
      })),
      ...props.events.map((e) => ({
        key: `e:${e.id}`,
        title: e.title,
        ...span(e.startsAt, e.endsAt, e.allDay),
        allDay: e.allDay,
        cancelled: false,
        tone: e.provider,
        event: e,
      })),
    ],
    [props.meetings, props.events],
  );

  const hasConnection = props.connections.length > 0;
  const openNew = (start?: Date) => {
    const s = start ?? nextHalfHour();
    setDraft({ start: s, end: new Date(s.getTime() + 30 * 60_000) });
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/${props.slug}/settings/calendars`}>
                <CalendarCog /> <span className="max-lg:sr-only">Calendars</span>
              </Link>
            </Button>
            {props.currentUser.role !== "guest" && (
              <Button size="sm" onClick={() => openNew()}>
                <CalendarPlus /> <span className="max-lg:sr-only">New meeting</span>
              </Button>
            )}
          </>
        }
      >
        <h1 className="font-medium max-sm:sr-only">Calendar</h1>
        <div className="flex items-center gap-1 sm:ml-2">
          <Button variant="outline" size="sm" onClick={() => go(new Date())}>
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous week"
            onClick={() => go(addDays(weekStart, -7))}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next week"
            onClick={() => go(addDays(weekStart, 7))}
          >
            <ChevronRight />
          </Button>
          <span className="ml-1 text-sm whitespace-nowrap text-muted-foreground">
            {mounted ? formatWeekRange(weekStart) : ""}
          </span>
        </div>
      </PageHeader>

      {!hasConnection && (
        <div className="border-b px-4 py-3">
          <Alert>
            <Plug />
            <AlertTitle>
              {props.available.length ? "Connect your calendar" : "Calendar sync isn't set up on this server"}
            </AlertTitle>
            <AlertDescription>
              {props.available.length
                ? "See your Google or Outlook events here, and send invitations for meetings you create in Knotworking."
                : "Meetings you create stay in Knotworking. An admin can enable Google or Microsoft calendar sync (see docs/calendar.md)."}
            </AlertDescription>
            {props.available.length > 0 && (
              <AlertAction>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/${props.slug}/settings/calendars`}>Connect</Link>
                </Button>
              </AlertAction>
            )}
          </Alert>
        </div>
      )}

      {mounted ? (
        <WeekGrid
          days={days}
          items={items}
          onSelect={setSelected}
          onCreate={props.currentUser.role === "guest" ? () => {} : openNew}
        />
      ) : (
        <div className="flex-1" />
      )}

      <EventSheet
        item={selected}
        slug={props.slug}
        currentUser={props.currentUser}
        documents={props.documents}
        onClose={() => setSelected(null)}
        onEdit={(m) => {
          setSelected(null);
          setDraft({ meeting: m, ...span(m.startsAt, m.endsAt, m.allDay) });
        }}
      />
      <MeetingDialog
        draft={draft}
        slug={props.slug}
        members={props.members.filter((m) => m.id !== props.currentUser.id)}
        connections={props.connections}
        onClose={() => setDraft(null)}
      />
    </>
  );
}

function nextHalfHour() {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

const tones = {
  meeting: "bg-label-purple-bg text-label-purple border-label-purple",
  google: "bg-label-blue-bg text-label-blue border-label-blue",
  microsoft: "bg-label-teal-bg text-label-teal border-label-teal",
} as const;

/** Hour gutter, then seven day columns that never shrink below 6rem. */
const GRID_COLS = "grid-cols-[56px_repeat(7,minmax(6rem,1fr))]";

function WeekGrid({
  days,
  items,
  onSelect,
  onCreate,
}: {
  days: Date[];
  items: CalendarItem[];
  onSelect: (item: CalendarItem) => void;
  onCreate: (start: Date) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    scroller.current?.scrollTo({ top: 8 * HOUR_PX - 8 });
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const allDayByDay = days.map((d) => items.filter((i) => i.allDay && i.start < addDays(d, 1) && i.end > d));
  const hasAllDay = allDayByDay.some((x) => x.length);

  return (
    // One scroller for both axes: on narrow screens the seven day columns keep a readable minimum width and
    // the grid scrolls sideways, with the day headers and the hour gutter pinned.
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
      <div className="flex min-w-[calc(56px+7*6rem)] flex-col">
        <div className="sticky top-0 z-20 bg-background">
          {/* Day headers */}
          <div className={cn("grid border-b", GRID_COLS)}>
            <div className="sticky left-0 z-10 bg-background" />
            {days.map((d) => (
              <div
                key={d.toISOString()}
                className="flex items-baseline justify-center gap-1.5 border-l py-2 text-sm"
              >
                <span className="text-muted-foreground">{formatWeekday(d)}</span>
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full font-medium tabular-nums",
                    sameDay(d, now) && "bg-primary text-primary-foreground",
                  )}
                >
                  {d.getDate()}
                </span>
              </div>
            ))}
          </div>

          {hasAllDay && (
            <div className={cn("grid border-b", GRID_COLS)}>
              <div className="sticky left-0 z-10 bg-background py-1 pr-2 text-right text-[10px] text-muted-foreground">
                all-day
              </div>
              {allDayByDay.map((list, i) => (
                <div key={i} className="flex flex-col gap-0.5 border-l p-1">
                  {list.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onSelect(item)}
                      className={cn(
                        "truncate rounded-sm border-l-2 px-1.5 py-0.5 text-left text-xs font-medium",
                        tones[item.tone],
                        item.cancelled && "line-through opacity-60",
                      )}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Time grid */}
        <div className={cn("relative grid", GRID_COLS)} style={{ height: 24 * HOUR_PX }}>
          <div className="sticky left-0 z-10 bg-background">
            {Array.from({ length: 24 }, (_, h) => (
              <span
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
                style={{ top: h * HOUR_PX }}
              >
                {h === 0 ? "" : formatTime(new Date(2000, 0, 1, h))}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className="relative border-l"
              onDoubleClick={(e) => {
                const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                const minutes = Math.floor(y / (HOUR_PX / 2)) * 30;
                const start = startOfDay(day);
                start.setMinutes(minutes);
                onCreate(start);
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div
                  key={h}
                  className="absolute inset-x-0 border-t border-border/60"
                  style={{ top: h * HOUR_PX }}
                />
              ))}
              {layoutDay(day, items).map(({ item, top, height, col, cols }) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onSelect(item)}
                  title={item.title}
                  className={cn(
                    "absolute overflow-hidden rounded-md border-l-2 px-1.5 py-0.5 text-left text-xs leading-tight shadow-xs transition-[filter] hover:brightness-95 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    tones[item.tone],
                    item.cancelled && "line-through opacity-60",
                  )}
                  style={{
                    top,
                    height,
                    left: `calc(${(col / cols) * 100}% + 2px)`,
                    width: `calc(${100 / cols}% - 4px)`,
                  }}
                >
                  <span className="block truncate font-medium">{item.title}</span>
                  {height > 30 && <span className="block truncate opacity-80">{formatTime(item.start)}</span>}
                </button>
              ))}
              {sameDay(day, now) && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-destructive before:absolute before:-top-1 before:-left-1 before:size-2.5 before:rounded-full before:bg-destructive"
                  style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Positions a day's timed items; overlapping items share the width in columns. */
function layoutDay(day: Date, items: CalendarItem[]) {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const timed = items
    .filter((i) => !i.allDay && i.start < dayEnd && i.end > dayStart)
    .map((item) => {
      const s = Math.max(item.start.getTime(), dayStart.getTime());
      const e = Math.min(item.end.getTime(), dayEnd.getTime());
      return { item, s, e };
    })
    .sort((a, b) => a.s - b.s || b.e - a.e);

  const out: { item: CalendarItem; top: number; height: number; col: number; cols: number }[] = [];
  let cluster: { item: CalendarItem; s: number; e: number; col: number }[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) {
      const minutes = (c.s - dayStart.getTime()) / 60_000;
      const duration = Math.max(20, (c.e - c.s) / 60_000);
      out.push({
        item: c.item,
        top: (minutes / 60) * HOUR_PX,
        height: (duration / 60) * HOUR_PX - 2,
        col: c.col,
        cols,
      });
    }
    cluster = [];
  };
  for (const t of timed) {
    if (t.s >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    const used = new Set(cluster.filter((c) => c.e > t.s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ ...t, col });
    clusterEnd = Math.max(clusterEnd, t.e);
  }
  flush();
  return out;
}
