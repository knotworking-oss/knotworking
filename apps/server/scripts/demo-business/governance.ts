import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { loginAs } from "./team";

/** An in-house food safety management standard (own wording) with clauses, plus objectives, culture plan, legal register and management review. */
const clauses: [string, string, string, string, boolean][] = [
  // clause, title, section title, text, fundamental
  [
    "1.1",
    "Senior management commitment",
    "Leadership and culture",
    "Senior management defines and communicates the food safety policy and provides the resources to deliver it.",
    true,
  ],
  [
    "1.2",
    "Food safety and quality objectives",
    "Leadership and culture",
    "Measurable objectives are set, reviewed and reported at least annually.",
    false,
  ],
  [
    "1.3",
    "Management review",
    "Leadership and culture",
    "Management review is held at least annually and decisions are tracked to completion.",
    false,
  ],
  [
    "1.4",
    "Food safety culture plan",
    "Leadership and culture",
    "A plan to develop and measure food safety culture is in place and reviewed.",
    false,
  ],
  [
    "1.5",
    "Raising concerns",
    "Leadership and culture",
    "Staff have a confidential route to raise food safety concerns.",
    false,
  ],
  [
    "2.1",
    "HACCP team and plan",
    "Hazard analysis",
    "A trained HACCP team maintains a plan covering all products and processes.",
    true,
  ],
  [
    "2.2",
    "Critical control point monitoring",
    "Hazard analysis",
    "CCPs are monitored, limits are defined and deviations are acted on.",
    true,
  ],
  [
    "2.3",
    "HACCP review",
    "Hazard analysis",
    "The plan is reviewed at least annually and after any significant change.",
    false,
  ],
  [
    "3.1",
    "Site standards and maintenance",
    "Prerequisites",
    "The site, equipment and services are maintained to prevent contamination.",
    false,
  ],
  ["3.2", "Cleaning and hygiene", "Prerequisites", "Cleaning is scheduled, verified and recorded.", false],
  [
    "3.3",
    "Pest control",
    "Prerequisites",
    "A contracted pest control programme is in place with trend analysis.",
    false,
  ],
  [
    "3.4",
    "Foreign-body control",
    "Prerequisites",
    "Controls for glass, metal and other foreign bodies are in place and verified.",
    false,
  ],
  [
    "3.5",
    "Temperature control and storage",
    "Prerequisites",
    "Chilled and frozen stores are monitored and out-of-limit readings acted on.",
    false,
  ],
  [
    "4.1",
    "Supplier approval",
    "Product control",
    "Suppliers are approved by risk and monitored, including service providers.",
    true,
  ],
  [
    "4.2",
    "Specifications",
    "Product control",
    "Raw materials, packaging and finished products have approved specifications.",
    false,
  ],
  [
    "4.3",
    "Allergen management",
    "Product control",
    "Allergens are identified, segregated and controlled, with labels verified.",
    true,
  ],
  ["4.4", "Labelling", "Product control", "Labels are verified against recipes before use.", false],
  [
    "4.5",
    "Traceability and recall",
    "Product control",
    "Full one-up/one-down traceability is tested at least annually.",
    true,
  ],
  [
    "5.1",
    "Training and competence",
    "People",
    "Staff are trained and competent for their role; records are kept.",
    false,
  ],
  [
    "5.2",
    "Personal hygiene",
    "People",
    "Hygiene rules, protective clothing and illness reporting are enforced.",
    false,
  ],
  [
    "5.3",
    "Document control",
    "People",
    "Procedures are controlled, reviewed and read by relevant staff.",
    false,
  ],
  [
    "6.1",
    "Internal audit",
    "Verification",
    "An internal audit programme covers all areas at least annually.",
    false,
  ],
  [
    "6.2",
    "Corrective action",
    "Verification",
    "Non-conformances are investigated with root cause and corrective action.",
    false,
  ],
  ["6.3", "Complaint handling", "Verification", "Complaints are investigated and trends reported.", false],
];

