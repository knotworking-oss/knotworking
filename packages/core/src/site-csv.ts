import { parseWholeNumberText, readCsvTable, sortRowErrors, type CsvImportRowError } from "./csv-import";
import type { ScheduleFrequencyUnit } from "./haccp";
import {
  glassItemKindLabels,
  glassItemKinds,
  glassItemStatuses,
  type GlassItemKind,
  type GlassItemStatus,
  type SiteFrequency,
} from "./site";

/**
 * CSV import of the glass and brittle plastics register: one row per item. An item is identified
 * by its area and description (compared without case), so importing the same file again changes
 * nothing, and a changed quantity, location, kind or frequency updates the item. Areas are rows
 * of the asset register, named by code or by name. Shared by the API, the web app and agents.
 */

export const glassCsvColumns = [
  "area",
  "description",
  "kind",
  "quantity",
  "location",
  "checkFrequency",
  "status",
] as const;
export type GlassCsvColumn = (typeof glassCsvColumns)[number];

export const glassCsvHeaders: Record<GlassCsvColumn, readonly string[]> = {
  area: ["area", "area name", "area code", "room", "zone"],
  description: ["description", "item", "item description", "what", "name"],
  kind: ["kind", "type", "material", "item type"],
  quantity: ["quantity", "qty", "number", "count", "no"],
  location: ["location", "where", "position", "fixed to"],
  checkFrequency: [
    "check frequency",
    "frequency",
    "check every",
    "checked",
    "inspection frequency",
    "check interval",
  ],
  status: ["status", "state"],
};

export const GLASS_CSV_TEMPLATE =
  "area,description,kind,quantity,location,check frequency\r\n" +
  "Packing hall,Window on east wall,glass,2,East wall,monthly\r\n" +
  "Packing hall,Light diffuser over line 2,brittle plastic,6,Ceiling,every 3 months\r\n";

/** One row, as read. A missing column leaves an existing item's field alone; an empty cell clears the location. */
export interface GlassEntry {
  row: number;
  /** The area's code or name as written. */
  area: string;
  description: string;
  kind?: GlassItemKind | undefined;
  quantity?: number | undefined;
  location?: string | null | undefined;
  checkFrequency?: SiteFrequency | undefined;
  status?: GlassItemStatus | undefined;
}

export type GlassRowError = CsvImportRowError<GlassCsvColumn>;

export interface GlassCsvResult {
  entries: GlassEntry[];
  errors: GlassRowError[];
  rowCount: number;
  ignoredColumns: string[];
}

const kindByText = new Map<string, GlassItemKind>();
for (const kind of glassItemKinds) {
  kindByText.set(kind, kind);
  kindByText.set(kind.replace(/_/g, " "), kind);
  kindByText.set(glassItemKindLabels[kind].toLowerCase(), kind);
}
kindByText.set("plastic", "brittle_plastic");
kindByText.set("hard plastic", "brittle_plastic");
kindByText.set("perspex", "brittle_plastic");
kindByText.set("polycarbonate", "brittle_plastic");

/** The kind a cell names ("Glass", "brittle plastic", "hard plastic"), or `null`. */
export const parseGlassKindText = (text: string): GlassItemKind | null =>
  kindByText.get(text.trim().toLowerCase().replace(/[_-]+/g, " ")) ?? null;

const unitWords: Record<string, ScheduleFrequencyUnit> = {
  hour: "hour",
  hours: "hour",
  hr: "hour",
  hrs: "hour",
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  wk: "week",
  wks: "week",
  month: "month",
  months: "month",
  mo: "month",
};
const namedFrequencies: Record<string, SiteFrequency> = {
  hourly: { every: 1, unit: "hour" },
  daily: { every: 1, unit: "day" },
  weekly: { every: 1, unit: "week" },
  fortnightly: { every: 2, unit: "week" },
  monthly: { every: 1, unit: "month" },
  quarterly: { every: 3, unit: "month" },
  "six monthly": { every: 6, unit: "month" },
  biannually: { every: 6, unit: "month" },
  annually: { every: 12, unit: "month" },
  yearly: { every: 12, unit: "month" },
  annual: { every: 12, unit: "month" },
};
const FREQUENCY_MAX = 1000;

