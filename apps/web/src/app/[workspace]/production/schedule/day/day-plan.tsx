"use client";

import { addDays, allergens as allergenInfo, minutesToClock, type AllergenCode } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
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
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { BatchStatusBadge } from "@/components/production-badges";
import { formatAmount } from "@/components/stock-badges";
import type { ProductionDayPlan } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
const allergenName = (code: AllergenCode) => allergenInfo[code] ?? code;
const clock = (m: number | null) => (m === null ? "–" : minutesToClock(m));

/**
 * Production → Day plan: one line on one day, timed against its shifts with each changeover and
 * allergen clean-down explained, and a proposed order with its reasons. Nothing changes until
 * someone saves an order.
 */
export function DayPlanView({
  slug,
  date,
  lines,
  plan,
}: {
  slug: string;
  date: string;
  lines: { id: string; name: string; active: boolean }[];
  plan: ProductionDayPlan | null;
}) {
  const router = useRouter();
  const canWrite = useWorkspace().can("production", "write");
  const base = `/${slug}/production`;
  const lineId = plan?.line.id ?? "";
  const go = (next: { line?: string; date?: string }) =>
    router.push(`${base}/schedule/day?line=${next.line ?? lineId}&date=${next.date ?? date}`);
  const current = plan?.steps.map((s) => s.batchId) ?? [];
  // An unsaved reorder belongs to one line, day and server order. When the plan changes underneath
  // it (sync refresh, another day or line), the draft no longer applies and the server order shows.
  const planKey = `${lineId}|${date}|${current.join(",")}`;
  const [draft, setDraft] = useState<{ key: string; ids: string[] } | null>(null);
  const [pending, setPending] = useState(false);
  const order = draft?.key === planKey ? draft.ids : current;

  if (!plan) {
    return (
      <p className="mx-auto max-w-5xl px-6 py-8 text-sm text-muted-foreground">
        No production lines yet. Add one under Production → Lines.
      </p>
    );
  }
  const reordered = order.some((id, i) => id !== current[i]);
  const stepOf = new Map(plan.steps.map((s) => [s.batchId, s]));

  async function save(batchIds: string[]) {
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].production.schedule.sequence.$put({
          param: { slug },
          json: { lineId, date, batchIds, expectedBatchIds: current },
        }),
      );
      setDraft(null);
      toast.success("Order saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  const move = (i: number, by: number) => {
    const next = [...order];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setDraft({ key: planKey, ids: next });
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous day"
            onClick={() => go({ date: addDays(date, -1) })}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next day"
            onClick={() => go({ date: addDays(date, 1) })}
          >
            <ChevronRight />
          </Button>
          <h2 className="text-lg font-semibold tracking-tight">{dayLabel(date)}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            aria-label="Date"
            className="w-40"
            value={date}
            onChange={(e) => e.target.value && go({ date: e.target.value })}
          />
          <Select value={lineId} onValueChange={(v) => go({ line: v })}>
            <SelectTrigger aria-label="Line" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {lines.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                    {!l.active && " (inactive)"}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" asChild>
            <Link href={`${base}/schedule?from=${date}`}>Line schedule</Link>
          </Button>
        </div>
      </div>

      {plan.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-destructive">
          {plan.warnings.map((w) => (
            <li key={w} className="flex items-center gap-2">
              <TriangleAlert className="size-4 shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label={plan.timing === "shifts" ? "Shifts" : plan.timing === "day_off" ? "Day off" : "Hours a day"}
          value={
            plan.windows.length ? plan.windows.map((w) => `${w.startClock}–${w.endClock}`).join(", ") : "None"
          }
        />
        <Stat label="Capacity" value={`${Math.round((plan.capacityMinutes / 60) * 100) / 100} h`} />
        <Stat label="Run time" value={`${Math.round((plan.runMinutes / 60) * 100) / 100} h`} />
        <Stat
          label="Changeovers"
          value={`${plan.changeoverMinutes} min, ${plan.cleanDowns} clean-down${plan.cleanDowns === 1 ? "" : "s"}`}
        />
        <Stat label="Ends" value={plan.endClock ?? "–"} warn={plan.overrunMinutes > 0} />
        <Stat label="Labour" value={`${plan.labourHours} person-hours`} />
      </dl>

      {plan.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No batches on {plan.line.name} this day. Assign batches to the line from their pages.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Batch</th>
                <th className="px-3 py-2 font-medium">Changeover before</th>
                <th className="px-3 py-2 font-medium">Runs</th>
                <th className="px-3 py-2 font-medium">Allergens</th>
                {canWrite && <th className="sr-only px-3 py-2 font-medium">Move</th>}
              </tr>
            </thead>
            <tbody>
              {order.map((id, i) => {
                const s = stepOf.get(id)!;
                return (
                  <tr key={id} className="border-b align-top last:border-b-0">
                    <td className="px-3 py-2 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`${base}/batches/${id}`} className="font-mono text-xs hover:underline">
                          {s.batchCode}
                        </Link>
                        <BatchStatusBadge status={s.status} />
                      </div>
                      <div>{s.recipe.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatAmount(s.planned)}
                        {s.crew !== null && ` · ${s.crew} ${s.crew === 1 ? "person" : "people"}`}
                      </div>
                      {s.warnings.map((w) => (
                        <div key={w} className="text-xs text-destructive">
                          {w}
                        </div>
                      ))}
                    </td>
                    <td className="max-w-72 px-3 py-2">
                      {s.changeover.cleanDown ? (
                        <Badge className="mb-1 border-transparent bg-label-orange-bg text-label-orange">
                          Clean-down {s.changeover.minutes} min
                        </Badge>
                      ) : (
                        <div className="tabular-nums">{s.changeover.minutes} min</div>
                      )}
                      <div className="text-xs text-muted-foreground">{s.changeover.reason}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      <span className={s.overrun ? "text-destructive" : ""}>
                        {s.startClock}–{s.endClock}
                      </span>
                      <div className="text-xs text-muted-foreground">
                        {s.runMinutes === null ? "No rate" : `${s.runMinutes} min`}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {s.allergens === null ? (
                        <span className="text-muted-foreground" title="Needs access to Food items">
                          Hidden
                        </span>
                      ) : s.allergens.contains.length === 0 ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        s.allergens.contains.map(allergenName).join(", ")
                      )}
                      {s.allergens !== null && s.allergens.mayContain.length > 0 && (
                        <div className="text-muted-foreground">
                          May contain {s.allergens.mayContain.map(allergenName).join(", ")}
                        </div>
                      )}
                    </td>
                    {canWrite && (
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Move ${s.batchCode} up`}
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Move ${s.batchCode} down`}
                            disabled={i === order.length - 1}
                            onClick={() => move(i, 1)}
                          >
                            <ArrowDown />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {canWrite && reordered && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={pending} onClick={() => void save(order)}>
            {pending && <Spinner data-icon="inline-start" />}Save this order
          </Button>
          <Button variant="outline" onClick={() => setDraft(null)}>
            Undo
          </Button>
          <span className="text-sm text-muted-foreground">
            Times and changeovers update once it is saved.
          </span>
        </div>
      )}

      {plan.steps.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Proposed order</CardTitle>
            <CardDescription>{plan.proposal.method}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ol className="flex flex-col gap-1 text-sm">
              {plan.proposal.order.map((p, i) => (
                <li key={p.batchId} className="flex gap-2">
                  <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{i + 1}.</span>
                  <span>
                    <span className="font-mono text-xs">{p.batchCode}</span>{" "}
                    <span className="text-muted-foreground">{p.reason}</span>
                  </span>
                </li>
              ))}
            </ol>
            <table className="w-fit text-sm tabular-nums">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pr-6 font-medium" />
                  <th className="pr-6 font-medium">Changeovers</th>
                  <th className="pr-6 font-medium">Clean-downs</th>
                  <th className="font-medium">Ends</th>
                </tr>
              </thead>
              <tbody>
                {(["current", "proposed"] as const).map((k) => (
                  <tr key={k}>
                    <th className="pr-6 text-left font-medium">{k === "current" ? "Current" : "Proposed"}</th>
                    <td className="pr-6">{plan.proposal[k].changeoverMinutes} min</td>
                    <td className="pr-6">{plan.proposal[k].cleanDowns}</td>
                    <td>{clock(plan.proposal[k].endMinute)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!plan.proposal.changed ? (
              <p className="text-sm text-muted-foreground">The current order is already the proposed one.</p>
            ) : (
              canWrite && (
                <Button
                  className="w-fit"
                  variant={plan.proposal.improves ? "default" : "outline"}
                  disabled={pending}
                  onClick={() => void save(plan.proposal.order.map((p) => p.batchId))}
                >
                  Use the proposed order
                </Button>
              )
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium tabular-nums ${warn ? "text-destructive" : ""}`}>{value}</dd>
    </div>
  );
}