export async function governance(ctx: Ctx) {
  const { api, today } = ctx;
  const user = ctx.ids.user!;
  const reviewer = await loginAs(ctx, "hannah@knotmilk.example");
  const own = (e: string) => user[e]!;
  let made = 0;

  // ── Standard and clauses ──
  const standards = (await api.get("/governance/standards")).standards as any[];
  let std = standards.find((s) => s.code === "KM-FSMS");
  if (!std) {
    std = pick(
      await api.post("/governance/standards", {
        code: "KM-FSMS",
        name: "Knotmilk Food Safety Management Standard",
        issue: "2026.1",
        publisher: "Knotmilk Dairy",
        note: "Internal standard used to track gaps against our food safety management system.",
      }),
      "standard",
    );
    const csv = [
      "clause,title,section,section title,text,fundamental",
      ...clauses.map(
        ([c, t, st, tx, f]) => `${c},"${t}",${c.split(".")[0]},"${st}","${tx}",${f ? "yes" : "no"}`,
      ),
    ].join("\n");
    await api.post(`/governance/standards/${std.id}/clauses/import`, { csv, dryRun: false });
    made++;
  }
  const detail = await api.get(`/governance/standards/${std.id}`);
  const clauseList: any[] = detail.clauses ?? [];
  const assess: Record<
    string,
    ["compliant" | "partial" | "gap" | "not_applicable", string, string?, number?]
  > = {
    "1.4": ["partial", "Culture plan drafted; survey not yet run.", "hannah@knotmilk.example", 45],
    "2.3": ["partial", "Annual HACCP review due next quarter.", "hannah@knotmilk.example", 60],
    "3.4": ["compliant", "Metal detection verified hourly; glass register current."],
    "4.4": [
      "partial",
      "Label approvals in place; one artefact check outstanding.",
      "hannah@knotmilk.example",
      30,
    ],
    "5.3": ["compliant", "SOP acknowledgements tracked in the system."],
    "6.1": ["partial", "Programme running; two audits planned.", "hannah@knotmilk.example", 35],
    "3.3": ["compliant", "Monthly visits with trend report."],
  };
  for (const c of clauseList) {
    if (c.status !== "not_assessed") continue;
    const ref = c.ref;
    const a = assess[ref] ?? ["compliant", "Evidence reviewed and satisfactory."];
    await api.post(`/governance/clauses/${c.id}/assessments`, {
      commandId: randomUUID(),
      status: a[0],
      note: a[1],
      ownerUserId: a[2] ? (user[a[2]] ?? null) : own("hannah@knotmilk.example"),
      dueOn: a[3] ? addDays(today, a[3]) : null,
    });
  }
  if (clauseList.length)
    await api
      .post(`/governance/standards/${std.id}/snapshots`, { label: `Gap review ${today}` })
      .catch(() => {});

  // ── Objectives ──
  const objs = (await api.get("/governance/objectives")).objectives as any[];
  const defs: [
    string,
    string,
    string,
    string,
    number,
    ["on_track" | "at_risk" | "off_track", string, string][],
  ][] = [
    [
      "Zero product recalls in 2026",
      "food_safety",
      "Number of recalls and withdrawals",
      "0",
      400,
      [
        ["on_track", "0", "No recalls year to date."],
        ["on_track", "0", "Mock recall passed."],
      ],
    ],
    [
      "Reduce customer complaints to under 3 per million units",
      "quality",
      "Complaints per million units sold",
      "< 3",
      400,
      [
        ["at_risk", "4.1", "Complaint rate above target in Q3 after label issue."],
        ["on_track", "2.8", "Rate fell after corrective actions."],
      ],
    ],
    [
      "100% of staff trained to their role requirements",
      "food_safety",
      "Training matrix compliance",
      "100%",
      200,
      [
        ["at_risk", "94%", "Three overdue refreshers."],
        ["on_track", "97%", "Refreshers booked."],
      ],
    ],
    [
      "Complete food safety culture survey",
      "culture",
      "Survey response rate",
      "> 80%",
      120,
      [["on_track", "0%", "Survey designed."]],
    ],
    [
      "Reduce raw milk wastage by 15%",
      "other",
      "Litres wasted per 1000 litres received",
      "< 0.8",
      300,
      [["on_track", "0.9", "Process improvements in filling."]],
    ],
  ];
  for (const [title, category, measure, target, due, progress] of defs) {
    let hit = objs.find((o) => o.title === title);
    if (!hit) {
      hit = pick(
        await api.post("/governance/objectives", {
          title,
          category,
          measure,
          target,
          ownerUserId: own("hannah@knotmilk.example"),
          dueOn: addDays(today, due),
        }),
        "objective",
      );
      for (const [i, [rag, value, note]] of progress.entries())
        await api.post(`/governance/objectives/${hit.id}/progress`, {
          on: addDays(today, -60 + i * 30),
          rag,
          value,
          note,
        });
      made++;
    }
  }
  const objsNow = (await api.get("/governance/objectives")).objectives as any[];

  // ── Culture activities ──
  const culture = ((await api.get("/governance/culture")).activities as any[] | undefined) ?? [];
  for (const [title, kind, daysAgo, done, participants, result] of [
    [
      "Quarterly food safety briefing",
      "training",
      40,
      true,
      58,
      "All shifts briefed on allergen changeover learnings.",
    ],
    [
      "Leadership walk: production hall",
      "leadership_walk",
      25,
      true,
      12,
      "Managers observed hygiene practice and spoke to operators.",
    ],
    ["Food safety week poster campaign", "communication", 70, true, 60, "Posters displayed in all areas."],
    ["Annual food safety culture survey", "survey", -30, false, null, null],
    ["Recognition: hygiene champion award", "recognition", -14, false, null, null],
    ["Allergen workshop for operators", "workshop", -21, false, null, null],
  ] as [string, string, number, boolean, number | null, string | null][]) {
    if ((culture as any[]).some((c) => c.title === title)) continue;
    const act = pick(
      await api.post("/governance/culture", {
        title,
        kind,
        plannedOn: addDays(today, -daysAgo),
        ownerUserId: own("hannah@knotmilk.example"),
        measure: "Participation and feedback",
        objectiveId: objsNow.find((o: any) => o.category === "culture")?.id ?? null,
      }),
      "activity",
    );
    if (done)
      await api.patch(`/governance/culture/${act.id}`, {
        completedOn: addDays(today, -daysAgo),
        participants,
        result,
      });
    made++;
  }

  // ── Legal and customer requirements ──
  const reqs = (await api.get("/governance/requirements")).requirements as any[];
  for (const [source, reference, title, customerName, desc] of [
    [
      "legal",
      "Reg (EC) 852/2004",
      "Hygiene of foodstuffs",
      null,
      "General hygiene requirements for food business operators.",
    ],
    [
      "legal",
      "Reg (EC) 853/2004",
      "Hygiene rules for food of animal origin",
      null,
      "Specific rules for dairy: raw milk criteria, heat treatment, approvals.",
    ],
    [
      "legal",
      "Food Information Regulations 2014",
      "Allergen labelling and food information",
      null,
      "Allergen emphasis, QUID, nutrition declaration.",
    ],
    [
      "legal",
      "Food Safety Act 1990",
      "General food safety requirements",
      null,
      "Food must not be injurious to health or unfit.",
    ],
    [
      "customer",
      "WCS-DAIRY-014",
      "Westcountry Co-operative dairy code of practice",
      "Westcountry Co-operative Stores",
      "Minimum remaining life on receipt and delivery temperatures.",
    ],
    ["certification", "SALSA", "SALSA scheme requirements", null, "Annual SALSA audit scope and conditions."],
  ] as [string, string, string, string | null, string][]) {
    if (reqs.some((r) => r.title === title)) continue;
    const r = pick(
      await api.post("/governance/requirements", {
        source,
        reference,
        title,
        customerName,
        description: desc,
        ownerUserId: own("hannah@knotmilk.example"),
        reviewDueOn: addDays(today, 120),
      }),
      "requirement",
    );
    await api
      .post(`/governance/requirements/${r.id}/review`, {
        reviewedOn: addDays(today, -30),
        compliance: "compliant",
        notes: "Reviewed against current procedures; compliant.",
        nextReviewOn: addDays(today, 335),
      })
      .catch(() => {});
    made++;
  }

  // ── Concerns (confidential) ──
  const concerns = (await api.get("/governance/concerns")).concerns as any[];
  if (concerns.length < 3) {
    for (const [category, description, status, outcome] of [
      [
        "behaviour",
        "Staff sometimes prop the production hall door open during hot weather, bypassing the airlock.",
        "closed",
        "Door closer fitted and toolbox talk given.",
      ],
      [
        "food_safety",
        "A hose was left lying on the floor in the cheese room overnight.",
        "investigating",
        null,
      ],
    ] as [string, string, string, string | null][]) {
      const c = pick(await api.post("/concerns", { category, description, anonymous: true }), "concern");
      if (status !== "open")
        await reviewer
          .patch(`/governance/concerns/${c.id}`, {
            status,
            investigation: "Reviewed with the area supervisor.",
            outcome,
          })
          .catch(() => {});
      made++;
    }
  }

  // ── Management review ──
  const reviews = (await api.get("/governance/reviews")).reviews as any[];
  if (!reviews.length) {
    const r = pick(
      await api.post("/governance/reviews", {
        title: "Management review H1 2026",
        periodFrom: addDays(today, -330),
        periodTo: addDays(today, -150),
        heldOn: addDays(today, -140),
      }),
      "review",
    );
    await api
      .patch(`/governance/reviews/${r.id}`, {
        attendees: "Eleanor Whitcombe, Rhys Pritchard, Hannah Okafor, Callum Brennan, Priya Desai",
        notes: {
          performance: "No recalls. Complaint rate at 3.1 per million. HACCP verification complete.",
          audits: "Internal audits completed on schedule; findings closed.",
          resources: "Approved purchase of a second metal detector.",
        },
        resources: "£18,500 capital approved for a second yogurt line metal detector.",
        decisions: [
          {
            id: randomUUID(),
            topic: "Metal detection",
            decision: "Purchase a second detector for the yogurt line.",
            ownerUserId: own("rhys@knotmilk.example"),
            dueOn: addDays(today, -60),
          },
          {
            id: randomUUID(),
            topic: "Culture",
            decision: "Run the annual food safety culture survey in Q4.",
            ownerUserId: own("hannah@knotmilk.example"),
            dueOn: addDays(today, 40),
          },
        ],
      })
      .catch((e) => console.warn("review patch:", String(e.message).slice(0, 200)));
    await reviewer.post(`/governance/reviews/${r.id}/sign`, {}).catch(() => {});
    made++;
  }
  return `${made} governance records`;
}
