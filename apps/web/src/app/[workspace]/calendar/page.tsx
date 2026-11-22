import type { Metadata } from "next";
import { CalendarView } from "@/components/calendar/calendar-view";
import { getBootstrap, getCalendar, getCalendarConnections, getMe } from "@/lib/api";

export const metadata: Metadata = { title: "Calendar" };

const DAY = 86_400_000;

/** Monday (UTC) of the week containing `d` — the client re-derives in local time. */
function utcMonday(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * DAY);
}

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const [{ workspace: slug }, { week }] = await Promise.all([params, searchParams]);
  const monday =
    week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? new Date(`${week}T00:00:00Z`) : utcMonday(new Date());
  // Fetch a day either side so every time zone's local week is covered.
  const from = new Date(monday.getTime() - DAY).toISOString();
  const to = new Date(monday.getTime() + 8 * DAY).toISOString();

  const [calendar, { connections, available }, boot, me] = await Promise.all([
    getCalendar(slug, from, to),
    getCalendarConnections(),
    getBootstrap(slug),
    getMe(),
  ]);

  return (
    <CalendarView
      slug={slug}
      week={monday.toISOString().slice(0, 10)}
      explicitWeek={Boolean(week)}
      meetings={calendar.meetings}
      events={calendar.events}
      connections={connections}
      available={available}
      members={boot.users.map((u) => ({ id: u.id, name: u.name, email: u.email }))}
      currentUser={{ id: me.user.id, role: me.workspaces.find((w) => w.slug === slug)?.role ?? "member" }}
      documents={boot.documents.map((d) => ({ id: d.id, title: d.title }))}
    />
  );
}
