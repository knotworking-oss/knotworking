import { z } from "zod";
import {
  allergens as allergenNames,
  convertQuantity,
  roundQuantity,
  sortAllergens,
  unitDimension,
  type AllergenCode,
  type ItemType,
  type StorageCondition,
  type UnitBridge,
  type UnitCode,
} from "./items";
import { optionalGtinSchema } from "./barcode";
import {
  micronutrientAmountsSchema,
  micronutrientKeys,
  micronutrientRetentionSchema,
  retainedAmount,
  type MicronutrientAmounts,
  type MicronutrientKey,
  type MicronutrientRetention,
} from "./micronutrients";
import { allergenMismatch, rollUpAllergens, type AllergenMismatch, type AllergenRollup } from "./recipes";

/**
 * Labels and nutrition module: nutrition per 100 g (or 100 ml) on items, rolled up through recipe
 * versions; the ingredient declaration in weight order with the 14 allergens emphasised (UK PPDS);
 * and product labels drafted from those, edited, and approved per recipe version. Builds on
 * recipes. No DOM or Node APIs.
 *
 * Everything here is computed from a {@link LabelGraph} (items with their label data, and the
 * approved recipe version of every item made in house), so the server, the web app and tests share
 * one implementation. Rich text is never baked in: emphasis is a list of {@link LabelSegment}s that
 * a client renders bold however it likes.
 */

// ─── Nutrition vocabulary ────────────────────────────────────────────────────

/**
 * The UK mandatory nutrition declaration (retained Regulation (EU) 1169/2011, Article 30(1)), plus
 * fibre, which is optional. Values are per 100 g, or per 100 ml for liquids.
 */
export const nutrientKeys = [
  "energyKj",
  "energyKcal",
  "fat",
  "saturates",
  "carbohydrate",
  "sugars",
  "fibre",
  "protein",
  "salt",
] as const;
export type NutrientKey = (typeof nutrientKeys)[number];
export const mandatoryNutrientKeys = nutrientKeys.filter((k) => k !== "fibre") as Exclude<
  NutrientKey,
  "fibre"
>[];

export const nutrientLabels: Record<NutrientKey, string> = {
  energyKj: "Energy",
  energyKcal: "Energy",
  fat: "Fat",
  saturates: "of which saturates",
  carbohydrate: "Carbohydrate",
  sugars: "of which sugars",
  fibre: "Fibre",
  protein: "Protein",
  salt: "Salt",
};
export const nutrientUnits: Record<NutrientKey, "kJ" | "kcal" | "g"> = {
  energyKj: "kJ",
  energyKcal: "kcal",
  fat: "g",
  saturates: "g",
  carbohydrate: "g",
  sugars: "g",
  fibre: "g",
  protein: "g",
  salt: "g",
};

/**
 * Substances that carry energy but are not declared on their own (they sit inside carbohydrate,
 * or are not in the panel at all): the energy calculation needs them. Per 100 g or 100 ml. Polyols
 * (sorbitol, xylitol, maltitol, …) are part of the declared carbohydrate; erythritol is a polyol
 * that counts as 0 kJ and is entered separately, so keep it out of `polyols`.
 */
export const energyExtraKeys = ["polyols", "erythritol", "organicAcids", "alcohol"] as const;
export type EnergyExtraKey = (typeof energyExtraKeys)[number];
export const energyExtraLabels: Record<EnergyExtraKey, string> = {
  polyols: "Polyols (not erythritol)",
  erythritol: "Erythritol",
  organicAcids: "Organic acids",
  alcohol: "Alcohol (ethanol)",
};

/** Raw nutrition values per 100 g or 100 ml. Fibre is optional (`null`: not known). */
export interface NutritionValues {
  energyKj: number;
  energyKcal: number;
  fat: number;
  saturates: number;
  carbohydrate: number;
  sugars: number;
  fibre: number | null;
  protein: number;
  salt: number;
  /**
   * Polyols, erythritol, organic acids and alcohol, for the energy calculation only (never
   * declared). Absent, `null` or 0: none. Polyols and erythritol are part of `carbohydrate`.
   */
  polyols?: number | null | undefined;
  erythritol?: number | null | undefined;
  organicAcids?: number | null | undefined;
  alcohol?: number | null | undefined;
}

export const nutritionBases = ["100g", "100ml"] as const;
export type NutritionBasis = (typeof nutritionBases)[number];
export const nutritionBasisLabels: Record<NutritionBasis, string> = {
  "100g": "per 100 g",
  "100ml": "per 100 ml",
};
/** The unit a basis counts in: per 100 **g** or per 100 **ml**. */
export const nutritionBasisUnit: Record<NutritionBasis, UnitCode> = { "100g": "g", "100ml": "ml" };

/** Decimal places nutrition is stored with (`numeric(10,3)`): salt needs three (0.012 g). */
export const NUTRIENT_DECIMALS = 3;

