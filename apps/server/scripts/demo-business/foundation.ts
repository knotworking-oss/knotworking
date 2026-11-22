import type { Ctx } from "./api";
import { addDays } from "./api";

/** People, suppliers, items, stock locations and recipes: the master data everything else hangs off. */

export const jobRoles = [
  "Production operative",
  "Production supervisor",
  "Quality technician",
  "Goods-in operative",
  "Warehouse operative",
  "Driver",
  "Maintenance engineer",
  "Cleaner",
  "Pasteuriser operator",
  "Cheesemaker",
];

const staff: [string, string, string, string, string, number][] = [
  // first, last, title, department, role, years of service
  ["Eleanor", "Whitcombe", "Managing Director", "Management", "", 12],
  ["Rhys", "Pritchard", "Operations Manager", "Operations", "", 9],
  ["Hannah", "Okafor", "Technical Manager", "Technical", "Quality technician", 7],
  ["Callum", "Brennan", "Production Manager", "Production", "Production supervisor", 8],
  ["Isla", "McAllister", "Quality Technician", "Technical", "Quality technician", 4],
  ["Dev", "Patel", "Quality Technician", "Technical", "Quality technician", 2],
  ["Sophie", "Lang", "Production Supervisor", "Production", "Production supervisor", 6],
  ["Gareth", "Hughes", "Production Supervisor", "Production", "Production supervisor", 5],
  ["Mateusz", "Kowalski", "Pasteuriser Operator", "Production", "Pasteuriser operator", 6],
  ["Aoife", "Brennan", "Pasteuriser Operator", "Production", "Pasteuriser operator", 3],
  ["Liam", "Fraser", "Cheesemaker", "Production", "Cheesemaker", 5],
  ["Zainab", "Rahman", "Cheesemaker", "Production", "Cheesemaker", 2],
  ["Tom", "Eastwood", "Production Operative", "Production", "Production operative", 3],
  ["Ruth", "Adeyemi", "Production Operative", "Production", "Production operative", 2],
  ["Jakub", "Nowak", "Production Operative", "Production", "Production operative", 4],
  ["Beth", "Calloway", "Production Operative", "Production", "Production operative", 1],
  ["Ahmed", "Yusuf", "Production Operative", "Production", "Production operative", 1],
  ["Kasia", "Zielinski", "Production Operative", "Production", "Production operative", 5],
  ["Owen", "Davies", "Production Operative", "Production", "Production operative", 2],
  ["Priyanka", "Shah", "Production Operative", "Production", "Production operative", 1],
  ["Marta", "Silva", "Goods-in Operative", "Warehouse", "Goods-in operative", 4],
  ["Craig", "Morrison", "Warehouse Supervisor", "Warehouse", "Warehouse operative", 7],
  ["Dan", "Whittle", "Warehouse Operative", "Warehouse", "Warehouse operative", 3],
  ["Nia", "Griffiths", "Warehouse Operative", "Warehouse", "Warehouse operative", 2],
  ["Stuart", "Kerr", "Driver", "Distribution", "Driver", 8],
  ["Imran", "Qureshi", "Driver", "Distribution", "Driver", 3],
  ["Pete", "Hollis", "Driver", "Distribution", "Driver", 1],
  ["Frank", "Doyle", "Maintenance Engineer", "Engineering", "Maintenance engineer", 10],
  ["Lena", "Vogel", "Cleaner", "Hygiene", "Cleaner", 2],
  ["Yusra", "Ahmed", "Cleaner", "Hygiene", "Cleaner", 1],
  ["Naomi", "Clarke", "Sales Manager", "Sales", "", 6],
  ["Jamie", "Thorpe", "Customer Services", "Sales", "", 3],
  ["Priya", "Desai", "Finance Manager", "Finance", "", 5],
  ["Colin", "Marsh", "Purchasing Buyer", "Purchasing", "", 4],
  ["Gemma", "Lloyd", "Planner", "Operations", "", 3],
];

