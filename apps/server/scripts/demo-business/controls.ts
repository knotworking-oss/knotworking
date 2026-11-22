import type { Ctx } from "./api";
import { addDays } from "./api";
import { hash } from "./commercial";
import { suppliers } from "./foundation";
import { loginAs } from "./team";

/** Supplier risk assessments and questionnaires; stock hygiene (expired write-offs, stocktake). */
export async function supplierControls(ctx: Ctx) {
  const { api, today } = ctx;
  const sup = ctx.ids.supplier!;
  let made = 0;
  const hazardsFor = (
    code: string,
  ): { level: "low" | "medium" | "high"; hazards: string[]; rationale: string; controls: string[] } => {
    if (code === "SUP-MILK")
      return {
        level: "high",
        hazards: ["microbiological", "chemical", "authenticity"],
        rationale:
          "Raw milk is the principal ingredient and a high-risk raw material: pathogen, antibiotic residue and adulteration risks.",
        controls: ["certificate", "specification", "coa_each_delivery", "testing_on_receipt"],
      };
    if (code === "SUP-CULT")
      return {
        level: "medium",
        hazards: ["microbiological", "allergen"],
        rationale: "Cultures determine fermentation and contain milk allergen.",
        controls: ["certificate", "questionnaire", "specification", "coa_each_delivery"],
      };
    if (code === "SUP-FRUIT")
      return {
        level: "medium",
        hazards: ["microbiological", "physical", "chemical"],
        rationale: "Fruit purées carry pesticide and foreign-body risks.",
        controls: ["certificate", "questionnaire", "specification", "coa_each_delivery"],
      };
    if (code === "SUP-GRAN")
      return {
        level: "high",
        hazards: ["allergen", "physical"],
        rationale: "Granola contains gluten and nuts; cross-contact and foreign-body risks.",
        controls: ["certificate", "questionnaire", "specification", "audit"],
      };
    if (code === "SUP-PACK" || code === "SUP-BOTTLE")
      return {
        level: "medium",
        hazards: ["physical", "chemical"],
        rationale: "Food-contact packaging: migration and foreign-body risks.",
        controls: ["certificate", "specification", "questionnaire"],
      };
    if (["SUP-HYG", "SUP-LAB", "SUP-PEST", "SUP-CALIB", "SUP-WASTE"].includes(code))
      return {
        level: "low",
        hazards: ["other"],
        rationale: "Service or non-food-contact supplier with low impact on product safety.",
        controls: ["certificate"],
      };
    return {
      level: "low",
      hazards: ["authenticity"],
      rationale: "Low-risk, shelf-stable ingredient from an established supplier.",
      controls: ["certificate", "specification"],
    };
  };
  for (const s of suppliers) {
    const id = sup[s.code];
    const controls = await api.get(`/suppliers/${id}/controls`);
    if ((controls.assessments ?? []).length > 0) continue;
    const h = hazardsFor(s.code);
    await api
      .post(`/suppliers/${id}/risk-assessments`, {
        itemId: null,
        riskLevel: h.level,
        hazards: h.hazards,
        rationale: h.rationale,
        controls: h.controls,
        controlNotes: null,
        reviewDueOn: addDays(today, 200 + (hash(s.code) % 120)),
      })
      .catch((e) => console.warn("risk:", s.code, String(e.message).slice(0, 200)));
    if (h.controls.includes("questionnaire")) {
      const q = await api
        .post(`/suppliers/${id}/questionnaires`, {
          title: "Annual supplier self-assessment 2026",
          sentOn: addDays(today, -80),
          notes: "Sent by the purchasing buyer.",
        })
        .catch((e) => {
          console.warn("quest:", String(e.message).slice(0, 200));
          return null;
        });
      const qid = q?.questionnaire?.id ?? q?.id;
      if (qid) {
        await api
          .post(`/suppliers/${id}/questionnaires/${qid}/receive`, {
            receivedOn: addDays(today, -65),
            notes: "Returned complete.",
          })
          .catch(() => {});
        await api
          .post(`/suppliers/${id}/questionnaires/${qid}/review`, {
            decision: "accepted",
            validUntil: addDays(today, 280),
            reviewNote: "Answers consistent with the certificate and our audit.",
          })
          .catch(() => {});
      }
    }
    made++;
  }
  return `${made} suppliers risk-assessed`;
}

export async function stockHygiene(ctx: Ctx) {
  const { api, today } = ctx;
  const loc = ctx.ids.location!;
  const stock = await loginAs(ctx, "callum@knotmilk.example");
  let wasted = 0,
    counted = 0;
  const lots: any[] = [];
  for (let off = 0; ; off += 200) {
    const page = (await api.get(`/stock/lots?limit=200&offset=${off}`)).lots as any[];
    lots.push(...page);
    if (page.length < 200) break;
  }
  for (const l of lots) {
    if (l.expiryState !== "expired" || !(l.onHand?.display > 0)) continue;
    for (const b of l.balances) {
      if (!(b.amount.display > 0)) continue;
      await api
        .post("/stock/waste", {
          lotId: l.id,
          locationId: b.locationId,
          quantity: b.amount.display,
          unit: b.amount.displayUnit,
          reason: `Expired (${l.expiryType === "use_by" ? "use by" : "best before"} ${l.expiresOn}); disposed of via food waste stream.`,
          reference: `WASTE-${today.replace(/-/g, "")}`,
        })
        .then(() => wasted++)
        .catch((e) => console.warn("waste:", l.lotCode, String(e.message).slice(0, 160)));
    }
  }
  // Stocktake of the dry ingredient store: small variances
  const dry = lots
    .filter(
      (l) =>
        l.item?.type === "ingredient" &&
        l.balances.some((b: any) => b.locationId === loc["DRY-1"] && b.amount.display > 0),
    )
    .slice(0, 12);
  const counts = dry.flatMap((l) =>
    l.balances
      .filter((b: any) => b.locationId === loc["DRY-1"] && b.amount.display > 0)
      .map((b: any) => {
        const v = (hash(l.id) % 7) - 3; // -3% .. +3%
        return {
          lotId: l.id,
          locationId: b.locationId,
          countedQuantity: Math.max(0, Math.round(b.amount.display * (1 + v / 100) * 100) / 100),
          unit: b.amount.displayUnit,
        };
      }),
  );
  const hasStocktake =
    (
      (await api.get("/stock/movements?limit=200&type=stocktake").catch(() => ({ movements: [] })))
        .movements ?? []
    ).length > 0;
  if (counts.length && !hasStocktake) {
    await stock
      .post("/stock/stocktakes", {
        counts,
        reference: `STK-${today.slice(0, 7)}`,
        reason: "Monthly dry store stocktake",
      })
      .then(() => (counted = counts.length))
      .catch((e) => console.warn("stocktake:", String(e.message).slice(0, 200)));
  }
  return `${wasted} expired lots written off, ${counted} stocktake lines`;
}
