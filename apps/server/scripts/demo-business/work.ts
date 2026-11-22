import { d } from "@knotworking/core";
import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { hash } from "./commercial";

/** Teams, projects, tasks with comments and time, wiki documents and meetings. */
export async function work(ctx: Ctx) {
  const { api, today } = ctx;
  const user = ctx.ids.user!;
  const u = (k: string) => user[`${k}@knotmilk.example`] ?? user[k]!;
  let made = 0;
  const boot = await api.get("/bootstrap");
  const teams = boot.teams as any[];
  const members = (await api.get("/members")).members as any[];
  const byEmail = (e: string) => members.find((m) => m.email === e)?.userId as string;
  const demoUsers = ["marcus", "noor", "priya", "tomas"]
    .map((n) => byEmail(`${n}@knotworking.dev`))
    .filter(Boolean);

  // ── Teams ──
  const team: Record<string, any> = Object.fromEntries(teams.map((t) => [t.key, t]));
  for (const [key, name, icon, color, who] of [
    ["TEC", "Technical", "🧪", "green", ["hannah", "callum"]],
    ["PRD", "Production", "🏭", "teal", ["callum", "rhys", "hannah"]],
    ["FIN", "Finance and Purchasing", "💷", "purple", ["priya.d", "colin", "eleanor"]],
    ["DIS", "Warehouse and Distribution", "🚚", "orange", ["rhys", "naomi"]],
  ] as [string, string, string, string, string[]][]) {
    if (team[key]) continue;
    const t = pick(
      await api.post("/teams", { key, name, icon, color, memberIds: who.map((w) => u(w)) }),
      "team",
    );
    team[key] = t;
    made++;
  }
  const fresh = await api.get("/bootstrap");
  const states = fresh.workflowStates as any[];
  const stateId = (teamKey: string, name: string) =>
    states.find((s) => s.teamId === team[teamKey].id && s.name === name)?.id as string | undefined;
  for (const t of Object.values(team)) {
    const full = (fresh.teams as any[]).find((x) => x.key === t.key);
    if (full) team[t.key] = full;
  }

  // ── Labels ──
  const labelNames: [string, string][] = [
    ["Food safety", "red"],
    ["Customer", "blue"],
    ["Supplier", "orange"],
    ["Audit", "purple"],
    ["Cost saving", "green"],
    ["Maintenance", "gray"],
    ["Training", "yellow"],
    ["Compliance", "teal"],
    ["Launch", "pink"],
  ];
  const labels = fresh.labels as any[];
  const label: Record<string, string> = {};
  for (const [name, color] of labelNames) {
    let hit = labels.find((l) => l.name === name);
    if (!hit) {
      hit = pick(await api.post("/labels", { name, color }), "label");
      made++;
    }
    label[name] = hit.id;
  }

  // ── Projects ──
  const projects = ((await api.get("/projects")).projects as any[]) ?? fresh.projects;
  const project: Record<string, string> = {};
  const projDefs: [string, string, string, string, string, string, number, number][] = [
    [
      "Annual SALSA / BRCGS audit readiness",
      "Prepare the site, documents and people for the annual certification audit.",
      "🏅",
      "purple",
      "hannah",
      "on_track",
      -60,
      70,
    ],
    [
      "Yogurt line capacity expansion",
      "Add a second filler and chiller capacity to meet retail growth.",
      "🏗️",
      "orange",
      "rhys",
      "at_risk",
      -90,
      150,
    ],
    [
      "Christmas range launch",
      "Honey & granola yogurt gift packs and festive cream and butter.",
      "🎄",
      "red",
      "naomi",
      "on_track",
      -50,
      20,
    ],
    [
      "Raw milk supply contract renewal",
      "Renegotiate the co-op milk contract with price and quality terms.",
      "🥛",
      "blue",
      "eleanor",
      "on_track",
      -30,
      90,
    ],
    [
      "Energy and waste reduction",
      "Cut electricity use per litre and reduce packaging waste by 10%.",
      "♻️",
      "green",
      "rhys",
      "on_track",
      -120,
      200,
    ],
  ];
  const existingProj = fresh.projects as any[];
  for (const [name, description, icon, color, lead, health, s, e] of projDefs) {
    let hit = existingProj.find((p) => p.name === name);
    if (!hit) {
      hit = pick(
        await api.post("/projects", {
          name,
          description,
          icon,
          color,
          status: "active",
          health,
          leadId: u(lead),
          startDate: addDays(today, s),
          targetDate: addDays(today, e),
          teamIds: [],
        }),
        "project",
      );
      made++;
    }
    project[name] = hit.id;
  }

  // ── Tasks ──
  const existingTasks = new Set(
    (await api.get("/tasks?limit=500").catch(() => ({ tasks: fresh.tasks }))).tasks?.map(
      (t: any) => t.title,
    ) ?? (fresh.tasks as any[]).map((t) => t.title),
  );
  type T = [
    string,
    string,
    string,
    string,
    string,
    number,
    number | null,
    string[],
    string,
    string?,
    number?,
  ];
  // [team, title, state, assignee, project, priority, due(days), labels, description, parentTitle?, estimateMins?]
  const SA = "Annual SALSA / BRCGS audit readiness",
    YL = "Yogurt line capacity expansion",
    XM = "Christmas range launch",
    MC = "Raw milk supply contract renewal",
    EW = "Energy and waste reduction";
  const tasks: T[] = [
    [
      "TEC",
      "Review and update allergen matrix for all products",
      "In Progress",
      "hannah",
      SA,
      2,
      6,
      ["Food safety", "Audit"],
      "Cross-check every recipe against the allergen matrix and labels before the audit.",
      undefined,
      240,
    ],
    [
      "TEC",
      "Close open internal audit actions",
      "In Progress",
      "hannah",
      SA,
      2,
      10,
      ["Audit"],
      "Chase owners of all open non-conformances and verify evidence.",
      undefined,
      180,
    ],
    [
      "TEC",
      "Run mock recall for soft cheese",
      "Todo",
      "hannah",
      SA,
      2,
      25,
      ["Food safety", "Audit"],
      "Trace one lot up and down the chain within 4 hours.",
      undefined,
      180,
    ],
    [
      "TEC",
      "Refresh HACCP plan for new Greek-style yogurt",
      "Todo",
      "hannah",
      SA,
      3,
      45,
      ["Food safety"],
      "Hazard analysis, CCPs and verification for NPD-001.",
      undefined,
      300,
    ],
    [
      "TEC",
      "Calibrate pH meters and probes",
      "Done",
      "callum",
      SA,
      3,
      -8,
      ["Compliance"],
      "Quarterly calibration against UKAS reference.",
      undefined,
      90,
    ],
    [
      "TEC",
      "Update supplier approval files for packaging suppliers",
      "In Review",
      "hannah",
      SA,
      2,
      12,
      ["Supplier", "Audit"],
      "Refresh certificates, questionnaires and risk assessments.",
      undefined,
      240,
    ],
    [
      "TEC",
      "Investigate water test result on production tap",
      "Todo",
      "hannah",
      null as any,
      1,
      5,
      ["Food safety"],
      "Repeat sample; check filter condition.",
      undefined,
      60,
    ],
    [
      "PRD",
      "Trial new bottle cap on 1L line",
      "In Progress",
      "callum",
      YL,
      3,
      14,
      ["Cost saving"],
      "Compare torque consistency and leak rate of new lightweight cap.",
      undefined,
      180,
    ],
    [
      "PRD",
      "Specify second yogurt cup filler",
      "In Progress",
      "rhys",
      YL,
      1,
      21,
      [],
      "Write URS and collect quotes from three equipment suppliers.",
      undefined,
      300,
    ],
    [
      "PRD",
      "Chiller 3 floor plan and refrigeration load calculation",
      "Todo",
      "rhys",
      YL,
      2,
      35,
      [],
      "Engage refrigeration contractor for design.",
      undefined,
      240,
    ],
    [
      "PRD",
      "Train two new pasteuriser operators",
      "In Progress",
      "callum",
      null as any,
      2,
      18,
      ["Training"],
      "Complete HTST competency sign-off for Aoife and one agency worker.",
      undefined,
      480,
    ],
    [
      "PRD",
      "Reduce changeover time on yogurt line",
      "Todo",
      "callum",
      YL,
      3,
      40,
      ["Cost saving"],
      "SMED workshop with operators; target 15 minutes saved.",
      undefined,
      300,
    ],
    [
      "PRD",
      "Fix recurring jam on bottle capper",
      "Done",
      "callum",
      null as any,
      1,
      -10,
      ["Maintenance"],
      "Replaced worn chuck; monitor for two weeks.",
      undefined,
      120,
    ],
    [
      "PRD",
      "Plan Christmas production schedule",
      "In Review",
      "callum",
      XM,
      1,
      7,
      ["Launch"],
      "Plan gift-pack run for the week of 7 December.",
      undefined,
      240,
    ],
    [
      "PRD",
      "Set up festive gift pack line layout",
      "Todo",
      "callum",
      XM,
      2,
      15,
      ["Launch"],
      "Layout for hand-packing station and case labels.",
      undefined,
      120,
    ],
    [
      "FIN",
      "Approve weekly purchase orders above £2,500",
      "Todo",
      "priya.d",
      null as any,
      2,
      2,
      ["Supplier"],
      "Weekly review of draft POs awaiting approval.",
      undefined,
      30,
    ],
    [
      "FIN",
      "Reconcile October supplier statements",
      "In Progress",
      "priya.d",
      null as any,
      2,
      3,
      [],
      "Match supplier statements to approved invoices; chase differences.",
      undefined,
      180,
    ],
    [
      "FIN",
      "Negotiate packaging price increase",
      "In Progress",
      "colin",
      null as any,
      2,
      14,
      ["Supplier", "Cost saving"],
      "Greenfield Packaging requested 6% increase; counter with volume commitment.",
      undefined,
      120,
    ],
    [
      "FIN",
      "Review milk price index clause with co-op",
      "Todo",
      "eleanor",
      MC,
      1,
      30,
      ["Supplier"],
      "Position paper on index-linked pricing and quality bonus.",
      undefined,
      180,
    ],
    [
      "FIN",
      "Prepare November management accounts",
      "Backlog",
      "priya.d",
      null as any,
      3,
      20,
      [],
      "Month-end close and variance commentary.",
      undefined,
      360,
    ],
    [
      "FIN",
      "Renew product liability and recall insurance",
      "In Progress",
      "eleanor",
      null as any,
      1,
      28,
      ["Compliance"],
      "Broker quotes and renewal paperwork.",
      undefined,
      120,
    ],
    [
      "FIN",
      "Set up Sage 50 invoice export mapping",
      "Todo",
      "priya.d",
      null as any,
      3,
      33,
      [],
      "Map nominal codes and VAT codes for the accounting connection.",
      undefined,
      180,
    ],
    [
      "SAL",
      "Quote Cotswold Manor for spring menu cream and butter",
      "In Progress",
      "naomi",
      XM,
      2,
      4,
      ["Customer"],
      "Prepare and send quote QUOTE-Spring.",
      undefined,
      60,
    ],
    [
      "SAL",
      "Westcountry Co-op range review meeting",
      "Todo",
      "naomi",
      null as any,
      1,
      9,
      ["Customer"],
      "Present NPD-001 and Christmas range; discuss promo plan.",
      undefined,
      120,
    ],
    [
      "SAL",
      "Sample pack for Hungry Heron chef trial",
      "Todo",
      "naomi",
      null as any,
      3,
      12,
      ["Customer"],
      "Send cream, soft cheese and butter samples with spec sheets.",
      undefined,
      60,
    ],
    [
      "SAL",
      "Respond to retailer complaint about label",
      "Done",
      "naomi",
      null as any,
      2,
      -22,
      ["Customer", "Food safety"],
      "Written response and corrective action report.",
      undefined,
      90,
    ],
    [
      "SAL",
      "Update price lists for January",
      "Backlog",
      "naomi",
      null as any,
      3,
      38,
      ["Customer"],
      "Apply milk price pass-through to all customer price lists.",
      undefined,
      180,
    ],
    [
      "MKT",
      "Design Christmas gift pack artwork",
      "In Review",
      "priya",
      XM,
      2,
      5,
      ["Launch"],
      "Gift-pack label and sleeve artwork for approval.",
      undefined,
      300,
    ],
    [
      "MKT",
      "Photograph festive range for website",
      "Todo",
      "priya",
      XM,
      3,
      9,
      ["Launch"],
      "Studio shoot of honey & granola yogurt and cream.",
      undefined,
      240,
    ],
    [
      "MKT",
      "Write Christmas newsletter",
      "In Progress",
      "priya",
      XM,
      2,
      8,
      ["Launch"],
      "Newsletter to farm shops and cafés.",
      undefined,
      120,
    ],
    [
      "MKT",
      "Update farm story page on website",
      "Done",
      "priya",
      null as any,
      4,
      -16,
      [],
      "New photos from milking time; herd stats.",
      undefined,
      90,
    ],
    [
      "DIS",
      "Plan Christmas delivery routes",
      "In Progress",
      "rhys",
      XM,
      1,
      10,
      ["Launch"],
      "Extra drops Dec 20–23; driver rota.",
      undefined,
      180,
    ],
    [
      "DIS",
      "Service refrigerated van KN24 MLK",
      "Todo",
      "rhys",
      null as any,
      2,
      11,
      ["Maintenance"],
      "Chassis and refrigeration unit service.",
      undefined,
      60,
    ],
    [
      "DIS",
      "Audit delivery temperature loggers",
      "Todo",
      "rhys",
      null as any,
      2,
      16,
      ["Food safety"],
      "Verify logger calibration and download compliance.",
      undefined,
      90,
    ],
    [
      "OPS",
      "Install LED lighting in production hall",
      "Backlog",
      "rhys",
      EW,
      4,
      60,
      ["Cost saving"],
      "Quote and payback for LED conversion.",
      undefined,
      240,
    ],
    [
      "OPS",
      "Heat recovery from pasteuriser cooling water",
      "Backlog",
      "rhys",
      EW,
      3,
      90,
      ["Cost saving"],
      "Feasibility study for pre-heating CIP water.",
      undefined,
      480,
    ],
    [
      "OPS",
      "Cut cardboard waste with returnable crates",
      "In Progress",
      "rhys",
      EW,
      2,
      30,
      ["Cost saving"],
      "Pilot returnable crates with three customers.",
      undefined,
      180,
    ],
    [
      "OPS",
      "Monthly water and energy meter readings",
      "Todo",
      "rhys",
      EW,
      3,
      6,
      [],
      "Record meter readings for the utilities register.",
      undefined,
      30,
    ],
    [
      "OPS",
      "Replace chiller 1 door seal",
      "Done",
      "rhys",
      null as any,
      2,
      -9,
      ["Maintenance"],
      "Raised as work order WO; completed by Frank Doyle.",
      undefined,
      60,
    ],
    [
      "OPS",
      "Annual fire risk assessment review",
      "In Review",
      "rhys",
      null as any,
      2,
      18,
      ["Compliance"],
      "Review against current layout; update evacuation plan.",
      undefined,
      180,
    ],
    [
      "GEN",
      "Plan Christmas party and shift cover",
      "Todo",
      "eleanor",
      null as any,
      4,
      26,
      [],
      "Book venue and ensure cover for chillers and dispatch.",
      undefined,
      90,
    ],
  ];
  const stateFor = (teamKey: string, stateName: string) =>
    stateId(teamKey, stateName) ?? states.find((s) => s.teamId === team[teamKey].id)?.id;
  const taskIds: Record<string, string> = {};
  for (const [teamKey, title, stateName, assignee, proj, priority, dueDays, lbls, desc, , est] of tasks) {
    if (existingTasks.has(title)) continue;
    const tm = team[teamKey];
    if (!tm) continue;
    const created = pick(
      await api.post("/tasks", {
        teamId: tm.id,
        title,
        description: d.doc(d.p(desc)),
        stateId: stateFor(teamKey, stateName),
        priority,
        assigneeId: u(assignee),
        projectId: proj ? (project[proj] ?? null) : null,
        labelIds: lbls.map((l) => label[l]).filter(Boolean),
        dueDate: dueDays === null ? null : addDays(today, dueDays),
        estimateMinutes: est ?? null,
      }),
      "task",
    );
    taskIds[title] = created.id;
    made++;
  }

  // Relations (dependencies)
  for (const [blocker, blocked] of [
    ["Specify second yogurt cup filler", "Chiller 3 floor plan and refrigeration load calculation"],
    ["Plan Christmas production schedule", "Set up festive gift pack line layout"],
    ["Design Christmas gift pack artwork", "Photograph festive range for website"],
  ]) {
    if (taskIds[blocker!] && taskIds[blocked!])
      await api
        .post("/task-relations", { blockingTaskId: taskIds[blocker!], blockedTaskId: taskIds[blocked!] })
        .catch(() => {});
  }
  // Comments
  const comments: [string, string, string][] = [
    [
      "Fix recurring jam on bottle capper",
      "callum",
      "Chuck replaced and torque reset. Running well since Monday.",
    ],
    [
      "Trial new bottle cap on 1L line",
      "callum",
      "First 2,000 bottles passed leak testing; second trial tomorrow.",
    ],
    [
      "Negotiate packaging price increase",
      "colin",
      "Greenfield will accept 3.5% if we commit to 6-month volumes.",
    ],
    [
      "Update supplier approval files for packaging suppliers",
      "hannah",
      "Questionnaires received from both bottle suppliers; waiting on updated BRCGS certificate.",
    ],
    [
      "Review and update allergen matrix for all products",
      "hannah",
      "Matrix updated for all yogurts; butter and cheese next.",
    ],
    [
      "Plan Christmas production schedule",
      "callum",
      "Draft schedule uploaded; needs sign-off on gift pack volumes.",
    ],
  ];
  for (const [title, who, text] of comments)
    if (taskIds[title])
      await api.post(`/tasks/${taskIds[title]}/comments`, { body: d.doc(d.p(text)) }).catch(() => {});

  // Time entries logged against completed/in-progress tasks
  let timeMade = 0;
  const entryDefs: [string, string, number][] = [
    ["Fix recurring jam on bottle capper", "callum", 120],
    ["Replace chiller 1 door seal", "rhys", 75],
    ["Calibrate pH meters and probes", "callum", 90],
    ["Respond to retailer complaint about label", "naomi", 80],
    ["Update farm story page on website", "priya", 100],
    ["Review and update allergen matrix for all products", "hannah", 150],
    ["Close open internal audit actions", "hannah", 110],
    ["Specify second yogurt cup filler", "rhys", 140],
    ["Trial new bottle cap on 1L line", "callum", 160],
    ["Reconcile October supplier statements", "priya.d", 120],
  ];
  for (const [title, who, mins] of entryDefs) {
    if (!taskIds[title]) continue;
    for (const [i, chunk] of [0.5, 0.3, 0.2].entries())
      await api
        .post(`/tasks/${taskIds[title]}/time-entries`, {
          minutes: Math.round(mins * chunk),
          note: ["Planning", "Hands-on work", "Follow-up"][i],
          entryDate: addDays(today, -(i + 1) - (hash(title) % 5)),
          userId: u(who),
        })
        .then(() => timeMade++)
        .catch(() => {});
  }

  // ── Documents (wiki) ──
  const docs = fresh.documents as any[];
  const docIds: Record<string, string> = {};
  const docDefs: [string, string, string | null, any][] = [
    [
      "Knotmilk Dairy company handbook",
      "📘",
      "GEN",
      d.doc(
        d.h(1, "Welcome to Knotmilk Dairy"),
        d.p(
          "We are a family dairy in the Somerset hills, making milk, yogurt, butter, cream and soft cheese for local retailers, schools, cafés and restaurants.",
        ),
        d.h(2, "How we work"),
        d.bullets(
          "Safety and quality come before output.",
          "Clean as you go. Report anything that doesn't look right.",
          "Tell your supervisor first; escalate to Technical for food safety questions.",
        ),
        d.h(2, "Who to ask"),
        d.bullets(
          "Production: Callum Brennan",
          "Technical and quality: Hannah Okafor",
          "Operations: Rhys Pritchard",
          "Sales: Naomi Clarke",
        ),
      ),
    ],
    [
      "The production day: how a shift runs",
      "🏭",
      "PRD",
      d.doc(
        d.h(1, "A typical production day"),
        d.numbered(
          "05:30 Early shift starts: pre-start check and metal detector test.",
          "06:00 Raw milk intake and tests.",
          "07:00 Pasteurisation and bottling.",
          "10:30 Yogurt base and filling.",
          "13:30 Late shift handover: record CCP checks.",
          "16:00 Cleaning and CIP.",
          "21:30 Cleaning crew arrives.",
        ),
        d.callout("⚠️", "Allergen products (granola) are always run last on the yogurt line."),
      ),
    ],
    [
      "Allergen matrix: how to read it",
      "⚠️",
      "TEC",
      d.doc(
        d.h(1, "Allergen matrix"),
        d.p(
          "The matrix lists the 14 major allergens against each recipe. It is generated from recipe allergens and kept in the Labelling module.",
        ),
        d.bullets(
          "Milk is present in every product.",
          "Granola contains cereals containing gluten and tree nuts, and may contain peanuts and sesame.",
          "Strawberry purée may contain sulphites.",
        ),
      ),
    ],
    [
      "Recall quick reference",
      "🚨",
      "TEC",
      d.doc(
        d.h(1, "Product recall: quick reference"),
        d.numbered(
          "Stop all despatch of the affected lot.",
          "Call the Technical Manager immediately.",
          "Identify lots using traceability.",
          "Notify customers and the FSA.",
          "Quarantine and record all stock.",
        ),
        d.p("Full procedure: SOP-007."),
      ),
    ],
    [
      "Customer onboarding checklist",
      "🤝",
      "SAL",
      d.doc(
        d.h(1, "Onboarding a new customer"),
        d.tasks(
          ["Credit check and account application", true],
          ["Agree specification and minimum shelf life on receipt", true],
          ["Set up delivery site and temperature requirements", false],
          ["Add price list", false],
          ["First delivery with a call to goods-in", false],
        ),
      ),
    ],
    [
      "Supplier approval process",
      "📦",
      "TEC",
      d.doc(
        d.h(1, "Approving a new supplier"),
        d.numbered(
          "Collect certification and send the questionnaire.",
          "Risk-assess the supplier and each item.",
          "Agree specifications for each material.",
          "Approve in the system with a review date.",
          "Review performance each quarter.",
        ),
      ),
    ],
    [
      "Weekly production planning meeting: notes template",
      "🗓️",
      "PRD",
      d.doc(
        d.h(1, "Weekly production planning"),
        d.h(2, "Agenda"),
        d.bullets(
          "Last week: yield, downtime, waste",
          "Next week: demand forecast and capacity",
          "Packaging and ingredient stock",
          "People: leave, training, agency cover",
          "Maintenance and cleaning",
        ),
      ),
    ],
    [
      "Christmas range 2026: plan",
      "🎄",
      "SAL",
      d.doc(
        d.h(1, "Christmas range"),
        d.p(
          "Honey & granola yogurt gift packs, festive double cream and salted butter. Launch week of 7 December.",
        ),
        d.tasks(
          ["Artwork approved", false],
          ["Gift pack line layout", false],
          ["Allergen label check (nuts)", false],
          ["Delivery route plan", false],
        ),
      ),
    ],
    [
      "Energy and waste reduction plan",
      "♻️",
      "OPS",
      d.doc(
        d.h(1, "Energy and waste reduction"),
        d.p("Targets: cut electricity per litre by 8% and packaging waste by 10% by year-end."),
        d.bullets(
          "LED lighting conversion",
          "Pasteuriser heat recovery",
          "Returnable crates",
          "Weekly meter readings",
        ),
      ),
    ],
  ];
  const topDocs = docs.filter((x) => !x.parentId).map((x) => x.title);
  for (const [title, icon, teamKey, content] of docDefs) {
    if (topDocs.includes(title)) {
      docIds[title] = docs.find((x) => x.title === title).id;
      continue;
    }
    const r = pick(
      await api.post("/documents", {
        title,
        icon,
        teamId: teamKey ? (team[teamKey]?.id ?? null) : null,
        content,
      }),
      "document",
    );
    docIds[title] = r.id;
    made++;
  }

  // ── Meetings ──
  const ms = (await api
    .get("/calendar?from=" + addDays(today, -40) + "&to=" + addDays(today, 40))
    .catch(() => ({ meetings: [] }))) as any;
  const haveMeeting = new Set(
    (ms.meetings ?? ms.events ?? []).map((m: any) => `${m.title}|${String(m.startsAt).slice(0, 10)}`),
  );
  const att = (names: string[]) => names.map((n) => `${n}@knotmilk.example`);
  const meetingDefs: [string, number, number, number, string[], string, string][] = [
    [
      "Weekly production planning",
      1,
      9,
      0,
      ["rhys", "callum", "hannah", "naomi", "colin"],
      "Meeting room",
      "Weekly",
    ],
    ["HACCP team meeting", 14, 14, 0, ["hannah", "callum", "rhys"], "Technical office", "Monthly"],
    [
      "Customer review: Westcountry Co-operative",
      9,
      11,
      0,
      ["naomi", "eleanor"],
      "Customer HQ, Exeter",
      "Customer",
    ],
    [
      "Monthly management meeting",
      5,
      15,
      0,
      ["eleanor", "rhys", "hannah", "callum", "priya.d", "naomi"],
      "Boardroom",
      "Monthly",
    ],
    [
      "Supplier review: Greenfield Packaging",
      16,
      10,
      30,
      ["colin", "rhys", "hannah"],
      "Video call",
      "Supplier",
    ],
  ];
  for (const [title, firstOffset, hour, min, who, location, kind] of meetingDefs) {
    const occurrences =
      kind === "Weekly" ? [-21, -14, -7, 0 + 0, 7, 14] : kind === "Monthly" ? [-28, 0] : [0];
    for (const [i, off] of occurrences.entries()) {
      const start = new Date(
        `${addDays(today, kind === "Weekly" ? off + ((8 - new Date(today).getUTCDay()) % 7 || 7) - 7 + 0 : firstOffset + off)}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00Z`,
      );
      const key = `${title}|${start.toISOString().slice(0, 10)}`;
      if (haveMeeting.has(key)) continue;
      const m = pick(
        await api.post("/meetings", {
          title,
          description: `${title} — standing agenda in the wiki.`,
          location,
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
          attendeeEmails: att(who),
          createNotes: i % 2 === 0,
        }),
        "meeting",
      );
      made++;
      if (start < new Date() && m?.id) await api.post(`/meetings/${m.id}/notes`, {}).catch(() => {});
    }
  }
  return `${made} work records, ${timeMade} time entries`;
}