export const suppliers = [
  {
    code: "SUP-MILK",
    name: "Somerset Vale Farms Co-op",
    contactName: "Alan Pettifer",
    email: "milk@somersetvale.example",
    phone: "01749 555 0101",
    address: "Manor Farm, Wells Road, Shepton Mallet, Somerset BA4 5XX",
    certification: "Red Tractor Dairy",
    months: 11,
    goods: true,
  },
  {
    code: "SUP-CULT",
    name: "Chr. Cultures UK",
    contactName: "Dr Mette Larsen",
    email: "orders@chrcultures.example",
    phone: "01904 555 0140",
    address: "Unit 4, Science Park, York YO10 5DG",
    certification: "BRCGS Food Safety",
    months: 8,
    goods: true,
  },
  {
    code: "SUP-FRUIT",
    name: "Orchard & Berry Ingredients",
    contactName: "Sam Whitlock",
    email: "sales@orchardberry.example",
    phone: "01234 555 0188",
    address: "Kent Fruit Park, Maidstone, Kent ME17 3XX",
    certification: "BRCGS Food Safety",
    months: 5,
    goods: true,
  },
  {
    code: "SUP-SUGAR",
    name: "British Sugar Direct",
    contactName: "Helen Ward",
    email: "trade@britishsugardirect.example",
    phone: "01603 555 0122",
    address: "Sugar Way, Wissington, Norfolk PE33 9XX",
    certification: "BRCGS Food Safety",
    months: 14,
    goods: true,
  },
  {
    code: "SUP-PACK",
    name: "Greenfield Packaging Ltd",
    contactName: "Paul Winters",
    email: "orders@greenfieldpack.example",
    phone: "0121 555 0166",
    address: "Unit 12, Tyseley Industrial Estate, Birmingham B11 2XX",
    certification: "BRCGS Packaging Materials",
    months: 9,
    goods: true,
  },
  {
    code: "SUP-BOTTLE",
    name: "Polybottle Solutions",
    contactName: "Rachel Ng",
    email: "sales@polybottle.example",
    phone: "01509 555 0177",
    address: "Loughborough Road, Leicestershire LE11 1XX",
    certification: "BRCGS Packaging Materials",
    months: 6,
    goods: true,
  },
  {
    code: "SUP-FLAV",
    name: "Madagascan Vanilla Traders",
    contactName: "Jean Bosco",
    email: "uk@mvtraders.example",
    phone: "020 5550 0133",
    address: "Warehouse 3, Tilbury Docks, Essex RM18 7XX",
    certification: "SEDEX SMETA",
    months: 3,
    goods: true,
  },
  {
    code: "SUP-SALT",
    name: "Cheshire Salt Works",
    contactName: "Dave Pickering",
    email: "info@cheshiresalt.example",
    phone: "01606 555 0199",
    address: "Marston, Northwich, Cheshire CW9 6XX",
    certification: "BRCGS Food Safety",
    months: 10,
    goods: true,
  },
  {
    code: "SUP-HONEY",
    name: "Wildflower Honey Company",
    contactName: "Judith Ames",
    email: "judith@wildflowerhoney.example",
    phone: "01793 555 0155",
    address: "Bee Lane, Swindon, Wiltshire SN6 8XX",
    certification: "SALSA",
    months: 7,
    goods: true,
  },
  {
    code: "SUP-GRAN",
    name: "Oakfield Granola Bakery",
    contactName: "Tess Oakfield",
    email: "tess@oakfieldgranola.example",
    phone: "01392 555 0144",
    address: "Mill Yard, Exeter, Devon EX4 4XX",
    certification: "SALSA",
    months: 2,
    goods: true,
  },
  {
    code: "SUP-HYG",
    name: "SafeClean Hygiene Supplies",
    contactName: "Mo Ali",
    email: "mo@safeclean.example",
    phone: "0117 555 0111",
    address: "Avonmouth Way, Bristol BS11 8XX",
    certification: "ISO 9001",
    months: 12,
    goods: true,
  },
  {
    code: "SUP-LAB",
    name: "Westcountry Food Analysis Ltd",
    contactName: "Dr Fiona Hale",
    email: "lab@wcfa.example",
    phone: "01392 555 0210",
    address: "Science Way, Exeter EX2 7XX",
    certification: "UKAS ISO 17025",
    months: 9,
    goods: false,
    serviceType: "Accredited testing laboratory",
  },
  {
    code: "SUP-PEST",
    name: "Rentokill Pest Control",
    contactName: "Gary Thompson",
    email: "gary@rentokill.example",
    phone: "0800 555 0120",
    address: "Pest House, Bristol BS3 4XX",
    certification: "BPCA Registered",
    months: 6,
    goods: false,
    serviceType: "Pest control contractor",
  },
  {
    code: "SUP-WASTE",
    name: "Westcountry Waste & Recycling",
    contactName: "Bryn Hollis",
    email: "bryn@wcwaste.example",
    phone: "01823 555 0177",
    address: "Transfer Station, Bridgwater TA6 4XX",
    certification: "Environment Agency Waste Carrier CBDU471234",
    months: 11,
    goods: false,
    serviceType: "Waste carrier",
  },
  {
    code: "SUP-CALIB",
    name: "Precision Calibration Services",
    contactName: "Nigel Rowe",
    email: "nigel@precisioncal.example",
    phone: "01275 555 0188",
    address: "Calibration House, Clevedon BS21 6XX",
    certification: "UKAS ISO 17025",
    months: 10,
    goods: false,
    serviceType: "Calibration services",
  },
];

