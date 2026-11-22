import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { hash } from "./commercial";
import { loginAs } from "./team";

/** Labelling (nutrition, label approval), new product development, and food defence. */
const N = (
  basis: "100g" | "100ml",
  kj: number,
  kcal: number,
  fat: number,
  sat: number,
  carb: number,
  sugars: number,
  fibre: number,
  protein: number,
  salt: number,
) => ({
  basis,
  energyKj: kj,
  energyKcal: kcal,
  fat,
  saturates: sat,
  carbohydrate: carb,
  sugars,
  fibre,
  protein,
  salt,
});
const nutrition: Record<string, ReturnType<typeof N>> = {
  "ING-MILK": N("100ml", 270, 64, 3.9, 2.5, 4.7, 4.7, 0, 3.4, 0.1),
  "ING-CREAM": N("100ml", 1900, 460, 48, 31, 2.4, 2.4, 0, 1.9, 0.04),
  "ING-SMP": N("100g", 1480, 350, 0.8, 0.5, 52, 52, 0, 36, 1.3),
  "ING-CULT-YOG": N("100g", 1500, 360, 5, 3, 60, 10, 0, 20, 2),
  "ING-CULT-MESO": N("100g", 1500, 360, 5, 3, 60, 10, 0, 20, 2),
  "ING-RENNET": N("100ml", 20, 5, 0, 0, 0.5, 0.5, 0, 0.5, 8),
  "ING-SUGAR": N("100g", 1700, 400, 0, 0, 100, 100, 0, 0, 0),
  "ING-STRAW": N("100g", 130, 31, 0.3, 0, 6, 6, 2, 0.7, 0.01),
  "ING-RASP": N("100g", 220, 52, 0.7, 0, 5, 4.4, 6.5, 1.2, 0.01),
  "ING-VAN": N("100g", 1100, 260, 0.1, 0, 12.7, 12.7, 0, 0.1, 0.01),
  "ING-HONEY": N("100g", 1300, 304, 0, 0, 82, 82, 0, 0.3, 0.01),
  "ING-PECTIN": N("100g", 700, 170, 0, 0, 5, 0, 80, 0, 0.5),
  "ING-SALT": N("100g", 0, 0, 0, 0, 0, 0, 0, 0, 98),
  "ING-GRAN": N("100g", 1900, 450, 15, 2, 66, 20, 6, 9, 0.1),
};
const declaration: Record<string, string> = {
  "ING-MILK": "Whole milk",
  "ING-CREAM": "Cream",
  "ING-SMP": "Skimmed milk powder",
  "ING-CULT-YOG": "Live yogurt cultures",
  "ING-CULT-MESO": "Live cultures",
  "ING-RENNET": "Vegetarian rennet",
  "ING-SUGAR": "Sugar",
  "ING-STRAW": "Strawberry purée",
  "ING-RASP": "Raspberry purée",
  "ING-VAN": "Vanilla extract",
  "ING-HONEY": "Honey",
  "ING-PECTIN": "Pectin",
  "ING-SALT": "Salt",
  "ING-GRAN": "Honey & oat granola (oats, honey, sunflower oil, almonds)",
};

export async function labelling(ctx: Ctx) {
  const { api } = ctx;
  const itemId = ctx.ids.item!,
    rcp = ctx.ids.recipe!;
  const approver = await loginAs(ctx, "hannah@knotmilk.example");
  let made = 0;
  for (const [code, n] of Object.entries(nutrition)) {
    const cur = ((await api.get(`/labelling/items?limit=200`)).items as any[]).find(
      (i) => i.itemId === itemId[code],
    );
    if (cur?.nutrition) continue;
    await api.put(`/labelling/items/${itemId[code]}`, {
      declarationName: declaration[code],
      nutrition: n,
      nutritionSource: "Supplier specification",
    });
    made++;
  }
  const labels = (await api.get("/labelling/labels?limit=100")).labels as any[];
  const portions: Record<string, number | null> = {
    "RCP-MILK-WH1": 200,
    "RCP-MILK-SS1": 200,
    "RCP-MILK-WH2": 200,
    "RCP-YOG-NAT500": 125,
    "RCP-YOG-STR150": 150,
    "RCP-YOG-RAS150": 150,
    "RCP-YOG-VAN150": 150,
    "RCP-YOG-HG150": 170,
    "RCP-BUTTER-S250": 10,
    "RCP-CREAM-D300": 30,
    "RCP-CHEESE-S200": 30,
  };
  for (const [code, portion] of Object.entries(portions)) {
    if (labels.some((l) => l.recipeId === rcp[code])) continue;
    try {
      const label = pick(
        await api.post("/labelling/labels", {
          recipeId: rcp[code],
          portionSize: portion,
          negligibleAsZero: true,
        }),
        "label",
      );
      await approver
        .post(`/labelling/labels/${label.id}/approve`, {})
        .catch((e) => console.warn("label approve:", code, String(e.message).slice(0, 160)));
      made++;
    } catch (e: any) {
      console.warn("label:", code, String(e.message).slice(0, 220));
    }
  }
  return `${made} labelling records`;
}

