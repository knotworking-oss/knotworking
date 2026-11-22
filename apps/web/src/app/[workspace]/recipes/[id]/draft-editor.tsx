"use client";

import { unitsForItem, unitsOfDimension, units, type UnitCode } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { RecipeVersion } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { ItemPicker, type PickedItem } from "./item-picker";

/** The content a draft starts from: the draft itself, a copy of the current version, or nothing. */
export type DraftStart = Pick<
  RecipeVersion,
  | "status"
  | "versionNumber"
  | "yieldQuantity"
  | "yieldUnit"
  | "method"
  | "changeNote"
  | "lines"
  | "outputItem"
>;

interface EditorLine {
  key: string;
  item: PickedItem | null;
  quantity: string;
  unit: UnitCode;
  note: string;
}

let keyCounter = 0;
const nextKey = () => `line-${++keyCounter}`;

const fromVersion = (line: RecipeVersion["lines"][number]): EditorLine => ({
  key: nextKey(),
  item: line.item,
  quantity: String(line.quantity),
  unit: line.unit,
  note: line.note ?? "",
});

/** At most four decimal places, as the database holds them. */
const validQuantity = (text: string) => {
  const n = Number(text);
  return (
    text.trim() !== "" && Number.isFinite(n) && n > 0 && Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6
  );
};

/**
 * Edits the draft of a recipe. Starts from the draft, or from a copy of the current version, and
 * saves the full content (`PUT /recipes/:id/draft`). Only a draft is editable; approving is separate.
 */
export function DraftEditor({
  slug,
  recipeId,
  start,
  onClose,
}: {
  slug: string;
  recipeId: string;
  /** The draft, or the version to copy into a new one. */
  start: DraftStart;
  onClose: () => void;
}) {
  const router = useRouter();
  const output = start.outputItem;
  const [pending, setPending] = useState(false);
  const [yieldQuantity, setYieldQuantity] = useState(String(start.yieldQuantity || ""));
  const [yieldUnit, setYieldUnit] = useState<UnitCode>(start.yieldUnit);
  const [method, setMethod] = useState(start.method ?? "");
  const [changeNote, setChangeNote] = useState(start.status === "draft" ? (start.changeNote ?? "") : "");
  const [lines, setLines] = useState<EditorLine[]>(start.lines.map(fromVersion));

  const update = (key: string, patch: Partial<EditorLine>) =>
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const move = (index: number, by: -1 | 1) =>
    setLines((all) => {
      const next = [...all];
      const target = index + by;
      if (target < 0 || target >= next.length) return all;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  const complete = lines.every((l) => l.item && validQuantity(l.quantity));
  const yieldValid =
    yieldQuantity.trim() !== "" && Number(yieldQuantity) >= 0 && Number.isFinite(Number(yieldQuantity));

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].recipes[":id"].draft.$put({
          param: { slug, id: recipeId },
          json: {
            yieldQuantity: Number(yieldQuantity),
            yieldUnit,
            method: method.trim() || null,
            changeNote: changeNote.trim() || null,
            lines: lines.map((l) => ({
              itemId: l.item!.id,
              quantity: Number(l.quantity),
              unit: l.unit,
              note: l.note.trim() || null,
            })),
          },
        }),
      );
      toast.success("Draft saved");
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={(e) => void save(e)}>
          <DialogHeader>
            <DialogTitle>
              {start.status === "draft" ? `Edit draft v${start.versionNumber}` : "New draft"}
            </DialogTitle>
            <DialogDescription>
              {start.status === "draft"
                ? "Saving replaces the whole draft. Nothing is used in production until it is approved."
                : `Starts a new version from v${start.versionNumber}. The approved version stays as it is until the new one is approved.`}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="draft-yield">One batch makes</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="draft-yield"
                    inputMode="decimal"
                    required
                    value={yieldQuantity}
                    onChange={(e) => setYieldQuantity(e.target.value)}
                  />
                  <Select value={yieldUnit} onValueChange={(v) => setYieldUnit(v as UnitCode)}>
                    <SelectTrigger className="w-24" aria-label="Yield unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {unitsOfDimension(output.unit).map((u) => (
                          <SelectItem key={u} value={u}>
                            {units[u].label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </Field>
              <Field>
                <FieldLabel htmlFor="draft-change">What changed</FieldLabel>
                <Input
                  id="draft-change"
                  maxLength={2000}
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel>Ingredients</FieldLabel>
              <div className="flex flex-col gap-2">
                {lines.length === 0 && (
                  <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    No ingredients yet.
                  </p>
                )}
                {lines.map((line, index) => {
                  const choices = line.item ? unitsForItem(line.item) : [line.unit];
                  return (
                    <div key={line.key} className="grid grid-cols-[1fr_6rem_5.5rem_auto] items-center gap-2">
                      <ItemPicker
                        slug={slug}
                        value={line.item}
                        excludeId={output.id}
                        onChange={(item) => {
                          const ok = unitsForItem(item);
                          update(line.key, { item, unit: ok.includes(line.unit) ? line.unit : item.unit });
                        }}
                      />
                      <Input
                        inputMode="decimal"
                        aria-label={`Quantity of ingredient ${index + 1}`}
                        aria-invalid={line.quantity !== "" && !validQuantity(line.quantity)}
                        value={line.quantity}
                        onChange={(e) => update(line.key, { quantity: e.target.value })}
                      />
                      <Select
                        value={line.unit}
                        onValueChange={(v) => update(line.key, { unit: v as UnitCode })}
                      >
                        <SelectTrigger aria-label={`Unit of ingredient ${index + 1}`}>
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
                      <div className="flex">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Move up"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Move down"
                          disabled={index === lines.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove ingredient"
                          onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setLines((all) => [
                        ...all,
                        { key: nextKey(), item: null, quantity: "", unit: output.unit, note: "" },
                      ])
                    }
                  >
                    <Plus data-icon="inline-start" /> Add ingredient
                  </Button>
                </div>
              </div>
            </Field>

            <Field>
              <FieldLabel htmlFor="draft-method">Method</FieldLabel>
              <Textarea
                id="draft-method"
                rows={6}
                maxLength={50_000}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !complete || !yieldValid}>
              {pending && <Spinner data-icon="inline-start" />} Save draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
