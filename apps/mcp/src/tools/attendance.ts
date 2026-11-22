import { z } from "zod";
import type { Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/**
 * Attendance module: read-only. Agents can see shifts, missing clock events and who is on site;
 * clocking, roll calls, voids, payroll files and kiosk pairing are people's acts in the app.
 */
export function registerAttendanceTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  define(
    "get_attendance_shifts",
    {
      module: "attendance",
      title: "Shifts and hours",
      description:
        "Shifts worked between two dates (local dates in the workspace's time zone, at most 93 days), per person: clock-in and clock-out, paid hours after rounding and breaks, basic and overtime hours, and issues (missing clock-in or clock-out, or longer than the maximum shift) that pay nothing until a manager fixes them. Needs write access to attendance. Set issues_only to list just the problems.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        from: isoDate,
        to: isoDate,
        department: z.string().max(200).optional(),
        issues_only: z.boolean().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const res = await api.call(
        ws(api).attendance.shifts.$get({
          param: { slug },
          query: {
            from: a.from,
            to: a.to,
            ...(a.department ? { department: a.department } : {}),
            ...(a.issues_only ? { issues: "true" } : {}),
          },
        }),
      );
      return {
        from: res.from,
        to: res.to,
        timeZone: res.timeZone,
        issues: res.issues,
        people: res.people.map((p) => ({
          staffNumber: p.staff.staffNumber,
          name: `${p.staff.firstName} ${p.staff.lastName}`,
          paidHours: hours(p.totals.paidMinutes),
          basicHours: hours(p.totals.basicMinutes),
          overtimeHours: hours(p.totals.overtimeMinutes),
          shifts: p.shifts.map((s) => ({
            date: s.date,
            start: s.start,
            end: s.end,
            paidHours: hours(s.paidMinutes),
            onSiteNow: s.open,
            issue: s.issue,
          })),
        })),
      };
    },
  );

  define(
    "who_is_on_site",
    {
      module: "attendance",
      title: "Who is on site",
      description:
        "Staff clocked in now and visitors signed in today, plus anyone who may have left without clocking or signing out. For a real emergency use the app's roll call, not this tool.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async ({ workspace }, api) => {
      const slug = await slugOf(api, workspace);
      const here = await api.call(ws(api).attendance["on-site"].$get({ param: { slug } }));
      const person = (s: { staffNumber: string; firstName: string; lastName: string; since: string }) => ({
        staffNumber: s.staffNumber,
        name: `${s.firstName} ${s.lastName}`,
        since: s.since,
      });
      const visitor = (v: {
        firstName: string;
        lastName: string;
        company: string | null;
        hostName: string | null;
        since: string;
      }) => ({
        name: `${v.firstName} ${v.lastName}`,
        company: v.company,
        visiting: v.hostName,
        since: v.since,
      });
      return {
        at: here.at,
        staff: here.staff.map(person),
        visitors: here.visitors.map(visitor),
        possiblyLeft: {
          staff: here.possiblyLeft.staff.map(person),
          visitors: here.possiblyLeft.visitors.map(visitor),
        },
      };
    },
  );
}
