"use client";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@knotworking/ui/components/chart";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

/**
 * The shadcn `chart` component (Recharts) with Knotworking's categorical series colours
 * (`--chart-1` … `--chart-5`, light and dark steps in `globals.css`). Dashboards build their
 * widgets on it; this demo is what `/design` shows.
 */
const spend = [
  { month: "Jun", ingredients: 18200, packaging: 6100 },
  { month: "Jul", ingredients: 19650, packaging: 5900 },
  { month: "Aug", ingredients: 17400, packaging: 6800 },
  { month: "Sep", ingredients: 21300, packaging: 7200 },
  { month: "Oct", ingredients: 22900, packaging: 6950 },
  { month: "Nov", ingredients: 20800, packaging: 7400 },
];

const spendConfig = {
  ingredients: { label: "Ingredients", color: "var(--chart-1)" },
  packaging: { label: "Packaging", color: "var(--chart-2)" },
} satisfies ChartConfig;

const oee = [
  { week: "W40", oee: 61 },
  { week: "W41", oee: 64 },
  { week: "W42", oee: 59 },
  { week: "W43", oee: 67 },
  { week: "W44", oee: 70 },
  { week: "W45", oee: 68 },
];

const oeeConfig = { oee: { label: "OEE %", color: "var(--chart-1)" } } satisfies ChartConfig;

export function ChartDemo() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <figure className="flex flex-col gap-2">
        <figcaption className="text-sm font-medium">Purchasing spend by month</figcaption>
        <ChartContainer config={spendConfig} className="aspect-auto h-56 w-full">
          <BarChart accessibilityLayer data={spend} barGap={2}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => `£${v / 1000}k`}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="ingredients" fill="var(--color-ingredients)" radius={[4, 4, 0, 0]} />
            <Bar dataKey="packaging" fill="var(--color-packaging)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartContainer>
      </figure>
      <figure className="flex flex-col gap-2">
        <figcaption className="text-sm font-medium">OEE by week</figcaption>
        <ChartContainer config={oeeConfig} className="aspect-auto h-56 w-full">
          <LineChart accessibilityLayer data={oee} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="week" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} width={32} domain={[0, 100]} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
            <Line dataKey="oee" type="monotone" stroke="var(--color-oee)" strokeWidth={2} dot={{ r: 4 }} />
          </LineChart>
        </ChartContainer>
      </figure>
    </div>
  );
}
