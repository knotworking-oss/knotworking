"use client";

import { useWorkspaceToday } from "@/lib/workspace-time";
import { addWeeks, batchesToCover, formatWeek, roundQuantity, units, weekStart } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ChevronLeft, ChevronRight, Factory } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { WeekHeading, weekLabel } from "@/components/demand-badges";
import { GapBadge, PlanIssueBadge } from "@/components/production-badges";
import { formatAmount } from "@/components/stock-badges";
import type { PlanFromDemand } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { PLAN_RANGES, type PlanRange } from "./ranges";

type Row = PlanFromDemand["rows"][number];
type Option = Row["options"][number];

const cellKey = (itemId: string, periodStart: string) => `${itemId}@${periodStart}`;
const formatNumber = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A batch count as typed: a positive number (at most 4 decimals), `0` for blank, `null` if invalid. */
function parseCount(text: string): number | null {
  const value = text.trim();
  if (value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && roundQuantity(n) === n ? n : null;
}

/**
 * Production → plan from demand. One row per product with demand, one column per ISO week: the
 * demand, what batches planned in that week already cover, and the gap. Where the product has
 * one usable recipe (or the person picks one), each week offers whole batches that cover the gap;
 * counts and planned dates (default: the week's Monday) can be changed, and the selected batches
 * are created together (`POST /production/plan-from-demand`).
 */
export function PlanFromDemandGrid({
  slug,
  plan,
  from,
  weeks,
}: {
  slug: string;
  plan: PlanFromDemand;
  from: string;
  weeks: PlanRange;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("production", "write");
  const canSeeRecipes = can("recipes", "read");
  /** Item id → the chosen recipe id, where the server could not pick one. */
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [dates, setDates] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const busy = saving || refreshing;
  const thisWeek = weekStart(useWorkspaceToday());

  function go(nextFrom: string, nextWeeks: PlanRange = weeks) {
    const params = new URLSearchParams({ from: formatWeek(nextFrom), weeks: String(nextWeeks) });
    router.push(`${pathname}?${params}`);
  }

  const recipeOf = (row: Row): Option | null =>
    row.recipe ?? row.options.find((o) => o.id === choices[row.item.id]) ?? null;

  /** The batches each cell would create: the person's count, else whole batches covering the gap. */
  const proposed = useMemo(() => {
    const out: {
      key: string;
      row: Row;
      recipe: Option;
      periodStart: string;
      text: string;
      count: number | null;
    }[] = [];
    for (const row of plan.rows) {
      const recipe = row.recipe ?? row.options.find((o) => o.id === choices[row.item.id]) ?? null;
      if (!recipe?.perBatch) continue;
      for (const cell of row.cells) {
        const key = cellKey(row.item.id, cell.periodStart);
        const suggested = batchesToCover(cell.gap.base, recipe.perBatch.base);
        const text = counts[key] ?? (suggested ? String(suggested) : "");
        out.push({ key, row, recipe, periodStart: cell.periodStart, text, count: parseCount(text) });
      }
    }
    return out;
  }, [plan, choices, counts]);
  const byKey = new Map(proposed.map((p) => [p.key, p]));
  const toCreate = proposed.filter((p) => p.count !== null && p.count > 0);
  const invalid = proposed.filter((p) => p.count === null);
  const dateOf = (p: { key: string; periodStart: string }) => dates[p.key] ?? p.periodStart;
  const selected = toCreate.filter((p) => !skipped.has(p.key));
  const badDates = selected.filter((p) => !ISO_DATE.test(dateOf(p)));

  function setCount(key: string, text: string) {
    setCounts((c) => ({ ...c, [key]: text }));
  }

  function toggle(key: string, on: boolean) {
    setSkipped((s) => {
      const next = new Set(s);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function create() {
    if (selected.length === 0 || invalid.length > 0 || badDates.length > 0) return;
    setSaving(true);
    try {
      const { batches } = await unwrap(
        browserApi().v1.workspaces[":slug"].production["plan-from-demand"].$post({
          param: { slug },
          json: {
            batches: selected.map((p) => ({
              recipeId: p.recipe.id,
              plannedOn: dateOf(p),
              batches: p.count!,
            })),
          },
        }),
      );
      toast.success(`${batches.length} batch${batches.length === 1 ? "" : "es"} planned`);
      setCounts({});
      setDates({});
      setSkipped(new Set());
      startRefresh(() => router.refresh());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const gaps = plan.rows.filter((r) => r.totals.gap.base > 0).length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Plan batches from demand</h2>
        <Button variant="outline" asChild>
          <Link href={`/${slug}/demand?from=${formatWeek(from)}&weeks=${weeks}`}>Edit demand</Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Earlier weeks"
          onClick={() => go(addWeeks(from, -weeks))}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Later weeks"
          onClick={() => go(addWeeks(from, weeks))}
        >
          <ChevronRight />
        </Button>
        <Button variant="outline" disabled={from === thisWeek} onClick={() => go(thisWeek)}>
          This week
        </Button>
        <Select value={String(weeks)} onValueChange={(v) => go(from, Number(v) as PlanRange)}>
          <SelectTrigger className="w-32" aria-label="Weeks shown">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PLAN_RANGES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} weeks
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {plan.weeks[0]?.week} to {plan.weeks.at(-1)?.week}
          {plan.rows.length > 0 &&
            ` · ${plan.rows.length} product${plan.rows.length === 1 ? "" : "s"} with demand, ${gaps ? `${gaps} not fully planned` : "all planned"}`}
        </span>
      </div>

      {plan.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No demand in these weeks.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-64 bg-card pl-4">Product and recipe</TableHead>
                {plan.weeks.map((w) => (
                  <TableHead
                    key={w.periodStart}
                    className={`min-w-32 text-right ${w.periodStart === thisWeek ? "text-foreground" : ""}`}
                  >
                    <WeekHeading periodStart={w.periodStart} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.rows.map((row) => {
                const recipe = recipeOf(row);
                return (
                  <TableRow key={row.item.id} className="align-top">
                    <TableCell className="sticky left-0 z-10 bg-card pl-4 whitespace-normal">
                      <div className="flex flex-col gap-1.5">
                        <div>
                          <span className="font-medium">{row.item.name}</span>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            {row.item.code}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {units[row.item.unit].label}
                          </span>
                        </div>
                        {row.options.length > 1 && !row.recipe ? (
                          <Select
                            value={choices[row.item.id] ?? ""}
                            onValueChange={(id) => setChoices((c) => ({ ...c, [row.item.id]: id }))}
                            disabled={busy}
                          >
                            <SelectTrigger
                              size="sm"
                              className="w-full"
                              aria-label={`Recipe for ${row.item.code}`}
                            >
                              <SelectValue placeholder="Choose a recipe…" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {row.options.map((o) => (
                                  <SelectItem key={o.id} value={o.id}>
                                    {o.name}
                                    <span className="text-xs text-muted-foreground">
                                      {" "}
                                      · {o.code} v{o.version?.versionNumber}
                                      {o.perBatch && ` · ${formatAmount(o.perBatch)} a batch`}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        ) : recipe ? (
                          <span className="text-xs text-muted-foreground">
                            {canSeeRecipes ? (
                              <Link href={`/${slug}/recipes/${recipe.id}`} className="hover:underline">
                                {recipe.code}
                              </Link>
                            ) : (
                              recipe.code
                            )}{" "}
                            v{recipe.version?.versionNumber}
                            {recipe.perBatch && ` · ${formatAmount(recipe.perBatch)} a batch`}
                          </span>
                        ) : null}
                        {row.issue && !(row.issue === "choose_recipe" && recipe) && (
                          <div>
                            <PlanIssueBadge issue={row.issue} />
                          </div>
                        )}
                        {(row.issue === "no_recipe" || row.issue === "no_approved_version") &&
                          canSeeRecipes && (
                            <Link
                              href={`/${slug}/recipes`}
                              className="text-xs text-muted-foreground hover:underline"
                            >
                              Go to recipes
                            </Link>
                          )}
                      </div>
                    </TableCell>
                    {row.cells.map((cell) => {
                      const key = cellKey(row.item.id, cell.periodStart);
                      const p = byKey.get(key);
                      const hasDemand = cell.demand.base > 0 || cell.batches.length > 0;
                      return (
                        <TableCell key={cell.periodStart} className="text-right">
                          {hasDemand ? (
                            <div className="flex flex-col items-end gap-1 text-xs">
                              <span>
                                <span className="text-muted-foreground">Demand </span>
                                <span className="tabular-nums">{formatAmount(cell.demand)}</span>
                              </span>
                              <span
                                title={cell.batches
                                  .map((b) => `${b.batchCode} (${b.plannedOn}): ${formatAmount(b.planned)}`)
                                  .join("\n")}
                              >
                                <span className="text-muted-foreground">Planned </span>
                                <span className="tabular-nums">{formatAmount(cell.planned)}</span>
                              </span>
                              <GapBadge gap={cell.gap} />
                              {p && canWrite && (
                                <label className="flex items-center gap-1 text-muted-foreground">
                                  <Input
                                    className={`h-7 w-14 text-right tabular-nums ${key in counts ? "bg-label-yellow-bg" : ""} ${p.count === null ? "border-destructive" : ""}`}
                                    inputMode="decimal"
                                    aria-label={`Batches of ${row.item.code} in ${formatWeek(cell.periodStart)}`}
                                    value={p.text}
                                    disabled={busy}
                                    onChange={(e) => setCount(key, e.target.value)}
                                  />
                                  ×
                                </label>
                              )}
                              {p && !canWrite && p.count ? (
                                <span className="text-muted-foreground tabular-nums">
                                  Suggest {p.count} ×
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {canWrite && plan.rows.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 className="font-medium">Batches to create</h3>
            <Button
              onClick={() => void create()}
              disabled={busy || selected.length === 0 || invalid.length > 0 || badDates.length > 0}
            >
              {busy ? <Spinner data-icon="inline-start" /> : <Factory data-icon="inline-start" />}
              Create {selected.length} batch{selected.length === 1 ? "" : "es"}
            </Button>
          </div>
          {invalid.length > 0 && (
            <p className="text-sm text-destructive">
              Batch counts must be numbers of at least 0 with up to 4 decimal places.
            </p>
          )}
          {toCreate.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to plan: every week with demand is covered, or its product needs a recipe first.
            </p>
          ) : (
            <Card className="overflow-x-auto py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 pl-4">
                      <span className="sr-only">Create</span>
                    </TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Recipe</TableHead>
                    <TableHead>Week</TableHead>
                    <TableHead className="text-right">Batches</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                    <TableHead className="pr-4">Planned on</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {toCreate.map((p) => {
                    const on = !skipped.has(p.key);
                    const date = dateOf(p);
                    return (
                      <TableRow key={p.key} className={on ? "" : "text-muted-foreground"}>
                        <TableCell className="pl-4">
                          <Checkbox
                            checked={on}
                            disabled={busy}
                            aria-label={`Create ${p.row.item.code} in ${formatWeek(p.periodStart)}`}
                            onCheckedChange={(v) => toggle(p.key, v === true)}
                          />
                        </TableCell>
                        <TableCell>
                          {p.row.item.name}{" "}
                          <span className="font-mono text-xs text-muted-foreground">{p.row.item.code}</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.recipe.code} v{p.recipe.version?.versionNumber}
                        </TableCell>
                        <TableCell>{weekLabel(p.periodStart)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(p.count!)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatAmount({
                            display: roundQuantity(p.recipe.perBatch!.display * p.count!),
                            displayUnit: p.recipe.perBatch!.displayUnit,
                          })}
                        </TableCell>
                        <TableCell className="pr-4">
                          <Input
                            type="date"
                            className={`h-8 w-40 ${ISO_DATE.test(date) ? "" : "border-destructive"}`}
                            aria-label={`Planned date for ${p.row.item.code} in ${formatWeek(p.periodStart)}`}
                            value={date}
                            disabled={busy || !on}
                            onChange={(e) => setDates((d) => ({ ...d, [p.key]: e.target.value }))}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
