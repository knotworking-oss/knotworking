import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { loginAs } from "./team";

const empty = {
  scope: "",
  basis: "",
  controls: "",
  response: "",
  ownerUserId: null as string | null,
  reviewDueOn: null as string | null,
  firstCheckDueOn: null as string | null,
  frequencyDays: null as number | null,
  subject: "",
  evidenceReference: "",
  sdsIssuedOn: null as string | null,
  sdsAttachmentId: null,
  supplierId: null as string | null,
  competenceExpiresOn: null as string | null,
  actionTaskIds: [],
  courseIds: [],
  hazards: [] as any[],
  unit: "",
  wasteCode: "",
  authorisationReference: "",
};

const haz = (
  hazard: string,
  peopleAtRisk: string,
  l: number,
  s: number,
  controls: string,
  rl: number,
  rs: number,
  rationale: string,
) => ({
  hazard,
  peopleAtRisk,
  likelihood: l,
  severity: s,
  controls,
  residualLikelihood: rl,
  residualSeverity: rs,
  rationale,
});

export async function hse(ctx: Ctx) {
  const { api, today } = ctx;
  const user = ctx.ids.user!,
    sup = ctx.ids.supplier!,
    course = ctx.ids.course!;
  const approver = await loginAs(ctx, "hannah@knotmilk.example");
  const owner = (e: string) => user[e]!;
  const review = addDays(today, 240);
  let made = 0;

  const existing = (await api.get("/hse/registers?limit=100")).records as any[];
  const defs: {
    kind: string;
    title: string;
    c: any;
    entries?: { daysAgo: number; outcome: string; findings: string; actions?: string; nextDays?: number }[];
  }[] = [
    // risk assessments
    {
      kind: "risk_assessment",
      title: "Manual handling: crates, cases and pallets",
      c: {
        scope: "All staff lifting or carrying milk crates, cases and ingredient sacks.",
        basis: "Manual Handling Operations Regulations 1992.",
        controls:
          "Trolleys and pallet trucks provided; 20 kg single-person limit; training for all warehouse and production staff.",
        response: "Report any strain injury to the supervisor; follow the accident procedure.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        hazards: [
          haz(
            "Lifting crates and sacks",
            "Warehouse and production staff",
            4,
            3,
            "Mechanical aids, rotation of tasks, training",
            2,
            2,
            "Residual risk is low with aids and training.",
          ),
        ],
        courseIds: [course["TRN-ALL"]!].filter(Boolean),
      },
    },
    {
      kind: "risk_assessment",
      title: "Slips, trips and falls: wet production floors",
      c: {
        scope: "Production hall, bottling hall, washdown areas.",
        basis: "Workplace (Health, Safety and Welfare) Regulations 1992.",
        controls: "Non-slip flooring, drainage, footwear policy, wet-floor signs, squeegee after spills.",
        response: "Clean spillages immediately and report defects.",
        ownerUserId: owner("callum@knotmilk.example"),
        reviewDueOn: review,
        hazards: [
          haz(
            "Wet floors from washdown and spills",
            "All production staff and visitors",
            4,
            3,
            "Anti-slip floor, slip-resistant boots, spill procedure",
            2,
            2,
            "Controlled by footwear and floor maintenance.",
          ),
        ],
      },
    },
    {
      kind: "risk_assessment",
      title: "Hot surfaces, steam and scalding: pasteuriser and boiler",
      c: {
        scope: "Plate pasteuriser, steam lines, boiler room.",
        basis: "Pressure Systems Safety Regulations 2000.",
        controls: "Lagging, guarding, permit for entry to boiler room, training for operators.",
        response: "Cool burns with running water for 20 minutes and call first aider.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        hazards: [
          haz(
            "Contact with hot surfaces or steam",
            "Pasteuriser operators and engineers",
            3,
            4,
            "Insulation, guarding, signage, PPE",
            1,
            4,
            "Rare event with serious potential.",
          ),
        ],
      },
    },
    {
      kind: "risk_assessment",
      title: "Vehicle movements and pedestrian segregation",
      c: {
        scope: "Yard, despatch dock, forklift routes.",
        basis: "Workplace Regulations; HSG136 Workplace transport.",
        controls: "Marked pedestrian walkways, one-way system, banksman for reversing, hi-vis.",
        response: "Report near misses to the Operations Manager.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        hazards: [
          haz(
            "Collision between forklifts, vans and pedestrians",
            "Drivers, warehouse staff, visitors",
            3,
            5,
            "Segregated routes, speed limits, trained drivers, beacons",
            1,
            5,
            "Low likelihood after segregation.",
          ),
        ],
      },
    },
    {
      kind: "risk_assessment",
      title: "Cleaning chemicals and CIP",
      c: {
        scope: "CIP of the pasteuriser, silos and fillers.",
        basis: "COSHH Regulations 2002.",
        controls: "Closed dosing systems, eyewash stations, PPE, training for cleaners.",
        response: "Flush eyes/skin for 15 minutes and seek medical advice.",
        ownerUserId: owner("hannah@knotmilk.example"),
        reviewDueOn: review,
        hazards: [
          haz(
            "Contact with caustic and acid CIP chemicals",
            "Cleaners and operators",
            3,
            4,
            "Automatic dosing, PPE, eyewash, training",
            1,
            4,
            "Closed system and PPE limit exposure.",
          ),
        ],
      },
    },
    // COSHH
    {
      kind: "coshh",
      title: "COSHH: Caustic soda 30% (CIP alkali)",
      c: {
        scope: "CIP station and chemical store.",
        basis: "COSHH Regulations 2002.",
        controls: "Bunded storage, closed transfer, face shield and gloves, eyewash at point of use.",
        response:
          "Eye contact: irrigate 15 min; skin: remove clothing, wash; ingestion: do not induce vomiting.",
        ownerUserId: owner("hannah@knotmilk.example"),
        reviewDueOn: review,
        subject: "Caustic soda solution 30%",
        evidenceReference: "SafeClean SDS rev 7 (2026)",
        sdsIssuedOn: addDays(today, -120),
      },
    },
    {
      kind: "coshh",
      title: "COSHH: Nitric acid 60% (CIP acid)",
      c: {
        scope: "CIP station and chemical store.",
        basis: "COSHH Regulations 2002.",
        controls: "Segregated from alkali, closed dosing, PPE.",
        response: "Move to fresh air; eyes irrigate; seek urgent medical advice.",
        ownerUserId: owner("hannah@knotmilk.example"),
        reviewDueOn: review,
        subject: "Nitric acid 60%",
        evidenceReference: "SafeClean SDS rev 4 (2026)",
        sdsIssuedOn: addDays(today, -150),
      },
    },
    {
      kind: "coshh",
      title: "COSHH: Surface sanitiser (quaternary ammonium)",
      c: {
        scope: "Hand-wash stations and surface sanitising.",
        basis: "COSHH Regulations 2002.",
        controls: "Diluted at the point of use, gloves provided.",
        response: "Wash skin; rinse eyes; seek advice if irritation persists.",
        ownerUserId: owner("hannah@knotmilk.example"),
        reviewDueOn: review,
        subject: "Food-safe sanitiser concentrate",
        evidenceReference: "SafeClean SDS rev 3 (2025)",
        sdsIssuedOn: addDays(today, -300),
      },
    },
    // contractors
    {
      kind: "contractor",
      title: "Contractor competence: Rentokill Pest Control",
      c: {
        scope: "Monthly pest control visits.",
        basis: "Contractor management procedure.",
        controls: "Sign in at reception; RAMS reviewed annually.",
        response: "Contact Operations Manager.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        supplierId: sup["SUP-PEST"],
        evidenceReference: "BPCA certificate and public liability £5m",
        competenceExpiresOn: addDays(today, 180),
      },
    },
    {
      kind: "contractor",
      title: "Contractor competence: Precision Calibration Services",
      c: {
        scope: "Calibration of probes and scales.",
        basis: "Contractor management procedure.",
        controls: "Escorted on site.",
        response: "Contact Technical Manager.",
        ownerUserId: owner("hannah@knotmilk.example"),
        reviewDueOn: review,
        supplierId: sup["SUP-CALIB"],
        evidenceReference: "UKAS 17025 accreditation, insurance certificate",
        competenceExpiresOn: addDays(today, 200),
      },
    },
    // inspections
    {
      kind: "inspection",
      title: "Pressure systems: steam boiler examination",
      c: {
        scope: "Steam boiler and safety valves.",
        basis: "Pressure Systems Safety Regulations 2000.",
        controls: "Written scheme of examination; insurance inspector.",
        response: "Isolate and notify the insurer if a defect is found.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        firstCheckDueOn: addDays(today, 60),
        frequencyDays: 365,
        evidenceReference: "Written scheme WSE-2026-04",
      },
      entries: [
        {
          daysAgo: 305,
          outcome: "pass",
          findings: "Boiler and safety valves examined; no defects.",
          nextDays: 365,
        },
      ],
    },
    {
      kind: "inspection",
      title: "LOLER thorough examination: forklifts",
      c: {
        scope: "Three counterbalance forklifts and the pallet stacker.",
        basis: "LOLER 1998 and PUWER 1998.",
        controls: "Six-monthly thorough examination by a competent person.",
        response: "Remove failed trucks from service.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        firstCheckDueOn: addDays(today, 25),
        frequencyDays: 182,
        evidenceReference: "LOLER examination schedule",
      },
      entries: [
        {
          daysAgo: 157,
          outcome: "pass",
          findings: "All trucks passed with one advisory on a fork tine.",
          actions: "Tine replaced.",
          nextDays: 182,
        },
      ],
    },
    {
      kind: "inspection",
      title: "Fixed electrical installation test (EICR)",
      c: {
        scope: "Whole site electrical installation.",
        basis: "Electricity at Work Regulations 1989.",
        controls: "Five-yearly EICR by NICEIC contractor.",
        response: "Rectify C1 and C2 defects immediately.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        firstCheckDueOn: addDays(today, 540),
        frequencyDays: 1825,
        evidenceReference: "NICEIC EICR certificate",
      },
      entries: [
        {
          daysAgo: 1285,
          outcome: "pass",
          findings: "Satisfactory with two C3 observations.",
          nextDays: 1825,
        },
      ],
    },
    {
      kind: "inspection",
      title: "Fire alarm weekly test and emergency lighting",
      c: {
        scope: "Fire alarm, emergency lighting and extinguishers.",
        basis: "Regulatory Reform (Fire Safety) Order 2005.",
        controls: "Weekly call-point test, quarterly service.",
        response: "Report faults to the Operations Manager.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        firstCheckDueOn: addDays(today, 2),
        frequencyDays: 7,
        evidenceReference: "Fire log book",
      },
      entries: [
        { daysAgo: 5, outcome: "pass", findings: "Call point 4 tested; all sounders working.", nextDays: 7 },
        { daysAgo: 12, outcome: "pass", findings: "Call point 7 tested; panel normal.", nextDays: 7 },
      ],
    },
    // emergency
    {
      kind: "emergency",
      title: "Fire evacuation drill",
      c: {
        scope: "Whole site, all shifts.",
        basis: "Regulatory Reform (Fire Safety) Order 2005.",
        controls: "Quarterly drill, roll call by marshals.",
        response: "Muster point at the front car park.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        firstCheckDueOn: addDays(today, 70),
        frequencyDays: 91,
        evidenceReference: "Fire evacuation procedure SOP-014",
      },
      entries: [
        {
          daysAgo: 21,
          outcome: "pass",
          findings: "Site evacuated in 3 min 40 s; all accounted for.",
          nextDays: 91,
        },
      ],
    },
    {
      kind: "emergency",
      title: "Chemical spill exercise",
      c: {
        scope: "CIP chemical store.",
        basis: "Emergency procedure for chemical spills.",
        controls: "Spill kits, bunding, trained first responders.",
        response: "Evacuate area, notify the Technical Manager.",
        ownerUserId: owner("hannah@knotmilk.example"),
        reviewDueOn: review,
        firstCheckDueOn: addDays(today, 110),
        frequencyDays: 365,
        evidenceReference: "Spill response procedure",
      },
      entries: [
        { daysAgo: 255, outcome: "pass", findings: "Spill contained within 6 minutes.", nextDays: 365 },
      ],
    },
    // waste, utilities, environment
    {
      kind: "waste",
      title: "Trade waste: food and packaging",
      c: {
        scope: "General waste, cardboard, plastic and food waste.",
        basis: "Environmental Protection Act 1990, duty of care.",
        controls: "Segregated skips; waste transfer notes retained for 2 years.",
        response: "Report spills to Operations.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        supplierId: sup["SUP-WASTE"],
        wasteCode: "02 05 01",
        authorisationReference: "CBDU-471234",
        unit: "kg",
      },
    },
    {
      kind: "utility",
      title: "Electricity: main site meter",
      c: {
        scope: "Site electricity consumption.",
        basis: "Energy monitoring.",
        controls: "Monthly meter reading.",
        response: "Investigate unusual increases.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        subject: "Main electricity meter MPAN 1234567890123",
        unit: "kWh",
      },
    },
    {
      kind: "utility",
      title: "Water: incoming mains meter",
      c: {
        scope: "Process and welfare water.",
        basis: "Energy monitoring and trade effluent consent.",
        controls: "Weekly meter reading.",
        response: "Investigate leaks.",
        ownerUserId: owner("rhys@knotmilk.example"),
        reviewDueOn: review,
        subject: "Incoming water meter",
        unit: "m3",
      },
    },
    {
      kind: "environmental_obligation",
      title: "Trade effluent consent",
      c: {
        scope: "Discharge of process wastewater to the sewer.",
        basis: "Water Industry Act 1991, consent TE/2024/0187.",
        controls: "Quarterly effluent sampling; pH 6–10, temperature below 43°C.",
        response: "Notify the water company of any breach within 24 hours.",
        ownerUserId: owner("hannah@knotmilk.example"),
        reviewDueOn: review,
        firstCheckDueOn: addDays(today, 40),
        frequencyDays: 91,
        evidenceReference: "Consent TE/2024/0187",
      },
      entries: [
        {
          daysAgo: 51,
          outcome: "pass",
          findings: "pH 7.4, temperature 31°C, COD within consent.",
          nextDays: 91,
        },
      ],
    },
  ];

  const ids: Record<string, string> = (ctx.ids.hseRegister ??= {});
  for (const def of defs) {
    let hit = existing.find((x) => x.title === def.title);
    if (!hit) {
      const created = pick(
        await api.post("/hse/registers", {
          commandId: randomUUID(),
          title: def.title,
          kind: def.kind,
          content: { ...empty, ...def.c },
        }),
        "record",
      );
      hit = created;
      made++;
      // Approve: some need another approver
      const rev = created.revision ?? 1;
      await approver
        .post(`/hse/registers/${created.id}/approve`, {
          commandId: randomUUID(),
          expectedRevision: rev,
          reason: "Reviewed and approved by the Technical Manager.",
        })
        .catch((e) => console.warn("approve:", def.title, String(e.message).slice(0, 220)));
      for (const entry of def.entries ?? []) {
        const cur = pick(await api.get(`/hse/registers/${created.id}`), "record");
        await api
          .post(`/hse/registers/${created.id}/entries`, {
            commandId: randomUUID(),
            expectedRevision: cur.revision ?? rev,
            performedOn: addDays(today, -entry.daysAgo),
            outcome: entry.outcome,
            findings: entry.findings,
            actions: entry.actions ?? "",
            evidenceReference: "Certificate on file",
            nextDueOn: entry.nextDays ? addDays(today, -entry.daysAgo + entry.nextDays) : null,
            quantity: null,
            periodFrom: null,
            resolvesEntryId: null,
          })
          .catch((e) => console.warn("entry:", def.title, String(e.message).slice(0, 220)));
      }
    }
    ids[def.title] = hit.id;
  }
  return `${made} HSE registers`;
}

