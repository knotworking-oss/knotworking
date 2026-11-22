import { cn } from "@knotworking/ui/lib/utils";

export interface TrendPoint {
  /** Shown under the bar and in its tooltip ("12 Oct"). */
  label: string;
  value: number;
  /** Drawn in the alert colour (a visit with moderate or high activity). */
  flag?: boolean;
}

/**
 * A small bar chart of a value over time, as plain SVG (no chart library): one bar per point in the
 * order given, the largest value labelled on the axis, flagged points in the destructive colour.
 * Colours are theme classes, so it follows light and dark. Used for pest sightings per visit.
 */
export function TrendChart({
  points,
  ariaLabel,
  unit = "",
  height = 96,
  className,
}: {
  points: readonly TrendPoint[];
  ariaLabel: string;
  /** Word after the figures in tooltips ("sightings"). */
  unit?: string;
  height?: number;
  className?: string;
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const barWidth = 22;
  const gap = 8;
  const left = 26;
  const bottom = 16;
  const width = left + points.length * (barWidth + gap);
  const plot = height - bottom - 4;
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${Math.max(width, 80)} ${height}`}
      width={Math.max(width, 80)}
      height={height}
      className={cn("max-w-full overflow-visible", className)}
    >
      <line x1={left - 4} x2={left - 4} y1={4} y2={4 + plot} className="stroke-border" />
      <line x1={left - 4} x2={Math.max(width, 80)} y1={4 + plot} y2={4 + plot} className="stroke-border" />
      <text x={left - 8} y={10} textAnchor="end" className="fill-muted-foreground text-[9px]">
        {max}
      </text>
      <text x={left - 8} y={4 + plot} textAnchor="end" className="fill-muted-foreground text-[9px]">
        0
      </text>
      {points.map((p, i) => {
        const h = p.value === 0 ? 1 : Math.max(2, (p.value / max) * plot);
        const x = left + i * (barWidth + gap);
        return (
          <g key={`${p.label}-${i}`}>
            <title>{`${p.label}: ${p.value}${unit ? ` ${unit}` : ""}`}</title>
            <rect
              x={x}
              y={4 + plot - h}
              width={barWidth}
              height={h}
              rx={2}
              className={p.flag ? "fill-destructive/80" : "fill-primary/70"}
            />
            {(points.length <= 8 || i % Math.ceil(points.length / 8) === 0) && (
              <text
                x={x + barWidth / 2}
                y={height - 3}
                textAnchor="middle"
                className="fill-muted-foreground text-[8px]"
              >
                {p.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
