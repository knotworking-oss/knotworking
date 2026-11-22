"use client";

import {
  todayInZone,
  type TestInvestigationStatus,
  type TestOutcome,
  type TestSubject,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { TestInvestigationBadge, TestOutcomeBadge, TestSampleStatusBadge } from "@/components/testing-badges";
import type { SamplingPoint, StockLot, TestLaboratory, TestPlan, TestSampleRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

interface Filters {
  q?: string | undefined;
  outcome?: TestOutcome | undefined;
  investigation?: TestInvestigationStatus | undefined;
}
const NONE = "none";

/** Testing → samples: the register with search and filters, and the log-a-sample dialog. */
export function SamplesBoard({
  slug,
  samples,
  total,
  plans,
  laboratories,
  points,
  lots,
  filters,
}: {
  slug: string;
  samples: TestSampleRow[];
  total: number;
  plans: TestPlan[];
  laboratories: TestLaboratory[];
  points: SamplingPoint[];
  lots: StockLot[];
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const timeZone = useWorkspaceTimeZone();
  const canWrite = useWorkspace().can("testing", "write");
  const [logging, setLogging] = useState(false);
  const [query, setQuery] = useState(filters.q ?? "");

  function applyFilters(next: Partial<Filters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.outcome) params.set("outcome", merged.outcome);
    if (merged.investigation) params.set("investigation", merged.investigation);
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Samples</h2>
          <p className="text-sm text-muted-foreground">{total} shown</p>
        </div>
        {canWrite && (
          <Button onClick={() => setLogging(true)}>
            <Plus data-icon="inline-start" /> Log sample
          </Button>
        )}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters({ q: query.trim() || undefined });
        }}
      >
        <Input
          className="w-64"
          placeholder="Reference, lot, item or point"
          aria-label="Search samples"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={filters.outcome ?? NONE}
          onValueChange={(v) => applyFilters({ outcome: v === NONE ? undefined : (v as TestOutcome) })}
        >
          <SelectTrigger className="w-40" aria-label="Outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NONE}>Any outcome</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="pass">Pass</SelectItem>
              <SelectItem value="fail">Fail</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={filters.investigation === "open" ? "secondary" : "outline"}
          aria-pressed={filters.investigation === "open"}
          onClick={() =>
            applyFilters({ investigation: filters.investigation === "open" ? undefined : "open" })
          }
        >
          Open investigations
        </Button>
      </form>

      {samples.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filters.q || filters.outcome || filters.investigation
            ? "No samples match these filters."
            : "No samples yet. Log one taken from a stock lot or a sampling point."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Reference</TableHead>
                <TableHead>Sampled</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Laboratory</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {samples.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4 font-mono text-xs">
                    <Link href={`/${slug}/testing/samples/${s.id}`} className="hover:underline">
                      {s.reference}
                    </Link>
                  </TableCell>
                  <TableCell>{formatLongDate(s.sampledOn, timeZone)}</TableCell>
                  <TableCell>
                    {s.lot ? (
                      <>
                        Lot <span className="font-mono text-xs">{s.lot.lotCode}</span> · {s.item?.code}
                      </>
                    ) : s.samplingPoint ? (
                      <>
                        <span className="font-mono text-xs">{s.samplingPoint.code}</span>{" "}
                        {s.samplingPoint.name}
                        {s.samplingPoint.zone && (
                          <span className="text-xs text-muted-foreground"> · {s.samplingPoint.zone}</span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>{s.laboratoryName ?? "—"}</TableCell>
                  <TableCell>
                    <TestSampleStatusBadge status={s.status} />
                  </TableCell>
                  <TableCell className="pr-4">
                    <span className="flex flex-wrap items-center gap-1">
                      <TestOutcomeBadge outcome={s.outcome} />
                      <TestInvestigationBadge status={s.investigationStatus} />
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {logging && (
        <LogSampleDialog
          slug={slug}
          plans={plans}
          laboratories={laboratories}
          points={points}
          lots={lots}
          today={todayInZone(timeZone)}
          onClose={() => setLogging(false)}
        />
      )}
    </div>
  );
}

function LogSampleDialog({
  slug,
  plans,
  laboratories,
  points,
  lots,
  today,
  onClose,
}: {
  slug: string;
  plans: TestPlan[];
  laboratories: TestLaboratory[];
  points: SamplingPoint[];
  lots: StockLot[];
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [subject, setSubject] = useState<TestSubject>("lot");
  const [lotId, setLotId] = useState("");
  const [pointId, setPointId] = useState("");
  const [planId, setPlanId] = useState(NONE);
  const [labId, setLabId] = useState(NONE);
  const [sampledOn, setSampledOn] = useState(today);
  const [sampledBy, setSampledBy] = useState("");
  const lot = lots.find((l) => l.id === lotId);
  const usablePlans = plans.filter((p) =>
    subject === "lot" ? p.subject === "lot" && p.item?.id === lot?.item.id : p.samplingPoint?.id === pointId,
  );
  const ready = subject === "lot" ? !!lotId : !!pointId && planId !== NONE;

  async function log(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const created = await unwrap(
        browserApi().v1.workspaces[":slug"].testing.samples.$post({
          param: { slug },
          json: {
            subject,
            ...(subject === "lot" ? { lotId } : { samplingPointId: pointId }),
            planId: planId === NONE ? null : planId,
            laboratoryId: labId === NONE ? null : labId,
            sampledOn,
            sampledBy: sampledBy.trim() || null,
          },
        }),
      );
      toast.success(`${created.reference} logged`);
      router.push(`/${slug}/testing/samples/${created.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void log(e)}>
          <DialogHeader>
            <DialogTitle>Log sample</DialogTitle>
            <DialogDescription>
              What it is tested for comes from the plan, or for a lot without one, the item&apos;s approved
              specification.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <ToggleGroup
              type="single"
              variant="outline"
              value={subject}
              onValueChange={(v) => {
                if (!v) return;
                setSubject(v as TestSubject);
                setPlanId(NONE);
              }}
            >
              <ToggleGroupItem value="lot">Stock lot</ToggleGroupItem>
              <ToggleGroupItem value="point">Sampling point</ToggleGroupItem>
            </ToggleGroup>
            {subject === "lot" ? (
              <Field>
                <FieldLabel htmlFor="sample-lot">Lot</FieldLabel>
                <Select
                  value={lotId}
                  onValueChange={(v) => {
                    setLotId(v);
                    setPlanId(NONE);
                  }}
                >
                  <SelectTrigger id="sample-lot" className="w-full">
                    <SelectValue placeholder="Choose a lot" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {lots.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.lotCode} · {l.item.code} {l.item.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="sample-point">Sampling point</FieldLabel>
                <Select
                  value={pointId}
                  onValueChange={(v) => {
                    setPointId(v);
                    setPlanId(plans.find((p) => p.samplingPoint?.id === v)?.id ?? NONE);
                  }}
                >
                  <SelectTrigger id="sample-point" className="w-full">
                    <SelectValue placeholder="Choose a point" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {points.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.code} · {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="sample-plan">Plan</FieldLabel>
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger id="sample-plan" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {subject === "lot" && <SelectItem value={NONE}>None: use the specification</SelectItem>}
                    {subject === "point" && <SelectItem value={NONE}>Choose a plan</SelectItem>}
                    {usablePlans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {subject === "point" && usablePlans.length === 0 && pointId && (
                <FieldDescription>This point has no plan: add one under Setup first.</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="sample-lab">Laboratory</FieldLabel>
              <Select value={labId} onValueChange={setLabId}>
                <SelectTrigger id="sample-lab" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NONE}>The plan&apos;s, or none</SelectItem>
                    {laboratories.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sample-date">Sampled on</FieldLabel>
                <Input
                  id="sample-date"
                  type="date"
                  max={today}
                  required
                  value={sampledOn}
                  onChange={(e) => setSampledOn(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sample-by">Sampled by</FieldLabel>
                <Input
                  id="sample-by"
                  maxLength={200}
                  value={sampledBy}
                  onChange={(e) => setSampledBy(e.target.value)}
                />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !ready}>
              {pending && <Spinner data-icon="inline-start" />} Log sample
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