export async function hseIncidents(ctx: Ctx) {
  const { api, today } = ctx;
  const user = ctx.ids.user!;
  const closer = await loginAs(ctx, "hannah@knotmilk.example");
  const staff = (await api.get("/people/staff?limit=500")).staff as any[];
  const person = (f: string, l: string) => staff.find((s) => s.firstName === f && s.lastName === l);
  const existing = (await api.get("/hse/incidents?limit=100")).incidents as any[];
  let made = 0;
  const defs: any[] = [
    {
      kind: "accident",
      daysAgo: 52,
      place: "Bottling hall",
      summary: "Operative slipped on a wet floor near the filler and bruised their hip.",
      staff: ["Jakub", "Nowak"],
      outcome: "first_aid",
      immediate: "First aid given by Sophie Lang; area dried and signed.",
      reporting: "not_required",
      rca: "Spillage not cleaned immediately after a bottle burst.",
      corr: "Reminded all staff of the clean-as-you-go rule; additional squeegee stations installed.",
      injury: { nature: "Bruising to hip", bodyPart: "Hip", treatment: "first_aid", daysAbsent: 0 },
      close: true,
      action: ["Install two additional squeegee stations in the bottling hall", 30],
    },
    {
      kind: "near_miss",
      daysAgo: 38,
      place: "Despatch yard",
      summary: "A reversing van nearly struck a pedestrian crossing the yard.",
      immediate: "Banksman reminded; pedestrian route repainted.",
      reporting: "not_required",
      rca: "Pedestrian crossed outside the marked walkway.",
      corr: "Toolbox talk delivered; additional signage.",
      close: true,
      action: ["Repaint pedestrian walkway and add convex mirror", 14],
    },
    {
      kind: "accident",
      daysAgo: 24,
      place: "Packing area",
      summary: "Employee cut a finger on a pot lid cutter while changing foil.",
      staff: ["Ruth", "Adeyemi"],
      outcome: "medical_treatment",
      immediate: "Wound cleaned and dressed; employee attended A&E for two stitches.",
      reporting: "not_required",
      rca: "Guard on the cutter was removed to clear a jam.",
      corr: "Guard interlock fitted; retrained on safe jam clearance.",
      injury: { nature: "Laceration to finger", bodyPart: "Left hand", treatment: "hospital", daysAbsent: 0 },
      close: true,
      action: ["Fit interlock to lid cutter guard", 10],
    },
    {
      kind: "unsafe_condition",
      daysAgo: 11,
      place: "Goods-in bay",
      summary: "A pallet racking upright was found damaged by a forklift impact.",
      immediate: "Rack unloaded and taped off; engineer called.",
      reporting: "not_required",
      action: ["Have racking inspected by a SEMA engineer", 7],
    },
    {
      kind: "near_miss",
      daysAgo: 6,
      place: "CIP station",
      summary: "A hose connection came loose during acid rinse; no spray reached staff.",
      immediate: "Pump stopped; connection replaced and tested.",
      reporting: "not_required",
      action: ["Replace all CIP hose clips with locking couplings", 21],
    },
    {
      kind: "ill_health",
      daysAgo: 4,
      place: "Production hall",
      summary: "Operative reported dermatitis on hands after extended glove use.",
      staff: ["Kasia", "Zielinski"],
      outcome: "none",
      immediate: "Offered alternative gloves and occupational health referral.",
      reporting: "not_assessed",
      action: ["Refer to occupational health and review glove types", 7],
    },
  ];
  const finish = async (id: string, d: any) => {
    let full = pick(await api.get(`/hse/incidents/${id}`), "incident");
    if (full.status === "closed") return;
    for (const a of (full.actions ?? []).filter((x: any) => x.status === "open")) {
      await api.post(`/hse/incidents/${id}/actions/${a.id}/complete`, {
        commandId: randomUUID(),
        expectedRevision: full.revision,
        status: "done",
        note: "Completed and verified on site.",
      });
      full = pick(await api.get(`/hse/incidents/${id}`), "incident");
    }
    if (!full.body.effectiveness) {
      await api.put(`/hse/incidents/${id}`, {
        commandId: randomUUID(),
        expectedRevision: full.revision,
        body: {
          ...full.body,
          effectiveness: "Checked after 30 days: no recurrence and the new control is in use.",
          investigation: full.body.investigation || "Investigated with the supervisor.",
        },
        reason: "Effectiveness review recorded.",
      });
      full = pick(await api.get(`/hse/incidents/${id}`), "incident");
    }
    await closer
      .post(`/hse/incidents/${id}/close`, {
        commandId: randomUUID(),
        expectedRevision: full.revision,
        reason: "Investigation complete and actions verified effective.",
      })
      .catch((e) => console.warn("incident close:", String(e.message).slice(0, 200)));
  };
  for (const d of defs) {
    const summary = d.summary as string;
    const have = existing.find((e) => e.summary === summary);
    if (have) {
      if (d.close && have.status !== "closed") await finish(have.id, d);
      continue;
    }
    const staffIds = (d.staff ? [person(d.staff[0], d.staff[1])?.id] : []).filter(Boolean);
    const created = pick(
      await api.post("/hse/incidents", {
        commandId: randomUUID(),
        body: {
          kind: d.kind,
          occurredOn: addDays(today, -d.daysAgo),
          place: d.place,
          summary,
          staffIds,
          healthDetails: "",
          immediateActions: d.immediate,
          ownerUserId: user["rhys@knotmilk.example"],
          investigation: d.rca ? "Investigated with the supervisor and staff involved." : "",
          rootCause: d.rca ?? "",
          correctiveActions: d.corr ?? "",
          effectiveness: "",
          reportingDecision: d.reporting,
          reportingBasis: d.reporting === "not_required" ? "Does not meet RIDDOR criteria." : "",
          reportingDueOn: null,
          reportReference: "",
          outcome: "none",
        },
      }),
      "incident",
    );
    let rev = created.revision ?? 1;
    if (d.injury && staffIds[0]) {
      const r = pick(
        await api.put(`/hse/incidents/${created.id}/injuries`, {
          commandId: randomUUID(),
          expectedRevision: rev,
          injuries: [
            {
              staffId: staffIds[0],
              personName: `${d.staff[0]} ${d.staff[1]}`,
              personType: "employee",
              ...d.injury,
            },
          ],
          outcome: d.outcome,
          reason: "Recorded from the accident book.",
        }),
        "incident",
      );
      rev = r.revision ?? rev + 1;
    }
    if (d.action) {
      const r = pick(
        await api.post(`/hse/incidents/${created.id}/actions`, {
          commandId: randomUUID(),
          expectedRevision: rev,
          description: d.action[0],
          ownerUserId: user["callum@knotmilk.example"],
          dueOn: addDays(today, -d.daysAgo + d.action[1]),
        }),
        "incident",
      );
      rev = r.revision ?? rev + 1;
    }
    if (d.close) await finish(created.id, d);
    made++;
  }
  return `${made} HSE incidents`;
}
