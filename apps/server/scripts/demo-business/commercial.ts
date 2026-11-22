import { randomUUID } from "node:crypto";
import type { Ctx } from "./api";
import { addDays } from "./api";
import { items, recipes } from "./foundation";
import { loginAs } from "./team";

/** Customers, price lists, production lines and purchasing with goods-in. */

export const customers = [
  {
    code: "CUS-WESTCO",
    name: "Westcountry Co-operative Stores",
    contactName: "Philippa Nance",
    email: "dairy.buying@westcountryco-op.example",
    phone: "01392 555 0301",
    address: "Distribution Centre, Marsh Barton, Exeter EX2 8XX",
    sites: ["Exeter DC", "Taunton Store 114", "Bath Store 207"],
  },
  {
    code: "CUS-FARMFRESH",
    name: "FarmFresh Local Grocers",
    contactName: "Tony Marchetti",
    email: "orders@farmfresh.example",
    phone: "0117 555 0302",
    address: "12 Gloucester Road, Bristol BS7 8XX",
    sites: ["Bristol Hub", "Clifton Shop"],
  },
  {
    code: "CUS-SCHOOLS",
    name: "Mendip Schools Catering Service",
    contactName: "Denise Hartley",
    email: "catering@mendipschools.example",
    phone: "01749 555 0303",
    address: "County Hall, Wells BA5 1XX",
    sites: ["Central Kitchen"],
  },
  {
    code: "CUS-HOTEL",
    name: "The Cotswold Manor Hotel",
    contactName: "Chef Ravi Menon",
    email: "kitchen@cotswoldmanor.example",
    phone: "01451 555 0304",
    address: "Bourton Road, Stow-on-the-Wold GL54 1XX",
    sites: [],
  },
  {
    code: "CUS-DELI",
    name: "Glastonbury Deli & Larder",
    contactName: "Marie Fontaine",
    email: "marie@glastodeli.example",
    phone: "01458 555 0305",
    address: "14 High Street, Glastonbury BA6 9XX",
    sites: [],
  },
  {
    code: "CUS-CAFES",
    name: "Bean & Leaf Café Group",
    contactName: "Jordan Pike",
    email: "purchasing@beanleaf.example",
    phone: "0117 555 0306",
    address: "Unit 3, Temple Quay, Bristol BS1 6XX",
    sites: ["Temple Quay", "Cabot Circus", "Park Street"],
  },
  {
    code: "CUS-HOSP",
    name: "Royal West Infirmary Catering",
    contactName: "Siobhan Doyle",
    email: "catering@rwinfirmary.example",
    phone: "01225 555 0307",
    address: "Combe Park, Bath BA1 3XX",
    sites: ["Main Kitchen"],
  },
  {
    code: "CUS-WHOLE",
    name: "Greenleaf Wholefoods",
    contactName: "Matt Greenleaf",
    email: "buying@greenleaf.example",
    phone: "01823 555 0308",
    address: "Silk Mills, Taunton TA1 2XX",
    sites: [],
  },
  {
    code: "CUS-RESTAU",
    name: "The Hungry Heron Restaurants",
    contactName: "Alex Brandt",
    email: "ops@hungryheron.example",
    phone: "01278 555 0309",
    address: "Quay Street, Bridgwater TA6 3XX",
    sites: [],
  },
  {
    code: "CUS-FARMSHOP",
    name: "Mendip Hills Farm Shop",
    contactName: "Sally Burrows",
    email: "sally@mendipfarmshop.example",
    phone: "01761 555 0310",
    address: "Priddy Road, Wells BA5 3XX",
    sites: [],
  },
];

// customer, item, unit price
export const prices: [string, string, number][] = [
  ["CUS-WESTCO", "FG-MILK-WH1", 0.98],
  ["CUS-WESTCO", "FG-MILK-SS1", 0.96],
  ["CUS-WESTCO", "FG-MILK-WH2", 1.62],
  ["CUS-WESTCO", "FG-YOG-NAT500", 1.35],
  ["CUS-WESTCO", "FG-YOG-STR150", 0.82],
  ["CUS-WESTCO", "FG-BUTTER-S250", 2.4],
  ["CUS-FARMFRESH", "FG-MILK-WH1", 1.05],
  ["CUS-FARMFRESH", "FG-YOG-NAT500", 1.45],
  ["CUS-FARMFRESH", "FG-YOG-VAN150", 0.9],
  ["CUS-FARMFRESH", "FG-CHEESE-S200", 1.9],
  ["CUS-SCHOOLS", "FG-MILK-SS1", 0.89],
  ["CUS-SCHOOLS", "FG-YOG-STR150", 0.74],
  ["CUS-SCHOOLS", "FG-YOG-RAS150", 0.76],
  ["CUS-HOTEL", "FG-CREAM-D300", 1.85],
  ["CUS-HOTEL", "FG-BUTTER-S250", 2.55],
  ["CUS-HOTEL", "FG-YOG-HG150", 1.2],
  ["CUS-CAFES", "FG-MILK-WH1", 1.02],
  ["CUS-CAFES", "FG-MILK-SS1", 1.0],
  ["CUS-CAFES", "FG-CREAM-D300", 1.8],
  ["CUS-DELI", "FG-CHEESE-S200", 2.05],
  ["CUS-DELI", "FG-BUTTER-S250", 2.7],
  ["CUS-DELI", "FG-YOG-HG150", 1.25],
  ["CUS-HOSP", "FG-YOG-NAT500", 1.3],
  ["CUS-HOSP", "FG-MILK-SS1", 0.9],
  ["CUS-WHOLE", "FG-YOG-NAT500", 1.5],
  ["CUS-WHOLE", "FG-YOG-RAS150", 0.95],
  ["CUS-WHOLE", "FG-BUTTER-S250", 2.65],
  ["CUS-RESTAU", "FG-CREAM-D300", 1.78],
  ["CUS-RESTAU", "FG-CHEESE-S200", 1.95],
  ["CUS-FARMSHOP", "FG-MILK-WH1", 1.1],
  ["CUS-FARMSHOP", "FG-YOG-STR150", 0.95],
  ["CUS-FARMSHOP", "FG-BUTTER-S250", 2.75],
];

