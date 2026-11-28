"use client";

import { isoWeekdayLabels, units, unitsForItem, type UnitCode } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { formatAmount } from "@/components/stock-badges";
import type { ProductionLine, RecipeRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

type Editing =
  | { kind: "line"; line: ProductionLine | null }
  | { kind: "rate"; line: ProductionLine }
  | { kind: "shifts"; line: ProductionLine }
  | { kind: "changeovers"; line: ProductionLine };

const weekdaysText = (days: readonly number[]) =>
  days.length === 7
    ? "every day"
    : days.join(",") === "1,2,3,4,5"
      ? "Mon–Fri"
      : days.map((d) => isoWeekdayLabels[d - 1]).join(", ");

/** Production → Lines: the lines, their hours per day, and the recipes each makes with its rate. */
export function LinesManager({
  slug,
  lines,
  recipes,
}: {
  slug: string;
  lines: ProductionLine[];
  recipes: RecipeRow[];
}) {
  const router = useRouter();
  const canManage = useWorkspace().can("production", "manage");
  const [editing, setEditing] = useState<Editing | null>(null);
  const api = browserApi().v1.workspaces[":slug"].production.lines;

  async function removeRate(line: ProductionLine, recipeId: string) {
    try {
      await unwrap(api[":id"].recipes[":recipeId"].$delete({ param: { slug, id: line.id, recipeId } }));
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Lines</h2>
          <p className="text-sm text-muted-foreground">
            <Link className="underline underline-offset-2" href={`/${slug}/production/schedule`}>
              Line schedule
            </Link>{" "}
            ·{" "}
            <Link className="underline underline-offset-2" href={`/${slug}/production/devices`}>
              Devices
            </Link>
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setEditing({ kind: "line", line: null })}>
            <Plus data-icon="inline-start" /> New line
          </Button>
        )}
      </div>
      {lines.length === 0 && <p className="text-sm text-muted-foreground">No lines yet.</p>}
      {lines.map((line) => (
        <Card key={line.id}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              {line.name}
              <span className="text-sm font-normal text-muted-foreground tabular-nums">
                {line.hoursPerDay} h a day
              </span>
              {!line.active && <Badge variant="outline">Inactive</Badge>}
            </CardTitle>
            {canManage && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "line", line })}>
                  Edit
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "rate", line })}>
                  <Plus data-icon="inline-start" /> Recipe rate
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "shifts", line })}>
                  Shifts
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "changeovers", line })}>
                  Changeovers
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Shifts</dt>
              <dd>
                {line.shifts.length === 0
                  ? `None: ${line.hoursPerDay} h every working day`
                  : line.shifts
                      .map((sh) => `${sh.name} ${sh.start}–${sh.end} ${weekdaysText(sh.weekdays)}`)
                      .join("; ")}
              </dd>
              <dt className="text-muted-foreground">Changeovers</dt>
              <dd>
                {line.changeoverMinutes} min by default
                {line.changeovers.length > 0 &&
                  `, ${line.changeovers.length} rule${line.changeovers.length === 1 ? "" : "s"}`}
                ; allergen clean-down {line.allergenCleanMinutes} min
              </dd>
              <dt className="text-muted-foreground">Crew</dt>
              <dd>{line.crewAvailable === null ? "Not limited" : `${line.crewAvailable} people`}</dd>
            </dl>
            {line.recipes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No recipes yet: without a rate a batch on this line has unknown hours.
              </p>
            ) : (
              <ul className="flex flex-col divide-y text-sm">
                {line.recipes.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {r.recipeName}{" "}
                      <span className="font-mono text-xs text-muted-foreground">{r.recipeCode}</span>
                    </span>
                    <span className="flex items-center gap-2 tabular-nums">
                      {formatAmount(r.ratePerHour)} an hour
                      {r.crewSize !== null && (
                        <span className="text-muted-foreground">
                          · {r.crewSize} {r.crewSize === 1 ? "person" : "people"}
                        </span>
                      )}
                      {canManage && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${r.recipeName} from ${line.name}`}
                          onClick={() => void removeRate(line, r.recipeId)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
      {editing?.kind === "line" && (
        <LineDialog slug={slug} line={editing.line} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === "rate" && (
        <RateDialog slug={slug} line={editing.line} recipes={recipes} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === "shifts" && (
        <ShiftsDialog slug={slug} line={editing.line} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === "changeovers" && (
        <ChangeoversDialog slug={slug} line={editing.line} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function Shell({
  title,
  description,
  onSubmit,
  onClose,
  children,
  wide,
}: {
  title: string;
  description: string;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await onSubmit();
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={wide ? "sm:max-w-2xl" : "sm:max-w-md"}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">{children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LineDialog({
  slug,
  line,
  onClose,
}: {
  slug: string;
  line: ProductionLine | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(line?.name ?? "");
  const [hours, setHours] = useState(String(line?.hoursPerDay ?? 8));
  const [active, setActive] = useState(line?.active ?? true);
  const [changeover, setChangeover] = useState(String(line?.changeoverMinutes ?? 0));
  const [clean, setClean] = useState(String(line?.allergenCleanMinutes ?? 0));
  const [crew, setCrew] = useState(line?.crewAvailable == null ? "" : String(line.crewAvailable));
  const api = browserApi().v1.workspaces[":slug"].production.lines;
  return (
    <Shell
      title={line ? `Edit ${line.name}` : "New line"}
      description="The hours a day are the capacity the schedule loads batches against."
      onClose={onClose}
      onSubmit={async () => {
        const json = { name: name.trim(), hoursPerDay: Number(hours) };
        if (line)
          await unwrap(
            api[":id"].$patch({
              param: { slug, id: line.id },
              json: {
                ...json,
                active,
                changeoverMinutes: Number(changeover),
                allergenCleanMinutes: Number(clean),
                crewAvailable: crew.trim() === "" ? null : Number(crew),
              },
            }),
          );
        else await unwrap(api.$post({ param: { slug }, json }));
      }}
    >
      <Field>
        <FieldLabel htmlFor="line-name">Name</FieldLabel>
        <Input
          id="line-name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="line-hours">Hours a day</FieldLabel>
        <Input
          id="line-hours"
          type="number"
          inputMode="decimal"
          step="0.25"
          min="0.25"
          max="24"
          required
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
      </Field>
      {line && (
        <div className="grid grid-cols-3 gap-3">
          <Field>
            <FieldLabel htmlFor="line-changeover">Changeover (min)</FieldLabel>
            <Input
              id="line-changeover"
              type="number"
              min="0"
              max="1440"
              step="1"
              required
              value={changeover}
              onChange={(e) => setChangeover(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="line-clean">Allergen clean (min)</FieldLabel>
            <Input
              id="line-clean"
              type="number"
              min="0"
              max="1440"
              step="1"
              required
              value={clean}
              onChange={(e) => setClean(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="line-crew">Crew available</FieldLabel>
            <Input
              id="line-crew"
              type="number"
              min="1"
              max="500"
              step="1"
              placeholder="No limit"
              value={crew}
              onChange={(e) => setCrew(e.target.value)}
            />
          </Field>
        </div>
      )}
      {line && (
        <Field orientation="horizontal">
          <input
            id="line-active"
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          <FieldLabel htmlFor="line-active">Active (inactive lines can't take new batches)</FieldLabel>
        </Field>
      )}
    </Shell>
  );
}

function RateDialog({
  slug,
  line,
  recipes,
  onClose,
}: {
  slug: string;
  line: ProductionLine;
  recipes: RecipeRow[];
  onClose: () => void;
}) {
  const [recipeId, setRecipeId] = useState("");
  const [rate, setRate] = useState("");
  const [unit, setUnit] = useState<UnitCode | "">("");
  const [crewSize, setCrewSize] = useState("");
  const recipe = recipes.find((r) => r.id === recipeId);
  const choices = recipe?.outputItem ? unitsForItem(recipe.outputItem) : [];
  const api = browserApi().v1.workspaces[":slug"].production.lines[":id"].recipes[":recipeId"];
  return (
    <Shell
      title={`Recipe rate on ${line.name}`}
      description="How much of the recipe's output the line makes in an hour. Setting it again changes the rate."
      onClose={onClose}
      onSubmit={async () => {
        if (!recipe || !unit) throw new Error("Choose a recipe and unit");
        await unwrap(
          api.$put({
            param: { slug, id: line.id, recipeId },
            json: { rate: Number(rate), unit, crewSize: crewSize.trim() === "" ? null : Number(crewSize) },
          }),
        );
      }}
    >
      <Field>
        <FieldLabel id="rate-recipe-label">Recipe</FieldLabel>
        <Select
          value={recipeId}
          onValueChange={(id) => {
            setRecipeId(id);
            setUnit(recipes.find((r) => r.id === id)?.outputItem?.unit ?? "");
            const existing = line.recipes.find((r) => r.recipeId === id)?.crewSize;
            setCrewSize(existing == null ? "" : String(existing));
          }}
        >
          <SelectTrigger aria-labelledby="rate-recipe-label" className="w-full">
            <SelectValue placeholder="Choose a recipe" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {recipes.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name} · {r.code}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <Field>
          <FieldLabel htmlFor="rate-value">Rate per hour</FieldLabel>
          <Input
            id="rate-value"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            required
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel id="rate-unit-label">Unit</FieldLabel>
          <Select value={unit} onValueChange={(v) => setUnit(v as UnitCode)} disabled={!recipe}>
            <SelectTrigger aria-labelledby="rate-unit-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((u) => (
                  <SelectItem key={u} value={u}>
                    {units[u].label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="rate-crew">People needed</FieldLabel>
        <Input
          id="rate-crew"
          type="number"
          min="1"
          max="500"
          step="1"
          placeholder="Not set"
          value={crewSize}
          onChange={(e) => setCrewSize(e.target.value)}
        />
      </Field>
    </Shell>
  );
}

type ShiftDraft = { key: number; name: string; weekdays: number[]; start: string; end: string };

function ShiftsDialog({ slug, line, onClose }: { slug: string; line: ProductionLine; onClose: () => void }) {
  const [rows, setRows] = useState<ShiftDraft[]>(
    line.shifts.map((sh, i) => ({
      key: i,
      name: sh.name,
      weekdays: [...sh.weekdays],
      start: sh.start.slice(0, 5),
      end: sh.end.slice(0, 5),
    })),
  );
  const [next, setNext] = useState(rows.length);
  const update = (key: number, patch: Partial<ShiftDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const api = browserApi().v1.workspaces[":slug"].production.lines[":id"].shifts;
  return (
    <Shell
      wide
      title={`Shifts on ${line.name}`}
      description="When the line runs. With shifts, a day's capacity is their length and the day plan is timed against them; a weekday with none has no capacity. An end at or before the start runs past midnight."
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          api.$put({
            param: { slug, id: line.id },
            json: {
              shifts: rows.map(({ name, weekdays, start, end }) => ({
                name: name.trim(),
                weekdays,
                start,
                end,
              })),
            },
          }),
        );
      }}
    >
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No shifts: the line counts {line.hoursPerDay} h a working day.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.key} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="grid grid-cols-[1fr_7rem_7rem_auto] items-end gap-2">
            <Field>
              <FieldLabel htmlFor={`shift-name-${r.key}`}>Name</FieldLabel>
              <Input
                id={`shift-name-${r.key}`}
                required
                maxLength={60}
                value={r.name}
                onChange={(e) => update(r.key, { name: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`shift-start-${r.key}`}>Start</FieldLabel>
              <Input
                id={`shift-start-${r.key}`}
                type="time"
                required
                value={r.start}
                onChange={(e) => update(r.key, { start: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`shift-end-${r.key}`}>End</FieldLabel>
              <Input
                id={`shift-end-${r.key}`}
                type="time"
                required
                value={r.end}
                onChange={(e) => update(r.key, { end: e.target.value })}
              />
            </Field>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Remove shift ${r.name || r.key + 1}`}
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Weekdays">
            {isoWeekdayLabels.map((label, i) => {
              const day = i + 1;
              const on = r.weekdays.includes(day);
              return (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  aria-pressed={on}
                  onClick={() =>
                    update(r.key, {
                      weekdays: on ? r.weekdays.filter((d) => d !== day) : [...r.weekdays, day].sort(),
                    })
                  }
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => {
          setRows((rs) => [
            ...rs,
            { key: next, name: "Day", weekdays: [1, 2, 3, 4, 5], start: "06:00", end: "14:00" },
          ]);
          setNext((n) => n + 1);
        }}
      >
        <Plus data-icon="inline-start" /> Add shift
      </Button>
    </Shell>
  );
}

type RuleDraft = { key: number; from: string; to: string; minutes: string; note: string };
const ANY = "any";

function ChangeoversDialog({
  slug,
  line,
  onClose,
}: {
  slug: string;
  line: ProductionLine;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<RuleDraft[]>(
    line.changeovers.map((r, i) => ({
      key: i,
      from: r.fromRecipeId ?? ANY,
      to: r.toRecipeId ?? ANY,
      minutes: String(r.minutes),
      note: r.note ?? "",
    })),
  );
  const [next, setNext] = useState(rows.length);
  const update = (key: number, patch: Partial<RuleDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const api = browserApi().v1.workspaces[":slug"].production.lines[":id"].changeovers;
  const recipeSelect = (id: string, value: string, onChange: (v: string) => void, label: string) => (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-labelledby={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={ANY}>Any recipe</SelectItem>
            {line.recipes.map((r) => (
              <SelectItem key={r.recipeId} value={r.recipeId}>
                {r.recipeName}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
  return (
    <Shell
      wide
      title={`Changeovers on ${line.name}`}
      description={`Minutes to change from one recipe to the next. The most specific rule wins; otherwise the same recipe again takes none and anything else ${line.changeoverMinutes} min (the line's default, set under Edit). An allergen clean-down takes at least ${line.allergenCleanMinutes} min.`}
      onClose={onClose}
      onSubmit={async () => {
        await unwrap(
          api.$put({
            param: { slug, id: line.id },
            json: {
              rules: rows.map((r) => ({
                fromRecipeId: r.from === ANY ? null : r.from,
                toRecipeId: r.to === ANY ? null : r.to,
                minutes: Number(r.minutes),
                note: r.note.trim(),
              })),
            },
          }),
        );
      }}
    >
      {line.recipes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add recipe rates first: rules are between recipes the line makes.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[1fr_1fr_5rem_auto] items-end gap-2 rounded-md border p-3">
          {recipeSelect(`co-from-${r.key}`, r.from, (v) => update(r.key, { from: v }), "From")}
          {recipeSelect(`co-to-${r.key}`, r.to, (v) => update(r.key, { to: v }), "To")}
          <Field>
            <FieldLabel htmlFor={`co-min-${r.key}`}>Minutes</FieldLabel>
            <Input
              id={`co-min-${r.key}`}
              type="number"
              min="0"
              max="1440"
              step="1"
              required
              value={r.minutes}
              onChange={(e) => update(r.key, { minutes: e.target.value })}
            />
          </Field>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Remove rule"
            onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
          >
            <Trash2 />
          </Button>
          <Field className="col-span-4">
            <FieldLabel htmlFor={`co-note-${r.key}`}>Note</FieldLabel>
            <Input
              id={`co-note-${r.key}`}
              maxLength={200}
              value={r.note}
              onChange={(e) => update(r.key, { note: e.target.value })}
            />
          </Field>
        </div>
      ))}
      {line.recipes.length > 0 && (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() => {
            setRows((rs) => [
              ...rs,
              { key: next, from: line.recipes[0]!.recipeId, to: ANY, minutes: "15", note: "" },
            ]);
            setNext((n) => n + 1);
          }}
        >
          <Plus data-icon="inline-start" /> Add rule
        </Button>
      )}
    </Shell>
  );
}
