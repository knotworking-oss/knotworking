"use client";

import {
  HAZARD_SCALE_MAX,
  decisionOutcomeLabels,
  decisionPathError,
  hazardRiskLabels,
  haccpHazardTypeLabels,
  haccpHazardTypes,
  type DecisionAnswers,
  type HaccpHazardType,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import type { HaccpLibraryEntry, HaccpTemplate } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const api = () => browserApi().v1.workspaces[":slug"].haccp;
type Answer = "" | "yes" | "no";
const answerOf = (a: Answer): boolean | null => (a === "" ? null : a === "yes");
const toAnswer = (v: boolean | null): Answer => (v === null ? "" : v ? "yes" : "no");
const answerOptions = [
  ["", "Not answered"],
  ["yes", "Yes"],
  ["no", "No"],
] as const;
const scaleOptions = Array.from(
  { length: HAZARD_SCALE_MAX },
  (_, i) => [String(i + 1), String(i + 1)] as const,
);

/**
 * The workspace's reusable starting points for a hazard analysis: library hazards a plan copies into
 * a step, and plan templates a new plan starts from. Plans keep their own copy, so editing or
 * deleting an entry here never changes a plan.
 */
export function LibraryBoard({
  slug,
  entries,
  templates,
}: {
  slug: string;
  entries: HaccpLibraryEntry[];
  templates: HaccpTemplate[];
}) {
  const router = useRouter();
  const canWrite = useWorkspace().can("haccp", "write");
  const [editing, setEditing] = useState<HaccpLibraryEntry | "new" | null>(null);

  async function remove(label: string, request: () => Promise<unknown>) {
    try {
      await request();
      toast.success(`${label} deleted`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">Hazard library</h2>
          {canWrite && (
            <Button onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" /> New hazard
            </Button>
          )}
        </div>
        {entries.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            The library is empty.
          </p>
        ) : (
          <Card className="overflow-x-auto py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Hazard</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Usual step</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Decision tree</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{e.title}</div>
                      <div className="text-xs text-muted-foreground">{e.description}</div>
                    </TableCell>
                    <TableCell>{haccpHazardTypeLabels[e.hazardType]}</TableCell>
                    <TableCell className="text-muted-foreground">{e.stepName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {hazardRiskLabels[e.risk.level]} ({e.risk.score})
                      </Badge>
                    </TableCell>
                    <TableCell>{decisionOutcomeLabels[e.outcome]}</TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && (
                        <span className="inline-flex gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Edit ${e.title}`}
                            onClick={() => setEditing(e)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Delete ${e.title}`}
                            onClick={() =>
                              remove(e.title, () =>
                                unwrapEmpty(api().library[":id"].$delete({ param: { slug, id: e.id } })),
                              )
                            }
                          >
                            <Trash2 />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight">Plan templates</h2>
        {templates.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            No templates yet.
          </p>
        ) : (
          <Card className="overflow-x-auto py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Template</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Hazards</TableHead>
                  <TableHead>CCPs</TableHead>
                  <TableHead>Saved by</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{t.name}</div>
                      {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                    </TableCell>
                    <TableCell className="tabular-nums">{t.stepCount}</TableCell>
                    <TableCell className="tabular-nums">{t.hazardCount}</TableCell>
                    <TableCell className="tabular-nums">{t.ccpCount}</TableCell>
                    <TableCell className="text-muted-foreground">{t.createdByName ?? "—"}</TableCell>
                    <TableCell className="pr-4 text-right">
                      {canWrite && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Delete ${t.name}`}
                          onClick={() =>
                            remove(t.name, () =>
                              unwrapEmpty(api().templates[":id"].$delete({ param: { slug, id: t.id } })),
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      {editing && (
        <EntryDialog
          slug={slug}
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EntryDialog({
  slug,
  entry,
  onClose,
}: {
  slug: string;
  entry: HaccpLibraryEntry | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [stepName, setStepName] = useState(entry?.stepName ?? "");
  const [hazardType, setHazardType] = useState<HaccpHazardType>(entry?.hazardType ?? "biological");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [likelihood, setLikelihood] = useState(String(entry?.likelihood ?? 3));
  const [severity, setSeverity] = useState(String(entry?.severity ?? 3));
  const [controlMeasure, setControlMeasure] = useState(entry?.controlMeasure ?? "");
  const [q, setQ] = useState<Record<keyof DecisionAnswers, Answer>>({
    q1: toAnswer(entry?.q1 ?? null),
    q2: toAnswer(entry?.q2 ?? null),
    q3: toAnswer(entry?.q3 ?? null),
    q4: toAnswer(entry?.q4 ?? null),
  });
  const [justification, setJustification] = useState(entry?.justification ?? "");
  const answers: DecisionAnswers = {
    q1: answerOf(q.q1),
    q2: answerOf(q.q2),
    q3: answerOf(q.q3),
    q4: answerOf(q.q4),
  };
  // Answers the path doesn't reach are dropped, as in the plan editor.
  for (let bad = decisionPathError(answers); bad; bad = decisionPathError(answers)) answers[bad] = null;
  return (
    <HaccpDialog
      title={entry ? "Edit hazard" : "New hazard"}
      description="A reusable hazard. Plans copy it into a step; changing it here never changes a plan."
      submitLabel="Save"
      wide
      onClose={onClose}
      onSubmit={async () => {
        const json = {
          title: title.trim(),
          stepName: stepName.trim() || null,
          hazardType,
          description: description.trim(),
          likelihood: Number(likelihood),
          severity: Number(severity),
          controlMeasure: controlMeasure.trim() || null,
          ...answers,
          justification: justification.trim() || null,
        };
        if (entry) {
          await unwrap(api().library[":id"].$put({ param: { slug, id: entry.id }, json }));
        } else {
          await unwrap(api().library.$post({ param: { slug }, json }));
        }
        return "Hazard saved";
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="lib-title">Name</FieldLabel>
          <Input
            id="lib-title"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="lib-step">Usual step (optional)</FieldLabel>
          <Input
            id="lib-step"
            maxLength={200}
            placeholder="Cooking"
            value={stepName}
            onChange={(e) => setStepName(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <SelectField
          id="lib-type"
          label="Hazard type"
          value={hazardType}
          onChange={(v) => setHazardType(v as HaccpHazardType)}
          options={haccpHazardTypes.map((t) => [t, haccpHazardTypeLabels[t]] as const)}
        />
        <Field>
          <FieldLabel htmlFor="lib-description">Hazard</FieldLabel>
          <Textarea
            id="lib-description"
            required
            rows={2}
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="lib-likelihood"
          label="Likelihood (1 to 5)"
          value={likelihood}
          onChange={setLikelihood}
          options={scaleOptions}
        />
        <SelectField
          id="lib-severity"
          label="Severity (1 to 5)"
          value={severity}
          onChange={setSeverity}
          options={scaleOptions}
        />
      </div>
      <Field>
        <FieldLabel htmlFor="lib-control">Control measure</FieldLabel>
        <Textarea
          id="lib-control"
          rows={2}
          maxLength={2000}
          required={q.q1 === "yes"}
          value={controlMeasure}
          onChange={(e) => setControlMeasure(e.target.value)}
        />
        <FieldDescription>
          Required when the decision tree says a control measure exists (Q1 yes).
        </FieldDescription>
      </Field>
      <div className="grid gap-4 sm:grid-cols-4">
        {(["q1", "q2", "q3", "q4"] as const).map((key) => (
          <SelectField
            key={key}
            id={`lib-${key}`}
            label={key.toUpperCase()}
            value={q[key]}
            onChange={(v) => setQ((prev) => ({ ...prev, [key]: v as Answer }))}
            options={answerOptions}
          />
        ))}
      </div>
      <Field>
        <FieldLabel htmlFor="lib-justification">Justification (optional)</FieldLabel>
        <Input
          id="lib-justification"
          maxLength={1000}
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}