/** Nutrition as entered for an item (from the supplier's specification) or computed for a recipe. */
export interface NutritionEntry {
  basis: NutritionBasis;
  values: NutritionValues;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

const threeDecimals = (value: number) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6;
const amount = (max: number) =>
  z.number().finite().min(0).max(max).refine(threeDecimals, "At most 3 decimal places");
/** Optional extra: left out or `null` is none (0). */
const optionalAmount = (max: number) =>
  amount(max)
    .nullable()
    .optional()
    .transform((v) => v ?? 0);

/**
 * Nutrition per 100 g or 100 ml, as entered from a supplier's specification. Grams can't exceed
 * 100 per 100 g; per 100 ml a dense liquid (syrup, honey) may carry more, so the cap is higher.
 * "Of which" values can't exceed their parent, and kJ must be about 4.2 × kcal (catches the two
 * typed the wrong way round).
 */
export const nutritionInputSchema = z
  .object({
    basis: z.enum(nutritionBases).default("100g"),
    energyKj: amount(10_000),
    energyKcal: amount(2_500),
    fat: amount(200),
    saturates: amount(200),
    carbohydrate: amount(200),
    sugars: amount(200),
    fibre: amount(200)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    protein: amount(200),
    salt: amount(200),
    polyols: optionalAmount(200),
    erythritol: optionalAmount(200),
    organicAcids: optionalAmount(200),
    alcohol: optionalAmount(200),
  })
  .superRefine((n, ctx) => {
    if (n.polyols + n.erythritol > n.carbohydrate + 1e-9) {
      ctx.addIssue({
        code: "custom",
        path: ["polyols"],
        message: "Polyols and erythritol are part of the carbohydrate, so can't be more than it",
      });
    }
    if (n.saturates > n.fat) ctx.addIssue({ code: "custom", path: ["saturates"], message: "More than fat" });
    if (n.sugars > n.carbohydrate) {
      ctx.addIssue({ code: "custom", path: ["sugars"], message: "More than carbohydrate" });
    }
    if (n.basis === "100g") {
      for (const key of [
        "fat",
        "carbohydrate",
        "protein",
        "salt",
        "fibre",
        "organicAcids",
        "alcohol",
      ] as const) {
        const value = n[key];
        if (value !== null && value > 100) {
          ctx.addIssue({ code: "custom", path: [key], message: "More than 100 g per 100 g" });
        }
      }
    }
    if (n.energyKcal >= 10) {
      const ratio = n.energyKj / n.energyKcal;
      if (ratio < 4 || ratio > 4.4) {
        ctx.addIssue({
          code: "custom",
          path: ["energyKj"],
          message: "Energy in kJ should be about 4.2 × the kcal (1 kcal = 4.184 kJ)",
        });
      }
    }
  });
export type NutritionInput = z.infer<typeof nutritionInputSchema>;

/** The kJ for a kcal figure, as a supplier's sheet would give it (1 kcal = 4.184 kJ). */
export const kcalToKj = (kcal: number) => Math.round(kcal * 4.184);
/** The kcal for a kJ figure (1 kcal = 4.184 kJ). */
export const kjToKcal = (kj: number) => Math.round(kj / 4.184);

/**
 * An item's labelling data (`PUT /labelling/items/:itemId`): how it is named in an ingredients
 * list, the components of a bought-in compound ingredient (from its specification), and its
 * nutrition. A full replacement: leave a field out (or send `null`) to clear it.
 */
export const itemLabelDataSchema = z.object({
  /** How the item appears in an ingredients list, e.g. "Wheat flour". Default: the item's name. */
  declarationName: optionalText(200).optional(),
  /**
   * For a bought-in compound ingredient, its own ingredients from the specification, e.g.
   * "sugar, cocoa mass, cocoa butter, emulsifier: soya lecithin". Shown in brackets after the name.
   */
  components: optionalText(2000).optional(),
  nutrition: nutritionInputSchema.nullable().optional(),
  /**
   * Optional vitamins and minerals per 100 g / ml (same basis as the nutrition), for the roll-up's
   * information. Never declared on a label.
   */
  micronutrients: micronutrientAmountsSchema.nullable().optional(),
  /**
   * Fraction of each micronutrient that survives cooking this item in a recipe (0 to 1; 0.6 loses
   * 40%). Left out: no loss assumed. Your own figures, from a retention table or analysis.
   */
  retention: micronutrientRetentionSchema.nullable().optional(),
  /** Where the nutrition came from, e.g. "Supplier specification v3, March 2026". */
  nutritionSource: optionalText(300).optional(),
});
export type ItemLabelDataInput = z.infer<typeof itemLabelDataSchema>;

/** Item types that are food, so have labelling data. Packaging never does. */
export const labelItemTypes = ["ingredient", "wip", "finished"] as const satisfies readonly ItemType[];
export const isFoodItemType = (type: ItemType) => type !== "packaging";

/** Where an item's nutrition comes from in a roll-up. */
export const nutritionSources = ["entered", "recipe", "missing"] as const;
export type NutritionSource = (typeof nutritionSources)[number];
export const nutritionSourceLabels: Record<NutritionSource, string> = {
  entered: "Entered",
  recipe: "From recipe",
  missing: "Missing",
};

export const labellingItemListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(labelItemTypes).optional(),
  /** `missing`: food items with no nutrition (entered, or complete from a recipe). */
  nutrition: z.enum(["all", ...nutritionSources]).default("all"),
  /** Default: active items only. */
  status: z.enum(["active", "archived", "all"]).default("active"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type LabellingItemListQuery = z.infer<typeof labellingItemListQuerySchema>;

// ─── Rich text without HTML ──────────────────────────────────────────────────

/** A run of label text. `emphasis` marks an allergen to show in bold (or however a client emphasises). */
export interface LabelSegment {
  text: string;
  emphasis?: true;
}
export const labelSegmentSchema = z.object({
  text: z.string().max(5000),
  emphasis: z.literal(true).optional(),
});

/** Joins adjacent runs of the same kind and drops empty ones. */
export function normalizeSegments(segments: readonly LabelSegment[]): LabelSegment[] {
  const out: LabelSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = out[out.length - 1];
    if (last && !!last.emphasis === !!segment.emphasis) last.text += segment.text;
    else out.push(segment.emphasis ? { text: segment.text, emphasis: true } : { text: segment.text });
  }
  return out;
}

/** Plain text of some segments (search, previews, the MCP server). */
export const segmentsText = (segments: readonly LabelSegment[]) => segments.map((s) => s.text).join("");

/** The editing form of segments: emphasis between double asterisks, `**milk**`. */
export const segmentsMarkup = (segments: readonly LabelSegment[]) =>
  segments.map((s) => (s.emphasis ? `**${s.text}**` : s.text)).join("");

/**
 * Parses the editing form back into segments: text between `**` pairs is emphasised. An unpaired
 * `**` is kept as text.
 */
export function parseSegmentsMarkup(markup: string): LabelSegment[] {
  const parts = markup.split("**");
  // An even number of parts means an odd number of markers: the last one has no partner.
  if (parts.length % 2 === 0)
    parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]}**${parts.at(-1)}`);
  return normalizeSegments(parts.map((text, i) => (i % 2 === 1 ? { text, emphasis: true } : { text })));
}

// ─── Allergen emphasis ───────────────────────────────────────────────────────

/**
 * Words that name each allergen in an ingredients list. Only the allergens an ingredient contains
 * are looked for, so "milk chocolate flavouring" in a dairy-free item is not emphasised.
 */
export const allergenKeywords: Record<AllergenCode, readonly string[]> = {
  celery: ["celery", "celeriac"],
  cereals_gluten: ["wheat", "rye", "barley", "oats", "oat", "spelt", "khorasan", "kamut", "gluten"],
  crustaceans: [
    "crustaceans",
    "crustacean",
    "prawns",
    "prawn",
    "shrimps",
    "shrimp",
    "crab",
    "lobster",
    "crayfish",
    "langoustines",
    "langoustine",
  ],
  eggs: ["eggs", "egg"],
  fish: [
    "fish",
    "anchovies",
    "anchovy",
    "salmon",
    "tuna",
    "cod",
    "haddock",
    "mackerel",
    "sardines",
    "sardine",
    "pollock",
    "trout",
  ],
  lupin: ["lupin"],
  milk: ["milk", "butter", "buttermilk", "cream", "cheese", "yoghurt", "yogurt"],
  molluscs: [
    "molluscs",
    "mollusc",
    "mussels",
    "mussel",
    "oysters",
    "oyster",
    "squid",
    "scallops",
    "scallop",
    "clams",
    "clam",
    "octopus",
    "whelks",
    "whelk",
    "cockles",
    "cockle",
  ],
  mustard: ["mustard"],
  nuts: [
    "almonds",
    "almond",
    "hazelnuts",
    "hazelnut",
    "walnuts",
    "walnut",
    "cashews",
    "cashew",
    "pecans",
    "pecan",
    "brazil nuts",
    "brazil nut",
    "pistachios",
    "pistachio",
    "macadamia",
    "nuts",
    "nut",
  ],
  peanuts: ["peanuts", "peanut", "groundnuts", "groundnut", "arachis"],
  sesame: ["sesame"],
  soybeans: ["soybeans", "soybean", "soyabeans", "soyabean", "soya", "soy"],
  sulphites: [
    "sulphur dioxide",
    "sulphites",
    "sulphite",
    "sulfites",
    "sulfite",
    "metabisulphite",
    "bisulphite",
  ],
};

/**
 * The word added in brackets when an ingredient contains an allergen its name doesn't mention:
 * "Whey powder (**milk**)". For cereals the specific cereal should be named; "gluten" is a
 * placeholder the draft warns about (`allergen_not_named`).
 */
export const allergenLabelTerms: Record<AllergenCode, string> = {
  celery: "celery",
  cereals_gluten: "gluten",
  crustaceans: "crustaceans",
  eggs: "egg",
  fish: "fish",
  lupin: "lupin",
  milk: "milk",
  molluscs: "molluscs",
  mustard: "mustard",
  nuts: "nuts",
  peanuts: "peanuts",
  sesame: "sesame",
  soybeans: "soya",
  sulphites: "sulphites",
};

/**
 * Phrases in which an allergen's keyword doesn't name that allergen: "cocoa butter" and "cream of
 * tartar" are not milk, "pine nuts" are not tree nuts. They are checked before emphasis, per
 * allergen, so "peanut butter" still emphasises "peanut" (peanuts) but not "butter" (milk). Words
 * that merely contain a keyword ("butternut", "buckwheat", "coconut", "nutmeg") never match, as
 * keywords match whole words only.
 */
export const nonAllergenPhrases: Partial<Record<AllergenCode, readonly string[]>> = {
  milk: [
    "cocoa butter",
    "shea butter",
    "mango butter",
    "kokum butter",
    "illipe butter",
    "coconut butter",
    "peanut butter",
    "nut butter",
    "almond butter",
    "cashew butter",
    "hazelnut butter",
    "seed butter",
    "apple butter",
    "butter beans",
    "butter bean",
    "cream of tartar",
    "coconut milk",
    "coconut cream",
    "almond milk",
    "oat milk",
    "rice milk",
    "soya milk",
    "soy milk",
    "hemp milk",
  ],
  nuts: ["pine nuts", "pine nut", "tiger nuts", "tiger nut", "nut-free", "nut free"],
  crustaceans: ["crab apples", "crab apple"],
  eggs: ["egg-free", "egg free"],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words or phrases only: never part of a longer word. */
function wordsPattern(words: readonly string[]): RegExp | null {
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(${sorted.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

const keywordAllergens = (() => {
  const out = new Map<string, AllergenCode[]>();
  for (const [code, words] of Object.entries(allergenKeywords) as [AllergenCode, readonly string[]][]) {
    for (const word of words) out.set(word, [...(out.get(word) ?? []), code]);
  }
  return out;
})();

/**
 * Where the allergens `codes` are named in some text: each keyword match, unless every allergen
 * it names is ruled out there by a {@link nonAllergenPhrases} phrase around it.
 */
function allergenMatches(
  text: string,
  codes: readonly AllergenCode[],
): { index: number; text: string; codes: AllergenCode[] }[] {
  const pattern = wordsPattern(codes.flatMap((code) => allergenKeywords[code]));
  if (!pattern) return [];
  const excluded = new Map<AllergenCode, [number, number][]>();
  for (const code of codes) {
    const phrases = wordsPattern(nonAllergenPhrases[code] ?? []);
    if (!phrases) continue;
    excluded.set(
      code,
      [...text.matchAll(phrases)].map((m) => [m.index, m.index + m[0].length]),
    );
  }
  const out: { index: number; text: string; codes: AllergenCode[] }[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const named = (keywordAllergens.get(match[0].toLowerCase()) ?? []).filter(
      (code) => codes.includes(code) && !(excluded.get(code) ?? []).some(([s, e]) => s <= start && end <= e),
    );
    if (named.length) out.push({ index: start, text: match[0], codes: named });
  }
  return out;
}

/** The allergens (of `codes`) that some text names, by their keywords. */
export function allergensNamedIn(text: string, codes: readonly AllergenCode[]): AllergenCode[] {
  const named = new Set(allergenMatches(text, codes).flatMap((m) => m.codes));
  return codes.filter((code) => named.has(code));
}

/**
 * Emphasises the allergens `codes` in some text. Text written with `**…**` markers is taken as the
 * person wrote it; otherwise every keyword of those allergens is emphasised, except where a
 * {@link nonAllergenPhrases} phrase says it isn't that allergen ("cocoa butter"). Returns the
 * allergens the text doesn't name at all (`unnamed`), which a caller adds in brackets.
 */
export function emphasiseAllergens(
  text: string,
  codes: readonly AllergenCode[],
): { segments: LabelSegment[]; unnamed: AllergenCode[] } {
  const matches = allergenMatches(text, codes);
  const named = new Set(matches.flatMap((m) => m.codes));
  const unnamed = codes.filter((code) => !named.has(code));
  if (text.includes("**")) return { segments: parseSegmentsMarkup(text), unnamed };
  const segments: LabelSegment[] = [];
  let last = 0;
  for (const match of matches) {
    segments.push({ text: text.slice(last, match.index) });
    segments.push({ text: match.text, emphasis: true });
    last = match.index + match.text.length;
  }
  segments.push({ text: text.slice(last) });
  return { segments: normalizeSegments(segments), unnamed };
}

/** "(**milk**, **egg**)": the bracket added for allergens a name doesn't mention. */
const unnamedBracket = (codes: readonly AllergenCode[]): LabelSegment[] =>
  codes.length === 0
    ? []
    : [
        { text: " (" },
        ...codes.flatMap((code, i): LabelSegment[] => [
          ...(i > 0 ? [{ text: ", " }] : []),
          { text: allergenLabelTerms[code], emphasis: true },
        ]),
        { text: ")" },
      ];

/** "a, b and c". */
export const joinWithAnd = (words: readonly string[]) =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

// ─── Rounding for declaration ────────────────────────────────────────────────

/** One declared value: rounded per the guidance, with the raw value kept beside it. */
export interface DeclaredNutrient {
  raw: number;
  /** The rounded value (0 when declared as "<0.5 g" and the like). */
  value: number;
  /** As printed: "12 g", "1.5 g", "<0.1 g", "1046 kJ". */
  display: string;
  /** True when shown as "<…": present, but at or below the threshold. */
  lessThan: boolean;
}

/**
 * Rounds a value for the nutrition declaration following the European Commission guidance on
 * tolerances and rounding (December 2012), which the FSA follows for the UK:
 *
 * - Energy: to the nearest 1 kJ or kcal.
 * - Fat, carbohydrate, sugars, protein, fibre: 10 g or more to the nearest 1 g; more than 0.5 g
 *   to the nearest 0.1 g; 0.5 g or less is declared "<0.5 g" ("0 g" when there is none).
 * - Saturates: 10 g or more to 1 g; more than 0.1 g to 0.1 g; otherwise "<0.1 g".
 * - Salt: 1 g or more to 0.1 g; more than 0.0125 g to 0.01 g; otherwise "<0.01 g".
 *
 * `negligibleAsZero` (a per-label choice) declares those small amounts as "0 g" instead of "<0.5 g",
 * "<0.1 g" or "<0.01 g". Whether that is acceptable for a product is the manufacturer's call.
 */
export function roundNutrient(
  key: NutrientKey,
  raw: number,
  options: { negligibleAsZero?: boolean | undefined } = {},
): DeclaredNutrient {
  const unit = nutrientUnits[key];
  const fixed = (value: number, decimals: number): DeclaredNutrient => {
    const rounded = roundQuantity(value, decimals);
    return { raw, value: rounded, display: `${rounded.toFixed(decimals)} ${unit}`, lessThan: false };
  };
  const below = (threshold: string): DeclaredNutrient =>
    raw <= 0 || options.negligibleAsZero
      ? { raw, value: 0, display: `0 ${unit}`, lessThan: false }
      : { raw, value: 0, display: `<${threshold} ${unit}`, lessThan: true };
  if (key === "energyKj" || key === "energyKcal") return fixed(Math.max(raw, 0), 0);
  if (key === "saturates") {
    if (raw >= 10) return fixed(raw, 0);
    if (raw > 0.1) return fixed(raw, 1);
    return below("0.1");
  }
  if (key === "salt") {
    if (raw >= 1) return fixed(raw, 1);
    if (raw > 0.0125) return fixed(raw, 2);
    return below("0.01");
  }
  if (raw >= 10) return fixed(raw, 0);
  if (raw > 0.5) return fixed(raw, 1);
  return below("0.5");
}

/** How the energy on a panel was worked out. */
export const energyMethods = ["declared", "calculated"] as const;
export type EnergyMethod = (typeof energyMethods)[number];
export const energyMethodLabels: Record<EnergyMethod, string> = {
  declared: "Summed from the ingredients' declared energy",
  calculated: "Calculated from the macronutrients (UK conversion factors)",
};

/**
 * Energy conversion factors per gram (retained Regulation (EU) 1169/2011, Annex XIV):
 *
 * | per g                    | kJ | kcal |
 * | ------------------------ | -- | ---- |
 * | fat                      | 37 | 9    |
 * | carbohydrate (not polyols) and protein | 17 | 4 |
 * | alcohol (ethanol)        | 29 | 7    |
 * | organic acid             | 13 | 3    |
 * | polyols                  | 10 | 2.4  |
 * | fibre                    | 8  | 2    |
 * | erythritol               | 0  | 0    |
 *
 * Salt counts for nothing. (Salatrims, 25 kJ / 6 kcal, are not held.)
 */
export const energyFactors = {
  fat: { kj: 37, kcal: 9 },
  carbohydrate: { kj: 17, kcal: 4 },
  protein: { kj: 17, kcal: 4 },
  fibre: { kj: 8, kcal: 2 },
  polyols: { kj: 10, kcal: 2.4 },
  erythritol: { kj: 0, kcal: 0 },
  organicAcids: { kj: 13, kcal: 3 },
  alcohol: { kj: 29, kcal: 7 },
} as const;

/**
 * Energy from the nutrients with {@link energyFactors}. The declared carbohydrate includes polyols
 * (Regulation 1169/2011 Annex I), so they are taken out of it and counted at their own, lower
 * factor; erythritol is taken out and counts as nothing. Organic acids and alcohol are not in the
 * carbohydrate and are added. Fibre counts when it is known, else it is left out (the carbohydrate
 * is the available carbohydrate, which excludes fibre).
 */
export function calculateEnergy(
  values: Pick<NutritionValues, "fat" | "carbohydrate" | "protein" | "fibre"> &
    Partial<Pick<NutritionValues, EnergyExtraKey>>,
): { energyKj: number; energyKcal: number } {
  const polyols = values.polyols ?? 0;
  const erythritol = values.erythritol ?? 0;
  const otherCarbohydrate = Math.max(0, values.carbohydrate - polyols - erythritol);
  const sum = (unit: "kj" | "kcal") =>
    values.fat * energyFactors.fat[unit] +
    otherCarbohydrate * energyFactors.carbohydrate[unit] +
    values.protein * energyFactors.protein[unit] +
    (values.fibre ?? 0) * energyFactors.fibre[unit] +
    polyols * energyFactors.polyols[unit] +
    erythritol * energyFactors.erythritol[unit] +
    (values.organicAcids ?? 0) * energyFactors.organicAcids[unit] +
    (values.alcohol ?? 0) * energyFactors.alcohol[unit];
  return { energyKj: roundQuantity(sum("kj"), 3), energyKcal: roundQuantity(sum("kcal"), 3) };
}

/** Reference intakes of an average adult (Regulation 1169/2011, Annex XIII, part B); energy 8400 kJ / 2000 kcal. */
export const referenceIntakes = {
  energy: 2000,
  fat: 70,
  saturates: 20,
  carbohydrate: 260,
  sugars: 90,
  protein: 50,
  salt: 6,
} as const;
export type ReferenceIntakeKey = keyof typeof referenceIntakes;

/** Values for one portion, rounded as the per 100 values are, with % of the reference intake. */
export interface PortionPanel {
  /** In g, or ml for a per 100 ml panel. */
  size: number;
  /** "1 slice", "half a pie"; null: only the size is printed. */
  label: string | null;
  raw: NutritionValues;
  declared: Record<NutrientKey, DeclaredNutrient | null>;
  /** Whole percent of the reference intake per portion (energy from the kcal; fibre has none). */
  ri: Partial<Record<ReferenceIntakeKey, number>>;
}

/** A nutrition panel as a label holds it: the raw values and what is printed. */
export interface NutritionPanel {
  basis: NutritionBasis;
  raw: NutritionValues;
  /** Printed values; `fibre` is `null` when not declared. */
  declared: Record<NutrientKey, DeclaredNutrient | null>;
  /** Small amounts were declared as "0 g" rather than "<0.5 g". */
  negligibleAsZero?: boolean;
  /** `calculated`: the energy in `raw` was worked out from the macronutrients. */
  energyMethod?: EnergyMethod;
  portion?: PortionPanel | null;
}

export interface PanelOptions {
  negligibleAsZero?: boolean | undefined;
  energyMethod?: EnergyMethod | undefined;
  /** Portion size in the panel's basis unit (g or ml), with its wording. */
  portionSize?: number | null | undefined;
  portionLabel?: string | null | undefined;
}

const declareAll = (raw: NutritionValues, negligibleAsZero: boolean | undefined) =>
  Object.fromEntries(
    nutrientKeys.map((key) => {
      const value = raw[key];
      return [key, value === null ? null : roundNutrient(key, value, { negligibleAsZero })];
    }),
  ) as NutritionPanel["declared"];

/** Percent of the reference intake, to a whole percent. */
const percentRi = (value: number, key: ReferenceIntakeKey) =>
  Math.round((value / referenceIntakes[key]) * 100);

/** The values without energy extras that are none (absent, `null` or 0), so a raw panel only holds what counts. */
export function withoutEmptyExtras(values: NutritionValues): NutritionValues {
  const out: NutritionValues = { ...values };
  for (const key of energyExtraKeys) {
    if (!out[key]) delete out[key];
  }
  return out;
}

/** Raw values to a panel, rounding every nutrient for declaration. */
export function nutritionPanel(
  basis: NutritionBasis,
  rawValues: NutritionValues,
  options: PanelOptions = {},
): NutritionPanel {
  const clean = withoutEmptyExtras(rawValues);
  const raw = options.energyMethod === "calculated" ? { ...clean, ...calculateEnergy(clean) } : clean;
  const panel: NutritionPanel = {
    basis,
    raw,
    declared: declareAll(raw, options.negligibleAsZero),
    negligibleAsZero: !!options.negligibleAsZero,
    energyMethod: options.energyMethod ?? "declared",
  };
  if (options.portionSize && options.portionSize > 0) {
    const factor = options.portionSize / 100;
    const scaled = Object.fromEntries(
      nutrientKeys.map((key) => [key, raw[key] === null ? null : roundQuantity(raw[key] * factor, 6)]),
    ) as unknown as NutritionValues;
    const ri: PortionPanel["ri"] = { energy: percentRi(scaled.energyKcal, "energy") };
    for (const key of ["fat", "saturates", "carbohydrate", "sugars", "protein", "salt"] as const) {
      ri[key] = percentRi(scaled[key], key);
    }
    panel.portion = {
      size: options.portionSize,
      label: options.portionLabel?.trim() || null,
      raw: scaled,
      declared: declareAll(scaled, options.negligibleAsZero),
      ri,
    };
  } else panel.portion = null;
  return panel;
}

/**
 * The same raw values with other presentation options (negligible amounts as "0 g", a portion):
 * works for a computed and a typed-in panel alike, and keeps how the energy was worked out.
 */
export function restylePanel(
  panel: NutritionPanel,
  options: Omit<PanelOptions, "energyMethod">,
): NutritionPanel {
  return {
    ...nutritionPanel(panel.basis, panel.raw, options),
    energyMethod: panel.energyMethod ?? "declared",
  };
}

// ─── Front-of-pack traffic lights ────────────────────────────────────────────

export const trafficLightLevels = ["green", "amber", "red"] as const;
export type TrafficLightLevel = (typeof trafficLightLevels)[number];
export const trafficLightLabels: Record<TrafficLightLevel, string> = {
  green: "Low",
  amber: "Medium",
  red: "High",
};
export const trafficLightNutrients = ["fat", "saturates", "sugars", "salt"] as const;
export type TrafficLightNutrient = (typeof trafficLightNutrients)[number];

/**
 * The UK front-of-pack thresholds (Department of Health, FSA and devolved governments, "Guide to
 * creating a front of pack nutrition label for pre-packed products sold through retail outlets",
 * 2016): low at or below `low`, high above `high`, medium between, per 100 g (solid food) or per
 * 100 ml (liquids); and high for a portion above `portionHigh` g. Check them against the current
 * guidance before relying on them.
 */
export const trafficLightThresholds: Record<
  NutritionBasis,
  Record<TrafficLightNutrient, { low: number; high: number; portionHigh: number }>
> = {
  "100g": {
    fat: { low: 3, high: 17.5, portionHigh: 21 },
    saturates: { low: 1.5, high: 5, portionHigh: 6 },
    sugars: { low: 5, high: 22.5, portionHigh: 27 },
    salt: { low: 0.3, high: 1.5, portionHigh: 1.8 },
  },
  "100ml": {
    fat: { low: 1.5, high: 8.75, portionHigh: 21 },
    saturates: { low: 0.75, high: 2.5, portionHigh: 6 },
    sugars: { low: 2.5, high: 11.25, portionHigh: 13.5 },
    salt: { low: 0.3, high: 0.75, portionHigh: 1.8 },
  },
};

export interface TrafficLight {
  nutrient: TrafficLightNutrient;
  level: TrafficLightLevel;
  /** The declared amount per 100 g / ml and, with a portion, per portion (g). */
  per100: number;
  perPortion: number | null;
}

/**
 * The traffic light of fat, saturates, sugars and salt for a panel, from the declared (rounded)
 * values, so the colour agrees with what is printed. Per 100 g / ml sets green, amber or red; a
 * portion above the per-portion limit makes it red as well.
 */
export function trafficLights(panel: Pick<NutritionPanel, "basis" | "declared" | "portion">): TrafficLight[] {
  const limits = trafficLightThresholds[panel.basis];
  return trafficLightNutrients.map((nutrient) => {
    const per100 = panel.declared[nutrient]?.value ?? 0;
    const perPortion = panel.portion ? (panel.portion.declared[nutrient]?.value ?? 0) : null;
    const { low, high, portionHigh } = limits[nutrient];
    const level: TrafficLightLevel =
      per100 > high || (perPortion !== null && perPortion > portionHigh)
        ? "red"
        : per100 > low
          ? "amber"
          : "green";
    return { nutrient, level, per100, perPortion };
  });
}

export interface NutritionPanelRow {
  label: string;
  value: string;
  /** "of which" rows. */
  indent: boolean;
  /** With a portion: the value per portion. */
  portionValue?: string;
  /** With a portion: "12%" of the reference intake. */
  ri?: string;
}

/** The rows of a printed panel in the legal order: energy (kJ / kcal), fat, saturates, … salt. */
export function nutritionPanelRows(
  panel: Pick<NutritionPanel, "declared"> & { portion?: PortionPanel | null | undefined },
): NutritionPanelRow[] {
  const d = panel.declared;
  const p = panel.portion ?? null;
  const rows: NutritionPanelRow[] = [
    {
      label: "Energy",
      value: `${d.energyKj?.display ?? "—"} / ${d.energyKcal?.display ?? "—"}`,
      indent: false,
      ...(p
        ? {
            portionValue: `${p.declared.energyKj?.display ?? "—"} / ${p.declared.energyKcal?.display ?? "—"}`,
            ri: `${p.ri.energy ?? 0}%`,
          }
        : {}),
    },
  ];
  for (const key of ["fat", "saturates", "carbohydrate", "sugars", "fibre", "protein", "salt"] as const) {
    const value = d[key];
    if (key === "fibre" && !value) continue;
    rows.push({
      label: nutrientLabels[key],
      value: value?.display ?? "—",
      indent: key === "saturates" || key === "sugars",
      ...(p
        ? {
            portionValue: p.declared[key]?.display ?? "—",
            ...(key !== "fibre" ? { ri: `${p.ri[key] ?? 0}%` } : {}),
          }
        : {}),
    });
  }
  return rows;
}

// ─── The graph a label is computed from ──────────────────────────────────────

/** What the label roll-ups need to know about an item. */
export interface LabelItemFacts extends UnitBridge {
  id: string;
  code: string;
  name: string;
  type: ItemType;
  unit: UnitCode;
  allergens: readonly AllergenCode[];
  mayContain: readonly AllergenCode[];
  storage?: StorageCondition | undefined;
  shelfLifeDays?: number | null | undefined;
  /** How it is named in an ingredients list; `null`: its name. */
  declarationName: string | null;
  /** A bought-in compound ingredient's own ingredients, from its specification. */
  components: string | null;
  /** Entered nutrition; ignored for an item made in house with an approved recipe. */
  nutrition: NutritionEntry | null;
  /** Optional vitamins and minerals per 100 g / ml of the nutrition's basis (never declared). */
  micronutrients?: MicronutrientAmounts | null | undefined;
  /** What fraction of each micronutrient survives cooking this item in a recipe (see `retainedAmount`). */
  retention?: MicronutrientRetention | null | undefined;
}

export interface LabelRecipeLine {
  itemId: string;
  quantity: number;
  unit: UnitCode;
}

/** One recipe version, as the roll-ups read it. */
export interface LabelRecipeVersion {
  recipeId: string;
  recipeCode: string;
  versionId: string;
  versionNumber: number;
  outputItemId: string;
  yieldQuantity: number;
  yieldUnit: UnitCode;
  lines: readonly LabelRecipeLine[];
}

/**
 * Everything a label is computed from: every item (by id), and for each item made in house the
 * approved version of its recipe (by the item's id), which is how sub-recipes are followed.
 */
export interface LabelGraph {
  items: ReadonlyMap<string, LabelItemFacts>;
  subRecipes: ReadonlyMap<string, LabelRecipeVersion>;
}

/** The basis a product's nutrition is declared on: per 100 ml for liquids, else per 100 g. */
export const nutritionBasisFor = (unit: UnitCode): NutritionBasis =>
  unitDimension(unit) === "volume" ? "100ml" : "100g";

const zeroValues = (): NutritionValues => ({
  energyKj: 0,
  energyKcal: 0,
  fat: 0,
  saturates: 0,
  carbohydrate: 0,
  sugars: 0,
  fibre: 0,
  protein: 0,
  salt: 0,
});

const roundValues = (values: NutritionValues, decimals = 6): NutritionValues => {
  const out = Object.fromEntries(
    nutrientKeys.map((key) => [key, values[key] === null ? null : roundQuantity(values[key], decimals)]),
  ) as unknown as NutritionValues;
  for (const key of energyExtraKeys) {
    const value = values[key];
    if (value) out[key] = roundQuantity(value, decimals);
  }
  return out;
};

// ─── Nutrition roll-up ───────────────────────────────────────────────────────

export const missingNutritionReasons = ["no_nutrition", "unconvertible", "no_yield", "cycle"] as const;
export type MissingNutritionReason = (typeof missingNutritionReasons)[number];
export const missingNutritionReasonLabels: Record<MissingNutritionReason, string> = {
  no_nutrition: "No nutrition entered",
  unconvertible: "Quantity can't be converted (needs a density or unit weight)",
  no_yield: "Yield can't be converted to grams or millilitres (needs a unit weight)",
  cycle: "Recipes use each other",
};

/** An item the roll-up couldn't account for, rather than counting it as zero. */
export interface MissingNutrition {
  itemId: string;
  code: string;
  name: string;
  reason: MissingNutritionReason;
  /** Codes of the sub-recipe items it was reached through, outermost first (empty at the top). */
  path: string[];
}

export interface NutritionRollup {
  basis: NutritionBasis;
  /** True when every food line has nutrition and the yield converts. */
  complete: boolean;
  /**
   * Raw values per 100 g / ml of the finished product, concentrated (or diluted) by the yield:
   * nutrients of the ingredients ÷ what one batch makes. Partial when `complete` is false; `null`
   * when the yield can't be worked out. `fibre` is null unless every ingredient gives it.
   */
  per100: NutritionValues | null;
  missing: MissingNutrition[];
  /** Codes of items without a fibre figure (fibre is optional, so this doesn't make it incomplete). */
  fibreMissing: string[];
  /**
   * Vitamins and minerals per 100 g / ml of the finished product, after each ingredient's
   * retention factors (what cooking destroys), in each nutrient's unit. Information only: never
   * on the declared panel. It sums what the ingredients give, so with `micronutrientsMissing` it
   * is a lower bound.
   */
  micronutrients: MicronutrientAmounts;
  /** Codes of items (sub-recipes' too) that gave no vitamin or mineral figure at all. */
  micronutrientsMissing: string[];
  /** Grams of food going into the mixing bowl per batch (lines that can be weighed). */
  bowlWeightG: number;
  /** What one batch makes, in g (or ml for a per 100 ml basis); null when it can't be converted. */
  yieldInBasisUnit: number | null;
  /** Finished weight ÷ bowl weight (below 1: moisture lost in cooking); mass products only. */
  yieldFactor: number | null;
}

interface ItemMicronutrients {
  /** Per 100 of the entry's basis, retention applied; `null`: none known. */
  amounts: MicronutrientAmounts | null;
  /** Items without any figure (a sub-recipe passes on its ingredients'). */
  missing: string[];
}

type ItemNutrition =
  | { ok: true; entry: NutritionEntry; fibreMissing: string[]; micro: ItemMicronutrients }
  | { ok: false; missing: MissingNutrition[]; fibreMissing: string[] };

/** Recipe lines that go into the food: packaging on a bill of materials is left out. */
export const foodLines = (version: LabelRecipeVersion, graph: LabelGraph) =>
  version.lines.filter((line) => {
    const item = graph.items.get(line.itemId);
    return !item || isFoodItemType(item.type);
  });

const gramsOf = (line: LabelRecipeLine, item: LabelItemFacts | undefined) =>
  item ? convertQuantity(line.quantity, line.unit, "g", item) : null;

/** A cache shared by the recursive roll-ups of one computation. */
type RollupCache = Map<string, NutritionRollup>;

/** Each amount times its retention factor: what is left after the item is cooked in a recipe. */
function applyRetention(
  amounts: MicronutrientAmounts,
  retention: MicronutrientRetention | null | undefined,
): MicronutrientAmounts {
  if (!retention) return amounts;
  const out: MicronutrientAmounts = {};
  for (const key of micronutrientKeys) {
    const value = amounts[key];
    if (typeof value === "number") out[key] = retainedAmount(key, value, retention);
  }
  return out;
}

function nutritionOfItem(
  item: LabelItemFacts,
  graph: LabelGraph,
  stack: readonly string[],
  cache: RollupCache,
): ItemNutrition {
  const sub = graph.subRecipes.get(item.id);
  if (sub) {
    if (stack.includes(item.id)) {
      return {
        ok: false,
        missing: [{ itemId: item.id, code: item.code, name: item.name, reason: "cycle", path: [] }],
        fibreMissing: [],
      };
    }
    const rolled = rollUpNutritionIn(sub, graph, [...stack, item.id], cache);
    const nested = (m: MissingNutrition): MissingNutrition => ({ ...m, path: [item.code, ...m.path] });
    if (!rolled.complete || !rolled.per100) {
      return { ok: false, missing: rolled.missing.map(nested), fibreMissing: rolled.fibreMissing };
    }
    const amounts = Object.keys(rolled.micronutrients).length ? rolled.micronutrients : null;
    return {
      ok: true,
      entry: { basis: rolled.basis, values: rolled.per100 },
      fibreMissing: rolled.fibreMissing,
      micro: {
        amounts: amounts && applyRetention(amounts, item.retention),
        missing: rolled.micronutrientsMissing,
      },
    };
  }
  if (item.nutrition) {
    const amounts =
      item.micronutrients && Object.keys(item.micronutrients).length ? item.micronutrients : null;
    return {
      ok: true,
      entry: item.nutrition,
      fibreMissing: item.nutrition.values.fibre === null ? [item.code] : [],
      micro: {
        amounts: amounts && applyRetention(amounts, item.retention),
        missing: amounts ? [] : [item.code],
      },
    };
  }
  return {
    ok: false,
    missing: [{ itemId: item.id, code: item.code, name: item.name, reason: "no_nutrition", path: [] }],
    fibreMissing: [],
  };
}

function rollUpNutritionIn(
  version: LabelRecipeVersion,
  graph: LabelGraph,
  stack: readonly string[],
  cache: RollupCache,
): NutritionRollup {
  const cached = cache.get(version.versionId);
  if (cached) return cached;
  const output = graph.items.get(version.outputItemId);
  const basis = nutritionBasisFor(output?.unit ?? version.yieldUnit);
  const totals = zeroValues();
  const extraTotals: Record<EnergyExtraKey, number> = {
    polyols: 0,
    erythritol: 0,
    organicAcids: 0,
    alcohol: 0,
  };
  const microTotals: MicronutrientAmounts = {};
  const microMissing = new Set<string>();
  let fibreKnown = true;
  const missing: MissingNutrition[] = [];
  const fibreMissing = new Set<string>();
  let bowlWeightG = 0;

  for (const line of foodLines(version, graph)) {
    const item = graph.items.get(line.itemId);
    if (!item) continue;
    bowlWeightG += gramsOf(line, item) ?? 0;
    const nutrition = nutritionOfItem(item, graph, stack, cache);
    for (const code of nutrition.fibreMissing) fibreMissing.add(code);
    if (!nutrition.ok) {
      missing.push(...nutrition.missing);
      continue;
    }
    const amountInBasis = convertQuantity(
      line.quantity,
      line.unit,
      nutritionBasisUnit[nutrition.entry.basis],
      item,
    );
    if (amountInBasis === null) {
      missing.push({ itemId: item.id, code: item.code, name: item.name, reason: "unconvertible", path: [] });
      continue;
    }
    const factor = amountInBasis / 100;
    for (const key of nutrientKeys) {
      const value = nutrition.entry.values[key];
      if (key === "fibre" && value === null) fibreKnown = false;
      else totals[key] = (totals[key] ?? 0) + (value ?? 0) * factor;
    }
    for (const key of energyExtraKeys) extraTotals[key] += (nutrition.entry.values[key] ?? 0) * factor;
    for (const code of nutrition.micro.missing) microMissing.add(code);
    if (nutrition.micro.amounts) {
      for (const key of micronutrientKeys) {
        const value = nutrition.micro.amounts[key];
        if (typeof value === "number") microTotals[key] = (microTotals[key] ?? 0) + value * factor;
      }
    }
  }

  const yieldInBasisUnit = output
    ? convertQuantity(version.yieldQuantity, version.yieldUnit, nutritionBasisUnit[basis], output)
    : null;
  if (output && (yieldInBasisUnit === null || !(yieldInBasisUnit > 0))) {
    missing.push({ itemId: output.id, code: output.code, name: output.name, reason: "no_yield", path: [] });
  }
  const yieldOk = yieldInBasisUnit !== null && yieldInBasisUnit > 0;
  const per100 = yieldOk
    ? roundValues({
        ...Object.fromEntries(
          nutrientKeys.map((key) => [key, ((totals[key] ?? 0) / yieldInBasisUnit) * 100]),
        ),
        ...Object.fromEntries(
          energyExtraKeys.map((key) => [key, (extraTotals[key] / yieldInBasisUnit) * 100]),
        ),
        fibre: fibreKnown ? ((totals.fibre ?? 0) / yieldInBasisUnit) * 100 : null,
      } as NutritionValues)
    : null;
  const micronutrients: MicronutrientAmounts = {};
  if (yieldOk) {
    for (const key of micronutrientKeys) {
      const total = microTotals[key];
      if (typeof total === "number") micronutrients[key] = roundQuantity((total / yieldInBasisUnit) * 100, 6);
    }
  }
  const yieldG = output ? convertQuantity(version.yieldQuantity, version.yieldUnit, "g", output) : null;
  const result: NutritionRollup = {
    basis,
    complete: missing.length === 0 && per100 !== null,
    per100,
    missing,
    fibreMissing: [...fibreMissing],
    micronutrients,
    micronutrientsMissing: [...microMissing],
    bowlWeightG: roundQuantity(bowlWeightG),
    yieldInBasisUnit: yieldInBasisUnit === null ? null : roundQuantity(yieldInBasisUnit),
    yieldFactor: yieldG !== null && bowlWeightG > 0 ? roundQuantity(yieldG / bowlWeightG) : null,
  };
  cache.set(version.versionId, result);
  return result;
}

/**
 * Nutrition per 100 g (or 100 ml) of what a recipe version makes, from its ingredients' quantities
 * and their nutrition, following sub-recipes through their approved versions. The totals are
 * divided by the batch's yield, so moisture lost in cooking concentrates the nutrients. Items
 * without nutrition are reported in `missing`, never counted as zero.
 */
export function rollUpNutrition(version: LabelRecipeVersion, graph: LabelGraph): NutritionRollup {
  return rollUpNutritionIn(version, graph, [version.outputItemId], new Map());
}

/**
 * An item's nutrition as the labelling module sees it: computed from its recipe's approved version
 * when it is made in house, else as entered.
 */
export function itemNutrition(
  itemId: string,
  graph: LabelGraph,
): { source: NutritionSource; entry: NutritionEntry | null; rollup: NutritionRollup | null } {
  const sub = graph.subRecipes.get(itemId);
  if (sub) {
    const rollup = rollUpNutrition(sub, graph);
    return {
      source: rollup.complete ? "recipe" : "missing",
      entry: rollup.complete && rollup.per100 ? { basis: rollup.basis, values: rollup.per100 } : null,
      rollup,
    };
  }
  const item = graph.items.get(itemId);
  return item?.nutrition
    ? { source: "entered", entry: item.nutrition, rollup: null }
    : { source: "missing", entry: null, rollup: null };
}

// ─── Ingredient declaration ──────────────────────────────────────────────────

/**
 * How compound ingredients made in house (sub-recipes) are declared: `bracketed` lists the compound
 * by name with its ingredients in brackets, "Pastry (**wheat** flour, **butter**, water)";
 * `expanded` lists its ingredients among the others, by their own weight.
 */
export const compoundStyles = ["bracketed", "expanded"] as const;
export type CompoundStyle = (typeof compoundStyles)[number];
export const compoundStyleLabels: Record<CompoundStyle, string> = {
  bracketed: "Compound ingredients with their ingredients in brackets",
  expanded: "Compound ingredients expanded into the list",
};

export interface Quid {
  /** Percentage of the ingredient (see `quidFor`). */
  percent: number;
  /** "12%", or "120 g per 100 g" when the finished product weighs less than it. */
  display: string;
}

/** One ingredient of a declaration. */
export interface DeclarationEntry {
  itemId: string;
  code: string;
  /** The name as declared, allergens emphasised. */
  name: LabelSegment[];
  /**
   * Grams going into the mixing bowl, per batch of the product; null when it can't be weighed. A
   * sub-recipe's ingredient counts its ingoing weight: the sub-recipe's quantity used ÷ its yield ×
   * the ingredient's quantity in it.
   */
  weightG: number | null;
  /**
   * Added water and volatile ingredients only (see `volatileItemIds`): the weight left in the
   * finished product, which is what places the entry in the list. Absent: placed by `weightG`.
   */
  finishedG?: number;
  quid: Quid | null;
  /** A sub-recipe's ingredients (bracketed style), heaviest first. */
  components: DeclarationEntry[] | null;
  /** A bought-in compound's own ingredients, from its specification, allergens emphasised. */
  componentsText: LabelSegment[] | null;
  /** True for an ingredient made in house from another recipe. */
  compound: boolean;
}

export const labelWarningKinds = [
  "allergen_not_named",
  "unweighable",
  "quid_not_found",
  "cycle",
  "unknown_item",
  "sub_recipe_yield",
  "volatile_not_found",
  "volatile_loss_exceeds",
  "water_rule_not_applied",
] as const;
export type LabelWarningKind = (typeof labelWarningKinds)[number];

export interface LabelWarning {
  kind: LabelWarningKind;
  itemCode: string;
  message: string;
}

/** QUID (FIC Annex VIII): "12%", or grams per 100 g of product when over 100% after moisture loss. */
export function quidFor(weightG: number, bowlWeightG: number, finishedWeightG: number | null): Quid | null {
  if (!(bowlWeightG > 0)) return null;
  // Moisture lost in cooking: the percentage is of the finished product (Annex VIII point 4(a)).
  const relativeTo =
    finishedWeightG !== null && finishedWeightG > 0 && finishedWeightG < bowlWeightG
      ? finishedWeightG
      : bowlWeightG;
  const percent = (weightG / relativeTo) * 100;
  if (percent > 100) {
    return { percent: roundQuantity(percent, 1), display: `${Math.round(percent)} g per 100 g` };
  }
  const shown = percent >= 10 ? Math.round(percent) : roundQuantity(percent, 1);
  return { percent: roundQuantity(percent, 1), display: `${shown}%` };
}

interface DeclarationContext {
  graph: LabelGraph;
  quid: ReadonlySet<string>;
  bowlWeightG: number;
  finishedWeightG: number | null;
  style: CompoundStyle;
  warnings: LabelWarning[];
  /** Allergens of every food item reached, for the roll-up. */
  reached: LabelItemFacts[];
  quidFound: Set<string>;
  /** Items treated as added water or volatile (placed by weight in the finished product). */
  volatile: ReadonlySet<string>;
  volatileFound: Set<string>;
  /** Water left out of the list under the 5% rule. */
  omittedWater: OmittedWater[];
}

/**
 * Water that FIC Annex VII part A point 1(b) lets the list leave out: "the amount of water added
 * need not be taken into consideration if it does not exceed 5% by weight of the finished product".
 */
export interface OmittedWater {
  itemId: string;
  code: string;
  /** Grams in the finished product (weight at use less what evaporated, for marked items). */
  weightG: number;
  /** Percent of the finished product, to one decimal place. */
  percent: number;
}

/** Share of the finished product at or below which added water is not listed. */
export const WATER_RULE_FRACTION = 0.05;

const WATER_NAME =
  /^(?:(?:added|drinking|potable|tap|filtered|still|spring|mineral|cold|cool|warm|hot|boiling|iced?)\s+)*water$/i;
/** Whether an ingredient is added water by its name: "Water", "Cold water", "Drinking water". */
export const isWaterName = (name: string) => WATER_NAME.test(name.trim());

const nameOf = (item: LabelItemFacts) => item.declarationName?.trim() || item.name;

/**
 * Grams one batch of a sub-recipe makes, to scale its ingredients to what the parent uses: the
 * yield in grams, so the ingredients of a sauce reduced from 1000 g to 500 g count twice their
 * share in each gram of sauce used (moisture lost in the sub-recipe is not lost from its
 * ingredients' ingoing weight). Falls back to the sub-recipe's bowl weight only when the yield
 * can't be converted to grams (counted without a unit weight, a volume without a density).
 * `null` when neither is known.
 */
function subRecipeMakesG(
  sub: LabelRecipeVersion,
  graph: LabelGraph,
): { grams: number | null; fromYield: boolean } {
  const output = graph.items.get(sub.outputItemId);
  const yieldG = convertQuantity(sub.yieldQuantity, sub.yieldUnit, "g", output ?? {});
  if (yieldG !== null && yieldG > 0) return { grams: yieldG, fromYield: true };
  const bowl = foodLines(sub, graph).reduce(
    (sum, line) => sum + (gramsOf(line, graph.items.get(line.itemId)) ?? 0),
    0,
  );
  return { grams: bowl > 0 ? bowl : null, fromYield: false };
}

/**
 * Entries of one version's food lines, `scale` grams in the product per gram in this version
 * (`null` when the compound itself can't be weighed).
 */
function declarationEntries(
  version: LabelRecipeVersion,
  ctx: DeclarationContext,
  scale: number | null,
  stack: readonly string[],
): DeclarationEntry[] {
  const merged = new Map<string, { item: LabelItemFacts; weightG: number | null }>();
  for (const line of foodLines(version, ctx.graph)) {
    const item = ctx.graph.items.get(line.itemId);
    if (!item) {
      ctx.warnings.push({
        kind: "unknown_item",
        itemCode: line.itemId,
        message: "A line names an item that no longer exists",
      });
      continue;
    }
    const grams = gramsOf(line, item);
    const previous = merged.get(item.id);
    const weightG = grams === null || scale === null ? null : grams * scale;
    if (!previous) merged.set(item.id, { item, weightG });
    else previous.weightG = previous.weightG === null || weightG === null ? null : previous.weightG + weightG;
  }

  const entries: DeclarationEntry[] = [];
  for (const { item, weightG } of merged.values()) {
    ctx.reached.push(item);
    if (ctx.volatile.has(item.id)) ctx.volatileFound.add(item.id);
    if (weightG === null) {
      ctx.warnings.push({
        kind: "unweighable",
        itemCode: item.code,
        message: `${item.code} can't be weighed (needs a density or unit weight), so it is placed last`,
      });
    }
    const sub = ctx.graph.subRecipes.get(item.id);
    if (sub && stack.includes(item.id)) {
      ctx.warnings.push({ kind: "cycle", itemCode: item.code, message: `${item.code}'s recipe uses itself` });
    }
    if (sub && !stack.includes(item.id)) {
      const makes = subRecipeMakesG(sub, ctx.graph);
      if (!makes.fromYield) {
        ctx.warnings.push({
          kind: "sub_recipe_yield",
          itemCode: item.code,
          message: `${item.code}'s yield can't be converted to grams (needs a unit weight or density), so its ingredients are weighed as at its mixing bowl, ignoring any moisture lost`,
        });
      }
      const subScale = weightG !== null && makes.grams !== null ? weightG / makes.grams : null;
      const components = declarationEntries(sub, ctx, subScale, [...stack, item.id]);
      const name = emphasiseAllergens(nameOf(item), item.allergens).segments;
      if (ctx.style === "expanded") {
        entries.push(...components.map((c) => ({ ...c })));
      } else {
        entries.push({
          itemId: item.id,
          code: item.code,
          name,
          weightG,
          quid: null,
          components: sortEntries(mergeEntries(components)),
          componentsText: null,
          compound: true,
        });
      }
      continue;
    }
    entries.push(plainEntry(item, weightG, ctx));
  }
  return sortEntries(ctx.style === "expanded" ? mergeEntries(entries) : entries);
}

