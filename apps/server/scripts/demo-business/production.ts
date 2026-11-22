import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays } from "./api";
import { items, recipes } from "./foundation";
import { hash } from "./commercial";
import { loginAs } from "./team";

/** Daily intake, production batches (consuming real lots), finished-goods stock and despatches. */

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 Sun
import { pickRecord as pick } from "./api";
const itemByCode = new Map(items.map((i) => [i.code, i]));

// weekday (1-5) → list of [recipe, output quantity]
const plan: Record<number, [string, number][]> = {
  1: [
    ["RCP-MILK-WH1", 1800],
    ["RCP-MILK-SS1", 1200],
    ["RCP-MILK-WH2", 400],
    ["RCP-YOGBASE", 1600],
    ["RCP-YOG-NAT500", 1000],
    ["RCP-YOG-STR150", 2000],
    ["RCP-YOG-VAN150", 1600],
    ["RCP-CREAM-D300", 600],
  ],
  2: [
    ["RCP-MILK-WH1", 1800],
    ["RCP-MILK-SS1", 1200],
    ["RCP-CURD", 120],
    ["RCP-BUTTER-S250", 600],
    ["RCP-YOGBASE", 1200],
    ["RCP-YOG-RAS150", 1600],
    ["RCP-YOG-HG150", 1200],
  ],
  3: [
    ["RCP-MILK-WH1", 1800],
    ["RCP-MILK-SS1", 1200],
    ["RCP-MILK-WH2", 400],
    ["RCP-YOGBASE", 1600],
    ["RCP-YOG-NAT500", 1000],
    ["RCP-YOG-STR150", 2000],
    ["RCP-CHEESE-S200", 450],
  ],
  4: [
    ["RCP-MILK-WH1", 1800],
    ["RCP-MILK-SS1", 1200],
    ["RCP-BUTTER-S250", 600],
    ["RCP-YOGBASE", 1200],
    ["RCP-YOG-VAN150", 1600],
    ["RCP-YOG-HG150", 1200],
    ["RCP-CREAM-D300", 600],
  ],
  5: [
    ["RCP-MILK-WH1", 1800],
    ["RCP-MILK-SS1", 1200],
    ["RCP-MILK-WH2", 400],
    ["RCP-YOGBASE", 1200],
    ["RCP-YOG-NAT500", 1000],
    ["RCP-YOG-RAS150", 1600],
  ],
};
const lineOf: Record<string, string> = {
  "RCP-MILK-WH1": "Milk pasteurising & bottling line",
  "RCP-MILK-SS1": "Milk pasteurising & bottling line",
  "RCP-MILK-WH2": "Milk pasteurising & bottling line",
  "RCP-YOGBASE": "Yogurt incubation & filling line",
  "RCP-YOG-NAT500": "Yogurt incubation & filling line",
  "RCP-YOG-STR150": "Yogurt incubation & filling line",
  "RCP-YOG-RAS150": "Yogurt incubation & filling line",
  "RCP-YOG-VAN150": "Yogurt incubation & filling line",
  "RCP-YOG-HG150": "Yogurt incubation & filling line",
  "RCP-BUTTER-S250": "Butter, cream & cheese room",
  "RCP-CREAM-D300": "Butter, cream & cheese room",
  "RCP-CURD": "Butter, cream & cheese room",
  "RCP-CHEESE-S200": "Butter, cream & cheese room",
};

