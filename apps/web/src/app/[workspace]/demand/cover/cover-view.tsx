"use client";

import { addWeeks, formatWeek, units, type StockAmount } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { WeekHeading } from "@/components/demand-badges";
import type { DemandCoverageData } from "@/lib/api";
import { DemandNav } from "../demand-nav";
import { GRID_RANGES, type GridRange } from "../ranges";

const number = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
const show = (a: StockAmount) => number(a.display);

/**
 * Demand → Cover: per product, demand against what covers it, week by week. What is left at the
 * end of each week is stock now plus planned batches so far minus demand so far; a negative
 * balance is a shortfall. Stock and batch rows appear only when the viewer can read those modules.
 */
export function CoverView({
  slug,
  coverage,
  from,
  fromDate,
  thisWeek,
  weeks,
  shortOnly,
}: {
  slug: string;
  coverage: DemandCoverageData;
  from: string;
  fromDate: string;
  thisWeek: string;
  weeks: GridRange;
  shortOnly: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { stock, production } = coverage.basis;
  const go = (nextFrom: string, nextWeeks: GridRange = weeks, short = shortOnly) => {
    const params = new URLSearchParams({ from: formatWeek(nextFrom), weeks: String(nextWeeks) });
    if (short) params.set("short", "1");
    router.push(`${pathname}?${params}`);
  };
  const counted = [stock && "stock available now", production && "planned batches"].filter(Boolean);

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-col gap-2">
        <DemandNav slug={slug} current="cover" />
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Demand cover</h2>
          <p className="text-sm text-muted-foreground">
            {counted.length
              ? `Demand against ${counted.join(" and ")}, week by week (${from} onwards). What is left is shown at the end of each week; red means short.`
              : "You can't read the stock or production modules, so only demand is shown and shortfalls can't be worked out."}
          </p>
          {counted.length === 1 && (
            <p className="text-sm text-muted-foreground">
              {stock
                ? "Planned batches aren't counted: you can't read the production module."
                : "Stock isn't counted: you can't read the stock module."}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Earlier weeks"
          disabled={fromDate <= thisWeek}
          onClick={() => go(addWeeks(fromDate, -weeks) < thisWeek ? thisWeek : addWeeks(fromDate, -weeks))}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Later weeks"
          onClick={() => go(addWeeks(fromDate, weeks))}
        >
          <ChevronRight />
        </Button>
        <Button variant="outline" disabled={fromDate === thisWeek} onClick={() => go(thisWeek)}>
          This week
        </Button>
        <Select value={String(weeks)} onValueChange={(v) => go(fromDate, Number(v) as GridRange)}>
          <SelectTrigger className="w-32" aria-label="Weeks shown">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {GRID_RANGES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} weeks
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant={shortOnly ? "secondary" : "outline"}
          aria-pressed={shortOnly}
          onClick={() => go(fromDate, weeks, !shortOnly)}
        >
          Short only
        </Button>
      </div>

      {coverage.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {shortOnly ? "Nothing runs short in these weeks." : "No demand in these weeks."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-56 bg-card pl-4">Product</TableHead>
                <TableHead className="min-w-24" />
                {coverage.weeks.map((w) => (
                  <TableHead key={w.periodStart} className="text-right">
                    <WeekHeading periodStart={w.periodStart} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {coverage.rows.map((row) => {
                const lines: { label: string; cell: (p: (typeof row.periods)[number]) => React.ReactNode }[] =
                  [
                    { label: "Demand", cell: (p) => show(p.demand) },
                    ...(production
                      ? [
                          {
                            label: "Planned",
                            cell: (p: (typeof row.periods)[number]) => (p.planned ? show(p.planned) : ""),
                          },
                        ]
                      : []),
                    ...(stock || production
                      ? [
                          {
                            label: "Left",
                            cell: (p: (typeof row.periods)[number]) =>
                              p.projected ? (
                                <span className={p.status === "short" ? "font-medium text-destructive" : ""}>
                                  {show(p.projected)}
                                </span>
                              ) : null,
                          },
                        ]
                      : []),
                  ];
                return lines.map((line, i) => (
                  <TableRow key={`${row.item.id}-${line.label}`} className={i === 0 ? "border-t-2" : ""}>
                    <TableCell className="sticky left-0 z-10 bg-card pl-4">
                      {i === 0 && (
                        <>
                          <span className="font-medium">{row.item.name}</span>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            {row.item.code}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {units[row.item.unit].label}
                          </span>
                          {row.stock && (
                            <span className="block text-xs text-muted-foreground">
                              {show(row.stock)} in stock now
                            </span>
                          )}
                          {row.firstShortWeek && (
                            <Badge className="mt-1 border-transparent bg-destructive/10 text-destructive">
                              Short from {formatWeek(row.firstShortWeek)}, up to {show(row.maxShortfall)}
                            </Badge>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{line.label}</TableCell>
                    {row.periods.map((p) => (
                      <TableCell
                        key={p.periodStart}
                        className={`text-right tabular-nums ${p.status === "short" ? "bg-destructive/10" : ""}`}
                      >
                        {line.cell(p)}
                      </TableCell>
                    ))}
                  </TableRow>
                ));
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