function plainEntry(item: LabelItemFacts, weightG: number | null, ctx: DeclarationContext): DeclarationEntry {
  const name = nameOf(item);
  const components = item.components?.trim() || null;
  let nameSegments: LabelSegment[];
  let componentsText: LabelSegment[] | null = null;
  let unnamed: AllergenCode[];
  if (components) {
    const inName = emphasiseAllergens(name, item.allergens);
    const inComponents = emphasiseAllergens(components, item.allergens);
    nameSegments = inName.segments;
    unnamed = inComponents.unnamed.filter((code) => inName.unnamed.includes(code));
    componentsText = normalizeSegments([...inComponents.segments, ...unnamedBracket(unnamed)]);
  } else {
    const emphasised = emphasiseAllergens(name, item.allergens);
    unnamed = emphasised.unnamed;
    nameSegments = normalizeSegments([...emphasised.segments, ...unnamedBracket(unnamed)]);
  }
  for (const code of unnamed) {
    ctx.warnings.push({
      kind: "allergen_not_named",
      itemCode: item.code,
      message: `${item.code} contains ${allergenNames[code].toLowerCase()}, which its declared name doesn't mention: "${allergenLabelTerms[code]}" was added; check the wording`,
    });
  }
  return {
    itemId: item.id,
    code: item.code,
    name: nameSegments,
    weightG,
    quid: null,
    components: null,
    componentsText,
    compound: false,
  };
}

