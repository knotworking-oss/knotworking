import type { Ctx } from "./api";
import { addDays } from "./api";
import { hash } from "./commercial";
import { loginAs } from "./team";

import { pickRecord as pick } from "./api";
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// Hazard helpers: decision-tree answers
const CCP = { q1: true, q2: true, q3: null, q4: null };
const PRP = { q1: true, q2: false, q3: true, q4: true };
const H = (
  hazardType: string,
  description: string,
  likelihood: number,
  severity: number,
  controlMeasure: string,
  tree: any = PRP,
  justification?: string,
) => ({
  hazardType,
  description,
  likelihood,
  severity,
  controlMeasure,
  ...tree,
  justification: justification ?? null,
});
const ccp = (
  code: string,
  processStep: string,
  stepRef: string,
  hazardType: string,
  hazard: string,
  limit: { min?: number; max?: number; unit?: string; pass?: string },
  monitoringMethod: string,
  frequency: { every: number; unit: string },
  role: string,
  correctiveAction: string,
  verification: string,
  duringProduction = true,
) => ({
  code,
  processStep,
  stepRef,
  hazardType,
  hazard,
  limitType: limit.pass ? "pass_fail" : "range",
  limitMin: limit.min ?? null,
  limitMax: limit.max ?? null,
  limitUnit: limit.unit ?? null,
  passCriterion: limit.pass ?? null,
  monitoringMethod,
  frequency,
  duringProduction,
  responsibleRole: role,
  correctiveAction,
  verification,
});

