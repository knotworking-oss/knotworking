import { vi } from "vitest";
import type { World, Persona } from "./world";
import { PASSWORD } from "./world";
import { PERSONAS } from "./personas";
import type { Rng } from "./rng";
import { moduleIds, resolveModuleAccess } from "@knotworking/core";

export interface Ingredient {
  id: string;
  code: string;
  name: string;
  unit: string;
  shelfDays: number;
  perBatchKg: number;
}
export interface Product {
  id: string;
  code: string;
  name: string;
  recipeId: string;
  unitWeightG: number;
  batchYield: number;
  shelfDays: number;
  lines: { itemId: string; quantity: number; unit: string }[];
}
export interface Master {
  suppliers: { id: string; name: string; supplies: string[] }[];
  customers: { id: string; name: string }[];
  ingredients: Ingredient[];
  packaging: Ingredient[];
  products: Product[];
  locations: {
    dry: string;
    chill: string;
    frozen: string;
    packing: string;
    finished: string;
    quarantine: string;
  };
}

export async function createPeople(w: World) {
  const ada: Persona = { ...PERSONAS[0]!, userId: "", cookie: "" };
  w.people.set("md", ada);
  await w.signInAll();
  const me = await w.call(ada, "GET", "/v1/me");
  ada.userId = me.body?.user?.id;

  for (const spec of PERSONAS.slice(1)) {
    const p: Persona = { ...spec, userId: "", cookie: "" };
    w.people.set(spec.key, p);
    if (spec.password === PASSWORD) {
      const inv = await w.call(ada, "POST", "/invitations", { email: spec.email, role: spec.role });
      const token = inv.body?.url?.split("/invite/")[1];
      if (!token) continue;
      await w.call(
        ada,
        "POST",
        `/v1/public/invitations/${token}/accept`,
        { name: spec.name, password: PASSWORD },
        [200],
      );
      vi.setSystemTime(new Date(Date.now() + 3_000));
    }
  }
  const members = await w.call(ada, "GET", "/members");
  for (const m of members.body?.members ?? []) {
    const p = [...w.people.values()].find((x) => x.email === m.email);
    if (p) p.userId = m.userId;
  }
  await w.signInAll();
  for (const p of w.people.values()) {
    if (p.role === "owner" || p.role === "admin") continue;
    for (const [mod, level] of Object.entries(p.access)) {
      await w.call(ada, "PUT", `/members/${p.userId}/module-access/${mod}`, { level });
    }
  }
}

const ING = [
  ["FLR-WH", "Wheat flour", 270, 30],
  ["SUG-CA", "Caster sugar", 540, 12],
  ["BUT-UN", "Unsalted butter", 90, 10],
  ["EGG-LQ", "Liquid egg", 14, 8],
  ["MLK-FR", "Fresh milk", 7, 15],
  ["CRM-DB", "Double cream", 10, 6],
  ["CHO-DK", "Dark chocolate", 365, 5],
  ["YST-DR", "Dried yeast", 180, 0.4],
  ["SLT-FN", "Fine salt", 1000, 0.5],
  ["OIL-RP", "Rapeseed oil", 270, 4],
  ["CHE-CH", "Mature cheddar", 60, 8],
  ["TOM-PR", "Tomato puree", 365, 9],
  ["CHK-DC", "Diced chicken", 6, 20],
  ["ONI-FR", "Onions", 14, 6],
  ["PAS-DR", "Dried pasta", 540, 14],
  ["RIC-LG", "Long grain rice", 720, 10],
  ["BCN-LN", "Lean bacon", 21, 7],
  ["VEG-MX", "Frozen veg mix", 365, 12],
  ["SPC-BL", "Spice blend", 365, 0.6],
  ["FLR-SR", "Self-raising flour", 270, 12],
  ["ALM-GR", "Ground almonds", 180, 3],
  ["BKP-PW", "Baking powder", 365, 0.3],
  ["VAN-EX", "Vanilla extract", 540, 0.1],
  ["APP-PU", "Apple purée", 180, 5],
] as const;
const PACK = [
  ["PK-TRAY", "Foil tray"],
  ["PK-LID", "Lid film"],
  ["PK-BOX", "Outer case"],
  ["PK-SLV", "Printed sleeve"],
  ["PK-BAG", "Bread bag"],
] as const;
const SUPPLIER_NAMES = [
  "Millbrook Flour Co",
  "Dairy Direct Ltd",
  "Eastern Poultry",
  "Sweet Source",
  "Fresh Fields Produce",
  "PackRight Packaging",
  "Global Dry Goods",
  "Cocoa & Co",
];
const CUSTOMER_NAMES = [
  "Northfield Supermarkets",
  "Corner Cafe Group",
  "Westside Wholesale",
  "Metro Convenience",
  "Harbour Hotels",
  "County Schools Catering",
  "Valley Garden Centres",
  "City Hospital Trust",
  "Sunrise Bakeries",
  "Quick Bites Ltd",
  "Airport Retail",
  "Farm Shop Collective",
];
const FINISHED = [
  ["Sourdough loaf", 800, 4, "FLR-WH", 0],
  ["Victoria sponge", 450, 5, "FLR-SR", 0],
  ["Chocolate brownie tray", 600, 7, "CHO-DK", 0],
  ["Chicken & veg pie", 350, 5, "CHK-DC", 1],
  ["Mac & cheese ready meal", 400, 6, "PAS-DR", 1],
  ["Tomato pasta bake", 400, 6, "TOM-PR", 1],
  ["Bacon & onion quiche", 300, 5, "BCN-LN", 1],
  ["Apple crumble", 500, 6, "APP-PU", 0],
  ["Fruit scone 4-pack", 240, 4, "FLR-SR", 0],
  ["Almond cake", 400, 8, "ALM-GR", 0],
] as const;