/** Expanded style: the same item reached twice is one entry, its weights summed. */
function mergeEntries(entries: DeclarationEntry[]): DeclarationEntry[] {
  const out = new Map<string, DeclarationEntry>();
  for (const entry of entries) {
    const previous = out.get(entry.itemId);
    if (!previous) out.set(entry.itemId, { ...entry });
    else {
      previous.weightG =
        previous.weightG === null || entry.weightG === null ? null : previous.weightG + entry.weightG;
    }
  }
  return [...out.values()];
}

/** Heaviest first; entries that can't be weighed last; ties by code so the order is stable. */
function sortEntries(entries: DeclarationEntry[]): DeclarationEntry[] {
  const weight = (e: DeclarationEntry) => e.finishedG ?? e.weightG;
  return entries.sort((a, b) => {
    const wa = weight(a);
    const wb = weight(b);
    if (wa === null || wb === null) {
      return wa === wb ? a.code.localeCompare(b.code) : wa === null ? 1 : -1;
    }
    const diff = wb - wa;
    return Math.abs(diff) > 1e-9 ? diff : a.code.localeCompare(b.code);
  });
}

function applyQuid(entries: DeclarationEntry[], ctx: DeclarationContext) {
  for (const entry of entries) {
    if (ctx.quid.has(entry.itemId)) {
      ctx.quidFound.add(entry.itemId);
      entry.quid =
        entry.weightG === null ? null : quidFor(entry.weightG, ctx.bowlWeightG, ctx.finishedWeightG);
    }
    if (entry.components) applyQuid(entry.components, ctx);
  }
}