export const plans = [
  {
    code: "HACCP-MILK",
    name: "Pasteurised milk and cream",
    description: "Reception, standardisation, pasteurisation, filling and chilled storage of milk and cream.",
    items: ["FG-MILK-WH1", "FG-MILK-SS1", "FG-MILK-WH2", "FG-CREAM-D300"],
    steps: [
      {
        ref: "1",
        name: "Raw milk reception",
        description: "Tanker arrives, temperature and antibiotic test.",
        hazards: [
          H(
            "biological",
            "Pathogens in raw milk (Salmonella, Listeria, E. coli O157)",
            4,
            5,
            "Supplier approval; temperature ≤ 5°C on receipt",
            PRP,
          ),
          H(
            "chemical",
            "Antibiotic and veterinary drug residues",
            3,
            4,
            "Rapid antibiotic test on every tanker",
            CCP,
            "Test is the only control before the milk enters the silo.",
          ),
        ],
      },
      {
        ref: "2",
        name: "Silo storage",
        description: "Raw milk held at ≤ 5°C.",
        hazards: [
          H("biological", "Growth of psychrotrophs", 3, 3, "Silo refrigeration and 48 hour limit", PRP),
        ],
      },
      {
        ref: "3",
        name: "Standardisation and separation",
        description: "Fat standardisation.",
        hazards: [
          H("physical", "Metal fragments from separator", 2, 3, "Planned maintenance of separator", PRP),
        ],
      },
      {
        ref: "4",
        name: "HTST pasteurisation",
        description: "72°C for 15 seconds with flow diversion.",
        hazards: [
          H(
            "biological",
            "Survival of pathogens through inadequate heat treatment",
            4,
            5,
            "Plate pasteuriser with flow diversion valve",
            CCP,
            "Last step that eliminates vegetative pathogens.",
          ),
        ],
      },
      {
        ref: "5",
        name: "Cooling",
        description: "Cooled to 5°C or below.",
        hazards: [
          H(
            "biological",
            "Growth of pathogens during slow cooling",
            3,
            4,
            "Plate cooler with temperature recording",
            CCP,
          ),
        ],
      },
      {
        ref: "6",
        name: "Filling and capping",
        description: "Bottle filler, cap and label.",
        hazards: [
          H("physical", "Foreign bodies in empty bottles or caps", 2, 4, "Bottle inspection and rinse", PRP),
          H("allergen", "Mislabelling of allergens", 2, 4, "Label check at start-up", PRP),
        ],
      },
      {
        ref: "7",
        name: "Chilled storage and despatch",
        description: "Stored at 0–5°C.",
        hazards: [H("biological", "Temperature abuse in storage", 3, 3, "Chiller monitoring alarms", PRP)],
      },
    ],
    ccps: [
      ccp(
        "CCP1",
        "Raw milk reception",
        "1",
        "chemical",
        "Antibiotic residues in raw milk",
        { pass: "Antibiotic test negative" },
        "Rapid antibiotic test on every tanker before discharge",
        { every: 1, unit: "day" },
        "Goods-in operative",
        "Reject the load; notify the supplier and Technical.",
        "Technical Manager reviews records weekly.",
      ),
      ccp(
        "CCP2",
        "HTST pasteurisation",
        "4",
        "biological",
        "Survival of pathogens",
        { min: 72, unit: "°C" },
        "Read the pasteuriser temperature recorder; check flow diversion",
        { every: 1, unit: "hour" },
        "Pasteuriser operator",
        "Divert product, hold and re-pasteurise; investigate.",
        "Daily chart review; weekly phosphatase test; annual validation.",
      ),
      ccp(
        "CCP3",
        "Cooling",
        "5",
        "biological",
        "Growth after pasteurisation",
        { max: 5, unit: "°C" },
        "Read the cooler outlet temperature",
        { every: 1, unit: "hour" },
        "Pasteuriser operator",
        "Re-cool; hold and test if above 8°C.",
        "Daily record review; probe calibration.",
      ),
    ],
  },
  {
    code: "HACCP-YOG",
    name: "Yogurt",
    description: "Yogurt base manufacture, fermentation, flavouring and filling.",
    items: ["FG-YOG-NAT500", "FG-YOG-STR150", "FG-YOG-RAS150", "FG-YOG-VAN150", "FG-YOG-HG150"],
    steps: [
      {
        ref: "1",
        name: "Milk standardisation and fortification",
        description: "Blend milk and skimmed milk powder.",
        hazards: [
          H("biological", "Pathogens in ingredients", 3, 4, "Approved suppliers and specifications", PRP),
        ],
      },
      {
        ref: "2",
        name: "Heat treatment",
        description: "90°C for 5 minutes.",
        hazards: [H("biological", "Pathogen survival", 4, 5, "Holding tube with temperature recorder", CCP)],
      },
      {
        ref: "3",
        name: "Inoculation and fermentation",
        description: "Cultured at 43°C to pH 4.5.",
        hazards: [
          H(
            "biological",
            "Pathogen growth if fermentation stalls",
            3,
            4,
            "pH ≤ 4.6 verified before cooling",
            CCP,
          ),
        ],
      },
      {
        ref: "4",
        name: "Flavouring (fruit, honey, granola)",
        description: "Blend purée, honey; dose granola.",
        hazards: [
          H(
            "allergen",
            "Cross-contact from granola (gluten, nuts)",
            3,
            5,
            "Allergen scheduling and changeover clean",
            PRP,
          ),
          H("physical", "Stones or stalks in fruit purée", 2, 3, "Supplier controls and in-line filter", PRP),
        ],
      },
      {
        ref: "5",
        name: "Filling and sealing",
        description: "Fill pots, foil seal.",
        hazards: [H("physical", "Metal fragments", 2, 4, "Metal detection on finished pots", CCP)],
      },
      {
        ref: "6",
        name: "Chilling",
        description: "Chilled to ≤ 5°C within 2 hours.",
        hazards: [H("biological", "Growth of yeasts and moulds", 3, 2, "Chiller monitoring", PRP)],
      },
    ],
    ccps: [
      ccp(
        "CCP1",
        "Heat treatment",
        "2",
        "biological",
        "Survival of pathogens",
        { min: 90, unit: "°C" },
        "Holding tube recorder",
        { every: 1, unit: "batch" },
        "Pasteuriser operator",
        "Re-treat the batch.",
        "Chart review each batch.",
      ),
      ccp(
        "CCP2",
        "Fermentation",
        "3",
        "biological",
        "Pathogen growth",
        { max: 4.6, unit: "pH" },
        "pH meter on completion of fermentation",
        { every: 1, unit: "batch" },
        "Production operative",
        "Continue incubation or reject the batch.",
        "Weekly pH meter calibration.",
      ),
      ccp(
        "CCP3",
        "Filling and sealing",
        "5",
        "physical",
        "Metal contamination",
        { pass: "All test pieces detected" },
        "Metal detector with Fe 2.0 / non-Fe 2.5 / SS 3.0 mm test pieces",
        { every: 1, unit: "hour" },
        "Production operative",
        "Quarantine product since last pass and re-run.",
        "Monthly detector service.",
      ),
    ],
  },
  {
    code: "HACCP-BC",
    name: "Butter and soft cheese",
    description: "Butter churning and soft cheese making.",
    items: ["FG-BUTTER-S250", "FG-CHEESE-S200"],
    steps: [
      {
        ref: "1",
        name: "Cream pasteurisation",
        description: "85°C for 15 seconds.",
        hazards: [H("biological", "Pathogens in cream", 4, 5, "Pasteuriser with flow diversion", CCP)],
      },
      {
        ref: "2",
        name: "Ripening and churning",
        description: "Overnight ripening, churning and working.",
        hazards: [
          H(
            "biological",
            "Listeria in post-process environment",
            3,
            5,
            "Environmental monitoring and hygiene zoning",
            PRP,
          ),
        ],
      },
      {
        ref: "3",
        name: "Curd setting and draining",
        description: "16 hour set, 12 hour drain.",
        hazards: [H("biological", "Pathogen growth during setting", 3, 4, "pH ≤ 4.6 before draining", CCP)],
      },
      {
        ref: "4",
        name: "Packing",
        description: "Wrap, tub and label.",
        hazards: [H("physical", "Foreign bodies", 2, 3, "Visual checks", PRP)],
      },
    ],
    ccps: [
      ccp(
        "CCP1",
        "Cream pasteurisation",
        "1",
        "biological",
        "Survival of pathogens",
        { min: 85, unit: "°C" },
        "Read the recorder",
        { every: 1, unit: "batch" },
        "Cheesemaker",
        "Divert and re-pasteurise.",
        "Daily chart review.",
      ),
      ccp(
        "CCP2",
        "Curd setting",
        "3",
        "biological",
        "Pathogen growth",
        { max: 4.6, unit: "pH" },
        "pH measurement before draining",
        { every: 1, unit: "batch" },
        "Cheesemaker",
        "Extend setting time or reject.",
        "pH meter calibration.",
      ),
    ],
  },
];

