import {
  barcodeBars,
  encodeCode128,
  encodeGs1Lot,
  isCode128Text,
  type LotBarcodeFormat,
} from "@knotworking/core";

/**
 * A lot's barcode as SVG: Code 128 of the lot code, or GS1-128 with the expiry (AI 17 or 15) and the
 * lot (AI 10). Drawn from `@knotworking/core` (no barcode library). A lot code GS1 can't carry, or
 * with characters Code 128 can't draw, falls back (GS1 to Code 128) or shows only the text.
 * Black bars on white whatever the theme: it is meant for paper and scanners.
 */
export function LotBarcode({
  lotCode,
  expiresOn,
  expiryType,
  format,
  height = 14,
}: {
  lotCode: string;
  expiresOn?: string | null;
  expiryType?: "use_by" | "best_before" | null;
  format: LotBarcodeFormat;
  /** Bar height in mm. */
  height?: number;
}) {
  const gs1 = format === "gs1-128" ? encodeGs1Lot({ lot: lotCode, expiresOn, expiryType }) : null;
  const plain = !gs1 && isCode128Text(lotCode) ? encodeCode128(lotCode) : null;
  const code = gs1 ?? plain;
  if (!code) {
    return <p className="text-xs">No barcode: this lot code has characters Code 128 can't print.</p>;
  }
  const { bars, viewBoxWidth } = barcodeBars(code);
  const human = gs1 ? gs1.human : lotCode;
  return (
    <figure className="m-0 inline-block bg-white text-black">
      <svg
        viewBox={`0 0 ${viewBoxWidth} 10`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Barcode ${human}`}
        style={{ height: `${height}mm`, width: `${Math.max(viewBoxWidth * 0.33, 30)}mm` }}
        shapeRendering="crispEdges"
      >
        <rect width={viewBoxWidth} height={10} fill="#fff" />
        {bars.map((b) => (
          <rect key={b.x} x={b.x} y={0} width={b.width} height={10} fill="#000" />
        ))}
      </svg>
      <figcaption className="mt-0.5 text-center font-mono text-[11px]">{human}</figcaption>
      {format === "gs1-128" && !gs1 && (
        <p className="text-center text-[10px]">Code 128 (lot code is not GS1-safe)</p>
      )}
    </figure>
  );
}