/**
 * Added water and volatile ingredients are listed by their weight in the finished product (FIC
 * Annex VII part A point 1: the weight at use minus what evaporated), not at the mixing bowl. The
 * moisture lost between the bowl and the finished product is taken from the ingredients marked as
 * volatile, in proportion to their weight (never below zero), wherever they are in the list;
 * everything else keeps its weight at use. Returns the grams lost beyond what they held.
 */
function applyVolatile(entries: DeclarationEntry[], ctx: DeclarationContext, lossG: number) {
  const marked: DeclarationEntry[] = [];
  const collect = (list: DeclarationEntry[]) => {
    for (const entry of list) {
      if (ctx.volatile.has(entry.itemId) && entry.weightG !== null) marked.push(entry);
      if (entry.components) collect(entry.components);
    }
  };
  collect(entries);
  for (const id of ctx.volatile) {
    if (!ctx.volatileFound.has(id)) {
      ctx.warnings.push({
        kind: "volatile_not_found",
        itemCode: ctx.graph.items.get(id)?.code ?? id,
        message: "Marked as added water or a volatile ingredient but not an ingredient of this version",
      });
    }
  }
  const total = marked.reduce((sum, e) => sum + (e.weightG ?? 0), 0);
  if (marked.length === 0 || !(total > 0)) return;
  if (lossG > total + 1e-9) {
    ctx.warnings.push({
      kind: "volatile_loss_exceeds",
      itemCode: marked[0]!.code,
      message: `The product loses ${Math.round(lossG)} g between the bowl and the pack, more than the ${Math.round(total)} g of the ingredients marked as volatile: they are placed as if nothing of them is left`,
    });
  }
  const kept = Math.max(0, 1 - lossG / total);
  for (const entry of marked) entry.finishedG = (entry.weightG ?? 0) * kept;
  const resort = (list: DeclarationEntry[]) => {
    for (const entry of list) if (entry.components) resort(entry.components);
    sortEntries(list);
  };
  resort(entries);
}