type It = {
  code: string;
  name: string;
  type: "ingredient" | "packaging" | "wip" | "finished";
  unit: "kg" | "g" | "l" | "ml" | "each";
  storage: "ambient" | "chilled" | "frozen";
  allergens?: string[];
  mayContain?: string[];
  shelfLifeDays?: number | null;
  standardCost: number;
  density?: number;
  unitWeightG?: number;
  supplier?: string;
  description?: string;
};
export const items: It[] = [
  {
    code: "ING-MILK",
    name: "Raw cows' milk",
    type: "ingredient",
    unit: "l",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 3,
    standardCost: 0.36,
    density: 1.03,
    supplier: "SUP-MILK",
  },
  {
    code: "ING-CREAM",
    name: "Double cream (bulk)",
    type: "ingredient",
    unit: "l",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 5,
    standardCost: 2.1,
    density: 1.0,
    supplier: "SUP-MILK",
  },
  {
    code: "ING-SMP",
    name: "Skimmed milk powder",
    type: "ingredient",
    unit: "kg",
    storage: "ambient",
    allergens: ["milk"],
    shelfLifeDays: 365,
    standardCost: 2.9,
    supplier: "SUP-MILK",
  },
  {
    code: "ING-CULT-YOG",
    name: "Yogurt culture (S. thermophilus / L. bulgaricus)",
    type: "ingredient",
    unit: "g",
    storage: "frozen",
    allergens: ["milk"],
    shelfLifeDays: 540,
    standardCost: 0.045,
    supplier: "SUP-CULT",
  },
  {
    code: "ING-CULT-MESO",
    name: "Mesophilic starter culture",
    type: "ingredient",
    unit: "g",
    storage: "frozen",
    allergens: ["milk"],
    shelfLifeDays: 540,
    standardCost: 0.06,
    supplier: "SUP-CULT",
  },
  {
    code: "ING-RENNET",
    name: "Vegetarian rennet",
    type: "ingredient",
    unit: "ml",
    storage: "chilled",
    shelfLifeDays: 365,
    standardCost: 0.012,
    supplier: "SUP-CULT",
  },
  {
    code: "ING-SUGAR",
    name: "Cane sugar",
    type: "ingredient",
    unit: "kg",
    storage: "ambient",
    shelfLifeDays: 730,
    standardCost: 0.98,
    supplier: "SUP-SUGAR",
  },
  {
    code: "ING-STRAW",
    name: "Strawberry purée",
    type: "ingredient",
    unit: "kg",
    storage: "chilled",
    shelfLifeDays: 120,
    standardCost: 4.8,
    density: 1.05,
    supplier: "SUP-FRUIT",
    mayContain: ["sulphites"],
  },
  {
    code: "ING-RASP",
    name: "Raspberry purée",
    type: "ingredient",
    unit: "kg",
    storage: "chilled",
    shelfLifeDays: 120,
    standardCost: 6.2,
    density: 1.05,
    supplier: "SUP-FRUIT",
  },
  {
    code: "ING-VAN",
    name: "Vanilla extract",
    type: "ingredient",
    unit: "kg",
    storage: "ambient",
    shelfLifeDays: 730,
    standardCost: 82,
    supplier: "SUP-FLAV",
  },
  {
    code: "ING-HONEY",
    name: "Wildflower honey",
    type: "ingredient",
    unit: "kg",
    storage: "ambient",
    shelfLifeDays: 730,
    standardCost: 6.4,
    supplier: "SUP-HONEY",
  },
  {
    code: "ING-PECTIN",
    name: "Pectin (apple)",
    type: "ingredient",
    unit: "kg",
    storage: "ambient",
    shelfLifeDays: 540,
    standardCost: 14.5,
    supplier: "SUP-FRUIT",
  },
  {
    code: "ING-SALT",
    name: "Fine sea salt",
    type: "ingredient",
    unit: "kg",
    storage: "ambient",
    shelfLifeDays: 1825,
    standardCost: 0.42,
    supplier: "SUP-SALT",
  },
  {
    code: "ING-GRAN",
    name: "Honey & oat granola",
    type: "ingredient",
    unit: "kg",
    storage: "ambient",
    allergens: ["cereals_gluten", "nuts"],
    mayContain: ["peanuts", "sesame"],
    shelfLifeDays: 270,
    standardCost: 5.1,
    supplier: "SUP-GRAN",
  },
  {
    code: "PKG-BTL1",
    name: "1 litre HDPE bottle",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.11,
    supplier: "SUP-BOTTLE",
  },
  {
    code: "PKG-BTL2",
    name: "2 litre HDPE bottle",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.17,
    supplier: "SUP-BOTTLE",
  },
  {
    code: "PKG-CAP",
    name: "Tamper-evident bottle cap",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.025,
    supplier: "SUP-BOTTLE",
  },
  {
    code: "PKG-POT500",
    name: "500g yogurt pot",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.09,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-POT150",
    name: "150g yogurt pot",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.055,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-LID",
    name: "Foil pot lid",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.012,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-WRAP250",
    name: "Butter wrap, 250g",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.03,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-TUB200",
    name: "200g soft cheese tub and lid",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.08,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-CART300",
    name: "300ml cream carton",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.07,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-LABEL",
    name: "Printed product label",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.02,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-CASE12",
    name: "Outer case (12 units)",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 0.42,
    supplier: "SUP-PACK",
  },
  {
    code: "PKG-CRATE",
    name: "Returnable milk crate",
    type: "packaging",
    unit: "each",
    storage: "ambient",
    standardCost: 4.5,
    supplier: "SUP-BOTTLE",
  },
  {
    code: "WIP-YOGBASE",
    name: "Yogurt base (cultured)",
    type: "wip",
    unit: "kg",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 2,
    standardCost: 0.74,
    density: 1.03,
  },
  {
    code: "WIP-CURD",
    name: "Soft cheese curd",
    type: "wip",
    unit: "kg",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 2,
    standardCost: 3.1,
  },
  {
    code: "FG-MILK-WH1",
    name: "Whole milk, 1 litre",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 7,
    standardCost: 0.6,
    unitWeightG: 1030,
  },
  {
    code: "FG-MILK-SS1",
    name: "Semi-skimmed milk, 1 litre",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 7,
    standardCost: 0.58,
    unitWeightG: 1030,
  },
  {
    code: "FG-MILK-WH2",
    name: "Whole milk, 2 litre",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 7,
    standardCost: 1.05,
    unitWeightG: 2060,
  },
  {
    code: "FG-YOG-NAT500",
    name: "Natural yogurt, 500g",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 21,
    standardCost: 0.55,
    unitWeightG: 500,
  },
  {
    code: "FG-YOG-STR150",
    name: "Strawberry yogurt, 150g",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    mayContain: ["sulphites"],
    shelfLifeDays: 21,
    standardCost: 0.48,
    unitWeightG: 150,
  },
  {
    code: "FG-YOG-RAS150",
    name: "Raspberry yogurt, 150g",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 21,
    standardCost: 0.52,
    unitWeightG: 150,
  },
  {
    code: "FG-YOG-VAN150",
    name: "Vanilla yogurt, 150g",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 21,
    standardCost: 0.5,
    unitWeightG: 150,
  },
  {
    code: "FG-YOG-HG150",
    name: "Honey & granola yogurt, 150g",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk", "cereals_gluten", "nuts"],
    mayContain: ["peanuts", "sesame"],
    shelfLifeDays: 18,
    standardCost: 0.7,
    unitWeightG: 170,
  },
  {
    code: "FG-BUTTER-S250",
    name: "Salted butter, 250g",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 56,
    standardCost: 1.45,
    unitWeightG: 250,
  },
  {
    code: "FG-CREAM-D300",
    name: "Double cream, 300ml",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 14,
    standardCost: 0.98,
    unitWeightG: 300,
  },
  {
    code: "FG-CHEESE-S200",
    name: "Soft cream cheese, 200g",
    type: "finished",
    unit: "each",
    storage: "chilled",
    allergens: ["milk"],
    shelfLifeDays: 28,
    standardCost: 0.95,
    unitWeightG: 200,
  },
];