export async function createMaster(w: World, rng: Rng): Promise<Master> {
  const mdp = w.people.get("md")!,
    buy = w.people.get("buyMgr")!,
    qa = w.people.get("qaMgr")!,
    sales = w.people.get("salesMgr")!;
  const loc = async (name: string, code: string) =>
    (await w.call(mdp, "POST", "/stock/locations", { name, code }, [201])).body?.id as string;
  const locations = {
    dry: await loc("Dry store", "DRY"),
    chill: await loc("Chiller", "CHL"),
    frozen: await loc("Freezer", "FRZ"),
    packing: await loc("Packing hall", "PCK"),
    finished: await loc("Finished goods", "FG"),
    quarantine: await loc("Quarantine cage", "QRN"),
  };

  const suppliers: Master["suppliers"] = [];
  for (const name of SUPPLIER_NAMES) {
    const r = await w.call(buy, "POST", "/suppliers", { name }, [201]);
    const id = r.body?.id;
    if (!id) continue;
    await w.call(qa, "POST", `/suppliers/${id}/approval`, { status: "approved", reviewDueOn: "2099-01-01" });
    suppliers.push({ id, name, supplies: [] });
  }
  const customers: Master["customers"] = [];
  for (const [i, name] of CUSTOMER_NAMES.entries()) {
    const r = await w.call(
      sales,
      "POST",
      "/customers",
      {
        code: `C${String(i + 1).padStart(3, "0")}`,
        name,
        address: `${i + 1} Trade Park Way`,
        email: `orders${i}@customer.example.test`,
      },
      [201],
    );
    if (r.body?.id) customers.push({ id: r.body.id, name });
  }

  const ingredients: Ingredient[] = [];
  for (const [code, name, shelfDays, perBatchKg] of ING) {
    const r = await w.call(buy, "POST", "/items", { code, name, type: "ingredient", unit: "kg" }, [201]);
    if (r.body?.id) {
      ingredients.push({ id: r.body.id, code, name, unit: "kg", shelfDays, perBatchKg });
      suppliers[rng.int(0, suppliers.length - 1)]?.supplies.push(r.body.id);
    }
  }
  const packaging: Ingredient[] = [];
  for (const [code, name] of PACK) {
    const r = await w.call(buy, "POST", "/items", { code, name, type: "ingredient", unit: "each" }, [201]);
    if (r.body?.id)
      packaging.push({ id: r.body.id, code, name, unit: "each", shelfDays: 3650, perBatchKg: 0 });
  }
  for (const s of suppliers) if (!s.supplies.length) s.supplies.push(ingredients[0]!.id);

  const products: Product[] = [];
  const mgr = w.people.get("qaMgr")!;
  for (const [i, [name, g, shelfDays, key, packed]] of FINISHED.entries()) {
    const code = `FG-${String(i + 1).padStart(2, "0")}`;
    const item = await w.call(
      mgr,
      "POST",
      "/items",
      { code, name, type: "finished", unit: "each", unitWeightG: g, shelfLifeDays: shelfDays },
      [201],
    );
    if (!item.body?.id) continue;
    const yieldQty = 100 + i * 20;
    const main = ingredients.find((x) => x.code === key)!;
    const others = [...ingredients]
      .filter((x) => x.id !== main.id)
      .sort(() => rng.next() - 0.5)
      .slice(0, 3);
    const lines = [
      { itemId: main.id, quantity: rng.round(((yieldQty * g) / 1000) * 0.45, 1), unit: "kg" },
      ...others.map((o) => ({
        itemId: o.id,
        quantity: rng.round(((yieldQty * g) / 1000) * 0.12, 2),
        unit: "kg",
      })),
      ...(packed
        ? [
            { itemId: packaging[0]!.id, quantity: yieldQty, unit: "each" },
            { itemId: packaging[1]!.id, quantity: yieldQty, unit: "each" },
          ]
        : [{ itemId: packaging[4]!.id, quantity: yieldQty, unit: "each" }]),
    ];
    const rec = await w.call(
      mgr,
      "POST",
      "/recipes",
      {
        code: `R-${code}`,
        name,
        outputItemId: item.body.id,
        draft: { yieldQuantity: yieldQty, yieldUnit: "each", lines },
      },
      [201],
    );
    if (!rec.body?.id) continue;
    await w.call(mgr, "POST", `/recipes/${rec.body.id}/draft/approve`);
    products.push({
      id: item.body.id,
      code,
      name,
      recipeId: rec.body.id,
      unitWeightG: g,
      batchYield: yieldQty,
      shelfDays,
      lines,
    });
  }
  return { suppliers, customers, ingredients, packaging, products, locations };
}

/** Flags personas whose granted modules are switched off by a missing dependency (my fixture, not the product). */
export function checkPersonaAccess(w: World) {
  const active = [...moduleIds];
  const out: string[] = [];
  for (const p of w.people.values()) {
    if (p.role === "owner" || p.role === "admin") continue;
    const eff = resolveModuleAccess({ role: p.role, active, grants: p.access as never });
    for (const [mod, lvl] of Object.entries(p.access)) {
      if (eff[mod as keyof typeof eff] === "none" || !eff[mod as keyof typeof eff])
        out.push(`${p.key}:${mod}(${lvl}) is cut off by a dependency`);
    }
  }
  return out;
}
