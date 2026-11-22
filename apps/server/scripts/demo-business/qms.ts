import { d } from "@knotworking/core";
import type { Ctx } from "./api";
import { addDays } from "./api";
import { hash } from "./commercial";
import { loginAs } from "./team";

/** SOPs (document-controlled), training courses/requirements/records, and approved specifications. */
import { pickRecord as pick } from "./api";

interface SopDef {
  code: string;
  title: string;
  category: string;
  owner: string;
  purpose: string;
  steps: string[];
  records: string;
  roles: string[];
}
export const sopDefs: SopDef[] = [
  {
    code: "SOP-001",
    title: "Raw milk intake, sampling and testing",
    category: "Goods-in",
    owner: "hannah@knotmilk.example",
    purpose: "Ensure every tanker of raw milk is checked before it is accepted onto site.",
    steps: [
      "Check the driver's collection note, tanker seal number and milk temperature (must be 5°C or below).",
      "Take a representative sample from the tanker before discharge.",
      "Run the antibiotic residue test; a positive result means the load is rejected.",
      "Record fat, protein and temperature on the intake log.",
      "Discharge to the raw milk silo only after all checks pass and the load is signed in.",
    ],
    records: "Raw milk intake log; antibiotic test record.",
    roles: ["Goods-in operative", "Pasteuriser operator", "Quality technician"],
  },
  {
    code: "SOP-002",
    title: "HTST pasteuriser operation and verification",
    category: "Production",
    owner: "callum@knotmilk.example",
    purpose: "Operate the plate pasteuriser so that every litre receives a validated heat treatment.",
    steps: [
      "Pre-sterilise the plant at 85°C for 20 minutes and record the time.",
      "Set the flow diversion valve to divert below 72°C and check it before starting.",
      "Pasteurise at a minimum of 72°C for 15 seconds; record temperature every 30 minutes.",
      "Run the alkaline phosphatase test on the first product of each shift.",
      "Divert and quarantine product if temperature falls below the legal minimum, then raise a deviation.",
    ],
    records: "Pasteuriser chart and log; phosphatase test results.",
    roles: ["Pasteuriser operator", "Production supervisor"],
  },
  {
    code: "SOP-003",
    title: "Clean-in-place (CIP) of pasteuriser, silos and fillers",
    category: "Hygiene",
    owner: "hannah@knotmilk.example",
    purpose: "Remove soil and microbial contamination from product-contact surfaces.",
    steps: [
      "Rinse with potable water until the outlet runs clear.",
      "Circulate 1.5% caustic at 75°C for 20 minutes.",
      "Rinse until neutral pH is confirmed.",
      "Circulate 0.8% nitric acid at 65°C for 15 minutes.",
      "Final rinse, then confirm conductivity and swab if due.",
    ],
    records: "CIP log; chemical titration record.",
    roles: ["Cleaner", "Pasteuriser operator"],
  },
  {
    code: "SOP-004",
    title: "Personal hygiene, protective clothing and visitors",
    category: "Hygiene",
    owner: "hannah@knotmilk.example",
    purpose: "Prevent contamination of product by people.",
    steps: [
      "Wear clean whites, hairnet, beard snood and boots before entering the production area.",
      "Wash and sanitise hands on entry, after breaks and after handling waste.",
      "No jewellery, watches or false nails; plain wedding bands only.",
      "Report any illness, diarrhoea or vomiting before starting your shift.",
      "Visitors complete the visitor declaration and are escorted at all times.",
    ],
    records: "Visitor declaration; return-to-work forms.",
    roles: [
      "Production operative",
      "Production supervisor",
      "Cheesemaker",
      "Pasteuriser operator",
      "Quality technician",
      "Goods-in operative",
      "Warehouse operative",
      "Cleaner",
      "Maintenance engineer",
    ],
  },
  {
    code: "SOP-005",
    title: "Allergen management and changeover",
    category: "Quality",
    owner: "hannah@knotmilk.example",
    purpose: "Prevent cross-contact between products containing different allergens.",
    steps: [
      "Schedule allergen-containing products (granola, nuts) last in the day where possible.",
      "After a changeover from an allergen product, complete a full clean and verify with an ATP swab.",
      "Label and store allergen ingredients in the designated racks.",
      "Check the label matches the recipe's allergen declaration before each run.",
      "Record the changeover on the allergen changeover log.",
    ],
    records: "Allergen changeover log; ATP swab results.",
    roles: ["Production operative", "Production supervisor", "Quality technician"],
  },
  {
    code: "SOP-006",
    title: "Metal detection and foreign-body control",
    category: "Quality",
    owner: "hannah@knotmilk.example",
    purpose: "Detect and remove metal and other foreign bodies from finished product.",
    steps: [
      "Test the detector at start-up, hourly and at end of run with Fe 2.0mm, non-Fe 2.5mm and stainless 3.0mm test pieces.",
      "If any test piece is missed, stop the line and quarantine product since the last good test.",
      "Rejected product is checked by the supervisor and recorded.",
      "Re-run all product from the last passing test.",
    ],
    records: "Metal detector check sheet.",
    roles: ["Production operative", "Quality technician"],
  },
  {
    code: "SOP-007",
    title: "Product recall and withdrawal",
    category: "Quality",
    owner: "hannah@knotmilk.example",
    purpose: "Remove unsafe product from the market quickly and traceably.",
    steps: [
      "The Technical Manager convenes the recall team within 2 hours of a confirmed issue.",
      "Identify affected lots using batch and lot traceability.",
      "Notify customers and the Food Standards Agency as required.",
      "Quarantine remaining stock and record quantities.",
      "Complete a root-cause investigation and close with corrective actions.",
    ],
    records: "Recall log; mock recall report.",
    roles: ["Quality technician", "Production supervisor"],
  },
  {
    code: "SOP-008",
    title: "Pest control",
    category: "Site",
    owner: "rhys@knotmilk.example",
    purpose: "Keep the site free of pests through monitoring and proofing.",
    steps: [
      "The contractor inspects all devices monthly and reports findings.",
      "Staff report any pest sighting immediately to the Technical team.",
      "Keep doors closed, waste covered and external areas clear of food residue.",
    ],
    records: "Pest control visit reports and device map.",
    roles: ["Warehouse operative", "Goods-in operative", "Maintenance engineer"],
  },
  {
    code: "SOP-009",
    title: "Glass, hard plastic and brittle material control",
    category: "Site",
    owner: "hannah@knotmilk.example",
    purpose: "Minimise the risk of glass and brittle plastic contamination.",
    steps: [
      "Maintain the glass and brittle plastics register; every item is checked monthly.",
      "Any breakage is reported immediately and the line is stopped.",
      "Clear and inspect the area, and check nearby product before restarting.",
    ],
    records: "Glass register; breakage log.",
    roles: ["Production supervisor", "Quality technician", "Maintenance engineer"],
  },
  {
    code: "SOP-010",
    title: "Cold chain and chilled storage",
    category: "Warehouse",
    owner: "rhys@knotmilk.example",
    purpose: "Keep chilled product between 0°C and 5°C.",
    steps: [
      "Record chiller temperatures every four hours.",
      "Do not leave product outside the chiller for more than 20 minutes.",
      "If a chiller exceeds 5°C for more than one hour, move stock and raise a deviation.",
    ],
    records: "Chiller temperature log.",
    roles: ["Warehouse operative", "Goods-in operative", "Driver"],
  },
  {
    code: "SOP-011",
    title: "Yogurt incubation and fermentation control",
    category: "Production",
    owner: "callum@knotmilk.example",
    purpose: "Produce consistent yogurt with a final pH of 4.4–4.6.",
    steps: [
      "Cool heat-treated base to 43°C and inoculate with the specified culture dose.",
      "Incubate and check pH hourly from three hours.",
      "Break and cool to below 8°C when pH reaches 4.5.",
      "Record start/end times and final pH on the batch record.",
    ],
    records: "Batch record; pH log.",
    roles: ["Production operative", "Pasteuriser operator"],
  },
  {
    code: "SOP-012",
    title: "Despatch loading and vehicle checks",
    category: "Distribution",
    owner: "rhys@knotmilk.example",
    purpose: "Load safely and keep chilled product within temperature on the road.",
    steps: [
      "Check the vehicle is clean, free of odours and pre-cooled to 3°C or below.",
      "Load FEFO and segregate allergen-sensitive products.",
      "Record the vehicle, temperature and load check before departure.",
      "Obtain a signed proof of delivery.",
    ],
    records: "Load check; proof of delivery.",
    roles: ["Driver", "Warehouse operative"],
  },
  {
    code: "SOP-013",
    title: "Customer complaint handling",
    category: "Quality",
    owner: "hannah@knotmilk.example",
    purpose: "Investigate every complaint and learn from it.",
    steps: [
      "Log the complaint with product, lot and customer details.",
      "Acknowledge within one working day.",
      "Investigate using batch records and retained samples.",
      "Reply with findings and any corrective action within ten working days.",
    ],
    records: "Complaint record.",
    roles: ["Quality technician"],
  },
  {
    code: "SOP-014",
    title: "Fire, evacuation and emergency procedure",
    category: "Health & safety",
    owner: "rhys@knotmilk.example",
    purpose: "Protect people in an emergency.",
    steps: [
      "On hearing the alarm, stop work, make equipment safe and leave by the nearest exit.",
      "Assemble at the muster point; fire marshals take the roll call.",
      "Do not re-enter until the fire service declares the building safe.",
    ],
    records: "Fire drill record.",
    roles: [
      "Production operative",
      "Production supervisor",
      "Cheesemaker",
      "Pasteuriser operator",
      "Quality technician",
      "Goods-in operative",
      "Warehouse operative",
      "Driver",
      "Cleaner",
      "Maintenance engineer",
    ],
  },
  {
    code: "SOP-015",
    title: "Manual handling",
    category: "Health & safety",
    owner: "rhys@knotmilk.example",
    purpose: "Reduce the risk of musculoskeletal injury.",
    steps: [
      "Assess the load before lifting; use a trolley or pallet truck where possible.",
      "Keep the load close, back straight, bend at the knees.",
      "Never lift more than 20 kg alone; ask for help or use a hoist.",
    ],
    records: "Manual handling assessments.",
    roles: ["Warehouse operative", "Production operative", "Driver", "Goods-in operative"],
  },
];

