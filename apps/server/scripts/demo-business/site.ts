import type { Ctx } from "./api";
import { addDays } from "./api";
import { hash } from "./commercial";
import { loginAs } from "./team";

import { pickRecord as pick } from "./api";
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export async function site(ctx: Ctx) {
  const { api, today } = ctx;
  const area = ctx.ids.haccpAsset!,
    user = ctx.ids.user!;
  const reviewer = await loginAs(ctx, "hannah@knotmilk.example");
  const eng = user["rhys@knotmilk.example"];
  let made = 0;
  const days: string[] = [];
  for (let d = -21; d <= -1; d++) {
    const day = addDays(today, d);
    if (dow(day) >= 1 && dow(day) <= 6) days.push(day);
  }

  // ── Storage monitoring ──
  const units = (await api.get("/site/storage/units?status=all")).units as any[];
  const unitIds: Record<string, string> = {};
  const unitDefs: [string, string, string, string, number | null, number | null, string, string][] = [
    [
      "ST-RAWCH",
      "Raw materials chiller",
      "chiller",
      "temperature",
      0,
      5,
      "°C",
      "Chilled raw materials store",
    ],
    ["ST-FGCH1", "Finished goods chiller 1", "chiller", "temperature", 0, 5, "°C", "Finished goods"],
    ["ST-FGCH2", "Finished goods chiller 2", "chiller", "temperature", 0, 5, "°C", "Finished goods"],
    ["ST-FRZ1", "Culture freezer", "freezer", "temperature", -25, -16, "°C", "Raw materials"],
    ["ST-DRY", "Dry ingredient store", "ambient", "temperature", 5, 25, "°C", "Dry store"],
    ["ST-DRYRH", "Dry ingredient store humidity", "ambient", "humidity", 30, 65, "%RH", "Dry store"],
  ];
  for (const [code, name, kind, measure, min, max, unit, location] of unitDefs) {
    let hit = units.find((u) => u.code === code);
    if (!hit) {
      hit = pick(
        await api.post("/site/storage/units", {
          code,
          name,
          kind,
          measure,
          location,
          limitMin: min,
          limitMax: max,
          unit,
          readingFrequency: { every: 1, unit: "day" },
        }),
        "unit",
      );
      made++;
    }
    unitIds[code] = hit.id;
  }
  if (!((await api.get("/site/storage/readings?limit=1")).readings as any[]).length) {
    let n = 0;
    for (const day of days)
      for (const [code, , , , min, max] of unitDefs) {
        for (const hr of [7, 15]) {
          const h = hash(code + day + hr);
          const mid = ((min ?? 0) + (max ?? 0)) / 2,
            span = ((max ?? 0) - (min ?? 0)) / 2;
          let v = Math.round((mid + (((h % 100) - 50) / 50) * span * 0.55) * 10) / 10;
          const out = code === "ST-FGCH1" && day === addDays(today, -11) && hr === 15;
          if (out) v = 6.9;
          const body: any = {
            unitId: unitIds[code],
            value: v,
            checkedAt: `${day}T${String(hr).padStart(2, "0")}:${10 + (h % 40)}:00.000Z`,
          };
          if (out) {
            body.note = "Door left ajar during loading.";
            body.correctiveAction = {
              actionTaken:
                "Door closed; temperature recovered to 3.5°C within 25 minutes; stock checked against probe log.",
              rootCause: "Door seal worn and loading took longer than normal.",
              preventiveAction: "Door seal replaced; strip curtain fitted.",
            };
          }
          await api.post("/site/storage/readings", body);
          n++;
        }
      }
    const pending = (
      (await api.get("/site/storage/readings?review=pending&limit=200")).readings as any[]
    ).map((r) => r.id);
    if (pending.length)
      await reviewer
        .post("/site/storage/readings/review", { ids: pending.slice(0, 200), decision: "approved" })
        .catch(() => {});
    made += n;
  }

  // ── Pest control ──
  const devices = (await api.get("/site/pest/devices?status=all")).devices as any[];
  const deviceIds: string[] = [];
  const pestDevs: [string, string, string, string][] = [
    ...[1, 2, 3, 4, 5, 6].map((i): [string, string, string, string] => [
      "rodent_bait_station",
      `RBS-${String(i).padStart(2, "0")}`,
      [
        "Perimeter north",
        "Perimeter east",
        "Perimeter south",
        "Perimeter west",
        "Despatch dock door",
        "Goods-in door",
      ][i - 1]!,
      "AR-GIB",
    ]),
    ["insect_electric_fly_killer", "EFK-01", "Goods-in bay", "AR-GIB"],
    ["insect_electric_fly_killer", "EFK-02", "Production hall entrance", "AR-PROD"],
    ["insect_electric_fly_killer", "EFK-03", "Despatch chiller lobby", "AR-CHILL"],
    ["pheromone_trap", "PHT-01", "Dry ingredient store", "AR-CHILL"],
  ];
  for (const [kind, code, location, a] of pestDevs) {
    let hit = devices.find((d) => d.code === code);
    if (!hit) {
      hit = pick(await api.post("/site/pest/devices", { kind, code, location, areaId: area[a] }), "device");
      made++;
    }
    deviceIds.push(hit.id);
  }
  if (!((await api.get("/site/pest/visits?limit=1")).visits as any[]).length) {
    for (const ago of [-77, -49, -21]) {
      const visitedOn = addDays(today, ago);
      const findings = deviceIds.map((id, i) => {
        const h = hash(id + ago);
        const found = h % 11 === 0;
        return {
          deviceId: id,
          activity: found ? "low" : "none",
          pest: found ? (pestDevs[i]![0].startsWith("insect") ? "Houseflies" : "Mouse") : null,
          count: found ? 1 + (h % 3) : 0,
          note: found ? "Minor activity noted." : "",
          action: found ? "Bait refreshed; area proofed." : "",
        };
      });
      await api.post("/site/pest/visits", {
        contractor: "Rentokill Pest Control",
        technician: ["Gary Thompson", "Leanne Voss"][hash(String(ago)) % 2],
        visitedOn,
        summary: "Routine monthly visit. All devices inspected and serviced.",
        recommendations: "Keep waste area clear of spillage; check door brush seals on despatch dock.",
        actionsTaken: "EFK tubes checked and bait stations replenished.",
        nextVisitOn: addDays(visitedOn, 28),
        findings,
      });
      made++;
    }
  }

  // ── Glass and brittle plastics ──
  const glass = (await api.get("/site/glass/items")).items as any[];
  const glassIds: string[] = glass.map((g) => g.id);
  if (glass.length < 5) {
    const defs: [string, string, string, number, string][] = [
      [
        "AR-PROD",
        "glass",
        "Light diffusers, production hall (polycarbonate covers)",
        24,
        "Production hall ceiling",
      ],
      ["AR-PROD", "brittle_plastic", "Hard plastic sample pots in the lab", 40, "Laboratory"],
      ["AR-PROD", "glass", "Viewing window, pasteuriser room", 1, "Pasteuriser room"],
      ["AR-GIB", "glass", "Office window facing the goods-in bay", 2, "Goods-in office"],
      ["AR-CHILL", "brittle_plastic", "Chiller light covers", 12, "Finished goods chiller 1 and 2"],
    ];
    for (const [a, kind, description, quantity, location] of defs) {
      const r = pick(
        await api.post("/site/glass/items", {
          areaId: area[a],
          kind,
          description,
          quantity,
          location,
          checkFrequency: { every: 1, unit: "month" },
        }),
        "item",
      );
      glassIds.push(r.id);
      made++;
    }
  }
  if (!((await api.get("/site/glass/checks?limit=1")).checks as any[]).length) {
    for (const ago of [-50, -20])
      await api.post("/site/glass/checks", {
        checkedAt: `${addDays(today, ago)}T10:00:00.000Z`,
        checks: glassIds.map((itemId, i) => ({
          itemId,
          condition: i === 1 && ago === -20 ? "damaged" : "intact",
          note: i === 1 && ago === -20 ? "One sample pot cracked; replaced." : null,
        })),
      });
    await api
      .post("/site/glass/breakages", {
        areaId: area["AR-PROD"],
        occurredAt: `${addDays(today, -16)}T11:40:00.000Z`,
        description: "A diffuser cover cracked during ceiling maintenance; no fragments found on equipment.",
        quarantined:
          "Stopped the yogurt line, quarantined product filled in the previous 30 minutes (240 pots).",
        cleanDown: "Area vacuumed and wiped; line restarted after supervisor release.",
      })
      .then(async (b) => {
        if (b.id ?? b.breakage?.id)
          await reviewer
            .post(`/site/glass/breakages/${b.id ?? b.breakage.id}/release`, {
              note: "All quarantined product checked and released.",
            })
            .catch(() => {});
      });
    made += 3;
  }

  // ── Maintenance ──
  const mAssets = (await api.get("/site/maintenance/assets?status=all")).assets as any[];
  const mIds: Record<string, string> = {};
  const assetDefs: [string, string, string, string][] = [
    ["EQ-PAST", "HTST plate pasteuriser", "Production hall", "AR-PROD"],
    ["EQ-FILL1", "Bottle filler and capper", "Bottling hall", "AR-PROD"],
    ["EQ-YOGF", "Yogurt cup filler", "Yogurt filling", "AR-PROD"],
    ["EQ-CHURN", "Butter churn", "Butter room", "AR-PROD"],
    ["EQ-CHILL1", "Chiller 1 refrigeration plant", "Warehouse", "AR-CHILL"],
    ["EQ-BOILER", "Steam boiler", "Plant room", "AR-PROD"],
    ["EQ-COMP", "Air compressor", "Plant room", "AR-PROD"],
    ["EQ-VAN1", "Delivery van KN24 MLK (refrigerated)", "Yard", "AR-GIB"],
  ];
  for (const [code, name, location, a] of assetDefs) {
    let hit = mAssets.find((x) => x.code === code);
    if (!hit) {
      hit = pick(
        await api.post("/site/maintenance/assets", { code, name, location, areaId: area[a] }),
        "asset",
      );
      made++;
    }
    mIds[code] = hit.id;
  }
  const tasks = (await api.get("/site/maintenance/tasks")).tasks as any[];
  const taskIds: Record<string, string> = {};
  const taskDefs: [string, string, string, { every: number; unit: string }, boolean][] = [
    [
      "EQ-PAST",
      "Plate pack inspection and gasket check",
      "Inspect plates and gaskets for leaks and wear.",
      { every: 3, unit: "month" },
      true,
    ],
    [
      "EQ-PAST",
      "Flow diversion valve test",
      "Verify the divert valve moves within 1 second of a low temperature signal.",
      { every: 1, unit: "month" },
      false,
    ],
    [
      "EQ-FILL1",
      "Filler lubrication and torque check",
      "Lubricate with food-grade grease; check capper torque.",
      { every: 1, unit: "week" },
      true,
    ],
    [
      "EQ-YOGF",
      "Seal head inspection",
      "Check sealing heads and replace foil cutters.",
      { every: 1, unit: "month" },
      true,
    ],
    [
      "EQ-CHILL1",
      "Refrigeration plant service",
      "Check refrigerant, defrost and door seals.",
      { every: 3, unit: "month" },
      false,
    ],
    [
      "EQ-BOILER",
      "Boiler safety valve test",
      "Test and record safety valve operation.",
      { every: 1, unit: "month" },
      false,
    ],
    [
      "EQ-VAN1",
      "Vehicle and refrigeration unit service",
      "Service the chassis and refrigeration unit.",
      { every: 6, unit: "month" },
      false,
    ],
  ];
  for (const [a, title, description, frequency, clearance] of taskDefs) {
    let hit = tasks.find((t) => t.title === title);
    if (!hit) {
      hit = pick(
        await api.post("/site/maintenance/tasks", {
          assetId: mIds[a],
          title,
          description,
          frequency,
          startOn: addDays(today, -120),
          clearanceRequired: clearance,
        }),
        "task",
      );
      made++;
    }
    taskIds[title] = hit.id;
  }
  if (!((await api.get("/site/maintenance/records?limit=1")).records as any[]).length) {
    for (const [title, id] of Object.entries(taskIds)) {
      const t = taskDefs.find((x) => x[1] === title)!;
      const gapDays = t[3].unit === "week" ? 7 : t[3].unit === "month" ? 30 * t[3].every : 30 * t[3].every;
      for (let ago = -Math.min(110, gapDays * 3); ago < 0; ago += gapDays) {
        const completedOn = addDays(today, Math.max(-110, ago + (hash(title) % 4)));
        const r = await api.post("/site/maintenance/records", {
          taskId: id,
          completedAt: `${completedOn}T13:00:00.000Z`,
          doneBy: eng,
          workDone: "Completed as per the planned maintenance schedule. No faults found.",
          nextDueOn: addDays(completedOn, gapDays),
          note: "",
        });
        const rec = pick(r, "record");
        if (t[4] && rec.id)
          await reviewer
            .post(`/site/maintenance/records/${rec.id}/clearance`, {
              note: "Hygiene clearance after maintenance: area cleaned and swabbed.",
            })
            .catch(() => {});
        made++;
      }
    }
    // Work orders
    const wos: [string, string, string, string, string, boolean, boolean][] = [
      [
        "EQ-FILL1",
        "breakdown",
        "Bottle filler capper jamming",
        "Capper head jamming every few minutes; caps arriving misaligned.",
        "high",
        true,
        true,
      ],
      [
        "EQ-CHILL1",
        "request",
        "Replace chiller 1 door seal",
        "Seal split on the hinge side.",
        "medium",
        false,
        true,
      ],
      [
        "EQ-YOGF",
        "breakdown",
        "Yogurt filler pump leaking",
        "Seal weeping on dosing pump.",
        "urgent",
        true,
        false,
      ],
      [
        "EQ-COMP",
        "request",
        "Replace compressor air filter",
        "Filter due; pressure drop noticeable.",
        "low",
        false,
        false,
      ],
      [
        "EQ-PAST",
        "request",
        "Repaint guard rail on pasteuriser platform",
        "Paint flaking onto platform.",
        "low",
        false,
        false,
      ],
    ];
    for (const [a, kind, title, description, priority, stops, complete] of wos) {
      const w = pick(
        await api.post("/site/maintenance/work-orders", {
          assetId: mIds[a],
          kind,
          title,
          description,
          priority,
          stopsProduction: stops,
          assignedTo: eng,
        }),
        "workOrder",
      );
      if (complete)
        await api.post(`/site/maintenance/work-orders/${w.id}/complete`, {
          workDone: "Fault traced and repaired; tested under load.",
          downtimeMinutes: stops ? 95 : null,
          partsCost: 86.5,
          labourCost: 120,
        });
      made++;
    }
  }

  // ── Checklists ──
  const templates = (await api.get("/site/checklists/templates")).templates as any[];
  const tpl: Record<string, any> = {};
  const tplDefs: [string, string, string, string[], boolean][] = [
    [
      "Production line pre-start check",
      "prestart",
      "Production hall",
      [
        "Line cleaned and CIP record signed",
        "No loose items, tools or jewellery on the line",
        "Metal detector tested with all three test pieces",
        "Labels and date codes checked against the batch sheet",
        "Hand-wash stations stocked with soap and sanitiser",
        "Allergen status of the previous run confirmed",
      ],
      true,
    ],
    [
      "Allergen changeover check",
      "allergen_changeover",
      "Yogurt filling",
      [
        "Previous allergen product fully removed from the line and area",
        "Line cleaned with allergen-validated clean",
        "ATP swab result below 10 RLU",
        "Granola hopper and dosing unit stripped and washed",
        "Labels checked: allergen declaration correct for next product",
      ],
      false,
    ],
  ];
  for (const [name, kind, line, items, duringProduction] of tplDefs) {
    let hit = templates.find((t) => t.name === name);
    if (!hit) {
      hit = pick(
        await api.post("/site/checklists/templates", {
          name,
          kind,
          line,
          frequency: kind === "prestart" ? { every: 1, unit: "day" } : null,
          duringProduction,
          items: items.map((prompt) => ({ prompt, guidance: null })),
        }),
        "template",
      );
      made++;
    }
    tpl[name] = pick(await api.get(`/site/checklists/templates/${hit.id}`), "template");
  }
  if (!((await api.get("/site/checklists/checks?limit=1")).checks as any[]).length) {
    for (const day of days.filter((d) => dow(d) <= 5)) {
      const t = tpl["Production line pre-start check"];
      const items = t.items ?? t.currentItems ?? [];
      const failDay = day === addDays(today, -6);
      await api.post("/site/checklists/checks", {
        templateId: t.id,
        performedAt: `${day}T05:50:00.000Z`,
        results: items.map((it: any, i: number) => ({
          itemId: it.id,
          result: failDay && i === 4 ? "fail" : "pass",
          note: failDay && i === 4 ? "Sanitiser empty; refilled immediately." : null,
        })),
        note: "",
      });
      made++;
    }
    const t2 = tpl["Allergen changeover check"];
    for (const day of days.filter((_, i) => i % 3 === 0)) {
      await api.post("/site/checklists/checks", {
        templateId: t2.id,
        performedAt: `${day}T13:15:00.000Z`,
        results: (t2.items ?? []).map((it: any) => ({ itemId: it.id, result: "pass" })),
        note: "Changeover verified before granola run.",
      });
      made++;
    }
  }
  return `${made} site records`;
}
