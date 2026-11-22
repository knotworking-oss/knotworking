"use client";

import {
  allergenCodes,
  allergens,
  specificationParameterCategories,
  specificationParameterCategoryLabels,
  storageConditions,
  storageLabels,
  type AllergenCode,
  type SpecificationKind,
  type SpecificationParameterCategory,
  type SpecificationParty,
  type StorageCondition,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
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
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { SpecificationVersion } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const NONE = "none";

interface EditorParameter {
  key: string;
  category: SpecificationParameterCategory;
  name: string;
  unit: string;
  min: string;
  target: string;
  max: string;
  limitText: string;
  method: string;
}

let keyCounter = 0;
const nextKey = () => `param-${++keyCounter}`;
const numText = (n: number | null) => (n === null ? "" : String(n));
const textOrNull = (s: string) => s.trim() || null;
const numberOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
const intOrNull = (s: string) => (s.trim() === "" ? null : Math.round(Number(s)));

/**
 * The draft editor: every field of a specification version. Opens with the draft, a copy of an
 * earlier version as the next draft, or nothing. Saving replaces the whole draft.
 */
export function SpecificationDraftEditor({
  slug,
  specificationId,
  kind,
  party,
  start,
  onClose,
}: {
  slug: string;
  specificationId: string;
  kind: SpecificationKind;
  party: SpecificationParty;
  start: SpecificationVersion | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const isDraft = start?.status === "draft";
  const [description, setDescription] = useState(start?.description ?? "");
  const [storage, setStorage] = useState<StorageCondition | typeof NONE>(start?.storage ?? NONE);
  const [storageInstructions, setStorageInstructions] = useState(start?.storageInstructions ?? "");
  const [shelfLife, setShelfLife] = useState(numText(start?.shelfLifeDays ?? null));
  const [minLife, setMinLife] = useState(numText(start?.minimumLifeOnReceiptDays ?? null));
  const [contains, setContains] = useState<AllergenCode[]>(start?.allergens ?? []);
  const [mayContain, setMayContain] = useState<AllergenCode[]>(start?.mayContain ?? []);
  const [origin, setOrigin] = useState(start?.countryOfOrigin ?? "");
  const [provenance, setProvenance] = useState(start?.provenance ?? "");
  const [claims, setClaims] = useState((start?.claims ?? []).join(", "));
  const [packaging, setPackaging] = useState(start?.packagingDetails ?? "");
  const [reviewDueOn, setReviewDueOn] = useState(start?.reviewDueOn ?? "");
  // An agreement belongs to one version: a copy of an approved version starts without it.
  const [agreedBy, setAgreedBy] = useState(isDraft ? (start?.agreedBy ?? "") : "");
  const [agreedOn, setAgreedOn] = useState(isDraft ? (start?.agreedOn ?? "") : "");
  const [agreementReference, setAgreementReference] = useState(
    isDraft ? (start?.agreementReference ?? "") : "",
  );
  const [changeNote, setChangeNote] = useState(isDraft ? (start?.changeNote ?? "") : "");
  const [parameters, setParameters] = useState<EditorParameter[]>(
    (start?.parameters ?? []).map((p) => ({
      key: nextKey(),
      category: p.category,
      name: p.name,
      unit: p.unit ?? "",
      min: numText(p.min),
      target: numText(p.target),
      max: numText(p.max),
      limitText: p.limitText ?? "",
      method: p.method ?? "",
    })),
  );

  const setAllergen = (code: AllergenCode, state: "contains" | "may" | "no") => {
    setContains((list) =>
      state === "contains" ? [...new Set([...list, code])] : list.filter((c) => c !== code),
    );
    setMayContain((list) =>
      state === "may" ? [...new Set([...list, code])] : list.filter((c) => c !== code),
    );
  };
  const updateParameter = (key: string, patch: Partial<EditorParameter>) =>
    setParameters((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].specifications[":id"].draft.$put({
          param: { slug, id: specificationId },
          json: {
            description: textOrNull(description),
            storage: storage === NONE ? null : storage,
            storageInstructions: textOrNull(storageInstructions),
            shelfLifeDays: intOrNull(shelfLife),
            minimumLifeOnReceiptDays: kind === "product" ? null : intOrNull(minLife),
            allergens: contains,
            mayContain,
            countryOfOrigin: textOrNull(origin),
            provenance: textOrNull(provenance),
            claims: claims
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean),
            packagingDetails: textOrNull(packaging),
            parameters: parameters.map((p) => ({
              category: p.category,
              name: p.name.trim(),
              unit: textOrNull(p.unit),
              min: numberOrNull(p.min),
              target: numberOrNull(p.target),
              max: numberOrNull(p.max),
              limitText: textOrNull(p.limitText),
              method: textOrNull(p.method),
            })),
            reviewDueOn: reviewDueOn || null,
            agreedBy: textOrNull(agreedBy),
            agreedOn: agreedOn || null,
            agreementReference: textOrNull(agreementReference),
            changeNote: textOrNull(changeNote),
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={(e) => void save(e)}>
          <DialogHeader>
            <DialogTitle>{isDraft ? `Edit draft v${start?.versionNumber}` : "New draft"}</DialogTitle>
            <DialogDescription>
              {start && !isDraft
                ? `Starts as a copy of v${start.versionNumber}. Approving it will supersede the approved version.`
                : "Saved drafts can be edited until someone with manage access approves them."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="spec-description">Description</FieldLabel>
              <Textarea
                id="spec-description"
                maxLength={5000}
                placeholder="What it is: composition, appearance, intended use"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            {kind === "packaging" && (
              <Field>
                <FieldLabel htmlFor="spec-packaging">Packaging details</FieldLabel>
                <Textarea
                  id="spec-packaging"
                  maxLength={2000}
                  placeholder="Material, food-contact compliance, dimensions, recyclability"
                  value={packaging}
                  onChange={(e) => setPackaging(e.target.value)}
                />
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="spec-storage">Storage</FieldLabel>
                <Select
                  value={storage}
                  onValueChange={(v) => setStorage(v as StorageCondition | typeof NONE)}
                >
                  <SelectTrigger id="spec-storage" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NONE}>Not set</SelectItem>
                      {storageConditions.map((s) => (
                        <SelectItem key={s} value={s}>
                          {storageLabels[s]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="spec-shelf-life">Shelf life (days)</FieldLabel>
                <Input
                  id="spec-shelf-life"
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={shelfLife}
                  onChange={(e) => setShelfLife(e.target.value)}
                />
              </Field>
              {kind !== "product" && (
                <Field>
                  <FieldLabel htmlFor="spec-min-life">Minimum life on receipt (days)</FieldLabel>
                  <Input
                    id="spec-min-life"
                    type="number"
                    min={0}
                    max={3650}
                    step={1}
                    value={minLife}
                    onChange={(e) => setMinLife(e.target.value)}
                  />
                </Field>
              )}
            </div>
            <Field>
              <FieldLabel htmlFor="spec-storage-instructions">Storage instructions</FieldLabel>
              <Input
                id="spec-storage-instructions"
                maxLength={1000}
                placeholder="e.g. Store below 5 °C; once opened use within 3 days"
                value={storageInstructions}
                onChange={(e) => setStorageInstructions(e.target.value)}
              />
            </Field>

            {kind !== "packaging" && (
              <FieldSet>
                <FieldLegend variant="label">Allergens</FieldLegend>
                <FieldDescription>
                  Tick what it contains, or may contain through cross-contact.
                </FieldDescription>
                <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {allergenCodes.map((code) => (
                    <div key={code} className="flex items-center justify-between gap-2 text-sm">
                      <span>{allergens[code]}</span>
                      <span className="flex items-center gap-3">
                        <span className="flex items-center gap-1">
                          <Checkbox
                            id={`contains-${code}`}
                            checked={contains.includes(code)}
                            onCheckedChange={(on) => setAllergen(code, on === true ? "contains" : "no")}
                          />
                          <Label htmlFor={`contains-${code}`} className="text-xs font-normal">
                            Contains
                          </Label>
                        </span>
                        <span className="flex items-center gap-1">
                          <Checkbox
                            id={`may-${code}`}
                            checked={mayContain.includes(code)}
                            onCheckedChange={(on) => setAllergen(code, on === true ? "may" : "no")}
                          />
                          <Label htmlFor={`may-${code}`} className="text-xs font-normal">
                            May contain
                          </Label>
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </FieldSet>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="spec-origin">Country of origin</FieldLabel>
                <Input
                  id="spec-origin"
                  maxLength={200}
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="spec-claims">Claims</FieldLabel>
                <Input
                  id="spec-claims"
                  placeholder="Comma-separated, e.g. Organic, Vegan"
                  value={claims}
                  onChange={(e) => setClaims(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="spec-provenance">Provenance</FieldLabel>
              <Textarea
                id="spec-provenance"
                maxLength={2000}
                placeholder="Variety, species, farm assurance, chain of custody"
                value={provenance}
                onChange={(e) => setProvenance(e.target.value)}
              />
            </Field>

            <FieldSet>
              <FieldLegend variant="label">Parameters and limits</FieldLegend>
              <FieldDescription>
                What is tested and the limits it must meet. Give a range, a target, or a written limit.
              </FieldDescription>
              <div className="flex flex-col gap-3">
                {parameters.map((p, index) => (
                  <div key={p.key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-6">
                    <Select
                      value={p.category}
                      onValueChange={(v) =>
                        updateParameter(p.key, { category: v as SpecificationParameterCategory })
                      }
                    >
                      <SelectTrigger
                        className="w-full sm:col-span-2"
                        aria-label={`Parameter ${index + 1} category`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {specificationParameterCategories.map((c) => (
                            <SelectItem key={c} value={c}>
                              {specificationParameterCategoryLabels[c]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Input
                      className="sm:col-span-3"
                      aria-label={`Parameter ${index + 1} name`}
                      placeholder="Name, e.g. Moisture"
                      required
                      maxLength={120}
                      value={p.name}
                      onChange={(e) => updateParameter(p.key, { name: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove parameter ${index + 1}`}
                      onClick={() => setParameters((list) => list.filter((x) => x.key !== p.key))}
                    >
                      <Trash2 />
                    </Button>
                    <Input
                      aria-label={`Parameter ${index + 1} minimum`}
                      placeholder="Min"
                      type="number"
                      step="any"
                      value={p.min}
                      onChange={(e) => updateParameter(p.key, { min: e.target.value })}
                    />
                    <Input
                      aria-label={`Parameter ${index + 1} target`}
                      placeholder="Target"
                      type="number"
                      step="any"
                      value={p.target}
                      onChange={(e) => updateParameter(p.key, { target: e.target.value })}
                    />
                    <Input
                      aria-label={`Parameter ${index + 1} maximum`}
                      placeholder="Max"
                      type="number"
                      step="any"
                      value={p.max}
                      onChange={(e) => updateParameter(p.key, { max: e.target.value })}
                    />
                    <Input
                      aria-label={`Parameter ${index + 1} unit`}
                      placeholder="Unit"
                      maxLength={20}
                      value={p.unit}
                      onChange={(e) => updateParameter(p.key, { unit: e.target.value })}
                    />
                    <Input
                      className="sm:col-span-2"
                      aria-label={`Parameter ${index + 1} written limit`}
                      placeholder="Written limit, e.g. Absent in 25 g"
                      maxLength={200}
                      value={p.limitText}
                      onChange={(e) => updateParameter(p.key, { limitText: e.target.value })}
                    />
                    <Input
                      className="sm:col-span-6"
                      aria-label={`Parameter ${index + 1} method`}
                      placeholder="Method, e.g. ISO 6579-1"
                      maxLength={200}
                      value={p.method}
                      onChange={(e) => updateParameter(p.key, { method: e.target.value })}
                    />
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  onClick={() =>
                    setParameters((list) => [
                      ...list,
                      {
                        key: nextKey(),
                        category: "chemical",
                        name: "",
                        unit: "",
                        min: "",
                        target: "",
                        max: "",
                        limitText: "",
                        method: "",
                      },
                    ])
                  }
                >
                  <Plus data-icon="inline-start" /> Add parameter
                </Button>
              </div>
            </FieldSet>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="spec-review">Review due</FieldLabel>
                <Input
                  id="spec-review"
                  type="date"
                  value={reviewDueOn}
                  onChange={(e) => setReviewDueOn(e.target.value)}
                />
              </Field>
            </div>

            {party !== "internal" && (
              <FieldSet>
                <FieldLegend variant="label">
                  {party === "supplier" ? "Supplier's agreement" : "Customer's agreement"}
                </FieldLegend>
                <FieldDescription>Who signed this version on their side, and when.</FieldDescription>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field>
                    <FieldLabel htmlFor="spec-agreed-by">Agreed by</FieldLabel>
                    <Input
                      id="spec-agreed-by"
                      maxLength={200}
                      value={agreedBy}
                      onChange={(e) => setAgreedBy(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="spec-agreed-on">On</FieldLabel>
                    <Input
                      id="spec-agreed-on"
                      type="date"
                      value={agreedOn}
                      onChange={(e) => setAgreedOn(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="spec-agreement-ref">Their reference</FieldLabel>
                    <Input
                      id="spec-agreement-ref"
                      maxLength={200}
                      value={agreementReference}
                      onChange={(e) => setAgreementReference(e.target.value)}
                    />
                  </Field>
                </div>
              </FieldSet>
            )}

            <Field>
              <FieldLabel htmlFor="spec-change-note">What changed</FieldLabel>
              <Textarea
                id="spec-change-note"
                maxLength={2000}
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Save draft
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
