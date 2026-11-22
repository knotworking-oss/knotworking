import { biTemplates } from "@knotworking/core";
import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays, pickRecord as pick } from "./api";
import { loginAs } from "./team";

/** BI dashboards from the module templates, and food-fraud (authenticity) assessments. */
export async function bi(ctx: Ctx) {
  const { api } = ctx;
  let made = 0;
  const dashboards = (await api.get("/bi/dashboards")).dashboards as any[];
  const have = new Set(dashboards.map((d) => d.title));
  for (const t of biTemplates("GBP")) {
    if (have.has(t.title)) continue;
    try {
      const r = pick(
        await api.post("/bi/dashboards", {
          title: t.title,
          description: t.description,
          scope: "workspace",
          spec: t.spec,
        }),
        "dashboard",
      );
      made++;
      if (r.id) await api.post(`/bi/dashboards/${r.id}/publish`, { audience: "workspace" }).catch(() => {});
    } catch (e: any) {
      console.warn("dashboard:", t.title, String(e.message).slice(0, 200));
    }
  }
  return `${made} dashboards`;
}

export async function authenticity(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    sup = ctx.ids.supplier!,
    user = ctx.ids.user!;
  const approver = await loginAs(ctx, "hannah@knotmilk.example");
  const existing = ((await api.get("/quality/authenticity")).authenticity ??
    (await api.get("/quality/authenticity")).assessments ??
    []) as any[];
  let made = 0;
  const owner = user["hannah@knotmilk.example"]!;
  const defs = [
    {
      title: "Honey: adulteration and origin fraud",
      item: "ING-HONEY",
      supplier: "SUP-HONEY",
      level: "high",
      scope: "Wildflower honey used in honey & granola yogurt.",
      origin: "UK blend; supplier states British wildflower honey.",
      chain: "Beekeepers → packer (Wildflower Honey Company) → Knotmilk.",
      factors: [
        [
          "history",
          "high",
          "Honey is among the most commonly adulterated foods (added syrups, mislabelled origin).",
        ],
        ["economic", "high", "High price relative to syrups creates strong incentive."],
        ["access", "medium", "Blending and dilution possible at the packer."],
        ["supply_chain", "medium", "Single UK packer; hives not individually traceable."],
        ["detectability", "medium", "Annual NMR testing available but not every delivery."],
      ],
      rationale: "High-value, historically fraud-prone ingredient with limited routine detection.",
      sources: [
        [
          "Food Standards Agency honey authenticity alert",
          "FSA bulletin 2025/11",
          "Industry reports of syrup adulteration; no UK findings for our supplier.",
        ],
      ],
      evidence: [
        [
          "provenance",
          "Supplier origin declaration and hive records",
          "WHC-ORIGIN-2026",
          addDays(today, 200),
        ],
      ],
      controls: [
        ["testing", "NMR authenticity test on one lot per year", 120, 365],
        ["intelligence_review", "Review of supplier mass balance for honey purchases", 60, 180],
      ],
    },
    {
      title: "Vanilla extract: dilution and synthetic substitution",
      item: "ING-VAN",
      supplier: "SUP-FLAV",
      level: "high",
      scope: "Vanilla extract in vanilla yogurt.",
      origin: "Madagascar via UK importer.",
      chain: "Growers → curers → extract manufacturer → importer → Knotmilk.",
      factors: [
        [
          "history",
          "high",
          "Vanilla extract is a recognised target for substitution with synthetic vanillin.",
        ],
        ["economic", "high", "Price volatility makes natural vanilla very expensive."],
        ["access", "medium", "Dilution at processor or importer is possible."],
        ["supply_chain", "high", "Long, complex chain with several traders."],
        ["detectability", "medium", "Isotope testing needed to prove natural origin."],
      ],
      rationale: "Complex supply chain and high price; natural origin is claimed on pack.",
      sources: [
        ["Trade press on vanilla prices", "Dairy trade journal, Aug 2026", "Prices up 15% on poor harvest."],
      ],
      evidence: [
        [
          "claim",
          "Certificate of analysis showing natural vanillin ratio",
          "MVT-COA-2026-04",
          addDays(today, 250),
        ],
      ],
      controls: [["testing", "Isotope ratio test on each new batch of extract", 90, 365]],
    },
    {
      title: "Raw milk: adulteration and species substitution",
      item: "ING-MILK",
      supplier: "SUP-MILK",
      level: "low",
      scope: "Raw cows' milk from the Somerset Vale Farms Co-op.",
      origin: "Farms within 20 miles of the dairy.",
      chain: "Farms → co-op tanker → Knotmilk.",
      factors: [
        ["history", "low", "No known fraud incidents in this supply."],
        ["economic", "low", "Low price and local supply reduce incentive."],
        ["access", "low", "Closed tanker with seals."],
        ["supply_chain", "low", "Short, fully traceable chain."],
        ["detectability", "high", "Fat, protein and freezing point checked on every load."],
      ],
      rationale: "Low vulnerability; routine compositional testing is effective.",
      sources: [["Co-op membership and farm audit", "Red Tractor certificates", "All farms assured."]],
      evidence: [
        ["provenance", "Co-op farm list and Red Tractor certificates", "SVF-FARMS-2026", addDays(today, 150)],
      ],
      controls: [["testing", "Quarterly freezing point depression check", 70, 90]],
    },
  ] as const;
  const existingTitles = new Set(existing.map((e: any) => e.title));
  for (const d of defs) {
    if (existingTitles.has(d.title)) continue;
    const draft = {
      ownerUserId: owner,
      scope: d.scope,
      origin: d.origin,
      supplyChain: d.chain,
      factors: d.factors.map(([factor, level, rationale]) => ({ factor, level, rationale })),
      vulnerability: d.level,
      rationale: d.rationale,
      sources: d.sources.map(([title, reference, findings]) => ({
        title,
        reference,
        checkedOn: addDays(today, -25),
        findings,
      })),
      evidence: d.evidence.map(([kind, title, reference, validUntil]) => ({
        kind,
        title,
        reference,
        note: "",
        validUntil,
        sampleId: null,
      })),
      controls: d.controls.map(([kind, description, due, freq]) => ({
        id: randomUUID(),
        kind,
        description,
        ownerUserId: owner,
        dueOn: addDays(today, due),
        frequencyDays: freq,
        acceptanceCriteria: "Result consistent with the declared origin and specification.",
      })),
      reviewDueOn: addDays(today, 330),
    };
    const created = pick(
      await api.post("/quality/authenticity", {
        commandId: randomUUID(),
        title: d.title,
        itemId: itemId[d.item],
        supplierId: sup[d.supplier],
        draft,
      }),
      "assessment",
    );
    const full = pick(await api.get(`/quality/authenticity/${created.id}`), "assessment");
    const draftVersion = full.draftVersion ?? full.draft ?? full;
    await approver
      .post(`/quality/authenticity/${created.id}/approve`, {
        commandId: randomUUID(),
        expectedUpdatedAt: draftVersion.updatedAt ?? created.updatedAt,
        note: "Reviewed and approved by the Technical Manager.",
        triggerIds: [],
      })
      .catch((e) => console.warn("authenticity approve:", String(e.message).slice(0, 220)));
    made++;
  }
  return `${made} authenticity assessments`;
}
