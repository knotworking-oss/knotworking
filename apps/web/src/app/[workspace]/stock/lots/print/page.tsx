import { lotBarcodeFormats, type LotBarcodeFormat } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import { LotBarcode } from "@/components/lot-barcode";
import { PrintPage } from "@/components/print-page";
import { getBootstrap, getStockLot } from "@/lib/api";
import { printDate } from "@/lib/print";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ ids?: string; format?: string; copies?: string }>;
};

export const metadata: Metadata = { title: "Print lot barcodes" };

const MAX_LOTS = 40;
const MAX_COPIES = 20;

/**
 * Lot labels on paper: one block per lot (and copy) with the item, lot code, expiry and a barcode
 * (Code 128 of the lot code, or GS1-128 with expiry and lot) that a scanner reads into the
 * production consumption form. `?ids=` takes lot ids separated by commas (at most 40).
 */
export default async function PrintLotBarcodesPage({ params, searchParams }: Props) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const format: LotBarcodeFormat = (lotBarcodeFormats as readonly string[]).includes(sp.format ?? "")
    ? (sp.format as LotBarcodeFormat)
    : "code128";
  const copies = Math.min(Math.max(Number.parseInt(sp.copies ?? "1", 10) || 1, 1), MAX_COPIES);
  const ids = [
    ...new Set(
      (sp.ids ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_LOTS);
  const [boot, lots] = await Promise.all([
    getBootstrap(slug),
    Promise.all(ids.map((id) => getStockLot(slug, id))),
  ]);
  const tz = boot.workspace.timeZone;

  const controls = (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border bg-background p-3">
      <input type="hidden" name="ids" value={ids.join(",")} />
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Barcode
        <select
          name="format"
          defaultValue={format}
          className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
        >
          <option value="code128">Code 128 (lot code)</option>
          <option value="gs1-128">GS1-128 (expiry and lot)</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Copies of each
        <input
          type="number"
          name="copies"
          min={1}
          max={MAX_COPIES}
          defaultValue={copies}
          className="h-9 w-20 rounded-md border bg-background px-2 text-sm text-foreground"
        />
      </label>
      <Button type="submit" variant="outline" size="sm">
        Show
      </Button>
      <p className="ml-auto max-w-xs text-xs text-muted-foreground">
        GS1-128 carries the expiry (use by or best before) and the lot number; the scan field finds the lot
        either way.
      </p>
    </form>
  );

  return (
    <PrintPage crumbs="Print lot barcodes" controls={controls}>
      {lots.length === 0 ? (
        <p>No lots chosen. Open a lot and use Print barcode, or a batch's produced lots.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {lots.flatMap((lot) =>
            Array.from({ length: copies }, (_, copy) => (
              <section
                key={`${lot.id}-${copy}`}
                className="break-inside-avoid border border-black p-2 text-[12px]"
              >
                <p className="font-semibold">{lot.item.name}</p>
                <p className="text-[11px]">
                  <span className="font-mono">{lot.item.code}</span> · lot{" "}
                  <span className="font-mono">{lot.lotCode}</span>
                </p>
                <p className="mb-1 text-[11px]">
                  {lot.expiresOn
                    ? `${lot.expiryType === "use_by" ? "Use by" : "Best before"} ${printDate(lot.expiresOn, tz)}`
                    : "No expiry date"}
                </p>
                <LotBarcode
                  lotCode={lot.lotCode}
                  expiresOn={lot.expiresOn}
                  expiryType={lot.expiryType}
                  format={format}
                />
              </section>
            )),
          )}
        </div>
      )}
    </PrintPage>
  );
}
