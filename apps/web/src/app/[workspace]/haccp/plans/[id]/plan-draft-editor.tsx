"use client";

import {
  HAZARD_SCALE_MAX,
  decisionOutcomeLabels,
  decisionPathError,
  decisionTreeOutcome,
  decisionTreeQuestions,
  hazardScaleLabels,
  type DecisionAnswers,
  type ProcessStepInput,
  ccpLimitTypeLabels,
  ccpLimitTypes,
  checkFrequencyUnits,
  haccpHazardTypeLabels,
  haccpHazardTypes,
  type CcpInput,
  type CcpLimitType,
  type CheckFrequencyUnit,
  type HaccpHazardType,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { ToggleGroup, ToggleGroupItem } from "@knotworking/ui/components/toggle-group";
import { Textarea } from "@knotworking/ui/components/textarea";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { SelectField } from "@/components/haccp-forms";
import type { HaccpLibraryEntry, HaccpPlanVersion } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

export type Option = { id: string; code: string; name: string };

type Answer = "" | "yes" | "no";
interface HazardForm {
  key: string;
  hazardType: HaccpHazardType;
  description: string;
  likelihood: string;
  severity: string;
  controlMeasure: string;
  q1: Answer;
  q2: Answer;
  q3: Answer;
  q4: Answer;
  justification: string;
}
/** A process step of the hazard analysis; `key` is its ref, which CCPs point at. */
interface StepForm {
  key: string;
  name: string;
  description: string;
  hazards: HazardForm[];
}
const answerOf = (a: Answer): boolean | null => (a === "" ? null : a === "yes");
const toAnswer = (v: boolean | null): Answer => (v === null ? "" : v ? "yes" : "no");
/** The answers the path reaches: later ones are dropped when an earlier answer ends the tree. */
function reachable(h: HazardForm): DecisionAnswers {
  const a: DecisionAnswers = {
    q1: answerOf(h.q1),
    q2: answerOf(h.q2),
    q3: answerOf(h.q3),
    q4: answerOf(h.q4),
  };
  for (let bad = decisionPathError(a); bad; bad = decisionPathError(a)) a[bad] = null;
  return a;
}
const blankHazard = (): HazardForm => ({
  key: nextKey(),
  hazardType: "biological",
  description: "",
  likelihood: "3",
  severity: "3",
  controlMeasure: "",
  q1: "",
  q2: "",
  q3: "",
  q4: "",
  justification: "",
});
/** A library hazard as a hazard of a step: a copy, no longer tied to the library. */
const hazardFromEntry = (e: HaccpLibraryEntry): HazardForm => ({
  key: nextKey(),
  hazardType: e.hazardType,
  description: e.description,
  likelihood: String(e.likelihood),
  severity: String(e.severity),
  controlMeasure: e.controlMeasure ?? "",
  q1: toAnswer(e.q1),
  q2: toAnswer(e.q2),
  q3: toAnswer(e.q3),
  q4: toAnswer(e.q4),
  justification: e.justification ?? "",
});
const blankStep = (): StepForm => ({ key: nextKey(), name: "", description: "", hazards: [] });
const stepFromVersion = (step: HaccpPlanVersion["steps"][number]): StepForm => ({
  key: step.id,
  name: step.name,
  description: step.description ?? "",
  hazards: step.hazards.map((h) => ({
    key: nextKey(),
    hazardType: h.hazardType,
    description: h.description,
    likelihood: String(h.likelihood),
    severity: String(h.severity),
    controlMeasure: h.controlMeasure ?? "",
    q1: toAnswer(h.q1),
    q2: toAnswer(h.q2),
    q3: toAnswer(h.q3),
    q4: toAnswer(h.q4),
    justification: h.justification ?? "",
  })),
});
const stepToInput = (step: StepForm): ProcessStepInput => ({
  ref: step.key,
  name: step.name.trim(),
  description: step.description.trim() || null,
  hazards: step.hazards.map((h) => ({
    hazardType: h.hazardType,
    description: h.description.trim(),
    likelihood: Number(h.likelihood),
    severity: Number(h.severity),
    controlMeasure: h.controlMeasure.trim() || null,
    ...reachable(h),
    justification: h.justification.trim() || null,
  })),
});

/** A CCP as the form holds it: numbers as typed. */
interface CcpForm {
  key: string;
  /** The `key` of the step it sits at, or empty. */
  stepRef: string;
  code: string;
  processStep: string;
  hazardType: HaccpHazardType;
  hazard: string;
  limitType: CcpLimitType;
  limitMin: string;
  limitMax: string;
  limitUnit: string;
  passCriterion: string;
  monitoringMethod: string;
  frequencyEvery: string;
  frequencyUnit: CheckFrequencyUnit;
  duringProduction: boolean;
  responsibleRole: string;
  correctiveAction: string;
  verification: string;
}

const frequencyUnitLabels: Record<CheckFrequencyUnit, string> = {
  batch: "batch",
  hour: "hours",
  day: "days",
  week: "weeks",
  month: "months",
};

let keySeq = 0;
const nextKey = () => `ccp-${++keySeq}`;

const blankCcp = (index: number): CcpForm => ({
  key: nextKey(),
  stepRef: "",
  code: `CCP${index + 1}`,
  processStep: "",
  hazardType: "biological",
  hazard: "",
  limitType: "range",
  limitMin: "",
  limitMax: "",
  limitUnit: "°C",
  passCriterion: "",
  monitoringMethod: "",
  frequencyEvery: "1",
  frequencyUnit: "batch",
  duringProduction: false,
  responsibleRole: "",
  correctiveAction: "",
  verification: "",
});

const fromVersion = (ccp: HaccpPlanVersion["ccps"][number]): CcpForm => ({
  key: nextKey(),
  stepRef: ccp.stepId ?? "",
  code: ccp.code,
  processStep: ccp.processStep,
  hazardType: ccp.hazardType,
  hazard: ccp.hazard,
  limitType: ccp.limitType,
  limitMin: ccp.limitMin === null ? "" : String(ccp.limitMin),
  limitMax: ccp.limitMax === null ? "" : String(ccp.limitMax),
  limitUnit: ccp.limitUnit ?? "",
  passCriterion: ccp.passCriterion ?? "",
  monitoringMethod: ccp.monitoringMethod,
  frequencyEvery: String(ccp.frequency.every),
  frequencyUnit: ccp.frequency.unit,
  duringProduction: ccp.duringProduction,
  responsibleRole: ccp.responsibleRole,
  correctiveAction: ccp.correctiveAction,
  verification: ccp.verification,
});

const toInput = (ccp: CcpForm): CcpInput => {
  const range = ccp.limitType === "range";
  return {
    code: ccp.code.trim(),
    processStep: ccp.processStep.trim(),
    stepRef: ccp.stepRef || null,
    hazardType: ccp.hazardType,
    hazard: ccp.hazard.trim(),
    limitType: ccp.limitType,
    limitMin: range && ccp.limitMin.trim() !== "" ? Number(ccp.limitMin) : null,
    limitMax: range && ccp.limitMax.trim() !== "" ? Number(ccp.limitMax) : null,
    limitUnit: range ? ccp.limitUnit.trim() || null : null,
    passCriterion: range ? null : ccp.passCriterion.trim() || null,
    monitoringMethod: ccp.monitoringMethod.trim(),
    frequency: { every: Number(ccp.frequencyEvery), unit: ccp.frequencyUnit },
    duringProduction: ccp.duringProduction,
    responsibleRole: ccp.responsibleRole.trim(),
    correctiveAction: ccp.correctiveAction.trim(),
    verification: ccp.verification.trim(),
  };
};

/**
 * Edits the draft of a plan: scope, notes and the full list of CCPs. Saving replaces the draft
 * (or starts the next version, copied from the current one). Approval happens on the plan page.
 */
export function PlanDraftEditor({
  slug,
  planId,
  base,
  isNew,
  products,
  recipes,
  library,
  onClose,
}: {
  slug: string;
  planId: string;
  /** The draft being edited, or the approved version a new draft starts from. */
  base: HaccpPlanVersion | null;
  isNew: boolean;
  products: Option[];
  recipes: Option[];
  /** Hazards of the workspace's library, copied into a step by value. */
  library: HaccpLibraryEntry[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [itemIds, setItemIds] = useState<string[]>(base?.scope.itemIds ?? []);
  const [recipeIds, setRecipeIds] = useState<string[]>(base?.scope.recipeIds ?? []);
  const [scopeNote, setScopeNote] = useState(base?.scopeNote ?? "");
  const [changeNote, setChangeNote] = useState(isNew ? "" : (base?.changeNote ?? ""));
  const [ccps, setCcps] = useState<CcpForm[]>(() => (base?.ccps ?? []).map(fromVersion));
  const [steps, setSteps] = useState<StepForm[]>(() => (base?.steps ?? []).map(stepFromVersion));
  const updateStep = (key: string, patch: Partial<StepForm>) =>
    setSteps((list) => list.map((st) => (st.key === key ? { ...st, ...patch } : st)));
  const moveStep = (index: number, by: number) =>
    setSteps((list) => {
      const next = [...list];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });
  const removeStep = (key: string) => {
    setSteps((list) => list.filter((st) => st.key !== key));
    setCcps((list) => list.map((c) => (c.stepRef === key ? { ...c, stepRef: "" } : c)));
  };

  const update = (key: string, patch: Partial<CcpForm>) =>
    setCcps((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const move = (index: number, by: number) =>
    setCcps((list) => {
      const next = [...list];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].haccp.plans[":id"].draft.$put({
          param: { slug, id: planId },
          json: {
            scope: { itemIds, recipeIds },
            scopeNote: scopeNote.trim() || null,
            changeNote: changeNote.trim() || null,
            steps: steps.map(stepToInput),
            ccps: ccps.map(toInput),
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
    <form className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8" onSubmit={(e) => void save(e)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {isNew
              ? `New draft${base ? ` from version ${base.versionNumber}` : ""}`
              : `Draft version ${base?.versionNumber}`}
          </h2>
          <p className="text-sm text-muted-foreground">
            The approved version keeps applying until a manager approves this draft.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />} Save draft
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <p className="text-sm text-muted-foreground">
              Products and recipes the plan covers. Leave both empty for a site-wide plan. Per-batch CCPs fall
              due on each batch in progress that the plan covers.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <ScopeList
                title="Products"
                options={products}
                selected={itemIds}
                onToggle={(id, on) => setItemIds((l) => toggle(l, id, on))}
              />
              <ScopeList
                title="Recipes"
                options={recipes}
                selected={recipeIds}
                onToggle={(id, on) => setRecipeIds((l) => toggle(l, id, on))}
              />
            </div>
            <Field>
              <FieldLabel htmlFor="draft-scope-note">Process, prerequisites and HACCP team</FieldLabel>
              <Textarea
                id="draft-scope-note"
                rows={3}
                maxLength={5000}
                value={scopeNote}
                onChange={(e) => setScopeNote(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="draft-change">What changed</FieldLabel>
              <Input
                id="draft-change"
                maxLength={2000}
                placeholder="e.g. Cooking limit lowered to 72 °C for 2 minutes after validation"
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hazard analysis</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            The process steps in order, the hazards at each, how likely and how severe, the control measure,
            and the Codex decision tree that says whether the step is a critical control point. The flow
            diagram is drawn from this list.
          </p>
          {steps.map((step, index) => (
            <StepFields
              key={step.key}
              step={step}
              library={library}
              index={index}
              last={index === steps.length - 1}
              onChange={(patch) => updateStep(step.key, patch)}
              onMove={(by) => moveStep(index, by)}
              onRemove={() => removeStep(step.key)}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setSteps((list) => [...list, blankStep()])}
          >
            <Plus data-icon="inline-start" /> Add process step
          </Button>
        </CardContent>
      </Card>

      {ccps.map((ccp, index) => (
        <Card key={ccp.key}>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>
              {ccp.code || "CCP"}{" "}
              {ccp.processStep && <span className="text-muted-foreground">· {ccp.processStep}</span>}
            </CardTitle>
            <div className="flex gap-1">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Move down"
                disabled={index === ccps.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${ccp.code}`}
                onClick={() => setCcps((list) => list.filter((c) => c.key !== ccp.key))}
              >
                <Trash2 />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <CcpFields ccp={ccp} steps={steps} onChange={(patch) => update(ccp.key, patch)} />
          </CardContent>
        </Card>
      ))}

      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => setCcps((list) => [...list, blankCcp(list.length)])}
      >
        <Plus data-icon="inline-start" /> Add critical control point
      </Button>
    </form>
  );
}

function ScopeList({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: Option[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{title}</legend>
      <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
        {options.length === 0 && <span className="text-sm text-muted-foreground">None</span>}
        {options.map((o) => (
          <div key={o.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`scope-${o.id}`}
              checked={selected.includes(o.id)}
              onCheckedChange={(on) => onToggle(o.id, on === true)}
            />
            <Label htmlFor={`scope-${o.id}`} className="font-normal">
              <span className="font-mono text-xs">{o.code}</span> {o.name}
            </Label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

const NO_STEP = "none";

/** One process step with its hazards and the decision tree for each. */
function StepFields({
  step,
  library,
  index,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  step: StepForm;
  library: HaccpLibraryEntry[];
  index: number;
  last: boolean;
  onChange: (patch: Partial<StepForm>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const id = (name: string) => `${step.key}-${name}`;
  const updateHazard = (key: string, patch: Partial<HazardForm>) =>
    onChange({ hazards: step.hazards.map((h) => (h.key === key ? { ...h, ...patch } : h)) });
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-end gap-2">
        <span className="pb-2 text-sm text-muted-foreground tabular-nums">{index + 1}.</span>
        <Field className="flex-1">
          <FieldLabel htmlFor={id("name")}>Step</FieldLabel>
          <Input
            id={id("name")}
            required
            maxLength={200}
            placeholder="Cooking"
            value={step.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </Field>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Move step up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Move step down"
          disabled={last}
          onClick={() => onMove(1)}
        >
          <ArrowDown />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove step ${step.name}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor={id("description")}>Description (optional)</FieldLabel>
        <Input
          id={id("description")}
          maxLength={1000}
          value={step.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>
      {step.hazards.map((h) => (
        <HazardFields
          key={h.key}
          hazard={h}
          onChange={(patch) => updateHazard(h.key, patch)}
          onRemove={() => onChange({ hazards: step.hazards.filter((x) => x.key !== h.key) })}
        />
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => onChange({ hazards: [...step.hazards, blankHazard()] })}
      >
        <Plus data-icon="inline-start" /> Add hazard
      </Button>
      {library.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            value=""
            onValueChange={(id) => {
              const entry = library.find((e) => e.id === id);
              if (entry) onChange({ hazards: [...step.hazards, hazardFromEntry(entry)] });
            }}
          >
            <SelectTrigger
              aria-label={`Add a hazard from the library to ${step.name || "this step"}`}
              className="w-72"
            >
              <SelectValue placeholder="Add from the hazard library" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {library.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

const scaleOptions = Array.from(
  { length: HAZARD_SCALE_MAX },
  (_, i) => [String(i + 1), `${i + 1} ${hazardScaleLabels[i + 1]}`] as const,
);

function HazardFields({
  hazard,
  onChange,
  onRemove,
}: {
  hazard: HazardForm;
  onChange: (patch: Partial<HazardForm>) => void;
  onRemove: () => void;
}) {
  const id = (name: string) => `${hazard.key}-${name}`;
  const answers = reachable(hazard);
  const outcome = decisionTreeOutcome(answers);
  const shown = [
    true,
    answers.q1 === true,
    answers.q1 === true && answers.q2 === false,
    answers.q1 === true && answers.q2 === false && answers.q3 === true,
  ];
  return (
    <div className="flex flex-col gap-3 rounded-md bg-muted/40 p-3">
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto]">
        <SelectField
          id={id("type")}
          label="Hazard type"
          value={hazard.hazardType}
          onChange={(v) => onChange({ hazardType: v as HaccpHazardType })}
          options={haccpHazardTypes.map((t) => [t, haccpHazardTypeLabels[t]] as const)}
        />
        <Field>
          <FieldLabel htmlFor={id("description")}>Hazard</FieldLabel>
          <Input
            id={id("description")}
            required
            maxLength={1000}
            placeholder="Survival of vegetative pathogens"
            value={hazard.description}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </Field>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="self-end"
          aria-label="Remove hazard"
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id={id("likelihood")}
          label="Likelihood"
          value={hazard.likelihood}
          onChange={(v) => onChange({ likelihood: v })}
          options={scaleOptions}
        />
        <SelectField
          id={id("severity")}
          label="Severity"
          value={hazard.severity}
          onChange={(v) => onChange({ severity: v })}
          options={scaleOptions}
        />
      </div>
      <Field>
        <FieldLabel htmlFor={id("control")}>Control measure</FieldLabel>
        <Input
          id={id("control")}
          maxLength={2000}
          required={hazard.q1 === "yes"}
          placeholder="Cook to a core temperature of 75 °C"
          value={hazard.controlMeasure}
          onChange={(e) => onChange({ controlMeasure: e.target.value })}
        />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Decision tree</legend>
        {decisionTreeQuestions.map((q, i) =>
          shown[i] ? (
            <div key={q.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="max-w-xl">
                <span className="font-mono text-xs uppercase">{q.id}</span> {q.text}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={hazard[q.id]}
                onValueChange={(v) => onChange({ [q.id]: v as Answer })}
              >
                <ToggleGroupItem value="yes">Yes</ToggleGroupItem>
                <ToggleGroupItem value="no">No</ToggleGroupItem>
              </ToggleGroup>
            </div>
          ) : null,
        )}
        <p className="text-sm">
          Outcome: <span className="font-medium">{decisionOutcomeLabels[outcome]}</span>
          {outcome === "no_control" && (
            <span className="text-muted-foreground">
              {" "}
              (change the step, process or product, or confirm control isn&apos;t needed here)
            </span>
          )}
        </p>
      </fieldset>
      <Field>
        <FieldLabel htmlFor={id("justification")}>Justification (optional)</FieldLabel>
        <Input
          id={id("justification")}
          maxLength={1000}
          value={hazard.justification}
          onChange={(e) => onChange({ justification: e.target.value })}
        />
      </Field>
    </div>
  );
}

function CcpFields({
  ccp,
  steps,
  onChange,
}: {
  ccp: CcpForm;
  steps: StepForm[];
  onChange: (patch: Partial<CcpForm>) => void;
}) {
  const id = (name: string) => `${ccp.key}-${name}`;
  const text = (name: keyof CcpForm) => ({
    id: id(name),
    value: ccp[name] as string,
    onChange: (e: { target: { value: string } }) => onChange({ [name]: e.target.value }),
  });
  return (
    <FieldGroup>
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr_12rem]">
        <Field>
          <FieldLabel htmlFor={id("code")}>Code</FieldLabel>
          <Input required maxLength={20} {...text("code")} />
        </Field>
        <Field>
          <FieldLabel htmlFor={id("processStep")}>Process step</FieldLabel>
          <Input required maxLength={200} placeholder="Cooking" {...text("processStep")} />
          {steps.length > 0 && (
            <div className="mt-2">
              <SelectField
                id={id("stepRef")}
                label="Step of the hazard analysis"
                value={ccp.stepRef || NO_STEP}
                onChange={(v) => {
                  const chosen = steps.find((st) => st.key === v);
                  onChange({
                    stepRef: chosen ? chosen.key : "",
                    ...(chosen && !ccp.processStep.trim() ? { processStep: chosen.name } : {}),
                  });
                }}
                options={[
                  [NO_STEP, "Not linked"],
                  ...steps.map((st, i) => [st.key, `${i + 1}. ${st.name || "Unnamed step"}`] as const),
                ]}
              />
            </div>
          )}
        </Field>
        <SelectField
          id={id("hazardType")}
          label="Hazard type"
          value={ccp.hazardType}
          onChange={(v) => onChange({ hazardType: v as HaccpHazardType })}
          options={haccpHazardTypes.map((t) => [t, haccpHazardTypeLabels[t]] as const)}
        />
      </div>
      <Field>
        <FieldLabel htmlFor={id("hazard")}>Hazard</FieldLabel>
        <Input required maxLength={1000} placeholder="Survival of vegetative pathogens" {...text("hazard")} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <SelectField
          id={id("limitType")}
          label="Critical limit"
          value={ccp.limitType}
          onChange={(v) => onChange({ limitType: v as CcpLimitType })}
          options={ccpLimitTypes.map((t) => [t, ccpLimitTypeLabels[t]] as const)}
        />
        {ccp.limitType === "range" ? (
          <div className="grid grid-cols-3 gap-2">
            <Field>
              <FieldLabel htmlFor={id("limitMin")}>Minimum</FieldLabel>
              <Input type="number" step="any" inputMode="decimal" {...text("limitMin")} />
            </Field>
            <Field>
              <FieldLabel htmlFor={id("limitMax")}>Maximum</FieldLabel>
              <Input type="number" step="any" inputMode="decimal" {...text("limitMax")} />
            </Field>
            <Field>
              <FieldLabel htmlFor={id("limitUnit")}>Unit</FieldLabel>
              <Input maxLength={20} placeholder="°C" {...text("limitUnit")} />
            </Field>
          </div>
        ) : (
          <Field>
            <FieldLabel htmlFor={id("passCriterion")}>A pass is</FieldLabel>
            <Input
              required
              maxLength={500}
              placeholder="Test pieces rejected; no metal detected"
              {...text("passCriterion")}
            />
          </Field>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={id("monitoringMethod")}>Monitoring method</FieldLabel>
        <Input
          required
          maxLength={1000}
          placeholder="Probe the core of the largest piece"
          {...text("monitoringMethod")}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[6rem_10rem_1fr]">
        <Field>
          <FieldLabel htmlFor={id("frequencyEvery")}>Every</FieldLabel>
          <Input
            type="number"
            min={1}
            max={1000}
            required
            disabled={ccp.frequencyUnit === "batch"}
            {...text("frequencyEvery")}
          />
        </Field>
        <SelectField
          id={id("frequencyUnit")}
          label="Frequency"
          value={ccp.frequencyUnit}
          onChange={(v) =>
            onChange({
              frequencyUnit: v as CheckFrequencyUnit,
              ...(v === "batch" ? { frequencyEvery: "1" } : {}),
            })
          }
          options={checkFrequencyUnits.map((u) => [u, frequencyUnitLabels[u]] as const)}
        />
        <Field>
          <FieldLabel htmlFor={id("responsibleRole")}>Responsible role</FieldLabel>
          <Input required maxLength={200} placeholder="Line leader" {...text("responsibleRole")} />
        </Field>
      </div>
      {ccp.frequencyUnit !== "batch" && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={id("duringProduction")}
            checked={ccp.duringProduction}
            onCheckedChange={(on) => onChange({ duringProduction: on === true })}
          />
          <Label htmlFor={id("duringProduction")}>
            Only while something the plan covers is in production
          </Label>
        </div>
      )}
      <Field>
        <FieldLabel htmlFor={id("correctiveAction")}>Corrective action</FieldLabel>
        <Textarea required rows={2} maxLength={2000} {...text("correctiveAction")} />
        <FieldDescription>Shown to whoever records an out-of-limit reading.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={id("verification")}>Verification</FieldLabel>
        <Textarea required rows={2} maxLength={2000} {...text("verification")} />
      </Field>
    </FieldGroup>
  );
}
