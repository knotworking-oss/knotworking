import {
  nutritionBasisLabels,
  nutritionPanelRows,
  trafficLightLabels,
  type LabelSegment,
  type NutritionPanel,
  type TrafficLight,
} from "@knotworking/core";
import { Fragment } from "react";
import { Ean13Barcode } from "./ean13-barcode";

/** Label text runs, with allergens (`emphasis`) in bold. */
export function LabelText({ segments }: { segments: readonly LabelSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.emphasis ? (
          <strong key={i} className="font-bold">
            {s.text}
          </strong>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}

type PanelView = Pick<NutritionPanel, "basis" | "declared"> & { portion?: NutritionPanel["portion"] };

/**
 * The nutrition declaration as printed: rounded values, "of which" rows indented, and with a
 * portion size a per-portion column and the % of the reference intake.
 */
export function NutritionTable({ panel }: { panel: PanelView }) {
  const portion = panel.portion ?? null;
  const unit = panel.basis === "100ml" ? "ml" : "g";
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-foreground/40">
          <th className="py-1 pr-4 text-left font-semibold">Typical values</th>
          <th className="py-1 text-right font-semibold">{nutritionBasisLabels[panel.basis]}</th>
          {portion && (
            <th className="py-1 pl-3 text-right font-semibold">
              Per {portion.label ? `${portion.label} ` : ""}({portion.size} {unit})
            </th>
          )}
          {portion && <th className="py-1 pl-3 text-right font-semibold">% RI*</th>}
        </tr>
      </thead>
      <tbody>
        {nutritionPanelRows(panel).map((row) => (
          <tr key={row.label} className="border-b border-foreground/15 last:border-b-0">
            <td className={`py-1 pr-4 ${row.indent ? "pl-4" : ""}`}>{row.label}</td>
            <td className="py-1 text-right tabular-nums">{row.value}</td>
            {portion && <td className="py-1 pl-3 text-right tabular-nums">{row.portionValue}</td>}
            {portion && <td className="py-1 pl-3 text-right tabular-nums">{row.ri ?? ""}</td>}
          </tr>
        ))}
      </tbody>
      {portion && (
        <tfoot>
          <tr>
            <td colSpan={4} className="pt-1 text-xs text-muted-foreground">
              * Reference intake of an average adult (8400 kJ / 2000 kcal)
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}

const lightColours = {
  green: "bg-status-completed/20 border-status-completed",
  amber: "bg-priority-medium/20 border-priority-medium",
  red: "bg-priority-urgent/20 border-priority-urgent",
} as const;

/** UK front-of-pack traffic lights (low, medium or high), per 100 g and per portion. */
export function TrafficLights({ lights }: { lights: readonly TrafficLight[] }) {
  const names = { fat: "Fat", saturates: "Saturates", sugars: "Sugars", salt: "Salt" } as const;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {lights.map((l) => (
        <li key={l.nutrient} className={`rounded-md border px-2 py-1.5 text-center ${lightColours[l.level]}`}>
          <p className="text-xs">{names[l.nutrient]}</p>
          <p className="font-semibold tabular-nums">{l.perPortion ?? l.per100} g</p>
          <p className="text-xs">{trafficLightLabels[l.level]}</p>
        </li>
      ))}
    </ul>
  );
}

export interface LabelPreviewContent {
  productName: string;
  ingredients: readonly LabelSegment[];
  allergenStatement: string | null;
  includeNutrition: boolean;
  nutrition: PanelView | null;
  storageInstructions: string | null;
  dateGuidance: string | null;
  netQuantity: string | null;
  /** The pack's EAN-13, drawn as a barcode when there is one. */
  gtin?: string | null | undefined;
}

/**
 * A product label laid out as it reads on pack: name and net quantity, ingredients with allergens
 * in bold, the allergen statement, the nutrition table, storage and date wording. A preview of the
 * text, not artwork.
 */
export function LabelPreview({
  label,
  watermark,
}: {
  label: LabelPreviewContent;
  /** Printed across the label, e.g. `DRAFT`: a preview that can never be approved. */
  watermark?: string | null | undefined;
}) {
  return (
    <div className="relative flex flex-col gap-3 overflow-hidden rounded-md border-2 border-foreground/70 bg-background p-4 text-sm text-foreground">
      {watermark && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-7xl font-black tracking-widest text-foreground/10 uppercase select-none"
          style={{ transform: "rotate(-20deg)" }}
        >
          {watermark}
        </span>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-base font-semibold">{label.productName}</p>
        {label.netQuantity && <p className="font-semibold">{label.netQuantity} ℮</p>}
      </div>
      <p>
        <span className="font-semibold">Ingredients: </span>
        {label.ingredients.length ? <LabelText segments={label.ingredients} /> : "—"}
      </p>
      {label.allergenStatement && <p>{label.allergenStatement}</p>}
      {label.includeNutrition &&
        (label.nutrition ? (
          <NutritionTable panel={label.nutrition} />
        ) : (
          <p className="rounded border border-dashed px-3 py-2 text-muted-foreground">
            Nutrition panel incomplete
          </p>
        ))}
      {label.storageInstructions && <p>{label.storageInstructions}</p>}
      {label.dateGuidance && <p>{label.dateGuidance}</p>}
      {label.gtin && (
        <div className="self-start bg-white p-1">
          <Ean13Barcode gtin={label.gtin} />
        </div>
      )}
    </div>
  );
}
