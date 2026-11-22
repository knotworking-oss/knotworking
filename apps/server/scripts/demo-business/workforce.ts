import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { hash } from "./commercial";
import { loginAs } from "./team";

const MON_FRI = 0b0011111,
  MON_SAT = 0b0111111;

export async function workforce(ctx: Ctx) {
  const { api, today } = ctx;
  const role = ctx.ids.role!,
    line = ctx.ids.line!,
    course = ctx.ids.course!;
  const hr = await loginAs(ctx, "rhys@knotmilk.example");
  let made = 0;

  // Agency staff records
  const staff = (await api.get("/people/staff?status=all&limit=500")).staff as any[];
  const agencyStaff = [
    ["Tyrone", "Webb"],
    ["Aleksandra", "Wrona"],
    ["Kofi", "Mensah"],
  ];
  for (const [firstName, lastName] of agencyStaff) {
    if (staff.some((s) => s.firstName === firstName && s.lastName === lastName)) continue;
    await api.post("/people/staff", {
      firstName,
      lastName,
      jobTitle: "Agency production operative",
      department: "Production",
      startDate: addDays(today, -40),
      jobRoleIds: [role["Production operative"]],
    });
    made++;
  }
  const all = (await api.get("/people/staff?limit=500")).staff as any[];
  const byName = (f: string, l: string) => all.find((s) => s.firstName === f && s.lastName === l);

  // Shifts
  const shiftsList = (await api.get("/workforce/shifts")).shifts as any[];
  const shift: Record<string, string> = {};
  for (const s of [
    {
      name: "Early production",
      startTime: "05:30",
      endTime: "13:30",
      lineId: line["Milk pasteurising & bottling line"],
    },
    {
      name: "Late production",
      startTime: "13:30",
      endTime: "21:30",
      lineId: line["Yogurt incubation & filling line"],
    },
    { name: "Warehouse and despatch", startTime: "06:00", endTime: "14:00", lineId: null },
    { name: "Day (office and technical)", startTime: "08:30", endTime: "17:00", lineId: null },
    { name: "Cleaning crew", startTime: "21:30", endTime: "05:30", lineId: null },
  ]) {
    let hit = shiftsList.find((x) => x.name === s.name);
    if (!hit) {
      hit = pick(await api.post("/workforce/shifts", { commandId: randomUUID(), ...s }), "shift");
      made++;
    }
    shift[s.name] = hit.id;
  }

  // Working patterns
  const patterns = (await api.get("/workforce/patterns")).patterns as any[];
  const havePattern = new Set(patterns.map((p) => p.staffId));
  let early = 0;
  for (const s of all) {
    if (s.firstName.startsWith("Demo") || havePattern.has(s.id)) continue;
    const roles = (s.jobRoles as any[]).map((r) => r.name);
    const dep = s.department as string;
    let shiftName = "Day (office and technical)",
      mask = MON_FRI,
      jobRole: string | null = null;
    if (["Warehouse", "Distribution"].includes(dep)) {
      shiftName = "Warehouse and despatch";
      mask = MON_SAT;
    } else if (dep === "Hygiene") {
      shiftName = "Cleaning crew";
      mask = MON_FRI;
      jobRole = role["Cleaner"] ?? null;
    } else if (dep === "Production" || dep === "Engineering") {
      shiftName = early++ % 2 === 0 ? "Early production" : "Late production";
      if (dep === "Engineering") shiftName = "Early production";
      jobRole = role[roles[0]] ?? null;
    }
    if (s.firstName === "Isla" || s.firstName === "Dev") shiftName = "Early production";
    await api.post("/workforce/patterns", {
      commandId: randomUUID(),
      staffId: s.id,
      shiftId: shift[shiftName],
      weekdays: mask,
      jobRoleId: jobRole ?? (roles[0] ? role[roles[0]] : null),
      validFrom: addDays(today, -200),
      validTo: null,
    });
    made++;
  }

  // Rota for the last fortnight and next four weeks
  const rota = (await api.get(`/workforce/rota?from=${addDays(today, 0)}&to=${addDays(today, 6)}`))
    .entries as any[] | undefined;
  if (!rota || rota.length < 10) {
    await api
      .post("/workforce/rota/generate", {
        commandId: randomUUID(),
        from: addDays(today, -14),
        to: addDays(today, 28),
      })
      .catch(async (e) => {
        console.warn("rota generate:", String(e.message).slice(0, 200));
      });
  }

  // Agencies
  const agencies = (await api.get("/workforce/agencies")).agencies as any[];
  const agencyId: Record<string, string> = {};
  for (const [name, contact] of [
    ["Westcountry Temps", "Karen Birch, 01278 555 0415"],
    ["FoodStaff Recruitment", "Ollie Grant, 0117 555 0422"],
  ]) {
    let hit = agencies.find((a) => a.name === name);
    if (!hit) {
      hit = pick(await api.post("/workforce/agencies", { commandId: randomUUID(), name, contact }), "agency");
      made++;
    }
    agencyId[name!] = hit.id;
  }
  const eng = (await api.get("/workforce/agencies")).engagements as any[];
  if (!eng.length) {
    for (const [i, [f, l]] of agencyStaff.entries()) {
      const s = byName(f!, l!);
      if (s) {
        await api.post("/workforce/agency-engagements", {
          commandId: randomUUID(),
          agencyId: agencyId[i < 2 ? "Westcountry Temps" : "FoodStaff Recruitment"],
          staffId: s.id,
          startOn: addDays(today, -40),
          endOn: addDays(today, 50),
          reference: `AG-${2600 + i}`,
        });
        made++;
      }
    }
  }

  // Minimum staffing requirements
  const reqs = (await api.get("/workforce/staffing/requirements")).requirements as any[];
  if (!reqs.length) {
    for (const r of [
      {
        shiftId: shift["Early production"],
        name: "Pasteuriser operators, early shift",
        headcount: 2,
        jobRoleId: role["Pasteuriser operator"],
        courseIds: [course["TRN-HTST"]!],
        weekdays: MON_FRI,
        appliesWhen: "production_planned",
      },
      {
        shiftId: shift["Early production"],
        name: "Production operatives, early shift",
        headcount: 5,
        jobRoleId: role["Production operative"],
        courseIds: [course["TRN-FH2"]!],
        weekdays: MON_FRI,
        appliesWhen: "production_planned",
      },
      {
        shiftId: shift["Late production"],
        name: "Production operatives, late shift",
        headcount: 4,
        jobRoleId: role["Production operative"],
        courseIds: [course["TRN-FH2"]!],
        weekdays: MON_FRI,
        appliesWhen: "production_planned",
      },
      {
        shiftId: shift["Warehouse and despatch"],
        name: "Warehouse operatives",
        headcount: 2,
        jobRoleId: role["Warehouse operative"],
        courseIds: [course["TRN-FORK"]!],
        weekdays: MON_SAT,
        appliesWhen: "always",
      },
      {
        shiftId: shift["Cleaning crew"],
        name: "Night cleaning crew",
        headcount: 2,
        jobRoleId: role["Cleaner"],
        courseIds: [course["TRN-CIP"]!],
        weekdays: MON_FRI,
        appliesWhen: "always",
      },
    ]) {
      await api
        .post("/workforce/staffing/requirements", {
          commandId: randomUUID(),
          validFrom: addDays(today, -200),
          validTo: null,
          ...r,
        })
        .catch((e) => console.warn("requirement:", String(e.message).slice(0, 160)));
      made++;
    }
  }

  // Absences (HR-recorded): leave and sickness
  const abs = (await api.get("/workforce/hr/absences")).absences as any[];
  if (abs.length < 6) {
    const cases: [string, string, string, number, number, string][] = [
      ["Tom", "Eastwood", "annual_leave", -20, -16, "approve"],
      ["Ruth", "Adeyemi", "annual_leave", 12, 21, "approve"],
      ["Jakub", "Nowak", "sickness", -9, -7, "record"],
      ["Beth", "Calloway", "annual_leave", 30, 34, "pending"],
      ["Mateusz", "Kowalski", "annual_leave", 8, 12, "approve"],
      ["Sophie", "Lang", "other_leave", -3, -3, "record"],
      ["Craig", "Morrison", "annual_leave", 40, 54, "pending"],
      ["Kasia", "Zielinski", "sickness", -2, 0, "record"],
      ["Stuart", "Kerr", "annual_leave", 19, 25, "approve"],
      ["Marta", "Silva", "annual_leave", -45, -38, "approve"],
      ["Gemma", "Lloyd", "annual_leave", 55, 62, "pending"],
    ];
    for (const [f, l, kind, s, e, action] of cases) {
      const person = byName(f, l);
      if (!person) continue;
      const created = pick(
        await api.post("/workforce/hr/absences", {
          commandId: randomUUID(),
          staffId: person.id,
          kind,
          startOn: addDays(today, s),
          endOn: addDays(today, e),
          staffNote: kind === "sickness" ? "Called in sick." : "Requested via HR.",
          hrNote: "",
        }),
        "absence",
      );
      if (action !== "pending")
        await api
          .post(`/workforce/hr/absences/${created.id}/decision`, {
            commandId: randomUUID(),
            expectedRevision: created.revision ?? 1,
            action: action === "record" ? "record" : "approve",
            reason: action === "record" ? "Recorded by HR." : "Approved — cover available.",
            hrNote: "",
          })
          .catch((er) => console.warn("decision:", String(er.message).slice(0, 160)));
      made++;
    }
  }

  // Payroll run for the previous calendar month
  const runs = (await api.get("/workforce/hr/payroll-runs")).runs as any[] | undefined;
  if (runs && !runs.length) {
    const first = new Date(`${today}T00:00:00Z`);
    first.setUTCDate(1);
    const toDate = new Date(first.getTime() - 86400000),
      fromDate = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), 1));
    const run = await api
      .post("/workforce/hr/payroll-runs", {
        commandId: randomUUID(),
        from: fromDate.toISOString().slice(0, 10),
        to: toDate.toISOString().slice(0, 10),
        note: "Monthly payroll preparation.",
      })
      .then((r) => pick(r, "run"))
      .catch((e) => {
        console.warn("payroll prepare:", String(e.message).slice(0, 200));
        return null;
      });
    if (run?.id)
      await hr
        .post(`/workforce/hr/payroll-runs/${run.id}/approve`, {
          commandId: randomUUID(),
          expectedRevision: run.revision ?? 1,
          note: "Checked against timesheets.",
        })
        .catch((e) => console.warn("payroll approve:", String(e.message).slice(0, 200)));
    made++;
  }
  return `${made} workforce records`;
}