export const lines = [
  {
    name: "Milk pasteurising & bottling line",
    hours: 10,
    crew: 6,
    recipes: { "RCP-MILK-WH1": 1800, "RCP-MILK-SS1": 1800, "RCP-MILK-WH2": 900 },
  },
  {
    name: "Yogurt incubation & filling line",
    hours: 9,
    crew: 5,
    recipes: {
      "RCP-YOGBASE": 1200,
      "RCP-YOG-NAT500": 1400,
      "RCP-YOG-STR150": 2600,
      "RCP-YOG-RAS150": 2600,
      "RCP-YOG-VAN150": 2600,
      "RCP-YOG-HG150": 1800,
    },
  },
  {
    name: "Butter, cream & cheese room",
    hours: 8,
    crew: 4,
    recipes: { "RCP-BUTTER-S250": 450, "RCP-CREAM-D300": 900, "RCP-CURD": 70, "RCP-CHEESE-S200": 600 },
  },
];

export async function commercial(ctx: Ctx) {
  const { api, today } = ctx;
  const cus = (ctx.ids.customer ??= {});
  const site = (ctx.ids.customerSite ??= {});
  const line = (ctx.ids.line ??= {});
  let made = 0;

  // Customers and delivery sites
  const existing = (await api.get("/customers?status=all&limit=200")).customers as any[];
  for (const c of customers) {
    let hit = existing.find((x) => x.code === c.code);
    if (!hit) {
      const r = await api.post("/customers", {
        code: c.code,
        name: c.name,
        address: c.address,
        contactName: c.contactName,
        email: c.email,
        phone: c.phone,
      });
      hit = r.customer ?? r;
      made++;
    }
    cus[c.code] = hit.id;
    const have = ((await api.get(`/customers/${hit.id}/sites`)).sites ?? []) as any[];
    for (const [i, s] of c.sites.entries()) {
      const code = `${c.code.slice(4, 8)}-${i + 1}`;
      if (have.some((x) => x.code === code)) continue;
      await api.post(`/customers/${hit.id}/sites`, {
        code,
        name: s,
        address: `${s}, ${c.address.split(",").slice(-2).join(",").trim()}`,
        phone: c.phone,
      });
      made++;
    }
  }

  // Price lists
  const existingPrices = (await api.get("/sales/prices")).prices as any[];
  for (const [cc, ic, price] of prices) {
    if (existingPrices.some((p) => p.customerId === cus[cc] && p.itemId === ctx.ids.item![ic])) continue;
    await api.post("/sales/prices", {
      commandId: randomUUID(),
      customerId: cus[cc],
      itemId: ctx.ids.item![ic],
      unit: "each",
      currency: "GBP",
      unitPrice: price,
      validFrom: addDays(today, -90),
      validTo: null,
      contractReference: `${cc.slice(4)}-2026`,
      terms: "Net 30 days.",
    });
    made++;
  }

  // Production lines + the recipes each can run
  const existingLines = (await api.get("/production/lines")).lines as any[];
  for (const l of lines) {
    let hit = existingLines.find((x) => x.name === l.name);
    if (!hit) {
      const r = await api.post("/production/lines", {
        name: l.name,
        hoursPerDay: l.hours,
        notes: "Standard line.",
      });
      hit = r.line ?? r;
      made++;
      await api.patch(`/production/lines/${hit.id}`, {
        crewAvailable: l.crew,
        changeoverMinutes: 20,
        allergenCleanMinutes: 45,
      });
    }
    line[l.name] = hit.id;
    for (const [rc, rate] of Object.entries(l.recipes)) {
      const rec = recipes.find((r) => r.code === rc)!;
      await api.put(`/production/lines/${hit.id}/recipes/${ctx.ids.recipe![rc]}`, {
        rate,
        unit: rec.yieldUnit,
        crewSize: Math.max(2, l.crew - 2),
      });
    }
  }
  return `${made} records created`;
}