export async function npd(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!;
  let made = 0;
  const existing = (await api.get("/npd/projects")).projects as any[];
  const defs = [
    {
      code: "NPD-001",
      name: "Greek-style strained yogurt 450g",
      customerName: "Westcountry Co-operative Stores",
      brief:
        "High-protein strained yogurt to compete with imported Greek-style brands; 10% protein, no added sugar.",
      targetLaunchOn: addDays(today, 75),
      targetCost: 0.82,
      targetShelfLifeDays: 24,
      storage: "chilled",
      claims: ["High protein", "No added sugar", "Live cultures"],
      constraints: "Must run on the existing yogurt line; max 8% increase in line time.",
      trials: [
        [
          "kitchen",
          -95,
          "Bench trial with 3% extra SMP and longer incubation.",
          "adjust",
          "Texture slightly thin; try straining through muslin.",
          null,
        ],
        [
          "factory",
          -60,
          "Pilot run of 300 kg on the yogurt line with a centrifuge strainer.",
          "pass",
          "Texture and protein target met.",
          null,
        ],
        [
          "shelf_life",
          -40,
          "Shelf-life study at 4°C and 8°C.",
          "pass",
          "Quality maintained to day 26 at 4°C.",
          26,
        ],
        ["sensory", -30, "Sensory panel with 24 consumers.", "pass", "Mean liking 7.6 of 9.", null],
      ],
      signoffs: [
        ["haccp_reviewed", "Hannah Okafor", -20],
        ["artwork_agreed", "Naomi Clarke", -10],
      ],
      status: "validation",
    },
    {
      code: "NPD-002",
      name: "Lemon curd & shortbread yogurt 150g",
      customerName: null,
      brief:
        "Premium dessert-style yogurt with lemon curd swirl and shortbread crumb for the festive season.",
      targetLaunchOn: addDays(today, 130),
      targetCost: 0.88,
      targetShelfLifeDays: 18,
      storage: "chilled",
      claims: ["Made with real lemon"],
      constraints: "Contains gluten and eggs: allergen changeover needed.",
      trials: [
        [
          "kitchen",
          -35,
          "Kitchen trial of lemon curd swirl.",
          "adjust",
          "Curd too tart; increase sugar by 15%.",
          null,
        ],
      ],
      signoffs: [],
      status: "trials",
    },
    {
      code: "NPD-003",
      name: "Cultured buttermilk 500ml",
      customerName: null,
      brief: "Traditional cultured buttermilk by-product of butter making for baking.",
      targetLaunchOn: addDays(today, 200),
      targetCost: 0.55,
      targetShelfLifeDays: 14,
      storage: "chilled",
      claims: [],
      constraints: "Uses buttermilk from the churn; needs pasteurising.",
      trials: [],
      signoffs: [],
      status: "brief",
    },
  ] as const;
  for (const p of defs) {
    let hit = existing.find((x) => x.code === p.code);
    if (!hit) {
      hit = pick(
        await api.post("/npd/projects", {
          code: p.code,
          name: p.name,
          brief: p.brief,
          customerName: p.customerName,
          targetLaunchOn: p.targetLaunchOn,
          targetCost: p.targetCost,
          targetShelfLifeDays: p.targetShelfLifeDays,
          storage: p.storage,
          claims: p.claims,
          constraints: p.constraints,
        }),
        "project",
      );
      for (const [kind, ago, description, outcome, findings, life] of p.trials)
        await api.post(`/npd/projects/${hit.id}/trials`, {
          kind,
          heldOn: addDays(today, ago),
          description,
          outcome,
          findings,
          achievedShelfLifeDays: life,
          storage: kind === "shelf_life" ? "chilled" : null,
        });
      for (const [key, by, ago] of p.signoffs)
        await api.post(`/npd/projects/${hit.id}/signoffs`, {
          key,
          by,
          on: addDays(today, ago),
          reference: null,
        });
      if (p.status !== "brief")
        await api.patch(`/npd/projects/${hit.id}`, { status: p.status }).catch(() => {});
      made++;
    }
  }
  return `${made} NPD projects`;
}