const sopContent = (s: SopDef) =>
  d.doc(
    d.h(1, s.title),
    d.h(2, "Purpose"),
    d.p(s.purpose),
    d.h(2, "Scope"),
    d.p("Applies to all staff and contractors working at the Knotmilk Dairy site."),
    d.h(2, "Procedure"),
    d.numbered(...s.steps),
    d.h(2, "Records"),
    d.p(s.records),
    d.callout("⚠️", "Any deviation from this procedure must be reported to a supervisor and recorded."),
  );

export const courses: {
  code: string;
  title: string;
  kind: "sop" | "induction" | "on_the_job" | "external" | "certificate";
  months: number | null;
  signOff?: boolean;
  sop?: string;
  roles: string[];
}[] = [
  { code: "TRN-IND", title: "Site induction", kind: "induction", months: null, roles: ["*"] },
  {
    code: "TRN-FH2",
    title: "Food hygiene, Level 2",
    kind: "certificate",
    months: 36,
    roles: [
      "Production operative",
      "Production supervisor",
      "Cheesemaker",
      "Pasteuriser operator",
      "Goods-in operative",
      "Warehouse operative",
      "Cleaner",
    ],
  },
  {
    code: "TRN-HACCP3",
    title: "HACCP, Level 3",
    kind: "external",
    months: 36,
    roles: ["Quality technician", "Production supervisor"],
  },
  {
    code: "TRN-ALL",
    title: "Allergen awareness",
    kind: "on_the_job",
    months: 12,
    roles: [
      "Production operative",
      "Production supervisor",
      "Cheesemaker",
      "Pasteuriser operator",
      "Quality technician",
    ],
  },
  {
    code: "TRN-FORK",
    title: "Counterbalance forklift licence",
    kind: "certificate",
    months: 36,
    roles: ["Warehouse operative", "Goods-in operative"],
  },
  {
    code: "TRN-FIRSTAID",
    title: "First aid at work",
    kind: "certificate",
    months: 36,
    roles: ["Production supervisor", "Maintenance engineer"],
  },
  {
    code: "TRN-CIP",
    title: "CIP competency",
    kind: "on_the_job",
    months: 12,
    signOff: true,
    roles: ["Cleaner", "Pasteuriser operator"],
  },
  {
    code: "TRN-HTST",
    title: "Pasteuriser operator competency",
    kind: "on_the_job",
    months: 12,
    signOff: true,
    roles: ["Pasteuriser operator"],
  },
  {
    code: "TRN-MD",
    title: "Metal detector operation",
    kind: "on_the_job",
    months: 12,
    signOff: true,
    roles: ["Production operative", "Quality technician"],
  },
];