/**
 * The 5% rule: added water that is no more than 5% of the finished product is left out of the list
 * (FIC Annex VII part A point 1(b)). It applies to an ingredient named as water, anywhere in the
 * list, by its weight in the finished product when it is marked as volatile (so what evaporated is
 * already off), else by its weight at use (which can only be more than what is left, so water under
 * the limit at use is under it in the product). It needs the finished weight; without it the water
 * stays listed.
 */
function applyWaterRule(entries: DeclarationEntry[], ctx: DeclarationContext) {
  const isWater = (entry: DeclarationEntry) => {
    const item = ctx.graph.items.get(entry.itemId);
    return !!item && !entry.compound && isWaterName(nameOf(item));
  };
  const waterEntries: DeclarationEntry[] = [];
  const collect = (list: DeclarationEntry[]) => {
    for (const entry of list) {
      if (isWater(entry) && (entry.finishedG ?? entry.weightG) !== null) waterEntries.push(entry);
      if (entry.components) collect(entry.components);
    }
  };
  collect(entries);
  if (waterEntries.length === 0) return;
  if (ctx.finishedWeightG === null || !(ctx.finishedWeightG > 0)) {
    ctx.warnings.push({
      kind: "water_rule_not_applied",
      itemCode: waterEntries[0]!.code,
      message:
        "The 5% rule for added water needs the weight of the finished product, which can't be worked out (the yield needs a unit weight or density): the water stays in the list",
    });
    return;
  }
  const limit = ctx.finishedWeightG * WATER_RULE_FRACTION;
  const strip = (list: DeclarationEntry[]): DeclarationEntry[] =>
    list.filter((entry) => {
      if (entry.components) entry.components = strip(entry.components);
      if (!isWater(entry)) return true;
      const weightG = entry.finishedG ?? entry.weightG;
      if (weightG === null || weightG > limit + 1e-9) return true;
      ctx.omittedWater.push({
        itemId: entry.itemId,
        code: entry.code,
        weightG: roundQuantity(weightG, 3),
        percent: roundQuantity((weightG / ctx.finishedWeightG!) * 100, 1),
      });
      return false;
    });
  entries.splice(0, entries.length, ...strip(entries));
}