export async function production(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    loc = ctx.ids.location!,
    rcpId = ctx.ids.recipe!,
    sup = ctx.ids.supplier!;
  const line = ctx.ids.line!;
  const qa = await loginAs(ctx, "hannah@knotmilk.example");
  const done = new Set<string>();
  for (let off = 0; ; off += 200) {
    const page = (await api.get(`/production/batches?limit=200&offset=${off}`)).batches as any[];
    for (const b of page) if (b.status === "completed") done.add(`${b.recipeId}:${b.plannedOn}`);
    if (page.length < 200) break;
  }
  /** Release a lot after QA checks. A lot held by an open test investigation stays in quarantine, as it should. */
  const release = async (lotId: string, what: string) => {
    try {
      await qa.post(`/stock/lots/${lotId}/status`, {
        status: "available",
        note: `Released by QA: ${what}. Micro and sensory checks within specification.`,
      });
      return true;
    } catch (e) {
      if (!String((e as Error).message).includes("release_blocked")) throw e;
      return false;
    }
  };

  // Lot availability helper (display units == item unit)
  const lotsFor = async (code: string, day: string) => {
    const r = (await api.get(`/stock/lots?itemId=${itemId[code]}&limit=200`)).lots as any[];
    return r
      .filter(
        (l) => l.status === "available" && !(l.expiryType === "use_by" && l.expiresOn && l.expiresOn < today),
      )
      .flatMap((l) =>
        l.balances.map((b: any) => ({
          lotId: l.id,
          locationId: b.locationId,
          qty: b.amount.display as number,
          exp: l.expiresOn as string | null,
          rec: l.receivedOn as string,
        })),
      )
      .filter((x) => x.qty > 0)
      .sort((a, b) => (a.exp ?? "9999").localeCompare(b.exp ?? "9999") || a.rec.localeCompare(b.rec));
  };

  const haveLots = new Set<string>();
  for (let off = 0; ; off += 200) {
    const page = (await api.get(`/stock/lots?limit=200&offset=${off}&includeEmpty=true`)).lots as any[];
    for (const l of page) haveLots.add(l.lotCode as string);
    if (page.length < 200) break;
  }
  const receipt = async (body: any) => {
    if (haveLots.has(body.lotCode)) return;
    await api.post("/stock/receipts", body);
    intake++;
  };
  let batches = 0,
    intake = 0,
    skipped = 0;
  const days: string[] = [];
  for (let d = -24; d <= -1; d++) {
    const day = addDays(today, d);
    if (dow(day) >= 1 && dow(day) <= 5) days.push(day);
  }

  for (const day of days) {
    // Raw milk (and cream twice a week) arrives by tanker; no best-before on bulk liquids used within the day.
    await receipt({
      itemId: itemId["ING-MILK"],
      quantity: 9500,
      unit: "l",
      locationId: loc["CH-RM"],
      receivedOn: day,
      lotCode: `MILK-${day.slice(2).replace(/-/g, "")}`,
      supplierId: sup["SUP-MILK"],
      supplierLotCode: `SVF-${(hash(day) % 90000) + 10000}`,
      reference: `Tanker ${(hash(day + "t") % 900) + 100}`,
      notes: "Tanker intake, temperature 3.8°C, antibiotic test negative.",
    });
    if ([2, 5].includes(dow(day)))
      await receipt({
        itemId: itemId["ING-CREAM"],
        quantity: 900,
        unit: "l",
        locationId: loc["CH-RM"],
        receivedOn: day,
        lotCode: `CREAM-B-${day.slice(2).replace(/-/g, "")}`,
        supplierId: sup["SUP-MILK"],
        supplierLotCode: `SVF-C${(hash(day) % 9000) + 1000}`,
        expiresOn: addDays(day, 5),
        expiryType: addDays(day, 5) >= today ? "use_by" : "best_before",
        reference: "Cream tote delivery",
      });

    for (const [rc, outQty] of plan[dow(day)] ?? []) {
      const rec = recipes.find((r) => r.code === rc)!;
      if (done.has(`${rcpId[rc]}:${day}`)) continue;
      // Scale down if ingredients or packaging are short.
      let factor = outQty / rec.yieldQty;
      const avail = new Map<string, Awaited<ReturnType<typeof lotsFor>>>();
      for (const l of rec.lines) {
        const lots = await lotsFor(l.item, day);
        avail.set(l.item, lots);
        const have = lots.reduce((t, x) => t + x.qty, 0);
        factor = Math.min(factor, have / l.qty);
      }
      factor = Math.floor(factor * rec.yieldQty * 0.98) / rec.yieldQty;
      if (factor * rec.yieldQty < outQty * 0.35) {
        skipped++;
        continue;
      }
      const qty = Math.floor((factor * rec.yieldQty) / 10) * 10;
      const b = pick(
        await api.post("/production/batches", {
          recipeId: rcpId[rc],
          plannedOn: day,
          outputQuantity: qty,
          outputUnit: rec.yieldUnit,
          lineId: line[lineOf[rc]!],
          outputLocationId: loc[itemByCode.get(rec.output)!.type === "wip" ? "WIP-SILO" : "FG-CH1"],
          notes: `Planned by the production manager.`,
        }),
        "batch",
      );
      await api.post(`/production/batches/${b.id}/start`, {});
      const f = qty / rec.yieldQty;
      const consume: any[] = [];
      for (const l of rec.lines) {
        let need = Math.round(l.qty * f * 10000) / 10000;
        for (const lot of avail.get(l.item)!) {
          if (need <= 0) break;
          const take = Math.min(need, lot.qty);
          if (take <= 0) continue;
          const key = `${lot.lotId}:${lot.locationId}`;
          const ex = consume.find((c) => `${c.lotId}:${c.locationId}` === key);
          if (ex) ex.quantity = Math.round((ex.quantity + take) * 10000) / 10000;
          else
            consume.push({
              lotId: lot.lotId,
              locationId: lot.locationId,
              quantity: Math.round(take * 10000) / 10000,
              unit: l.unit,
            });
          lot.qty -= take;
          need = Math.round((need - take) * 10000) / 10000;
        }
      }
      await api.post(`/production/batches/${b.id}/consumption`, { lines: consume });
      const out = itemByCode.get(rec.output)!;
      const yieldNoise = out.type === "wip" ? 1 : 0.985 + (hash(rc + day) % 12) / 1000;
      const o = await api.post(`/production/batches/${b.id}/output`, {
        quantity: Math.round(qty * yieldNoise * 100) / 100,
        unit: rec.yieldUnit,
        locationId:
          loc[
            out.type === "wip"
              ? "WIP-SILO"
              : rc.includes("CHEESE") || rc.includes("BUTTER") || rc.includes("CREAM")
                ? "FG-CH2"
                : "FG-CH1"
          ],
        lotCode: `${rc.replace("RCP-", "").slice(0, 10)}-${day.slice(2).replace(/-/g, "")}`,
        expiresOn: addDays(day, out.shelfLifeDays ?? 7),
        expiryType:
          out.type === "finished" && addDays(day, out.shelfLifeDays ?? 7) >= today ? "use_by" : "best_before",
      });
      const outLot = (o.outputs as any[] | undefined)?.at(-1)?.lotId;
      if (outLot) await release(outLot, `${rec.name} ${day}`);
      else console.warn("no lot id in output response", Object.keys(o));
      await api.post(`/production/batches/${b.id}/complete`, {
        note: "Batch complete; hygiene and metal-detection checks passed.",
      });
      batches++;
    }
  }
  const q = (await api.get("/stock/lots?status=quarantine&limit=200&includeEmpty=true")).lots as any[];
  let released = 0;
  for (const l of q)
    if (["wip", "finished"].includes(l.item.type) && (await release(l.id, `${l.item.name} lot ${l.lotCode}`)))
      released++;
  return `${released} lots released, ${intake} intakes, ${batches} batches completed, ${skipped} skipped for shortages`;
}