export const locations: [string, string, "ambient" | "chilled" | "frozen"][] = [
  ["Goods-in bay", "GIB", "ambient"],
  ["Chilled raw materials store", "CH-RM", "chilled"],
  ["Freezer (cultures)", "FRZ-1", "frozen"],
  ["Dry ingredient store", "DRY-1", "ambient"],
  ["Packaging store", "PKG-1", "ambient"],
  ["Finished goods chiller 1", "FG-CH1", "chilled"],
  ["Finished goods chiller 2", "FG-CH2", "chilled"],
  ["Despatch dock", "DSP", "chilled"],
  ["Quarantine cage", "QRN", "ambient"],
  ["Pasteuriser silo (WIP)", "WIP-SILO", "chilled"],
];

interface Rl {
  item: string;
  qty: number;
  unit: string;
  note?: string;
}
interface Rc {
  code: string;
  name: string;
  output: string;
  yieldQty: number;
  yieldUnit: string;
  method: string;
  lines: Rl[];
}
const pack = (units: number, caseUnit?: number): Rl[] =>
  caseUnit ? [{ item: "PKG-CASE12", qty: Math.ceil(units / caseUnit), unit: "each" }] : [];
export const recipes: Rc[] = [
  {
    code: "RCP-MILK-WH1",
    name: "Whole milk 1L",
    output: "FG-MILK-WH1",
    yieldQty: 1000,
    yieldUnit: "each",
    method:
      "1. Receive and test raw milk (temperature ≤ 5°C, antibiotic test negative).\n2. Standardise to 3.9% fat and filter.\n3. Pasteurise at 72°C for 15 seconds (HTST) and cool to ≤ 5°C.\n4. Fill into 1 litre bottles, cap, label and crate.\n5. Store at 0–5°C.",
    lines: [
      { item: "ING-MILK", qty: 970, unit: "l" },
      { item: "PKG-BTL1", qty: 1000, unit: "each" },
      { item: "PKG-CAP", qty: 1000, unit: "each" },
      { item: "PKG-LABEL", qty: 1000, unit: "each" },
      ...pack(1000, 12),
    ],
  },
  {
    code: "RCP-MILK-SS1",
    name: "Semi-skimmed milk 1L",
    output: "FG-MILK-SS1",
    yieldQty: 1000,
    yieldUnit: "each",
    method:
      "1. Receive and test raw milk.\n2. Separate and standardise to 1.7% fat.\n3. Pasteurise at 72°C for 15 seconds and cool to ≤ 5°C.\n4. Fill, cap, label and crate.",
    lines: [
      { item: "ING-MILK", qty: 980, unit: "l" },
      { item: "PKG-BTL1", qty: 1000, unit: "each" },
      { item: "PKG-CAP", qty: 1000, unit: "each" },
      { item: "PKG-LABEL", qty: 1000, unit: "each" },
      ...pack(1000, 12),
    ],
  },
  {
    code: "RCP-MILK-WH2",
    name: "Whole milk 2L",
    output: "FG-MILK-WH2",
    yieldQty: 500,
    yieldUnit: "each",
    method: "As whole milk 1L, filling into 2 litre bottles.",
    lines: [
      { item: "ING-MILK", qty: 970, unit: "l" },
      { item: "PKG-BTL2", qty: 500, unit: "each" },
      { item: "PKG-CAP", qty: 500, unit: "each" },
      { item: "PKG-LABEL", qty: 500, unit: "each" },
    ],
  },
  {
    code: "RCP-YOGBASE",
    name: "Yogurt base",
    output: "WIP-YOGBASE",
    yieldQty: 1000,
    yieldUnit: "kg",
    method:
      "1. Standardise milk to 3.5% fat and fortify with skimmed milk powder.\n2. Homogenise at 200 bar and heat-treat at 90°C for 5 minutes.\n3. Cool to 43°C and inoculate with culture.\n4. Incubate for 4–5 hours until pH 4.5.\n5. Break, cool to 8°C and hold in the silo.",
    lines: [
      { item: "ING-MILK", qty: 940, unit: "l" },
      { item: "ING-SMP", qty: 38, unit: "kg" },
      { item: "ING-CULT-YOG", qty: 100, unit: "g" },
    ],
  },
  {
    code: "RCP-YOG-NAT500",
    name: "Natural yogurt 500g",
    output: "FG-YOG-NAT500",
    yieldQty: 1000,
    yieldUnit: "each",
    method:
      "1. Pump cooled yogurt base to the filler.\n2. Fill 500g pots, seal with foil lid.\n3. Label, case and chill to ≤ 5°C within 2 hours.",
    lines: [
      { item: "WIP-YOGBASE", qty: 505, unit: "kg" },
      { item: "PKG-POT500", qty: 1000, unit: "each" },
      { item: "PKG-LID", qty: 1000, unit: "each" },
      { item: "PKG-LABEL", qty: 1000, unit: "each" },
      ...pack(1000, 6),
    ],
  },
  {
    code: "RCP-YOG-STR150",
    name: "Strawberry yogurt 150g",
    output: "FG-YOG-STR150",
    yieldQty: 2000,
    yieldUnit: "each",
    method:
      "1. Blend yogurt base with sugar and strawberry purée (12%).\n2. Fill 150g pots, seal and label.\n3. Case and chill to ≤ 5°C.",
    lines: [
      { item: "WIP-YOGBASE", qty: 250, unit: "kg" },
      { item: "ING-STRAW", qty: 36, unit: "kg" },
      { item: "ING-SUGAR", qty: 14, unit: "kg" },
      { item: "ING-PECTIN", qty: 1.2, unit: "kg" },
      { item: "PKG-POT150", qty: 2000, unit: "each" },
      { item: "PKG-LID", qty: 2000, unit: "each" },
      { item: "PKG-LABEL", qty: 2000, unit: "each" },
      ...pack(2000, 12),
    ],
  },
  {
    code: "RCP-YOG-RAS150",
    name: "Raspberry yogurt 150g",
    output: "FG-YOG-RAS150",
    yieldQty: 2000,
    yieldUnit: "each",
    method: "As strawberry yogurt, using raspberry purée (12%).",
    lines: [
      { item: "WIP-YOGBASE", qty: 250, unit: "kg" },
      { item: "ING-RASP", qty: 36, unit: "kg" },
      { item: "ING-SUGAR", qty: 15, unit: "kg" },
      { item: "ING-PECTIN", qty: 1.2, unit: "kg" },
      { item: "PKG-POT150", qty: 2000, unit: "each" },
      { item: "PKG-LID", qty: 2000, unit: "each" },
      { item: "PKG-LABEL", qty: 2000, unit: "each" },
      ...pack(2000, 12),
    ],
  },
  {
    code: "RCP-YOG-VAN150",
    name: "Vanilla yogurt 150g",
    output: "FG-YOG-VAN150",
    yieldQty: 2000,
    yieldUnit: "each",
    method: "Blend yogurt base with sugar and vanilla extract; fill, seal, label and case.",
    lines: [
      { item: "WIP-YOGBASE", qty: 280, unit: "kg" },
      { item: "ING-SUGAR", qty: 16, unit: "kg" },
      { item: "ING-VAN", qty: 0.6, unit: "kg" },
      { item: "PKG-POT150", qty: 2000, unit: "each" },
      { item: "PKG-LID", qty: 2000, unit: "each" },
      { item: "PKG-LABEL", qty: 2000, unit: "each" },
      ...pack(2000, 12),
    ],
  },
  {
    code: "RCP-YOG-HG150",
    name: "Honey & granola yogurt 150g",
    output: "FG-YOG-HG150",
    yieldQty: 1500,
    yieldUnit: "each",
    method:
      "1. Blend yogurt base with honey.\n2. Dose granola into the sealed topper compartment.\n3. Seal, label and case.",
    lines: [
      { item: "WIP-YOGBASE", qty: 190, unit: "kg" },
      { item: "ING-HONEY", qty: 12, unit: "kg" },
      { item: "ING-GRAN", qty: 22.5, unit: "kg" },
      { item: "PKG-POT150", qty: 1500, unit: "each" },
      { item: "PKG-LID", qty: 1500, unit: "each" },
      { item: "PKG-LABEL", qty: 1500, unit: "each" },
      ...pack(1500, 12),
    ],
  },
  {
    code: "RCP-BUTTER-S250",
    name: "Salted butter 250g",
    output: "FG-BUTTER-S250",
    yieldQty: 800,
    yieldUnit: "each",
    method:
      "1. Separate cream and ripen overnight.\n2. Churn, wash and work the butter; add salt (1.5%).\n3. Portion into 250g blocks and wrap.\n4. Case and chill.",
    lines: [
      { item: "ING-CREAM", qty: 420, unit: "l" },
      { item: "ING-SALT", qty: 3, unit: "kg" },
      { item: "ING-CULT-MESO", qty: 60, unit: "g" },
      { item: "PKG-WRAP250", qty: 800, unit: "each" },
      { item: "PKG-LABEL", qty: 800, unit: "each" },
      ...pack(800, 12),
    ],
  },
  {
    code: "RCP-CREAM-D300",
    name: "Double cream 300ml",
    output: "FG-CREAM-D300",
    yieldQty: 1000,
    yieldUnit: "each",
    method: "Standardise to 48% fat, pasteurise, cool, fill into cartons, seal and label.",
    lines: [
      { item: "ING-CREAM", qty: 300, unit: "l" },
      { item: "PKG-CART300", qty: 1000, unit: "each" },
      { item: "PKG-LABEL", qty: 1000, unit: "each" },
      ...pack(1000, 12),
    ],
  },
  {
    code: "RCP-CURD",
    name: "Soft cheese curd",
    output: "WIP-CURD",
    yieldQty: 150,
    yieldUnit: "kg",
    method:
      "1. Heat milk to 30°C, add mesophilic culture and rennet.\n2. Set for 16 hours.\n3. Ladle and drain the curd in muslin for 12 hours.",
    lines: [
      { item: "ING-MILK", qty: 1000, unit: "l" },
      { item: "ING-CULT-MESO", qty: 20, unit: "g" },
      { item: "ING-RENNET", qty: 40, unit: "ml" },
    ],
  },
  {
    code: "RCP-CHEESE-S200",
    name: "Soft cream cheese 200g",
    output: "FG-CHEESE-S200",
    yieldQty: 500,
    yieldUnit: "each",
    method: "Blend curd with salt and a little cream, fill 200g tubs and seal.",
    lines: [
      { item: "WIP-CURD", qty: 90, unit: "kg" },
      { item: "ING-CREAM", qty: 8, unit: "l" },
      { item: "ING-SALT", qty: 1.2, unit: "kg" },
      { item: "PKG-TUB200", qty: 500, unit: "each" },
      { item: "PKG-LABEL", qty: 500, unit: "each" },
      ...pack(500, 12),
    ],
  },
];