/** The declaration as text runs: "Wheat flour, Sugar (12%), Pastry (**wheat** flour, …)". */
export function declarationSegments(entries: readonly DeclarationEntry[]): LabelSegment[] {
  const out: LabelSegment[] = [];
  entries.forEach((entry, i) => {
    if (i > 0) out.push({ text: ", " });
    out.push(...entry.name);
    if (entry.quid) out.push({ text: ` (${entry.quid.display})` });
    if (entry.components?.length)
      out.push({ text: " (" }, ...declarationSegments(entry.components), { text: ")" });
    else if (entry.componentsText?.length) out.push({ text: " (" }, ...entry.componentsText, { text: ")" });
  });
  return normalizeSegments(out);
}

/** "Allergy advice: for allergens, see ingredients in bold. May contain tree nuts and peanuts." */
export function allergenStatement(contains: readonly AllergenCode[], mayContain: readonly AllergenCode[]) {
  const parts: string[] = [];
  if (contains.length) parts.push("Allergy advice: for allergens, see ingredients in bold.");
  if (mayContain.length) {
    parts.push(`May contain ${joinWithAnd(mayContain.map((code) => allergenNames[code].toLowerCase()))}.`);
  }
  return parts.join(" ");
}

// ─── Staleness ───────────────────────────────────────────────────────────────

/**
 * What a label was drafted from, to tell later whether it is out of date: the recipe version, each
 * food item reached (its allergens, its declaration wording, unless made in house its nutrition,
 * and how its quantities convert to weight), the version each sub-recipe was followed through, and
 * the output item's allergens and conversion (which turns the yield into grams or millilitres).
 *
 * `conversion` was added after the first snapshots were stored: a snapshot without it (on an item
 * or the output) is not compared on it, so older labels don't all turn stale at once; the next
 * draft or refresh records it.
 */
export interface LabelSourceSnapshot {
  recipeVersionId: string;
  items: Record<
    string,
    {
      code: string;
      allergens: string;
      nutrition: string | null;
      declaration: string;
      /** The item's unit, unit weight and density (see {@link conversionKey}). */
      conversion?: string;
    }
  >;
  subRecipes: Record<string, string>;
  output: { itemId: string; code: string; allergens: string; conversion?: string };
}

const allergenKey = (item: Pick<LabelItemFacts, "allergens" | "mayContain">) =>
  `${sortAllergens(item.allergens).join(",")}|${sortAllergens(item.mayContain).join(",")}`;
/** The declared nutrients, and the energy extras only when there are any (so older snapshots still match). */
const nutritionKey = (entry: NutritionEntry | null) =>
  entry
    ? `${entry.basis}|${nutrientKeys.map((k) => (entry.values[k] === null ? "-" : roundQuantity(entry.values[k], NUTRIENT_DECIMALS))).join("|")}${energyExtraKeys
        .filter((k) => entry.values[k])
        .map((k) => `|${k}=${roundQuantity(entry.values[k]!, NUTRIENT_DECIMALS)}`)
        .join("")}`
    : null;
const declarationKey = (item: LabelItemFacts) => `${nameOf(item)}|${item.components?.trim() ?? ""}`;
/**
 * What converts an item's quantities to weight (and a product's yield to its nutrition basis): its
 * unit, grams per each and grams per millilitre. The roll-up, the weight order, QUID and the yield
 * all depend on them.
 */
const conversionKey = (item: Pick<LabelItemFacts, "unit" | "unitWeightG" | "densityGPerMl">) =>
  `${item.unit}|${item.unitWeightG ?? "-"}|${item.densityGPerMl ?? "-"}`;

export function labelSourceSnapshot(version: LabelRecipeVersion, graph: LabelGraph): LabelSourceSnapshot {
  const items: LabelSourceSnapshot["items"] = {};
  const subRecipes: Record<string, string> = {};
  const visit = (v: LabelRecipeVersion, stack: readonly string[]) => {
    for (const line of foodLines(v, graph)) {
      const item = graph.items.get(line.itemId);
      if (!item) continue;
      const sub = graph.subRecipes.get(item.id);
      items[item.id] = {
        code: item.code,
        allergens: allergenKey(item),
        nutrition: sub ? null : nutritionKey(item.nutrition),
        declaration: declarationKey(item),
        conversion: conversionKey(item),
      };
      if (sub && !stack.includes(item.id) && !(item.id in subRecipes)) {
        subRecipes[item.id] = sub.versionId;
        visit(sub, [...stack, item.id]);
      }
    }
  };
  visit(version, [version.outputItemId]);
  const output = graph.items.get(version.outputItemId);
  return {
    recipeVersionId: version.versionId,
    items,
    subRecipes,
    output: {
      itemId: version.outputItemId,
      code: output?.code ?? "",
      allergens: output ? allergenKey(output) : "",
      ...(output ? { conversion: conversionKey(output) } : {}),
    },
  };
}

export const labelStaleKinds = [
  "recipe_version_superseded",
  "ingredients_changed",
  "sub_recipe_changed",
  "allergens_changed",
  "nutrition_changed",
  "declaration_changed",
  "conversion_changed",
] as const;
export type LabelStaleKind = (typeof labelStaleKinds)[number];
export const labelStaleKindLabels: Record<LabelStaleKind, string> = {
  recipe_version_superseded: "The recipe has a newer approved version",
  ingredients_changed: "The ingredients reached through sub-recipes have changed",
  sub_recipe_changed: "A sub-recipe has a newer approved version",
  allergens_changed: "Allergens of an ingredient (or of the product) have changed",
  nutrition_changed: "Nutrition of an ingredient has changed",
  declaration_changed: "How an ingredient is declared has changed",
  conversion_changed:
    "The unit, unit weight or density of an ingredient (or of the product) has changed, so its weight has",
};

export interface LabelStaleReason {
  kind: LabelStaleKind;
  /** The items concerned, by code (empty for `recipe_version_superseded`). */
  itemCodes: string[];
}

/**
 * Why a label drafted from `before` no longer matches `now`. Nutrition changes are left out when
 * the label declares no nutrition (`withNutrition` false). A conversion change is always reported:
 * it moves the weight order and QUID as well as the nutrition.
 */
export function compareLabelSources(
  before: LabelSourceSnapshot,
  now: LabelSourceSnapshot,
  withNutrition = true,
): LabelStaleReason[] {
  const reasons: LabelStaleReason[] = [];
  const add = (kind: LabelStaleKind, codes: string[]) => {
    if (codes.length) reasons.push({ kind, itemCodes: [...new Set(codes)].sort() });
  };
  if (before.recipeVersionId !== now.recipeVersionId) {
    reasons.push({ kind: "recipe_version_superseded", itemCodes: [] });
  }
  const ids = new Set([...Object.keys(before.items), ...Object.keys(now.items)]);
  const changedIngredients: string[] = [];
  const allergens: string[] = [];
  const nutrition: string[] = [];
  const declaration: string[] = [];
  const conversion: string[] = [];
  // Snapshots stored before conversions were recorded have no `conversion`: not compared.
  const conversionChanged = (a: { conversion?: string }, b: { conversion?: string }) =>
    a.conversion !== undefined && b.conversion !== undefined && a.conversion !== b.conversion;
  for (const id of ids) {
    const a = before.items[id];
    const b = now.items[id];
    if (!a || !b) {
      changedIngredients.push((a ?? b)!.code);
      continue;
    }
    if (a.allergens !== b.allergens) allergens.push(b.code);
    if (a.nutrition !== b.nutrition) nutrition.push(b.code);
    if (a.declaration !== b.declaration) declaration.push(b.code);
    if (conversionChanged(a, b)) conversion.push(b.code);
  }
  if (before.output.allergens !== now.output.allergens) allergens.push(now.output.code);
  if (conversionChanged(before.output, now.output)) conversion.push(now.output.code);
  const subs: string[] = [];
  for (const id of new Set([...Object.keys(before.subRecipes), ...Object.keys(now.subRecipes)])) {
    if (before.subRecipes[id] !== now.subRecipes[id])
      subs.push(now.items[id]?.code ?? before.items[id]?.code ?? id);
  }
  add("sub_recipe_changed", subs);
  add("ingredients_changed", changedIngredients);
  add("allergens_changed", allergens);
  if (withNutrition) add("nutrition_changed", nutrition);
  add("declaration_changed", declaration);
  add("conversion_changed", conversion);
  return reasons;
}

// ─── Everything a label is drafted from ──────────────────────────────────────

export interface LabelFactsOptions {
  compoundStyle?: CompoundStyle | undefined;
  /** Items whose percentage is declared (QUID): those emphasised in the product's name. */
  quidItemIds?: readonly string[] | undefined;
  /**
   * Items that are added water or volatile ingredients: listed by their weight in the finished
   * product instead of at the mixing bowl (a per-label choice).
   */
  volatileItemIds?: readonly string[] | undefined;
  /** How the panel's energy is worked out. Default: summed from the ingredients' declared energy. */
  energyMethod?: EnergyMethod | undefined;
  /** Declare negligible amounts as "0 g" rather than "<0.5 g". */
  negligibleAsZero?: boolean | undefined;
  /** Portion size in g (ml for a per 100 ml panel), for per-portion values and %RI. */
  portionSize?: number | null | undefined;
  portionLabel?: string | null | undefined;
}

export interface LabelFacts {
  recipeVersionId: string;
  compoundStyle: CompoundStyle;
  nutrition: NutritionRollup & {
    /** The rounded panel when the roll-up is complete; `null` otherwise. */
    panel: NutritionPanel | null;
    /** Front-of-pack traffic lights for the panel (UK guidance); `null` without a panel. */
    trafficLights: TrafficLight[] | null;
  };
  /** The ingredients, heaviest at the mixing bowl first. */
  ingredients: DeclarationEntry[];
  /** Added water left out of the list by the 5% rule (at most 5% of the finished product). */
  omittedWater: OmittedWater[];
  /** The ingredients list as text runs, allergens emphasised. */
  declaration: LabelSegment[];
  /** Rolled up through every level of sub-recipes (the recipes module's roll-up). */
  allergens: AllergenRollup;
  /** Against the product item's own declaration. */
  allergenMismatch: AllergenMismatch;
  /** "May contain": the roll-up's, plus the product item's own (cross-contact on site). */
  mayContain: AllergenCode[];
  allergenStatement: string;
  warnings: LabelWarning[];
  snapshot: LabelSourceSnapshot;
}

