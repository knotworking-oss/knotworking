import type { Hono } from "hono";

/** In-memory stand-in for the read-only Attendance routes the MCP tools use. */
export function mountFakeAttendance(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const grace = {
    id: "g",
    staffNumber: "100001",
    firstName: "Grace",
    lastName: "Hopper",
    department: "Production",
  };
  const alan = {
    id: "a",
    staffNumber: "100002",
    firstName: "Alan",
    lastName: "Turing",
    department: "Hygiene",
  };
  const shift = (date: string, paidMinutes: number, issue: string | null = null) => ({
    inEventId: "i",
    outEventId: issue ? null : "o",
    start: `${date}T08:00:00.000Z`,
    end: issue ? null : `${date}T16:30:00.000Z`,
    date,
    minutes: issue ? null : 510,
    paidMinutes,
    open: false,
    issue,
  });
  const people = [
    {
      staff: grace,
      shifts: [shift("2026-03-02", 480)],
      totals: { shifts: 1, paidMinutes: 480, basicMinutes: 450, overtimeMinutes: 30, issues: 0 },
    },
    {
      staff: alan,
      shifts: [shift("2026-03-03", 0, "missing_out")],
      totals: { shifts: 0, paidMinutes: 0, basicMinutes: 0, overtimeMinutes: 0, issues: 1 },
    },
  ];
  app.get(`${ws}/attendance/shifts`, (c) => {
    const from = c.req.query("from")!;
    const to = c.req.query("to")!;
    if (from > to) return c.json(err("invalid_input", "`from` is after `to`"), 400);
    const rows = c.req.query("issues") === "true" ? people.filter((p) => p.totals.issues > 0) : people;
    return c.json({ from, to, timeZone: "Europe/London", people: rows, issues: 1 });
  });
  app.get(`${ws}/attendance/on-site`, (c) =>
    c.json({
      at: "2026-03-03T10:00:00.000Z",
      staff: [{ ...grace, status: "active", since: "2026-03-03T07:58:00.000Z" }],
      visitors: [{ id: "v", firstName: "Mary", lastName: "Somerville", since: "2026-03-03T09:00:00.000Z" }],
      possiblyLeft: {
        staff: [{ ...alan, status: "active", since: "2026-03-01T08:00:00.000Z" }],
        visitors: [],
      },
    }),
  );
}