export async function defence(ctx: Ctx) {
  const { api, today } = ctx;
  const approver = await loginAs(ctx, "hannah@knotmilk.example");
  let made = 0;
  const controls = (await api.get("/defence/controls?status=all")).controls as any[];
  const ctl: Record<string, string> = {};
  for (const [name, kind, area, freq, instr] of [
    [
      "Perimeter fence and gate inspection",
      "perimeter",
      "Site boundary",
      7,
      "Walk the perimeter; check fence, gates and lighting.",
    ],
    [
      "Visitor and contractor sign-in",
      "access",
      "Reception",
      1,
      "Check the visitor log is complete and badges are returned.",
    ],
    ["Key and lock control audit", "locks_keys", "Key cabinet", 30, "Reconcile keys against the register."],
    [
      "CCTV function test",
      "cctv",
      "Yard and goods-in",
      14,
      "Check all cameras record and footage is retrievable.",
    ],
    [
      "Tamper-evident seals on bulk silos",
      "tamper_evidence",
      "Raw milk silos",
      1,
      "Check seals are intact and numbers match the log.",
    ],
    [
      "Pre-employment and agency worker checks",
      "personnel",
      "HR",
      30,
      "Review checks on new starters and agency staff.",
    ],
  ] as [string, string, string, number, string][]) {
    let hit = controls.find((c) => c.name === name);
    if (!hit) {
      hit = pick(
        await api.post("/defence/controls", { name, kind, area, frequencyDays: freq, instructions: instr }),
        "control",
      );
      made++;
    }
    ctl[name] = hit.id;
    const checks = (await api.get(`/defence/checks?controlId=${hit.id}&limit=1`)).checks as any[];
    if (!checks.length) {
      for (let i = 4; i >= 1; i--) {
        const fail = name.startsWith("CCTV") && i === 2;
        await api.post(`/defence/controls/${hit.id}/checks`, {
          checkedOn: addDays(today, -Math.min(i * freq, i * 14)),
          outcome: fail ? "fail" : "pass",
          notes: fail ? "Camera 3 (yard) not recording." : "Satisfactory.",
          actionTaken: fail ? "Camera replaced the same day." : "",
        });
      }
      made++;
    }
  }
  const failed = (await api.get("/defence/checks?outcome=open&limit=50")).checks as any[];
  for (const c of failed)
    await api
      .post(`/defence/checks/${c.id}/resolve`, { resolution: "Replaced the camera and verified recording." })
      .catch(() => {});

  const assessments = (await api.get("/defence/assessments")).assessments as any[];
  if (!assessments.length || !assessments.some((a) => a.title.startsWith("Site food defence"))) {
    const t = (
      area: string,
      threat: string,
      source: string,
      l: number,
      i: number,
      existing: string,
      mitigation: string,
      controlNames: string[],
    ) => ({
      id: randomUUID(),
      area,
      threat,
      source,
      likelihood: l,
      impact: i,
      existingControls: existing,
      mitigation,
      controlIds: controlNames.map((n) => ctl[n]).filter(Boolean),
    });
    const created = pick(
      await api.post("/defence/assessments", {
        title: "Site food defence assessment 2026",
        scope: "Whole site, all shifts, including raw milk reception, silos and despatch.",
        draft: {
          summary:
            "Annual assessment of intentional contamination, theft and fraud threats using a TACCP approach.",
          reviewDueOn: addDays(today, 330),
          threats: [
            t(
              "Raw milk reception",
              "Malicious contamination of a tanker or silo",
              "supply_chain",
              2,
              5,
              "Tanker seals and driver ID checks",
              "Seal verification at every intake.",
              ["Tamper-evident seals on bulk silos", "Visitor and contractor sign-in"],
            ),
            t(
              "Despatch dock",
              "Theft of finished product or substitution of loads",
              "intruder",
              3,
              3,
              "Locked dock doors, CCTV, load checks",
              "Reconcile loads to despatch notes.",
              ["CCTV function test"],
            ),
            t(
              "Production hall",
              "Disgruntled employee tampering with product",
              "employee",
              2,
              5,
              "Pre-employment checks, supervision, CCTV",
              "Rotate sensitive duties; check agency workers.",
              ["Pre-employment and agency worker checks", "CCTV function test"],
            ),
            t(
              "Site perimeter",
              "Unauthorised access out of hours",
              "intruder",
              3,
              4,
              "Fence, gate and lighting",
              "Weekly perimeter check.",
              ["Perimeter fence and gate inspection", "Key and lock control audit"],
            ),
            t(
              "IT systems",
              "Cyber attack on production or label systems",
              "cyber",
              2,
              4,
              "Firewall and backups",
              "Staff phishing awareness.",
              [],
            ),
          ],
        },
      }),
      "assessment",
    );
    const full = pick(await api.get(`/defence/assessments/${created.id}`), "assessment");
    const draft = full.draft ?? full.draftVersion ?? full.currentDraft;
    await approver
      .post(`/defence/assessments/${created.id}/draft/approve`, {
        draftId: draft?.id ?? draft?.draftId,
        revision: draft?.revision ?? draft?.updatedAt ?? "",
      })
      .catch((e) => console.warn("defence approve:", String(e.message).slice(0, 220)));
    made++;
  }
  const ex = (await api.get("/defence/exercises")).exercises as any[];
  if (!ex.length) {
    await api.post("/defence/exercises", {
      title: "Tabletop: tanker tampering scenario",
      scenario: "A driver reports a missing seal on a raw milk tanker before discharge.",
      heldOn: addDays(today, -80),
      participants: "Operations Manager, Technical Manager, Goods-in team, Production Manager",
      outcome: "partly_effective",
      findings: "Goods-in team knew to quarantine the load but weren't sure who to call out of hours.",
      actions: "Out-of-hours escalation list added to the reception desk and SOP-001.",
    });
    made++;
  }
  return `${made} defence records`;
}
