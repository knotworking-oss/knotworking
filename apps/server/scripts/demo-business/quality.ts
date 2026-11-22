import type { Ctx } from "./api";
import { addDays } from "./api";
import { loginAs } from "./team";

import { pickRecord as pick } from "./api";

export async function quality(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    sup = ctx.ids.supplier!,
    user = ctx.ids.user!;
  const verifier = await loginAs(ctx, "rhys@knotmilk.example");
  let made = 0;

  // Real lots to link records to
  const lots: any[] = [];
  for (let off = 0; ; off += 200) {
    const page = (await api.get(`/stock/lots?limit=200&offset=${off}&includeEmpty=true`)).lots as any[];
    lots.push(...page);
    if (page.length < 200) break;
  }
  const lotOf = (code: string, nth = 0) =>
    lots
      .filter((l) => l.item.code === code)
      .sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.lotCode.localeCompare(b.lotCode))[nth];

  // ── Complaints ──
  const complaints = (await api.get("/quality/complaints?status=all&limit=100")).complaints as any[];
  if (complaints.length < 6) {
    const defs: any[] = [
      {
        d: -34,
        source: "consumer",
        category: "foreign_body",
        severity: "major",
        item: "FG-YOG-STR150",
        lot: 2,
        name: "Mrs P. Lawson",
        contact: "p.lawson@mail.example",
        desc: "A small piece of hard clear plastic found in a strawberry yogurt pot.",
        close: {
          response:
            "We apologised, replaced the product and inspected the filler. The fragment matched the film from the lid seal; supplier notified.",
          justified: true,
          note: "Linked to non-conformance on lid supplier.",
        },
      },
      {
        d: -29,
        source: "customer",
        category: "quality",
        severity: "minor",
        item: "FG-MILK-WH1",
        lot: 1,
        customer: "Glastonbury Deli & Larder",
        desc: "Customer reports milk tasting slightly sour two days before best before.",
        close: {
          response:
            "Retained sample and chiller logs checked; chiller 1 door seal found worn. Seal replaced and credit issued.",
          justified: true,
        },
      },
      {
        d: -25,
        source: "retailer",
        category: "labelling",
        severity: "major",
        item: "FG-YOG-HG150",
        lot: 1,
        customer: "Westcountry Co-operative Stores",
        desc: "Retailer found the allergen box not highlighting nuts on a batch of honey & granola yogurt.",
        close: {
          response:
            "Label artwork verified; incorrect label roll loaded. Line clearance check strengthened and affected lots recalled from the DC.",
          justified: true,
        },
      },
      {
        d: -21,
        source: "consumer",
        category: "packaging",
        severity: "minor",
        item: "FG-MILK-SS1",
        lot: 3,
        name: "Mr D. Okonkwo",
        contact: "07700 900123",
        desc: "Bottle cap leaked in the shopping bag.",
        close: {
          response: "Cap torque settings re-verified; no wider issue found. Voucher sent.",
          justified: false,
        },
      },
      {
        d: -12,
        source: "consumer",
        category: "illness",
        severity: "critical",
        item: "FG-CHEESE-S200",
        lot: 0,
        name: "Anonymous",
        contact: "",
        desc: "Customer reports stomach upset after eating soft cheese. No medical confirmation.",
        status: "investigating",
      },
      {
        d: -7,
        source: "customer",
        category: "quantity",
        severity: "minor",
        item: "FG-BUTTER-S250",
        lot: 0,
        customer: "Greenleaf Wholefoods",
        desc: "Case contained 11 butter blocks instead of 12.",
        status: "open",
      },
      {
        d: -3,
        source: "consumer",
        category: "quality",
        severity: "minor",
        item: "FG-YOG-NAT500",
        lot: 2,
        name: "Ms A. Reeve",
        contact: "a.reeve@mail.example",
        desc: "Yogurt unusually thin and watery on opening.",
        status: "open",
      },
      {
        d: -2,
        source: "regulator",
        category: "labelling",
        severity: "minor",
        item: "FG-MILK-WH2",
        lot: 0,
        customer: "Trading Standards (routine inspection)",
        desc: "Inspector queried the font size of the net quantity on the 2 litre label.",
        status: "investigating",
      },
    ];
    for (const c of defs) {
      const l = lotOf(c.item, c.lot) ?? lotOf(c.item, 0);
      const created = pick(
        await api.post("/quality/complaints", {
          receivedOn: addDays(today, c.d),
          source: c.source,
          category: c.category,
          severity: c.severity,
          complainantName: c.name ?? null,
          complainantContact: c.contact ?? null,
          customer: c.customer ?? null,
          itemId: itemId[c.item],
          lotId: l?.id ?? null,
          reportedLotCode: l?.lotCode ?? null,
          description: c.desc,
        }),
        "complaint",
      );
      if (c.status === "investigating")
        await api.patch(`/quality/complaints/${created.id}`, {
          status: "investigating",
          investigation: "Retained samples and batch records under review.",
        });
      if (c.close) await api.post(`/quality/complaints/${created.id}/close`, c.close);
      made++;
    }
  }

  // ── Non-conformances ──
  const ncs = (await api.get("/quality/nonconformances?status=all&limit=100")).nonconformances as any[];
  {
    const hannah = user["hannah@knotmilk.example"],
      callum = user["callum@knotmilk.example"],
      rhys = user["rhys@knotmilk.example"];
    const defs: any[] = [
      {
        d: -33,
        source: "supplier",
        severity: "major",
        title: "Foil lid seal film delaminating",
        desc: "Foil lids from the current delivery peel apart at the edge, leaving film fragments.",
        supplier: "SUP-PACK",
        item: "PKG-LID",
        containment: "Quarantined remaining lid stock; switched to previous lot.",
        root: "Supplier changed adhesive layer without notification.",
        corr: "Supplier issued 8D report and replaced stock.",
        prev: "Added lid seal peel test on receipt.",
        owner: hannah,
        due: -10,
        close: "Peel test passed on three consecutive deliveries.",
      },
      {
        d: -28,
        source: "process",
        severity: "minor",
        title: "Chiller 1 door seal worn",
        desc: "Chiller temperature drifted to 6.8°C during peak loading.",
        containment: "Stock moved to chiller 2.",
        root: "Door seal perished.",
        corr: "Seal replaced by maintenance.",
        prev: "Door seals added to quarterly PPM.",
        owner: callum,
        due: -14,
        close: "Temperature stable at 3°C for 14 days.",
      },
      {
        d: -24,
        source: "product",
        severity: "major",
        title: "Wrong label loaded on honey & granola line",
        desc: "Labels without the nut allergen highlight were applied to a batch.",
        containment: "Held and relabelled the affected batch; recalled 2 cases from the retailer.",
        root: "Line clearance did not check label artwork version.",
        corr: "Label artwork check added to start-up checklist and signed by two people.",
        prev: "Label rolls colour-coded by allergen profile.",
        owner: hannah,
        due: -5,
        close: "Verified on 10 consecutive start-ups.",
      },
      {
        d: -15,
        source: "process",
        severity: "minor",
        title: "Hand-wash station sign missing in goods-in",
        desc: "Internal audit found no hand-wash sign at the goods-in door.",
        root: "Sign removed during repainting and not replaced.",
        correctiveAction: "Sign installed.",
        owner: rhys,
        due: -8,
        close: "Sign in place and checked at next audit.",
      },
      {
        d: -10,
        source: "supplier",
        severity: "minor",
        title: "Strawberry purée delivered at 8°C",
        desc: "Delivery temperature exceeded the specification limit of 5°C.",
        supplier: "SUP-FRUIT",
        item: "ING-STRAW",
        containment: "Accepted after technical review; product within shelf-life tests.",
        status: "action_taken",
        corr: "Supplier reminded of cold chain requirements.",
        owner: hannah,
        due: 7,
      },
      {
        d: -4,
        source: "process",
        severity: "major",
        title: "Metal detector reject bin overflowing",
        desc: "Reject bin not emptied for two shifts; risk of rejected product being returned to line.",
        containment: "Bin emptied and contents segregated.",
        owner: callum,
        due: 10,
      },
      {
        d: -2,
        source: "process",
        severity: "minor",
        title: "Pasteuriser chart paper missed on shift change",
        desc: "Chart paper not changed at the 06:00 handover.",
        owner: callum,
        due: 12,
      },
    ];
    for (const n of defs) {
      const wasNew = !ncs.some((x) => x.title === n.title);
      let created = ncs.find((x) => x.title === n.title);
      if (!created)
        created = pick(
          await api.post("/quality/nonconformances", {
            raisedOn: addDays(today, n.d),
            source: n.source,
            severity: n.severity,
            title: n.title,
            description: n.desc,
            supplierId: n.supplier ? sup[n.supplier] : null,
            itemId: n.item ? itemId[n.item] : null,
            containment: n.containment ?? null,
            rootCause: n.root ?? null,
            correctiveAction: n.corr ?? n.correctiveAction ?? null,
            preventiveAction: n.prev ?? null,
            ownerUserId: n.owner,
            dueOn: addDays(today, n.due),
          }),
          "nonconformance",
        );
      if (created.status === "closed") continue;
      if (n.root) await api.patch(`/quality/nonconformances/${created.id}`, { rootCause: n.root });
      if (n.status === "action_taken" || n.close)
        await api.patch(`/quality/nonconformances/${created.id}`, { status: "action_taken" });
      if (n.close)
        await verifier.post(`/quality/nonconformances/${created.id}/close`, { verificationNote: n.close });
      if (wasNew) made++;
    }
  }

  // ── Audits ──
  const audits = (await api.get("/quality/audits?status=all&limit=100")).audits as any[];
  const have = (t: string) => audits.some((a) => a.title === t);
  const auditDefs: any[] = [
    {
      title: "Internal GMP audit: production hall",
      scope: "Hygiene, GMP, allergen controls and housekeeping in the production hall.",
      d: -45,
      auditor: "Isla McAllister",
      summary: "Good standard of housekeeping. Two minor findings on signage and hand-wash facilities.",
      findings: [
        {
          title: "Hand-wash sign missing",
          description: "No hand-wash sign at the goods-in entrance.",
          severity: "minor",
          correctiveAction: "Install sign.",
        },
      ],
    },
    {
      title: "Internal HACCP and traceability audit",
      scope: "HACCP records, CCP monitoring and one-up/one-down traceability exercise.",
      d: -30,
      auditor: "Hannah Okafor",
      summary: "CCP records complete. Traceability exercise achieved full mass balance within 3 hours.",
      findings: [],
    },
    {
      title: "Supplier audit: Greenfield Packaging",
      scope: "On-site audit of packaging manufacturing, hygiene and traceability.",
      d: -20,
      auditor: "Hannah Okafor",
      summary: "Site meets expectations; lid film adhesive change management needs tightening.",
      findings: [
        {
          title: "Change management for materials",
          description: "Adhesive formulation was changed without customer notification.",
          severity: "major",
          correctiveAction: "Supplier to implement a notification procedure.",
        },
      ],
    },
    {
      title: "Mock BRCGS Issue 9 gap audit",
      scope: "Gap assessment against BRCGS Food Safety Issue 9 ahead of the annual certification audit.",
      d: 21,
      auditor: "External consultant",
    },
    {
      title: "Internal environmental monitoring audit",
      scope: "Swab programme, zoning and verification results.",
      d: 35,
      auditor: "Isla McAllister",
    },
    {
      title: "Warehouse and despatch audit",
      scope: "Cold chain, FEFO, pest proofing and vehicle load checks.",
      d: 14,
      auditor: "Dev Patel",
    },
  ];
  for (const a of auditDefs) {
    if (have(a.title)) continue;
    const created = pick(
      await api.post("/quality/audits", {
        title: a.title,
        scope: a.scope,
        plannedOn: addDays(today, a.d),
        auditorName: a.auditor,
      }),
      "audit",
    );
    if (a.d < 0)
      await api.post(`/quality/audits/${created.id}/complete`, {
        completedOn: addDays(today, a.d),
        summary: a.summary,
        findings: a.findings,
      });
    made++;
  }
  const progs = (await api.get("/quality/audit-programmes")).programmes as any[];
  const progDefs = [
    {
      title: "Monthly internal GMP audit",
      scope: "Rolling GMP audit of one production area each month.",
      intervalMonths: 1,
      d: 10,
      auditorName: "Isla McAllister",
    },
    {
      title: "Annual supplier audit programme",
      scope: "Risk-based audit of high-risk suppliers.",
      intervalMonths: 12,
      d: 90,
      auditorName: "Hannah Okafor",
    },
    {
      title: "Quarterly HACCP verification",
      scope: "Review of HACCP plan effectiveness and CCP records.",
      intervalMonths: 3,
      d: 40,
      auditorName: "Hannah Okafor",
    },
  ];
  for (const p of progDefs)
    if (!progs.some((x) => x.title === p.title)) {
      await api.post("/quality/audit-programmes", {
        title: p.title,
        scope: p.scope,
        intervalMonths: p.intervalMonths,
        nextPlannedOn: addDays(today, p.d),
        auditorName: p.auditorName,
      });
      made++;
    }

  // ── Mock recall ──
  const recalls = (await api.get("/quality/recall-tests?limit=50")).recallTests as any[];
  if (!recalls.length) {
    const l = lotOf("FG-YOG-STR150", 1) ?? lotOf("FG-MILK-WH1", 0);
    if (l) {
      const at = new Date(`${addDays(today, -18)}T10:00:00Z`);
      await api.post("/quality/recall-tests", {
        conductedOn: addDays(today, -18),
        lotId: l.id,
        direction: "both",
        scenario: "Mock recall of a strawberry yogurt lot following a fictional supplier foreign-body alert.",
        startedAt: at.toISOString(),
        completedAt: new Date(at.getTime() + 2 * 3600e3 + 25 * 60e3).toISOString(),
        quantityExpected: 2000,
        quantityTraced: 1990,
        notes: "99.5% traced to customers within 2h25m; target is 4 hours and 98%.",
      });
      made++;
    }
  }
  return `${made} quality records`;
}
