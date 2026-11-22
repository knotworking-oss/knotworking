"use client";

import { formatAnalyteLimit } from "@knotworking/core";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
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
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { TestOutcomeBadge } from "@/components/testing-badges";
import type { TestTrend } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

const ALL = "all";

/** Testing → trends: one analyte's results over time, optionally in one zone, with totals. */
export function TrendView({
  slug,
  analytes,
  zones,
  analyte,
  zone,
  trend,
}: {
  slug: string;
  analytes: string[];
  zones: string[];
  analyte: string | undefined;
  zone: string | undefined;
  trend: TestTrend | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const timeZone = useWorkspaceTimeZone();
  const go = (next: { analyte?: string | undefined; zone?: string | undefined }) => {
    const params = new URLSearchParams();
    const a = "analyte" in next ? next.analyte : analyte;
    const z = "zone" in next ? next.zone : zone;
    if (a) params.set("analyte", a);
    if (z) params.set("zone", z);
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  };
  if (analytes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        No results yet. Trends appear once samples have results.
      </p>
    );
  }
  const s = trend?.summary;
  const tiles = s
    ? [
        { label: "Results", value: String(s.results) },
        {
          label: "Failed",
          value: `${s.fails}${s.failRate != null ? ` (${Math.round(s.failRate * 100)}%)` : ""}`,
        },
        { label: "Mean", value: s.mean != null ? String(s.mean) : "—" },
        { label: "Range", value: s.min != null ? `${s.min}–${s.max}` : "—" },
      ]
    : [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={analyte} onValueChange={(v) => go({ analyte: v })}>
          <SelectTrigger className="w-64" aria-label="Analyte">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {analytes.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {zones.length > 0 && (
          <Select value={zone ?? ALL} onValueChange={(v) => go({ zone: v === ALL ? undefined : v })}>
            <SelectTrigger className="w-56" aria-label="Zone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>Every zone and lot</SelectItem>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm font-normal text-muted-foreground">{t.label}</CardTitle>
            </CardHeader>
            <CardContent className="px-4 text-2xl font-semibold tabular-nums">{t.value}</CardContent>
          </Card>
        ))}
      </div>
      {trend && trend.points.length > 0 && (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Sampled</TableHead>
                <TableHead>Sample</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Limit</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="pr-4">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...trend.points].reverse().map((p) => (
                <TableRow key={`${p.sampleId}-${p.name}`}>
                  <TableCell className="pl-4">{formatLongDate(p.sampledOn, timeZone)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/${slug}/testing/samples/${p.sampleId}`} className="hover:underline">
                      {p.reference}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {p.lotCode
                      ? `Lot ${p.lotCode} · ${p.itemCode}`
                      : `${p.pointCode}${p.zone ? ` · ${p.zone}` : ""}`}
                  </TableCell>
                  <TableCell>{formatAnalyteLimit(p)}</TableCell>
                  <TableCell className="tabular-nums">
                    {p.value != null ? `${p.value}${p.unit ? ` ${p.unit}` : ""}` : (p.valueText ?? "—")}
                  </TableCell>
                  <TableCell className="pr-4">
                    <TestOutcomeBadge outcome={p.outcome} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {trend?.truncated && (
        <p className="text-sm text-muted-foreground">Only the first 1,000 results are shown.</p>
      )}
    </div>
  );
}
