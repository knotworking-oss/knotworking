import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { hash } from "./commercial";

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
// Europe/London is UTC+0 in winter and UTC+1 in summer; today is November so UTC == local time.

export async function attendance(ctx: Ctx) {
  const { api, today } = ctx;
  let made = 0;
  await api.patch("/attendance/settings", {
    roundingMinutes: 5,
    breakAfterHours: 6,
    breakMinutes: 30,
    maxShiftHours: 14,
    overtimeAfterWeeklyHours: 40,
    payrollFormat: "generic",
    visitorRetentionMonths: 24,
    badgeRequiresPin: true,
    offlineReplayHours: 72,
    visitorSiteRules:
      "Sign in at reception. Wear the visitor badge and whites supplied. No food or drink in production areas. Report any illness before entering.",
  });

  const devices = (await api.get("/attendance/devices")).devices as any[];
  if (!devices.length) {
    for (const name of ["Staff entrance kiosk", "Goods-in kiosk"])
      await api.post("/attendance/devices", { name });
    made += 2;
  }

  const staff = ((await api.get("/people/staff?limit=500")).staff as any[]).filter(
    (s) => !s.firstName.startsWith("Demo"),
  );
  // Has anyone got clock events in the last two weeks already? (people with events are listed per period)
  const probe = (await api.get(
    `/attendance/shifts?from=${addDays(today, -14)}&to=${addDays(today, -1)}`,
  )) as any;
  const hasEvents = (probe.people?.length ?? 0) > 3;
  if (!hasEvents) {
    const rota = (await api.get(`/workforce/rota?from=${addDays(today, -14)}&to=${addDays(today, -1)}`))
      .entries as any[];
    const shiftStart: Record<string, number> = {
      "Early production": 5.5,
      "Late production": 13.5,
      "Warehouse and despatch": 6,
      "Day (office and technical)": 8.5,
      "Cleaning crew": 21.5,
    };
    const shifts = (await api.get("/workforce/shifts")).shifts as any[];
    const startOf = new Map(shifts.map((s) => [s.id, shiftStart[s.name] ?? 8]));
    let n = 0,
      failures = 0;
    console.log(`rota entries in window: ${rota.length}`);
    for (const e of rota) {
      if (e.workDate >= today) continue;
      const staffId = e.staff?.id ?? e.entry?.staffId;
      const h = hash(`${staffId}${e.workDate}`);
      if (h % 23 === 0) continue; // absent / not clocked
      const start = startOf.get(e.shiftId) ?? 8;
      const inMin = Math.round(start * 60 - 8 + (h % 14)); // arrives a few minutes either side
      const hours = 8 + ((h >> 3) % 5) / 10 + ([0, 0, 0, 1][h % 4] ?? 0) / 4;
      const at = (minutes: number, base: string) => {
        const d = new Date(`${base}T00:00:00Z`);
        d.setUTCMinutes(minutes);
        return d.toISOString();
      };
      try {
        await api.post("/attendance/events", {
          staffId,
          kind: "in",
          at: at(inMin, e.workDate),
          reason: "Backfilled from kiosk log",
        });
        await api.post("/attendance/events", {
          staffId,
          kind: "out",
          at: at(inMin + Math.round(hours * 60), e.workDate),
          reason: "Backfilled from kiosk log",
        });
        n += 2;
      } catch (err) {
        if (failures++ < 3) console.warn("clock event:", String((err as Error).message).slice(0, 220));
      }
    }
    made += n;
  }

  // Fire drill roll call
  const rolls = (await api.get("/attendance/roll-calls")).rollCalls as any[];
  if (!rolls.length) {
    const rc = pick(
      await api.post("/attendance/roll-calls", { kind: "drill", notes: "Quarterly fire drill, whole site." }),
      "rollCall",
    );
    await api
      .post(`/attendance/roll-calls/${rc.id}/end`, {
        notes: "Evacuation complete in 3 minutes 40 seconds. All accounted for.",
      })
      .catch(() => {});
    made++;
  }
  return `${made} attendance records`;
}