export async function haccp(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    user = ctx.ids.user!;
  const qa = await loginAs(ctx, "hannah@knotmilk.example");
  const planId = (ctx.ids.haccpPlan ??= {});
  const ccpIds = (ctx.ids.ccp ??= {});
  const assetIds = (ctx.ids.haccpAsset ??= {});
  let made = 0;

  const existing = (await api.get("/haccp/plans?status=all&limit=100")).plans as any[];
  for (const p of plans) {
    let hit = existing.find((x) => x.code === p.code);
    if (!hit) {
      hit = pick(
        await api.post("/haccp/plans", {
          code: p.code,
          name: p.name,
          description: p.description,
          reviewIntervalMonths: 12,
          hazardReviewIntervalMonths: 12,
          draft: {
            scope: { itemIds: p.items.map((i) => itemId[i]), recipeIds: [] },
            scopeNote: `Covers ${p.name.toLowerCase()} produced at the Knotmilk site.`,
            changeNote: "Initial plan.",
            steps: p.steps,
            ccps: p.ccps,
          },
        }),
        "plan",
      );
      await qa.post(`/haccp/plans/${hit.id}/draft/approve`, {
        effectiveOn: addDays(today, -150),
        reviewDueOn: addDays(today, 215),
        hazardReviewDueOn: addDays(today, 215),
        note: "Approved by the HACCP team.",
      });
      made++;
    }
    planId[p.code] = hit.id;
    const detail = pick(await api.get(`/haccp/plans/${hit.id}`), "plan");
    for (const c of detail.currentVersion?.ccps ?? []) ccpIds[`${p.code}:${c.code}`] = c.id;
  }

  // Assets: areas and equipment to clean and calibrate
  const existingAssets = (await api.get("/haccp/assets?status=all")).assets as any[];
  const assets: [string, string, string, string, any, any, number?, string?][] = [
    [
      "equipment",
      "EQ-PAST",
      "HTST plate pasteuriser",
      "Production hall",
      { every: 1, unit: "day" },
      { every: 6, unit: "month" },
      0.5,
      "°C",
    ],
    [
      "equipment",
      "EQ-PROBE1",
      "Pasteuriser temperature probe",
      "Production hall",
      null,
      { every: 3, unit: "month" },
      0.3,
      "°C",
    ],
    ["equipment", "EQ-PH", "pH meter (lab)", "Laboratory", null, { every: 1, unit: "week" }, 0.05, "pH"],
    [
      "equipment",
      "EQ-MD1",
      "Metal detector, yogurt line",
      "Yogurt filling",
      { every: 1, unit: "week" },
      null,
    ],
    ["equipment", "EQ-FILL1", "Bottle filler", "Bottling hall", { every: 1, unit: "day" }, null],
    [
      "equipment",
      "EQ-CH1",
      "Finished goods chiller 1 probe",
      "Chiller 1",
      null,
      { every: 6, unit: "month" },
      0.5,
      "°C",
    ],
    [
      "area",
      "AR-PROD",
      "Production hall floors and drains",
      "Production hall",
      { every: 1, unit: "day" },
      null,
    ],
    ["area", "AR-CHILL", "Chillers and cold rooms", "Warehouse", { every: 1, unit: "week" }, null],
    ["area", "AR-GIB", "Goods-in bay", "Goods-in", { every: 1, unit: "day" }, null],
    ["area", "AR-STAFF", "Staff welfare and changing rooms", "Welfare", { every: 1, unit: "day" }, null],
  ];
  for (const [kind, code, name, location, cleaningFrequency, calibrationFrequency, tol, unit] of assets) {
    let hit = existingAssets.find((a) => a.code === code);
    if (!hit) {
      hit = pick(
        await api.post("/haccp/assets", {
          kind,
          code,
          name,
          location,
          cleaningFrequency,
          calibrationFrequency,
          calibrationTolerance: tol ?? null,
          measurementUnit: unit ?? null,
        }),
        "asset",
      );
      made++;
    }
    assetIds[code] = hit.id;
  }

  // Records history: logs, cleaning, calibration, sign-offs (only once)
  const logs = (await api.get("/haccp/logs?limit=1")).logs as any[];
  if (!logs.length) {
    const days: string[] = [];
    for (let d = -14; d <= -1; d++) {
      const day = addDays(today, d);
      if (dow(day) >= 1 && dow(day) <= 5) days.push(day);
    }
    const spec: Record<
      string,
      { code: string; times: number; gen: (h: number) => { value?: number; passed?: boolean } }[]
    > = {
      "HACCP-MILK": [
        { code: "CCP1", times: 2, gen: () => ({ passed: true }) },
        { code: "CCP2", times: 4, gen: (h) => ({ value: Math.round((72.6 + (h % 8) / 10) * 10) / 10 }) },
        { code: "CCP3", times: 4, gen: (h) => ({ value: Math.round((3.1 + (h % 15) / 10) * 10) / 10 }) },
      ],
      "HACCP-YOG": [
        { code: "CCP1", times: 2, gen: (h) => ({ value: Math.round((90.4 + (h % 10) / 10) * 10) / 10 }) },
        { code: "CCP2", times: 2, gen: (h) => ({ value: Math.round((4.35 + (h % 20) / 100) * 100) / 100 }) },
        { code: "CCP3", times: 4, gen: () => ({ passed: true }) },
      ],
      "HACCP-BC": [
        { code: "CCP1", times: 1, gen: (h) => ({ value: Math.round((85.5 + (h % 8) / 10) * 10) / 10 }) },
        { code: "CCP2", times: 1, gen: (h) => ({ value: Math.round((4.3 + (h % 25) / 100) * 100) / 100 }) },
      ],
    };
    let n = 0,
      deviations = 0;
    for (const day of days) {
      for (const [pc, list] of Object.entries(spec)) {
        if (pc === "HACCP-BC" && ![2, 3, 4].includes(dow(day))) continue;
        for (const s of list)
          for (let t = 0; t < s.times; t++) {
            const h = hash(`${pc}${s.code}${day}${t}`);
            let r = s.gen(h);
            const bad = h % 97 === 0; // a rare out-of-limit reading
            if (bad && r.value !== undefined)
              r = { value: pc === "HACCP-MILK" && s.code === "CCP2" ? 71.4 : r.value };
            const at = `${day}T${String(6 + t * 2).padStart(2, "0")}:${String(10 + (h % 45)).padStart(2, "0")}:00.000Z`;
            const body: any = { ccpId: ccpIds[`${pc}:${s.code}`], ...r, checkedAt: at, note: "" };
            if (r.value === 71.4) {
              body.note = "Temperature dipped; product diverted automatically.";
              body.correctiveAction = {
                actionTaken: "Product diverted by the flow diversion valve and re-pasteurised.",
                rootCause: "Steam valve slow to respond after a pressure drop.",
                preventiveAction: "Steam trap serviced; added to PPM.",
              };
              deviations++;
            }
            await api.post("/haccp/logs", body);
            n++;
          }
      }
      // Cleaning of each area/asset with a cleaning frequency
      for (const [kind, code, , , cf] of assets) {
        if (!cf) continue;
        if (cf.unit === "week" && dow(day) !== 5) continue;
        const h = hash(code + day);
        await api.post("/haccp/cleaning", {
          assetId: assetIds[code],
          cleanedAt: `${day}T${String(15 + (h % 3)).padStart(2, "0")}:30:00.000Z`,
          note: "Cleaned and sanitised; visually inspected.",
        });
      }
    }
    // Calibrations
    for (const [, code, name, , , cal, tol] of assets) {
      if (!cal) continue;
      const ref = code === "EQ-PH" ? 7 : 72;
      for (const ago of [-60, -3]) {
        const drift = (((hash(code + ago) % 7) - 3) / 100) * (tol ?? 0.5);
        await api.post("/haccp/calibration", {
          assetId: assetIds[code],
          calibratedAt: `${addDays(today, ago)}T09:00:00.000Z`,
          referenceReading: ref,
          actualReading: Math.round((ref + drift) * 100) / 100,
          method: "Compared against UKAS-calibrated reference thermometer / buffer",
          nextDueOn: addDays(
            today,
            ago + (cal.unit === "week" ? 7 : cal.unit === "month" ? 30 * cal.every : 30),
          ),
          note: "Within tolerance.",
        });
      }
    }
    // Day sign-offs for all but the last two production days
    for (const day of days.slice(0, -2))
      await qa
        .post("/haccp/signoffs/bulk", {
          wholeSite: true,
          day,
          note: "Records reviewed; no outstanding issues.",
        })
        .catch(() => {});
    // Review pending logs
    await qa
      .post("/haccp/logs/review", {
        ids: (await api.get("/haccp/logs?review=pending&limit=200")).logs.slice(0, 200).map((l: any) => l.id),
        decision: "approved",
      })
      .catch(() => {});
    made += n;
    return `${made} HACCP records (${n} CCP readings, ${deviations} deviations)`;
  }
  const dev = (await api.get("/haccp/logs?outOfLimits=true&limit=100")).logs as any[];
  if (dev.length < 2) {
    const day = (n: number) => addDays(today, n);
    const cases: [string, string, number, string, any][] = [
      [
        "HACCP-MILK:CCP2",
        day(-9),
        71.4,
        "Temperature dipped to 71.4°C for 40 seconds after a steam pressure drop.",
        {
          actionTaken:
            "Flow diversion valve diverted product automatically; 1,800 litres re-pasteurised and held until phosphatase test negative.",
          rootCause: "Steam trap on the heat exchanger was partially blocked.",
          preventiveAction: "Steam trap replaced and added to quarterly planned maintenance.",
        },
      ],
      [
        "HACCP-MILK:CCP3",
        day(-5),
        6.8,
        "Cooler outlet reading 6.8°C during peak filling.",
        {
          actionTaken:
            "Reduced flow rate until outlet returned to 4°C; product from the 20 minute window held and tested.",
          rootCause: "Chilled water supply temperature high after plant defrost.",
          preventiveAction: "Defrost cycle rescheduled outside production.",
        },
      ],
      [
        "HACCP-YOG:CCP2",
        day(-3),
        4.78,
        "Fermentation ended at pH 4.78, above the 4.6 limit.",
        {
          actionTaken: "Incubation extended by 40 minutes; batch released after pH reached 4.52.",
          rootCause: "Culture dose weighed 8% light.",
          preventiveAction: "Culture sachets pre-weighed by the supplier; second-person check added.",
        },
      ],
    ];
    for (const [key, d, value, note, ca] of cases) {
      await api.post("/haccp/logs", {
        ccpId: ccpIds[key],
        value,
        checkedAt: `${d}T09:20:00.000Z`,
        note,
        correctiveAction: ca,
      });
      made++;
    }
  }
  return `${made} HACCP records`;
}
