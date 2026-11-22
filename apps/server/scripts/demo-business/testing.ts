import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { hash } from "./commercial";

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export async function testing(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!;
  let made = 0;
  const labs = (await api.get("/testing/laboratories?status=all")).laboratories as any[];
  const labId: Record<string, string> = {};
  for (const l of [
    {
      name: "Knotmilk in-house QC laboratory",
      inHouse: true,
      accreditation: null,
      accreditationExpiresOn: null,
      contact: "Isla McAllister, ext 214",
      notes: "pH, fat, phosphatase, antibiotic and organoleptic testing.",
    },
    {
      name: "Westcountry Food Analysis Ltd",
      inHouse: false,
      accreditation: "UKAS ISO 17025:2017",
      accreditationExpiresOn: addDays(today, 280),
      contact: "Dr Fiona Hale, lab@wcfa.example",
      notes: "Microbiology, shelf-life and nutritional analysis.",
    },
  ]) {
    let hit = labs.find((x) => x.name === l.name);
    if (!hit) {
      hit = pick(await api.post("/testing/laboratories", l), "laboratory");
      made++;
    }
    labId[l.name] = hit.id;
  }
  const inhouse = labId["Knotmilk in-house QC laboratory"]!,
    ext = labId["Westcountry Food Analysis Ltd"]!;

  const points = (await api.get("/testing/points?status=all")).points as any[];
  const pointId: Record<string, string> = {};
  for (const p of [
    {
      code: "ENV-Z1-FILL",
      name: "Yogurt filler nozzle (Zone 1)",
      kind: "environmental",
      zone: "Zone 1",
      location: "Yogurt filling",
    },
    {
      code: "ENV-Z2-FLOOR",
      name: "Floor drain near filler (Zone 3)",
      kind: "environmental",
      zone: "Zone 3",
      location: "Production hall",
    },
    {
      code: "ENV-Z1-CHURN",
      name: "Butter churn discharge (Zone 1)",
      kind: "environmental",
      zone: "Zone 1",
      location: "Butter room",
    },
    { code: "WTR-MAINS", name: "Production water tap", kind: "water", zone: null, location: "Plant room" },
  ]) {
    let hit = points.find((x) => x.code === p.code);
    if (!hit) {
      hit = pick(await api.post("/testing/points", p), "point");
      made++;
    }
    pointId[p.code] = hit.id;
  }

  const A = (category: string, name: string, extra: any = {}) => ({ category, name, ...extra });
  const swab = [
    A("microbiological", "Listeria spp.", { limitText: "Not detected", method: "ISO 11290-1" }),
    A("microbiological", "Enterobacteriaceae", { unit: "cfu/swab", max: 10, method: "ISO 21528" }),
  ];
  const plans = (await api.get("/testing/plans?status=all")).plans as any[];
  const planId: Record<string, string> = {};
  const planDefs: any[] = [
    {
      name: "Weekly Zone 1 filler swab",
      subject: "point",
      samplingPointId: pointId["ENV-Z1-FILL"],
      frequencyDays: 7,
      laboratoryId: ext,
      rationale: "Listeria control on product-contact surfaces.",
      analytes: swab,
    },
    {
      name: "Fortnightly floor drain swab",
      subject: "point",
      samplingPointId: pointId["ENV-Z2-FLOOR"],
      frequencyDays: 14,
      laboratoryId: ext,
      rationale: "Verify cleaning of drains.",
      analytes: swab,
    },
    {
      name: "Monthly water potability",
      subject: "point",
      samplingPointId: pointId["WTR-MAINS"],
      frequencyDays: 30,
      laboratoryId: ext,
      rationale: "Verify potability of process water.",
      analytes: [
        A("microbiological", "E. coli", { limitText: "Not detected in 100ml" }),
        A("microbiological", "Coliforms", { limitText: "Not detected in 100ml" }),
        A("chemical", "Free chlorine", { unit: "mg/l", max: 0.5 }),
      ],
    },
    {
      name: "Weekly natural yogurt micro",
      subject: "lot",
      itemId: itemId["FG-YOG-NAT500"],
      frequencyDays: 7,
      laboratoryId: ext,
      rationale: "Verify product safety and shelf life.",
      analytes: [
        A("microbiological", "Yeasts and moulds", { unit: "cfu/g", max: 100, method: "ISO 21527" }),
        A("microbiological", "Enterobacteriaceae", { unit: "cfu/g", max: 10, method: "ISO 21528" }),
        A("microbiological", "Listeria monocytogenes", {
          limitText: "Not detected in 25g",
          method: "ISO 11290",
        }),
      ],
    },
    {
      name: "Weekly whole milk micro",
      subject: "lot",
      itemId: itemId["FG-MILK-WH1"],
      frequencyDays: 7,
      laboratoryId: ext,
      rationale: "Verify pasteurisation effectiveness.",
      analytes: [
        A("microbiological", "Total viable count", { unit: "cfu/ml", max: 50000 }),
        A("microbiological", "Enterobacteriaceae", { unit: "cfu/ml", max: 1 }),
      ],
    },
    {
      name: "Butter Listeria and salt",
      subject: "lot",
      itemId: itemId["FG-BUTTER-S250"],
      frequencyDays: 14,
      laboratoryId: ext,
      rationale: "Verify butter safety.",
      analytes: [
        A("microbiological", "Listeria monocytogenes", { limitText: "Not detected in 25g" }),
        A("chemical", "Salt", { unit: "%", min: 1.2, max: 1.8 }),
      ],
    },
  ];
  for (const p of planDefs) {
    let hit = plans.find((x) => x.name === p.name);
    if (!hit) {
      hit = pick(await api.post("/testing/plans", { ...p, startedOn: addDays(today, -70) }), "plan");
      made++;
    }
    planId[p.name] = hit.id;
  }

  // Lots to sample
  const lots: any[] = [];
  for (let off = 0; ; off += 200) {
    const page = (await api.get(`/stock/lots?limit=200&offset=${off}&includeEmpty=true`)).lots as any[];
    lots.push(...page);
    if (page.length < 200) break;
  }
  const lotsOf = (code: string) =>
    lots.filter((l) => l.item.code === code).sort((a, b) => a.lotCode.localeCompare(b.lotCode));

  const existing = (await api.get("/testing/samples?limit=200")).samples as any[];
  if (existing.length < 8) {
    const record = async (sample: any, failOne = false) => {
      const full = pick(await api.get(`/testing/samples/${sample.id}`), "sample");
      const results = (full.results ?? []).map((r: any, i: number) => {
        const pass = !(failOne && i === 0);
        if (r.limitText && /not detected/i.test(r.limitText))
          return {
            resultId: r.id,
            valueText: pass ? "Not detected" : "Detected",
            outcome: pass ? "pass" : "fail",
          };
        const max = r.max ?? null,
          min = r.min ?? null;
        const v =
          max !== null
            ? pass
              ? Math.round(max * 0.12 * 10) / 10
              : max * 4
            : min !== null
              ? Math.round(((min + (r.max ?? min + 0.3)) / 2) * 100) / 100
              : 1;
        return { resultId: r.id, value: v };
      });
      await api.post(`/testing/samples/${sample.id}/results`, {
        reportedOn: addDays(sample.sampledOn, 3),
        reportReference: `WCFA-${(hash(sample.id) % 90000) + 10000}`,
        results,
      });
    };
    // Weekly swabs for 8 weeks; one failure in week 6 with an investigation
    for (let w = 8; w >= 1; w--) {
      const sampledOn = addDays(today, -w * 7 + 1);
      const s = pick(
        await api.post("/testing/samples", {
          subject: "point",
          planId: planId["Weekly Zone 1 filler swab"],
          samplingPointId: pointId["ENV-Z1-FILL"],
          laboratoryId: ext,
          sampledOn,
          sampledBy: "Isla McAllister",
          notes: "Post-clean swab before start-up.",
        }),
        "sample",
      );
      await record(s, w === 6);
      if (w === 6)
        await api
          .post(`/testing/samples/${s.id}/investigation/close`, {
            findings:
              "Listeria spp. isolated on one swab (not L. monocytogenes). Filler nozzle seal found with residue.",
            rootCause: "Residual product in the nozzle seal groove after CIP.",
            actionTaken:
              "Seal replaced, intensified clean-and-swab (three consecutive negatives) before the next run.",
          })
          .catch(() => {});
      made++;
    }
    for (let w = 4; w >= 1; w--) {
      const s = pick(
        await api.post("/testing/samples", {
          subject: "point",
          planId: planId["Fortnightly floor drain swab"],
          samplingPointId: pointId["ENV-Z2-FLOOR"],
          laboratoryId: ext,
          sampledOn: addDays(today, -w * 14 + 2),
          sampledBy: "Dev Patel",
        }),
        "sample",
      );
      await record(s);
      made++;
    }
    for (const m of [2, 1]) {
      const s = pick(
        await api.post("/testing/samples", {
          subject: "point",
          planId: planId["Monthly water potability"],
          samplingPointId: pointId["WTR-MAINS"],
          laboratoryId: ext,
          sampledOn: addDays(today, -m * 28),
          sampledBy: "Dev Patel",
        }),
        "sample",
      );
      await record(s);
      made++;
    }
    // Lot samples
    for (const [code, plan, take] of [
      ["FG-YOG-NAT500", "Weekly natural yogurt micro", 6],
      ["FG-MILK-WH1", "Weekly whole milk micro", 5],
      ["FG-BUTTER-S250", "Butter Listeria and salt", 3],
    ] as [string, string, number][]) {
      const picked = lotsOf(code).slice(0, take);
      for (const l of picked) {
        const sampledOn = `20${l.lotCode.slice(-6, -4)}-${l.lotCode.slice(-4, -2)}-${l.lotCode.slice(-2)}`;
        if (sampledOn > today) continue;
        const s = pick(
          await api.post("/testing/samples", {
            subject: "lot",
            lotId: l.id,
            planId: planId[plan],
            laboratoryId: ext,
            sampledOn,
            sampledBy: "Isla McAllister",
            notes: "Retained sample sent to the lab.",
          }),
          "sample",
        );
        await record(s);
        made++;
      }
    }
    // A couple still awaiting results
    for (const code of ["FG-YOG-STR150", "FG-CHEESE-S200"]) {
      const l = lotsOf(code).at(-1);
      if (l) {
        await api.post("/testing/samples", {
          subject: "lot",
          lotId: l.id,
          laboratoryId: ext,
          sampledOn: addDays(today, -1),
          sampledBy: "Dev Patel",
          analytes: [
            A("microbiological", "Listeria monocytogenes", { limitText: "Not detected in 25g" }),
            A("microbiological", "Yeasts and moulds", { unit: "cfu/g", max: 100 }),
          ],
        });
        made++;
      }
    }
  }
  return `${made} testing records`;
}
