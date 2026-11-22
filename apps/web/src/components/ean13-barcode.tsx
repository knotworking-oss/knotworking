import { ean13Layout, type Ean13Layout } from "@knotworking/core";

/** Height of the bars in modules, and how far the guard bars reach into the digits (GS1 EAN-13). */
const BAR_HEIGHT = 60;
const GUARD_EXTRA = 5;
const DIGIT_SIZE = 9;

/**
 * An EAN-13 barcode as SVG: black bars on white with the quiet zones the symbol needs, the guard
 * bars longer, and the digits underneath (the first outside the left guard). Vector, so it prints
 * sharp at any size: `width` is the printed width (a CSS length); 37.29 mm is the nominal size.
 * Draws nothing but the digits when the number isn't a valid EAN-13.
 */
export function Ean13Barcode({
  gtin,
  width = "37.29mm",
  className,
}: {
  gtin: string;
  width?: string;
  className?: string | undefined;
}) {
  let layout: Ean13Layout;
  try {
    layout = ean13Layout(gtin);
  } catch {
    return <span className={className}>{gtin}</span>;
  }
  const height = BAR_HEIGHT + GUARD_EXTRA + DIGIT_SIZE;
  const textY = BAR_HEIGHT + GUARD_EXTRA + DIGIT_SIZE - 1.5;
  const q = layout.quietLeft;
  return (
    <svg
      role="img"
      aria-label={`EAN-13 barcode ${layout.gtin}`}
      viewBox={`0 0 ${layout.totalModules} ${height}`}
      style={{ width, height: "auto" }}
      className={className}
      shapeRendering="crispEdges"
    >
      <title>{`EAN-13 ${layout.gtin}`}</title>
      <rect width={layout.totalModules} height={height} fill="#fff" />
      {layout.bars.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={0}
          width={bar.width}
          height={bar.guard ? BAR_HEIGHT + GUARD_EXTRA : BAR_HEIGHT}
          fill="#000"
        />
      ))}
      <g fill="#000" fontFamily="monospace" fontSize={DIGIT_SIZE} textAnchor="middle">
        <text x={q - 5} y={textY}>
          {layout.first}
        </text>
        {[...layout.left].map((digit, i) => (
          <text key={`l${i}`} x={q + 3 + i * 7 + 3.5} y={textY}>
            {digit}
          </text>
        ))}
        {[...layout.right].map((digit, i) => (
          <text key={`r${i}`} x={q + 50 + i * 7 + 3.5} y={textY}>
            {digit}
          </text>
        ))}
      </g>
    </svg>
  );
}
