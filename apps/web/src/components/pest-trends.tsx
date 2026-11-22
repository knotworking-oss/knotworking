"use client";

import {
  pestActivityLabels,
  pestTrendGroupingLabels,
  pestTrendGroupings,
  type PestTrendGrouping,
} from "@knotworking/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useState } from "react";
import { TrendChart } from "@/components/trend-chart";
import type { PestTrends } from "@/lib/api";
import { formatShortDate } from "@/lib/format";

/**
 * Pest sightings over time: one small chart per device, area or pest (the grouping is chosen
 * here; the three are loaded together), the busiest first. A bar is one visit; a red bar is a visit
 * with moderate or high activity there.
 */
export function PestTrendsCard({ trends }: { trends: Record<PestTrendGrouping, PestTrends> }) {
  const [group, setGroup] = useState<PestTrendGrouping>("device");
  const current = trends[group];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trends</CardTitle>
        <CardDescription>
          Sightings per visit{current.from ? ` since ${formatShortDate(current.from)}` : ""}, by{" "}
          {pestTrendGroupingLabels[group].toLowerCase()}.
        </CardDescription>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={group}
          onValueChange={(v) => v && setGroup(v as PestTrendGrouping)}
          className="justify-start"
        >
          {pestTrendGroupings.map((g) => (
            <ToggleGroupItem key={g} value={g}>
              {pestTrendGroupingLabels[g]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        {current.series.length === 0 ? (
          <p className="text-sm text-muted-foreground">No findings recorded yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {current.series.map((s) => {
              const Arrow = s.direction === "up" ? ArrowUp : s.direction === "down" ? ArrowDown : ArrowRight;
              return (
                <div key={s.key} className="flex flex-col gap-1 rounded-md border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{s.label}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      {s.direction && <Arrow className="size-3" aria-label={`Last visit: ${s.direction}`} />}
                      {s.sightings} in total
                    </span>
                  </div>
                  {s.detail && <span className="truncate text-xs text-muted-foreground">{s.detail}</span>}
                  <TrendChart
                    ariaLabel={`Sightings per visit for ${s.label}`}
                    unit="sightings"
                    points={s.points.map((p) => ({
                      label: formatShortDate(p.on),
                      value: p.sightings,
                      flag: p.highest === "moderate" || p.highest === "high",
                    }))}
                  />
                  <span className="text-xs text-muted-foreground">
                    Highest: {pestActivityLabels[s.highest].toLowerCase()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