export async function foundation(ctx: Ctx) {
  const { api, today } = ctx;
  const ids = (ctx.ids.item ??= {});
  const sup = (ctx.ids.supplier ??= {});
  const loc = (ctx.ids.location ??= {});
  const role = (ctx.ids.role ??= {});
  const rcp = (ctx.ids.recipe ??= {});
  const stf = (ctx.ids.staff ??= {});
  let made = 0;

  // Job roles
  const existingRoles = (await api.get("/people/job-roles?status=all")).jobRoles as any[];
  for (const name of jobRoles) {
    const hit = existingRoles.find((r) => r.name === name);
    role[name] = hit
      ? hit.id
      : ((await api.post("/people/job-roles", { name, description: `${name} (Knotmilk Dairy)` })).jobRole
          ?.id ??
        (await api.get("/people/job-roles?status=all")).jobRoles.find((r: any) => r.name === name).id);
    if (!hit) made++;
  }

  // Staff
  const existingStaff = (await api.get("/people/staff?status=all&limit=500")).staff as any[];
  for (const [firstName, lastName, jobTitle, department, roleName, years] of staff) {
    const hit = existingStaff.find((s) => s.firstName === firstName && s.lastName === lastName);
    if (hit) {
      stf[`${firstName} ${lastName}`] = hit.id;
      continue;
    }
    const startDate = addDays(today, -Math.round(years * 365 + ((firstName.length * 17) % 200)));
    const r = await api.post("/people/staff", {
      firstName,
      lastName,
      jobTitle,
      department,
      startDate,
      jobRoleIds: roleName ? [role[roleName]] : [],
    });
    stf[`${firstName} ${lastName}`] = (r.staff ?? r).id;
    made++;
  }

  // Suppliers + approval
  const existingSup = (await api.get("/suppliers?limit=200")).suppliers as any[];
  for (const s of suppliers) {
    let hit = existingSup.find((x) => x.code === s.code);
    if (!hit) {
      const r = await api.post("/suppliers", {
        code: s.code,
        name: s.name,
        contactName: s.contactName,
        email: s.email,
        phone: s.phone,
        address: s.address,
        certification: s.certification,
        certificateExpiresOn: addDays(today, s.months * 30),
        category: s.goods ? "goods" : "service",
        serviceType: s.goods ? null : s.serviceType,
      });
      hit = r.supplier ?? r;
      made++;
      await api.post(`/suppliers/${hit.id}/approval`, {
        status: "approved",
        note: "Approved after supplier questionnaire and certificate review.",
        reviewDueOn: addDays(today, 330),
      });
    }
    sup[s.code] = hit.id;
  }

  // Items
  const existingItems = (await api.get("/items?status=all&limit=200")).items as any[];
  for (const it of items) {
    const hit = existingItems.find((x) => x.code === it.code);
    if (hit) {
      ids[it.code] = hit.id;
      continue;
    }
    const r = await api.post("/items", {
      code: it.code,
      name: it.name,
      type: it.type,
      unit: it.unit,
      storage: it.storage,
      allergens: it.allergens ?? [],
      mayContain: it.mayContain ?? [],
      shelfLifeDays: it.shelfLifeDays ?? null,
      standardCost: it.standardCost,
      densityGPerMl: it.density ?? null,
      unitWeightG: it.unitWeightG ?? null,
      suppliers: it.supplier
        ? [
            {
              supplierId: sup[it.supplier]!,
              preferred: true,
              supplierCode: `${it.supplier.slice(4)}-${it.code.slice(-4)}`,
            },
          ]
        : [],
    });
    ids[it.code] = (r.item ?? r).id;
    made++;
  }

  // Locations
  const existingLoc = (await api.get("/stock/locations?status=all")).locations as any[];
  for (const [name, code, storage] of locations) {
    const hit = existingLoc.find((l) => l.code === code || l.name === name);
    if (hit) {
      loc[code] = hit.id;
      continue;
    }
    const r = await api.post("/stock/locations", { name, code, storage });
    loc[code] = (r.location ?? r).id;
    made++;
  }

  // Recipes (create with a draft, then approve)
  const existingRcp = (await api.get("/recipes?status=all&limit=200")).recipes as any[];
  for (const r of recipes) {
    const hit = existingRcp.find((x) => x.code === r.code);
    if (hit) {
      rcp[r.code] = hit.id;
      continue;
    }
    const created = await api.post("/recipes", {
      code: r.code,
      name: r.name,
      outputItemId: ids[r.output]!,
      description: `Standard recipe for ${r.name}.`,
      draft: {
        yieldQuantity: r.yieldQty,
        yieldUnit: r.yieldUnit,
        method: r.method,
        changeNote: "Initial version",
        lines: r.lines.map((l) => ({
          itemId: ids[l.item]!,
          quantity: l.qty,
          unit: l.unit,
          note: l.note ?? null,
        })),
      },
    });
    const id = (created.recipe ?? created).id;
    rcp[r.code] = id;
    await api.post(`/recipes/${id}/draft/approve`, {});
    made++;
  }
  return `${made} records created`;
}
