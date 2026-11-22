import { rotaQuerySchema, staffingQuerySchema, workforceAvailabilitySchema } from "@knotworking/core";
import type { Hono } from "hono";
export function mountFakeWorkforce(app: Hono, ws: string) {
  app.get(`${ws}/workforce/availability`, (c) => {
    const parsed = workforceAvailabilitySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: { code: "invalid_input", message: "Choose a window of up to 366 days" } }, 400);
    return c.json({
      sourceEnabled: true,
      availability: parsed.data.offset
        ? []
        : [
            {
              staffId: "staff-a",
              staffNumber: "100001",
              firstName: "Test",
              lastName: "Colleague",
              from: parsed.data.from,
              to: parsed.data.to,
              availability: "unavailable",
            },
          ],
      hasMore: false,
    });
  });
  app.get(`${ws}/workforce/rota`, (c) => {
    const parsed = rotaQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: { code: "invalid_input", message: "Choose a window of up to 31 days" } }, 400);
    return c.json({
      ...parsed.data,
      absenceSourceEnabled: true,
      shifts: [
        { id: "shift-a", name: "Early", startTime: "06:00", endTime: "14:00", lineId: null, active: true },
      ],
      entries: [
        {
          id: "entry-a",
          shiftId: "shift-a",
          workDate: parsed.data.from,
          staff: { id: "staff-a", staffNumber: "100001", firstName: "Test", lastName: "Colleague" },
          jobRole: null,
          agency: null,
          unavailable: false,
        },
      ],
    });
  });
  app.get(`${ws}/workforce/staffing`, (c) => {
    const parsed = staffingQuerySchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: { code: "invalid_input", message: "Choose a window of up to 31 days" } }, 400);
    return c.json({
      ...parsed.data,
      absenceSourceEnabled: true,
      trainingSourceEnabled: true,
      productionSourceEnabled: true,
      summary: { requirementsChecked: 1, shortfalls: 1, unfilledPositions: 1 },
      shifts: [],
    });
  });
}
