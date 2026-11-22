import { barcodeBars, encodeGs1Sscc } from "@knotworking/core";
/** Logistics SSCC in GS1-128: AI 00, FNC1 and quiet zones, at a 0.5 mm module and 32 mm bar height. */
export function SsccBarcode({ sscc }: { sscc: string }) {
  const code = encodeGs1Sscc(sscc);
  if (!code) return null;
  const { bars, viewBoxWidth } = barcodeBars(code);
  return (
    <figure className="inline-block bg-white p-2 text-black">
      <svg
        role="img"
        aria-label={`GS1-128 SSCC ${sscc}`}
        viewBox={`0 0 ${viewBoxWidth} 32`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        style={{ width: `${viewBoxWidth * 0.5}mm`, height: "32mm" }}
      >
        <rect width={viewBoxWidth} height={32} fill="#fff" />
        {bars.map((b) => (
          <rect key={b.x} x={b.x} y={0} width={b.width} height={32} fill="#000" />
        ))}
      </svg>
      <figcaption className="text-center font-mono text-xs">{code.human}</figcaption>
    </figure>
  );
}