/**
 * A check frequency as people write it: `monthly`, `weekly`, `quarterly`, `annually`, `every 2
 * weeks`, `3 months`, `every day`. `null` for anything else.
 */
export function parseFrequencyText(text: string): SiteFrequency | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/-/g, " ");
  const named = namedFrequencies[value];
  if (named) return named;
  const m = /^(?:every )?(\d+|a|an|one)? ?([a-z]+)$/.exec(value);
  if (!m) return null;
  const unit = unitWords[m[2]!];
  if (!unit) return null;
  const every = m[1] === undefined || m[1] === "a" || m[1] === "an" || m[1] === "one" ? 1 : Number(m[1]);
  // "every month" is allowed; a bare "months" is not a frequency.
  if (m[1] === undefined && !value.startsWith("every ")) return null;
  return every >= 1 && every <= FREQUENCY_MAX ? { every, unit } : null;
}

export const GLASS_FREQUENCY_HELP = "Use monthly, weekly, quarterly, annually, or e.g. every 2 weeks";

/**
 * Reads a glass register CSV. Columns (any order, names from `glassCsvHeaders`): `area` and
 * `description` are required; optional: `kind` (glass, brittle plastic, ceramic, other; new items
 * default to glass), `quantity` (default 1), `location`, `check frequency` (default monthly) and
 * `status` (`active` or `removed`).
 */
export function parseGlassCsv(text: string): GlassCsvResult {
  const table = readCsvTable<GlassCsvColumn>(text, {
    columns: glassCsvHeaders,
    required: ["area", "description"],
    template: GLASS_CSV_TEMPLATE.split("\r\n")[0]!,
  });
  const errors: GlassRowError[] = [...table.errors];
  const entries: GlassEntry[] = [];
  const firstRowOf = new Map<string, number>();

  for (const r of table.rows) {
    const row = r.row;
    const before = errors.length;
    const fail = (column: GlassCsvColumn, message: string) => errors.push({ row, column, message });

    const area = r.cell("area") ?? "";
    const description = r.cell("description") ?? "";
    if (!area) fail("area", "The row needs an area (its code or name)");
    if (!description) fail("description", "The row needs a description");
    else if (description.length > 300) fail("description", "The description is longer than 300 characters");
    const entry: GlassEntry = { row, area, description };

    const identity = `${area.toLowerCase()}\n${description.toLowerCase()}`;
    if (area && description) {
      const seen = firstRowOf.get(identity);
      if (seen !== undefined) fail("description", `This item is already on row ${seen}`);
      else firstRowOf.set(identity, row);
    }

    const kind = r.cell("kind");
    if (kind) {
      const parsed = parseGlassKindText(kind);
      if (!parsed) {
        fail(
          "kind",
          `"${kind}" is not a kind. Use ${glassItemKinds.map((k) => k.replace(/_/g, " ")).join(", ")}`,
        );
      } else entry.kind = parsed;
    }

    const quantity = r.cell("quantity");
    if (quantity) {
      const n = parseWholeNumberText(quantity);
      if (n === null || n < 1 || n > 10_000)
        fail("quantity", `"${quantity}" is not a whole number from 1 to 10,000`);
      else entry.quantity = n;
    }

    const location = r.cell("location");
    if (location !== undefined) {
      if (location.length > 200) fail("location", "The location is longer than 200 characters");
      else entry.location = location || null;
    }

    const frequency = r.cell("checkFrequency");
    if (frequency) {
      const parsed = parseFrequencyText(frequency);
      if (!parsed) fail("checkFrequency", `"${frequency}" is not a frequency. ${GLASS_FREQUENCY_HELP}`);
      else entry.checkFrequency = parsed;
    }

    const status = r.cell("status");
    if (status) {
      const value = status.toLowerCase();
      if (!(glassItemStatuses as readonly string[]).includes(value)) {
        fail("status", `"${status}" is not a status. Use active or removed`);
      } else entry.status = value as GlassItemStatus;
    }

    if (errors.length === before) entries.push(entry);
  }
  return {
    entries,
    errors: sortRowErrors(errors),
    rowCount: table.rowCount,
    ignoredColumns: table.ignoredColumns,
  };
}