export async function qms(ctx: Ctx) {
  const { api, today } = ctx;
  const approver = await loginAs(ctx, "hannah@knotmilk.example");
  const userId = ctx.ids.user!,
    role = ctx.ids.role!,
    stf = ctx.ids.staff!;
  const sopId = (ctx.ids.sop ??= {});
  const courseId = (ctx.ids.course ??= {});
  let made = 0;

  // ── SOPs ──
  const existing = (await api.get("/sops?status=all&limit=200")).sops as any[];
  for (const s of sopDefs) {
    let hit = existing.find((x) => x.code === s.code);
    if (!hit) {
      const created = pick(
        await api.post("/sops", {
          code: s.code,
          title: s.title,
          category: s.category,
          ownerId: userId[s.owner],
          reviewIntervalMonths: 12,
          ackReminderDays: 14,
          ackReminderRepeatDays: 7,
          content: sopContent(s),
        }),
        "sop",
      );
      hit = created;
      await api.post(`/sops/${hit.id}/submit`, { changeSummary: "Initial issue." });
      const full = pick(await api.get(`/sops/${hit.id}`), "sop");
      const versionId =
        full.draftVersion?.id ??
        full.versions?.find(
          (v: any) => v.status === "pending" || v.status === "submitted" || v.status === "in_review",
        )?.id ??
        full.versions?.[0]?.id;
      await approver.post(`/sops/${hit.id}/versions/${versionId}/decision`, {
        decision: "approve",
        effectiveOn: addDays(today, -60 - (hash(s.code) % 120)),
        reviewDueOn: addDays(today, 60 + (hash(s.code) % 280)),
        note: "Reviewed against current practice.",
      });
      made++;
    }
    sopId[s.code] = hit.id;
    await api.put(`/sops/${hit.id}/targets`, {
      jobRoleIds: s.roles.map((r) => role[r]).filter(Boolean),
      userIds: [],
    });
  }

  // ── Training courses & requirements ──
  const existingCourses = (await api.get("/training/courses?status=all")).courses as any[];
  const sopCourse = (c: string) => ({
    code: `TRN-${c}`,
    title: `${sopDefs.find((s) => s.code === c)!.title}`,
    kind: "sop" as const,
    months: 12,
    sop: c,
    roles: sopDefs.find((s) => s.code === c)!.roles,
  });
  const allCourses = [
    ...courses,
    ...["SOP-002", "SOP-003", "SOP-004", "SOP-005", "SOP-007"].map(sopCourse),
  ] as typeof courses;
  for (const c of allCourses) {
    let hit = existingCourses.find((x) => x.code === c.code);
    if (!hit) {
      hit = pick(
        await api.post("/training/courses", {
          code: c.code,
          title: c.title,
          kind: c.kind,
          validityMonths: c.months,
          requiresSignOff: c.signOff ?? false,
          sopId: c.sop ? sopId[c.sop] : undefined,
          description: `${c.title} for Knotmilk Dairy staff.`,
        }),
        "course",
      );
      made++;
    }
    courseId[c.code] = hit.id;
    const roles = c.roles.includes("*")
      ? Object.keys(role).filter((r) => !["Driver"].includes(r) || true)
      : c.roles;
    await api.put(`/training/courses/${hit.id}/requirements`, {
      requirements: roles.map((r) => ({ jobRoleId: role[r]!, dueWithinDays: 30 })),
    });
  }

  // ── Training records: most people trained, a realistic few lapsed or missing ──
  const staffList = (await api.get("/people/staff?limit=500")).staff as any[];
  const haveRecords = new Set(
    ((await api.get("/training/records?limit=500")).records as any[]).map(
      (r) => `${r.staffId}:${r.courseId}`,
    ),
  );
  const byCourse = new Map<string, string[]>();
  const trainerName = ["Hannah Okafor", "Isla McAllister", "Callum Brennan", "Dev Patel"];
  for (const s of staffList) {
    const roleNames = (s.jobRoles as any[]).map((r) => r.name);
    for (const c of allCourses) {
      const needed = c.roles.includes("*") || c.roles.some((r) => roleNames.includes(r));
      if (!needed) continue;
      const h = hash(`${s.id}${c.code}`);
      if (h % 17 === 0) continue; // never trained → shows as missing/overdue
      if (haveRecords.has(`${s.id}:${courseId[c.code]}`)) continue;
      const validDays = (c.months ?? 60) * 30;
      const ageDays = h % 11 === 0 ? validDays + 10 + (h % 60) : h % Math.max(60, validDays - 20); // a few lapsed
      const start = s.startDate ?? addDays(today, -400);
      let on = addDays(today, -Math.min(ageDays, 700));
      if (on < start) on = addDays(start, 7 + (h % 20));
      const key = `${c.code}|${on}|${trainerName[h % 4]}`;
      byCourse.set(key, [...(byCourse.get(key) ?? []), s.id]);
    }
  }
  let recs = 0;
  for (const [key, ids] of byCourse) {
    const [code, on, trainer] = key.split("|");
    await api.post("/training/records", {
      staffIds: ids,
      courseId: courseId[code!],
      completedOn: on,
      outcome: "competent",
      trainerName: trainer,
      notes: "Trained and observed.",
    });
    recs += ids.length;
  }
  // Sign-off competency records
  const pending = ((await api.get("/training/records?signOff=pending&limit=500")).records as any[]).map(
    (r) => r.id,
  );
  for (let i = 0; i < pending.length; i += 100)
    await approver
      .post("/training/records/sign-off", { recordIds: pending.slice(i, i + 100) })
      .catch(() => {});
  return `${made} SOPs/courses created, ${recs} training records`;
}