/**
 * Computes everything a label is drafted from for one recipe version: nutrition, the ingredient
 * declaration with QUID, allergens and the allergen statement, warnings, and the snapshot that
 * tells later whether the label is out of date.
 */
export function computeLabelFacts(
  version: LabelRecipeVersion,
  graph: LabelGraph,
  options: LabelFactsOptions = {},
): LabelFacts {
  const style = options.compoundStyle ?? "bracketed";
  const nutrition = rollUpNutrition(version, graph);
  const output = graph.items.get(version.outputItemId);
  const finishedWeightG = output
    ? convertQuantity(version.yieldQuantity, version.yieldUnit, "g", output)
    : null;
  const ctx: DeclarationContext = {
    graph,
    quid: new Set(options.quidItemIds ?? []),
    bowlWeightG: nutrition.bowlWeightG,
    finishedWeightG,
    style,
    warnings: [],
    reached: [],
    quidFound: new Set(),
    volatile: new Set(options.volatileItemIds ?? []),
    volatileFound: new Set(),
    omittedWater: [],
  };
  const ingredients = declarationEntries(version, ctx, 1, [version.outputItemId]);
  applyQuid(ingredients, ctx);
  if (ctx.volatile.size > 0) {
    const lossG = finishedWeightG !== null ? Math.max(0, nutrition.bowlWeightG - finishedWeightG) : 0;
    applyVolatile(ingredients, ctx, lossG);
  }
  applyWaterRule(ingredients, ctx);
  for (const id of ctx.quid) {
    if (!ctx.quidFound.has(id)) {
      ctx.warnings.push({
        kind: "quid_not_found",
        itemCode: graph.items.get(id)?.code ?? id,
        message: "Marked for a percentage (QUID) but not an ingredient of this version",
      });
    }
  }
  const allergens = rollUpAllergens(ctx.reached.map((item) => ({ item })));
  const outputFacts = output ?? { allergens: [], mayContain: [] };
  const mayContain = sortAllergens(
    [...allergens.mayContain, ...outputFacts.mayContain].filter((code) => !allergens.contains.includes(code)),
  );
  // One warning per item and kind is enough.
  const seen = new Set<string>();
  const warnings = ctx.warnings.filter((w) => {
    const key = `${w.kind}|${w.itemCode}|${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const panel =
    nutrition.complete && nutrition.per100
      ? nutritionPanel(nutrition.basis, nutrition.per100, {
          negligibleAsZero: options.negligibleAsZero,
          energyMethod: options.energyMethod,
          portionSize: options.portionSize,
          portionLabel: options.portionLabel,
        })
      : null;
  return {
    recipeVersionId: version.versionId,
    compoundStyle: style,
    nutrition: { ...nutrition, panel, trafficLights: panel ? trafficLights(panel) : null },
    ingredients,
    omittedWater: ctx.omittedWater,
    declaration: declarationSegments(ingredients),
    allergens,
    allergenMismatch: allergenMismatch(allergens, outputFacts),
    mayContain,
    allergenStatement: allergenStatement(allergens.contains, mayContain),
    warnings,
    snapshot: labelSourceSnapshot(version, graph),
  };
}

// ─── Storage and date guidance ───────────────────────────────────────────────

/** Default storage wording for a product's storage condition. */
export const storageGuidance: Record<StorageCondition, string> = {
  ambient: "Store in a cool, dry place.",
  chilled: "Keep refrigerated at 0–5°C.",
  frozen: "Keep frozen at -18°C or below. Do not refreeze once defrosted.",
};

/** Default date wording: use by for chilled food (safety), best before otherwise (quality). */
export function dateGuidance(storage: StorageCondition, shelfLifeDays: number | null | undefined) {
  const mark = storage === "chilled" ? "Use by" : "Best before";
  const life = shelfLifeDays
    ? ` Shelf life ${shelfLifeDays} day${shelfLifeDays === 1 ? "" : "s"} from production.`
    : "";
  return `${mark}: see date on pack.${life}`;
}

/** Net quantity for an item sold by count with a unit weight ("400 g", "1.5 kg"). */
export function netQuantityFor(item: Pick<LabelItemFacts, "unit" | "unitWeightG">): string | null {
  if (unitDimension(item.unit) !== "count" || !item.unitWeightG) return null;
  return item.unitWeightG >= 1000
    ? `${roundQuantity(item.unitWeightG / 1000, 3)} kg`
    : `${roundQuantity(item.unitWeightG, 1)} g`;
}

// ─── Product labels ──────────────────────────────────────────────────────────

/**
 * Document control, like recipe versions: a recipe has at most one `draft` label (the only
 * editable one) and at most one `approved` label. Approving a draft supersedes the approved one.
 * Approved and superseded labels never change; a correction is a new draft.
 */
export const productLabelStatuses = ["draft", "approved", "superseded"] as const;
export type ProductLabelStatus = (typeof productLabelStatuses)[number];
export const productLabelStatusLabels: Record<ProductLabelStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

/**
 * Where a label's nutrition panel came from: `computed` (drafted or refreshed from a complete
 * roll-up of the ingredients) or `entered` (typed in by a person, e.g. from a laboratory
 * analysis). A computed panel is only ever stored when the roll-up is complete; an entered one is
 * the person's statement, shown as such to whoever approves the label.
 */
export const labelPanelSources = ["computed", "entered"] as const;
export type LabelPanelSource = (typeof labelPanelSources)[number];
export const labelPanelSourceLabels: Record<LabelPanelSource, string> = {
  computed: "Computed from the ingredients",
  entered: "Typed in",
};

/** The name of a recipe's first label, when none is given. */
export const DEFAULT_LABEL_VARIANT = "Standard";

/**
 * Options of a label that shape its computed parts (and so are set when drafting or refreshing):
 * see `LabelFactsOptions`. The portion is also editable on a draft without a refresh.
 */
const labelOptionFields = {
  compoundStyle: z.enum(compoundStyles).optional(),
  quidItemIds: z.array(z.uuid()).max(50).optional(),
  /** False for a product exempt from the nutrition declaration. Default true. */
  includeNutrition: z.boolean().optional(),
  /** Added water and volatile ingredients, listed by their weight in the finished product. */
  volatileItemIds: z.array(z.uuid()).max(50).optional(),
  energyMethod: z.enum(energyMethods).optional(),
  negligibleAsZero: z.boolean().optional(),
  /** g (ml for a liquid), for per-portion values and %RI; `null`: none. */
  portionSize: z.number().positive().max(5000).nullable().optional(),
  portionLabel: optionalText(60).optional(),
};

export const productLabelCreateSchema = z.object({
  /** The label is drafted against the recipe's approved version. */
  recipeId: z.uuid(),
  /**
   * Which of the recipe's labels this is: a pack size, a customer's own label. Each variant is
   * drafted, approved and numbered on its own. Default `Standard`; fixed once drafted.
   */
  variant: z.string().trim().min(1).max(80).optional(),
  ...labelOptionFields,
});
export type ProductLabelCreateInput = z.infer<typeof productLabelCreateSchema>;

/** Redrafts the computed parts of a draft from current data (and the recipe's approved version). */
export const productLabelRefreshSchema = z.object(labelOptionFields);
export type ProductLabelRefreshInput = z.infer<typeof productLabelRefreshSchema>;

/** Edits the text of a draft. Computed parts can be overwritten here; refresh redrafts them. */
export const productLabelUpdateSchema = z
  .object({
    productName: z.string().trim().min(1).max(300),
    /** The ingredients list with allergens between `**` markers: "**Wheat** flour, sugar". */
    ingredients: z.string().trim().min(1).max(10_000),
    allergenStatement: optionalText(2000),
    /** `null` to declare no nutrition. Values are rounded for the panel on save. */
    nutrition: nutritionInputSchema.nullable(),
    storageInstructions: optionalText(1000),
    dateGuidance: optionalText(500),
    netQuantity: optionalText(100),
    /** The pack's barcode: an EAN-13 (or a UPC-A), checked, printed as bars on the label. Empty or `null`: none. */
    gtin: optionalGtinSchema,
    notes: optionalText(2000),
    /** Presentation of the panel, applied to its raw values at once (no refresh needed). */
    negligibleAsZero: z.boolean(),
    portionSize: z.number().positive().max(5000).nullable(),
    portionLabel: optionalText(60),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type ProductLabelUpdateInput = z.infer<typeof productLabelUpdateSchema>;

export const productLabelListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  recipeId: z.uuid().optional(),
  /** `current`: drafts and approved labels (default). */
  status: z.enum([...productLabelStatuses, "current", "all"]).default("current"),
  /** Only labels that need review (approved) or a refresh (draft). */
  stale: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ProductLabelListQuery = z.infer<typeof productLabelListQuerySchema>;

/** Options of `GET /labelling/recipes/:id/versions/:versionId` (computed, never stored). */
const itemIdList = z
  .string()
  .max(2000)
  .optional()
  .transform((v, ctx) => {
    const ids = (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      if (!z.uuid().safeParse(id).success) {
        ctx.addIssue({ code: "custom", message: `Not an item id: ${id}` });
        return z.NEVER;
      }
    }
    return ids;
  });
export const labelFactsQuerySchema = z.object({
  compoundStyle: z.enum(compoundStyles).optional(),
  /** Comma-separated item ids to declare a percentage for. */
  quid: itemIdList,
  /** Comma-separated item ids of added water and volatile ingredients. */
  volatile: itemIdList,
  energyMethod: z.enum(energyMethods).optional(),
  negligibleAsZero: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  portionSize: z.coerce.number().positive().max(5000).optional(),
  portionLabel: z.string().trim().max(60).optional(),
});
export type LabelFactsQuery = z.infer<typeof labelFactsQuerySchema>;

/** The allergen codes as their full names, for display. */
export const allergenNameList = (codes: readonly AllergenCode[]) => codes.map((code) => allergenNames[code]);

// ─── Four-eyes ───────────────────────────────────────────────────────────────

/**
 * Whether someone may approve a label: not the person who last edited it (created, edited or
 * refreshed the draft), unless they are the only member with `manage` on labels. `managerIds` are
 * the members who hold `manage`. The same rule as approving an SOP.
 */
export function canApproveProductLabel(input: {
  lastEditedBy: string | null;
  deciderId: string;
  managerIds: readonly string[];
}): boolean {
  if (input.lastEditedBy !== input.deciderId) return true;
  return input.managerIds.every((id) => id === input.deciderId);
}
