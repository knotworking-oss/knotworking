"use client";

import { addDays, units, unitsForItem, type UnitCode } from "@knotworking/core";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { CalendarRange, ChevronLeft, ChevronRight, ClipboardList, Factory, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { BatchStatusBadge } from "@/components/production-badges";
import { formatAmount } from "@/components/stock-badges";
import type { ProductionBatch, RecipeRow, StockLocation } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const NONE = "none";

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** Production → the batch schedule for one week, by planned date, with planning. */
export function BatchSchedule({
  slug,
  from,
  to,
  today,
  batches,
  earlier,
  recipes,
  locations,
}: {
  slug: string;
  from: string;
  to: string;
  today: string;
  batches: ProductionBatch[];
  earlier: ProductionBatch[];
  recipes: RecipeRow[];
  locations: StockLocation[];
}) {
  const { can } = useWorkspace();
  const canWrite = can("production", "write");
  const [planning, setPlanning] = useState<string | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const base = `/${slug}/production`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" asChild aria-label="Previous week">
            <Link href={`${base}?week=${addDays(from, -7)}`}>
              <ChevronLeft />
            </Link>
          </Button>
          <Button variant="outline" size="icon" asChild aria-label="Next week">
            <Link href={`${base}?week=${addDays(from, 7)}`}>
              <ChevronRight />
            </Link>
          </Button>
          <h2 className="text-lg font-semibold tracking-tight">
            {dayLabel(from)} – {dayLabel(to)}
          </h2>
          {(today < from || today > to) && (
            <Button variant="ghost" size="sm" asChild>
              <Link href={base}>This week</Link>
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {can("demand") && (
            <Button variant="outline" asChild>
              <Link href={`${base}/plan?from=${from}`}>
                <CalendarRange data-icon="inline-start" /> Plan from demand
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link href={`${base}/schedule?from=${from}`}>
              <Factory data-icon="inline-start" /> Line schedule
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`${base}/requirements?from=${from}&to=${to}`}>
              <ClipboardList data-icon="inline-start" /> Material requirements
            </Link>
          </Button>
          {canWrite && (
            <Button onClick={() => setPlanning(today >= from && today <= to ? today : from)}>
              <Plus data-icon="inline-start" /> Plan batch
            </Button>
          )}
        </div>
      </div>

      {earlier.length > 0 && (
        <DayGroup
          title="Earlier, still open"
          hint="Planned before this week and not completed or cancelled"
          batches={earlier}
          slug={slug}
        />
      )}

      {days.map((day) => (
        <DayGroup
          key={day}
          title={dayLabel(day)}
          hint={day === today ? "Today" : undefined}
          batches={batches.filter((b) => b.plannedOn === day)}
          slug={slug}
          onPlan={canWrite ? () => setPlanning(day) : undefined}
        />
      ))}

      {planning && (
        <PlanBatchDialog
          slug={slug}
          plannedOn={planning}
          recipes={recipes}
          locations={locations}
          onClose={() => setPlanning(null)}
        />
      )}
    </div>
  );
}

function DayGroup({
  title,
  hint,
  batches,
  slug,
  onPlan,
}: {
  title: string;
  hint?: string | undefined;
  batches: ProductionBatch[];
  slug: string;
  onPlan?: (() => void) | undefined;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-baseline gap-2 font-medium">
          {title}
          {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
        </h3>
        {onPlan && (
          <Button variant="ghost" size="sm" onClick={onPlan}>
            <Plus data-icon="inline-start" /> Plan
          </Button>
        )}
      </div>
      {batches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No batches.</p>
      ) : (
        <Card className="gap-0 divide-y py-0">
          {batches.map((b) => (
            <BatchRow key={b.id} batch={b} slug={slug} />
          ))}
        </Card>
      )}
    </section>
  );
}

/** One batch on the schedule: code, recipe and version, size, output so far and status. */
export function BatchRow({ batch, slug }: { batch: ProductionBatch; slug: string }) {
  return (
    <Link
      href={`/${slug}/production/batches/${batch.id}`}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-muted/50"
    >
      <Factory className="size-4 text-muted-foreground" />
      <span className="font-mono text-xs">{batch.batchCode}</span>
      <span className="min-w-40 flex-1">
        {batch.recipe.name}{" "}
        <span className="text-xs text-muted-foreground">
          {batch.recipe.code}
          {batch.recipeVersion && ` v${batch.recipeVersion.versionNumber}`}
        </span>
      </span>
      <span className="text-muted-foreground tabular-nums">
        {batch.batches !== null && `${batch.batches} × · `}
        {formatAmount(batch.planned)}
      </span>
      {batch.produced.display > 0 && (
        <span className="text-muted-foreground tabular-nums">made {formatAmount(batch.produced)}</span>
      )}
      {batch.outputLocation && (
        <span className="text-xs text-muted-foreground">→ {batch.outputLocation.name}</span>
      )}
      <BatchStatusBadge status={batch.status} />
    </Link>
  );
}

/** Plan a batch of a recipe's approved version, by number of batches or by target output. */
function PlanBatchDialog({
  slug,
  plannedOn: initialDate,
  recipes,
  locations,
  onClose,
}: {
  slug: string;
  plannedOn: string;
  recipes: RecipeRow[];
  locations: StockLocation[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [recipeId, setRecipeId] = useState(recipes[0]?.id ?? "");
  const [plannedOn, setPlannedOn] = useState(initialDate);
  const [mode, setMode] = useState<"batches" | "output">("batches");
  const [quantity, setQuantity] = useState("1");
  const recipe = recipes.find((r) => r.id === recipeId);
  const output = recipe?.outputItem;
  const unitChoices = output ? unitsForItem(output) : [];
  const [unit, setUnit] = useState<UnitCode | "">(output?.unit ?? "");
  const [locationId, setLocationId] = useState(NONE);
  const [batchCode, setBatchCode] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const size =
        mode === "batches"
          ? { batches: Number(quantity) }
          : { outputQuantity: Number(quantity), outputUnit: (unit || output!.unit) as UnitCode };
      const batch = await unwrap(
        browserApi().v1.workspaces[":slug"].production.batches.$post({
          param: { slug },
          json: {
            recipeId,
            plannedOn,
            ...size,
            ...(locationId !== NONE ? { outputLocationId: locationId } : {}),
            ...(batchCode.trim() ? { batchCode: batchCode.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          },
        }),
      );
      toast.success(`Batch ${batch.batchCode} planned`);
      onClose();
      router.push(`/${slug}/production/batches/${batch.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Plan a batch</DialogTitle>
            <DialogDescription>
              The batch is made to the recipe&apos;s current approved version. Check stock on the material
              requirements page.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            {recipes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No recipe has an approved version yet. Approve one on the Recipes page first.
              </p>
            ) : (
              <Field>
                <FieldLabel id="plan-recipe-label">Recipe</FieldLabel>
                <Select
                  value={recipeId}
                  onValueChange={(id) => {
                    setRecipeId(id);
                    setUnit(recipes.find((r) => r.id === id)?.outputItem?.unit ?? "");
                  }}
                >
                  <SelectTrigger aria-labelledby="plan-recipe-label" className="w-full">
                    <SelectValue placeholder="Choose a recipe" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {recipes.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            · {r.code} v{r.approvedVersionNumber}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {output && <FieldDescription>Makes {output.name}.</FieldDescription>}
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="plan-date">Planned on</FieldLabel>
              <Input
                id="plan-date"
                type="date"
                required
                value={plannedOn}
                onChange={(e) => setPlannedOn(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel id="plan-mode-label">Size</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-labelledby="plan-mode-label"
                value={mode}
                onValueChange={(v) => v && setMode(v as "batches" | "output")}
              >
                <ToggleGroupItem value="batches">Number of batches</ToggleGroupItem>
                <ToggleGroupItem value="output">Target output</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field>
                <FieldLabel htmlFor="plan-quantity">{mode === "batches" ? "Batches" : "Output"}</FieldLabel>
                <Input
                  id="plan-quantity"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  required
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </Field>
              {mode === "output" && (
                <Field>
                  <FieldLabel id="plan-unit-label">Unit</FieldLabel>
                  <Select value={unit} onValueChange={(v) => setUnit(v as UnitCode)}>
                    <SelectTrigger aria-labelledby="plan-unit-label" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {unitChoices.map((u) => (
                          <SelectItem key={u} value={u}>
                            {units[u].label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            <Field>
              <FieldLabel id="plan-location-label">Output location</FieldLabel>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger aria-labelledby="plan-location-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NONE}>Decide later</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="plan-code">Batch code (optional)</FieldLabel>
              <Input
                id="plan-code"
                maxLength={60}
                placeholder="Generated, e.g. B261111-001"
                value={batchCode}
                onChange={(e) => setBatchCode(e.target.value)}
              />
              <FieldDescription>Also the default lot code of what the batch makes.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="plan-notes">Notes (optional)</FieldLabel>
              <Textarea
                id="plan-notes"
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !recipe}>
              {pending && <Spinner data-icon="inline-start" />}
              Plan batch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