/** Purchase orders for every goods supplier over the last weeks, with goods-in lots. */
export async function purchasing(ctx: Ctx) {
  const { api, today } = ctx;
  const itemId = ctx.ids.item!,
    sup = ctx.ids.supplier!,
    loc = ctx.ids.location!;
  const bySupplier = new Map<string, typeof items>();
  for (const it of items)
    if (it.supplier && it.type !== "wip")
      bySupplier.set(it.supplier, [...(bySupplier.get(it.supplier) ?? []), it]);
  const approver = await loginAs(ctx, "priya.d@knotmilk.example");
  const existingOrders = (await api.get("/purchasing/orders?status=all&limit=200")).orders as any[];

  const qtyFor = (it: (typeof items)[number], week: number) => {
    const base: Record<string, number> = {
      "ING-CREAM": 600,
      "ING-SMP": 400,
      "ING-CULT-YOG": 4000,
      "ING-CULT-MESO": 1500,
      "ING-RENNET": 1500,
      "ING-SUGAR": 300,
      "ING-STRAW": 250,
      "ING-RASP": 200,
      "ING-VAN": 6,
      "ING-HONEY": 80,
      "ING-PECTIN": 25,
      "ING-SALT": 100,
      "ING-GRAN": 150,
      "ING-MILK": 0,
    };
    if (it.type === "ingredient") return base[it.code] ?? 100;
    const pk: Record<string, number> = {
      "PKG-BTL1": 14000,
      "PKG-BTL2": 4000,
      "PKG-CAP": 18000,
      "PKG-POT500": 7000,
      "PKG-POT150": 20000,
      "PKG-LID": 28000,
      "PKG-WRAP250": 4000,
      "PKG-TUB200": 3000,
      "PKG-CART300": 4000,
      "PKG-LABEL": 70000,
      "PKG-CASE12": 6000,
      "PKG-CRATE": 400,
    };
    return Math.round((pk[it.code] ?? 5000) * (week === 0 ? 1 : 0.9));
  };

  let n = 0;
  for (const week of [0, 1, 2, 3]) {
    const orderedOn = addDays(today, -28 + week * 7);
    if (week === 3 && false) continue;
    for (const [code, list] of bySupplier) {
      const lines = list
        .filter((i) => i.code !== "ING-MILK")
        .map((i) => ({
          itemId: itemId[i.code]!,
          quantity: qtyFor(i, week),
          unit: i.unit,
          unitPrice: i.standardCost,
          expectedOn: addDays(orderedOn, 2),
        }));
      if (!lines.length) continue;
      const note = `Weekly replenishment ${orderedOn}.`;
      let po = existingOrders.find(
        (o) => o.supplierId === sup[code] && o.notes === note && o.status !== "cancelled",
      );
      if (!po) {
        const created = await api.post("/purchasing/orders", {
          supplierId: sup[code],
          expectedOn: addDays(orderedOn, 2),
          deliveryLocationId: loc["GIB"],
          notes: note,
          lines,
        });
        po = created.order ?? created;
      }
      const fresh = async () => {
        const r = await api.get(`/purchasing/orders/${po.id}`);
        return r.order ?? r;
      };
      let full = await fresh();
      if (full.status === "draft") {
        const value = lines.reduce((t, l) => t + l.quantity * (l.unitPrice ?? 0), 0);
        if (value > 2500) await approver.post(`/purchasing/orders/${po.id}/approve`, {});
        await api.post(`/purchasing/orders/${po.id}/send`, { orderedOn });
        full = await fresh();
      }
      if (full.status === "cancelled" || (full.deliveries?.length ?? 0) > 0) continue;
      const receivedOn = addDays(orderedOn, 2);
      const recLines = full.lines.map((l: any) => {
        const it = items.find((x) => itemId[x.code] === l.itemId)!;
        const store =
          it.type === "packaging"
            ? "PKG-1"
            : it.storage === "frozen"
              ? "FRZ-1"
              : it.storage === "chilled"
                ? "CH-RM"
                : "DRY-1";
        const life = it.shelfLifeDays ?? 365;
        return {
          lineId: l.id,
          outcome: "accepted",
          quantity: l.ordered.inLineUnit,
          unit: l.unit,
          locationId: loc[store],
          lotCode: `${it.code.slice(-5)}-${receivedOn.slice(2).replace(/-/g, "")}`,
          supplierLotCode: `SL${10000 + (hash(code + receivedOn + it.code) % 89999)}`,
          expiresOn: it.type === "packaging" ? null : addDays(receivedOn, Math.min(life, 540)),
          expiryType: it.type === "packaging" ? null : "best_before",
          status: "available",
        };
      });
      await api.post(`/purchasing/orders/${po.id}/receipts`, {
        receivedOn,
        deliveryReference: `DN-${String(hash(code + week)).slice(0, 5)}`,
        lines: recLines,
      });
      n++;
    }
  }
  return `${n} purchase orders raised, sent and received`;
}

const hash = (s: string) => {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
};
export { hash };