/** Approved specifications for key items. */
export async function specifications(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    sup = ctx.ids.supplier!;
  const approver = await loginAs(ctx, "hannah@knotmilk.example");
  const existing = (await api.get("/specifications?status=all&limit=200")).specifications as any[];
  const P = (
    category: string,
    name: string,
    unit: string | null,
    min?: number,
    target?: number,
    max?: number,
    method?: string,
    limitText?: string,
  ) => ({
    category,
    name,
    unit,
    min,
    target,
    max,
    method: method ?? null,
    ...(limitText ? { limitText } : {}),
  });
  const defs: {
    code: string;
    title: string;
    item: string;
    supplier?: string;
    customer?: string;
    draft: any;
  }[] = [
    {
      code: "SPEC-ING-MILK",
      title: "Raw cows' milk",
      item: "ING-MILK",
      supplier: "SUP-MILK",
      draft: {
        description: "Raw bulk cows' milk from Somerset Vale Farms Co-op herds.",
        storage: "chilled",
        storageInstructions: "Hold at 5°C or below.",
        shelfLifeDays: 3,
        allergens: ["milk"],
        countryOfOrigin: "United Kingdom",
        claims: ["Red Tractor assured"],
        parameters: [
          P("physical", "Temperature on receipt", "°C", 0, 4, 5, "Probe"),
          P("chemical", "Butterfat", "%", 3.8, 4.1, 4.6, "Milkoscan"),
          P("chemical", "Protein", "%", 3.2, 3.4, 3.8, "Milkoscan"),
          P("microbiological", "Total bacterial count", "cfu/ml", undefined, undefined, 100000, "ISO 4833"),
          P("microbiological", "Somatic cell count", "cells/ml", undefined, undefined, 400000, "Fossomatic"),
          P(
            "chemical",
            "Antibiotic residues",
            null,
            undefined,
            undefined,
            undefined,
            "Rapid test",
            "Negative",
          ),
        ],
        reviewDueOn: addDays(today, 200),
        agreedBy: "Alan Pettifer",
        agreedOn: addDays(today, -165),
        agreementReference: "SVF/KM/2026-01",
        changeNote: "Initial agreed specification.",
      },
    },
    {
      code: "SPEC-ING-CREAM",
      title: "Double cream (bulk)",
      item: "ING-CREAM",
      supplier: "SUP-MILK",
      draft: {
        description: "Pasteurised double cream, 48% fat.",
        storage: "chilled",
        shelfLifeDays: 5,
        allergens: ["milk"],
        countryOfOrigin: "United Kingdom",
        parameters: [
          P("chemical", "Butterfat", "%", 47.5, 48, 49, "Gerber"),
          P("physical", "Temperature on receipt", "°C", 0, 3, 5, "Probe"),
          P("microbiological", "Enterobacteriaceae", "cfu/g", undefined, undefined, 10, "ISO 21528"),
        ],
        reviewDueOn: addDays(today, 150),
        agreedBy: "Alan Pettifer",
        agreedOn: addDays(today, -200),
        changeNote: "Initial version.",
      },
    },
    {
      code: "SPEC-ING-STRAW",
      title: "Strawberry purée",
      item: "ING-STRAW",
      supplier: "SUP-FRUIT",
      draft: {
        description: "Heat-treated strawberry purée, 10°Brix.",
        storage: "chilled",
        shelfLifeDays: 120,
        allergens: [],
        mayContain: ["sulphites"],
        countryOfOrigin: "Spain",
        claims: ["No added sugar"],
        parameters: [
          P("chemical", "Brix", "°Bx", 9, 10, 12, "Refractometer"),
          P("chemical", "pH", null, 3.2, 3.5, 3.9, "pH meter"),
          P(
            "sensory",
            "Appearance",
            null,
            undefined,
            undefined,
            undefined,
            "Visual",
            "Red, free of seeds over 2mm",
          ),
          P("microbiological", "Yeasts and moulds", "cfu/g", undefined, undefined, 100, "ISO 21527"),
        ],
        reviewDueOn: addDays(today, 120),
        agreedBy: "Sam Whitlock",
        agreedOn: addDays(today, -180),
        changeNote: "Initial version.",
      },
    },
    {
      code: "SPEC-ING-SUGAR",
      title: "Cane sugar",
      item: "ING-SUGAR",
      supplier: "SUP-SUGAR",
      draft: {
        description: "White granulated sugar.",
        storage: "ambient",
        shelfLifeDays: 730,
        allergens: [],
        countryOfOrigin: "United Kingdom",
        parameters: [
          P("chemical", "Sucrose", "%", 99.7, undefined, undefined, "Polarimetry"),
          P("physical", "Foreign matter", null, undefined, undefined, undefined, "Visual", "None visible"),
        ],
        reviewDueOn: addDays(today, 300),
        agreedBy: "Helen Ward",
        agreedOn: addDays(today, -60),
      },
    },
    {
      code: "SPEC-PKG-BTL1",
      title: "1 litre HDPE bottle",
      item: "PKG-BTL1",
      supplier: "SUP-BOTTLE",
      draft: {
        description: "Food-grade HDPE 1 litre bottle, 38mm neck.",
        storage: "ambient",
        allergens: [],
        packagingDetails: "Delivered on pallets, shrink wrapped.",
        parameters: [
          P("physical", "Capacity", "ml", 1020, 1030, 1050, "Fill-to-brim"),
          P("physical", "Mass", "g", 28, 30, 32, "Scale"),
        ],
        reviewDueOn: addDays(today, 250),
        agreedBy: "Rachel Ng",
        agreedOn: addDays(today, -100),
      },
    },
    {
      code: "SPEC-FG-MILK-WH1",
      title: "Whole milk, 1 litre (customer specification)",
      item: "FG-MILK-WH1",
      customer: "Westcountry Co-operative Stores",
      draft: {
        description: "Pasteurised whole milk, standardised to 3.9% fat.",
        storage: "chilled",
        storageInstructions: "Keep refrigerated at 0–5°C.",
        shelfLifeDays: 7,
        minimumLifeOnReceiptDays: 5,
        allergens: ["milk"],
        countryOfOrigin: "United Kingdom",
        claims: ["British milk"],
        parameters: [
          P("chemical", "Fat", "%", 3.7, 3.9, 4.1, "Milkoscan"),
          P("microbiological", "Enterobacteriaceae", "cfu/ml", undefined, undefined, 1, "ISO 21528"),
          P(
            "chemical",
            "Alkaline phosphatase",
            null,
            undefined,
            undefined,
            undefined,
            "Phosphatase test",
            "Negative",
          ),
        ],
        reviewDueOn: addDays(today, 180),
        agreedBy: "Philippa Nance",
        agreedOn: addDays(today, -150),
        agreementReference: "WCS-DAIRY-014",
      },
    },
    {
      code: "SPEC-FG-YOG-NAT500",
      title: "Natural yogurt, 500g (customer specification)",
      item: "FG-YOG-NAT500",
      customer: "Westcountry Co-operative Stores",
      draft: {
        description: "Set-style natural yogurt with live cultures.",
        storage: "chilled",
        shelfLifeDays: 21,
        minimumLifeOnReceiptDays: 14,
        allergens: ["milk"],
        claims: ["Live cultures"],
        parameters: [
          P("chemical", "pH", null, 4.3, 4.5, 4.7, "pH meter"),
          P("chemical", "Fat", "%", 3.2, 3.5, 4.0, "Gerber"),
          P("microbiological", "Lactic acid bacteria", "cfu/g", 10000000, undefined, undefined, "ISO 15214"),
          P("microbiological", "Yeasts and moulds", "cfu/g", undefined, undefined, 100, "ISO 21527"),
        ],
        reviewDueOn: addDays(today, 90),
        agreedBy: "Philippa Nance",
        agreedOn: addDays(today, -120),
      },
    },
    {
      code: "SPEC-FG-BUTTER",
      title: "Salted butter, 250g",
      item: "FG-BUTTER-S250",
      draft: {
        description: "Churned salted butter, 82% fat.",
        storage: "chilled",
        shelfLifeDays: 56,
        allergens: ["milk"],
        claims: ["Made with fresh cream"],
        parameters: [
          P("chemical", "Fat", "%", 82, 82.5, undefined, "Butyrometer"),
          P("chemical", "Salt", "%", 1.2, 1.5, 1.8, "Titration"),
          P("microbiological", "Listeria monocytogenes", "cfu/25g", undefined, undefined, 0, "ISO 11290"),
        ],
        reviewDueOn: addDays(today, 240),
        agreedBy: "Hannah Okafor",
        agreedOn: addDays(today, -90),
      },
    },
  ];
  let made = 0;
  for (const s of defs) {
    if (existing.some((x) => x.code === s.code)) continue;
    const created = pick(
      await api.post("/specifications", {
        code: s.code,
        title: s.title,
        itemId: itemId[s.item],
        supplierId: s.supplier ? sup[s.supplier] : undefined,
        customerName: s.customer,
        draft: s.draft,
      }),
      "specification",
    );
    await approver.post(`/specifications/${created.id}/draft/approve`, {});
    made++;
  }
  return `${made} specifications approved`;
}
