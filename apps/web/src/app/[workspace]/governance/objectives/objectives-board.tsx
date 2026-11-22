"use client";

import {
  formatUkDate,
  governanceObjectiveCategories,
  governanceObjectiveCategoryLabels,
  governanceObjectiveRagLabels,
  governanceObjectiveRags,
  governanceObjectiveStatuses,
  governanceObjectiveStatusLabels,
  type GovernanceObjectiveCategory,
  type GovernanceObjectiveRag,
  type GovernanceObjectiveStatus,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  GovernanceDueBadge,
  GovernanceObjectiveStatusBadge,
  GovernanceRagBadge,
} from "@/components/governance-badges";
import type { GovernanceObjective } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { FormDialog, useSubmit } from "../governance-forms";
import { EnumSelect, GovernanceFrame, MemberSelect } from "../governance-nav";

const gov = () => browserApi().v1.workspaces[":slug"].governance;

/** Management review → objectives: food safety and quality objectives and their progress. */
export function ObjectivesBoard({ slug, objectives }: { slug: string; objectives: GovernanceObjective[] }) {
  const canWrite = useWorkspace().can("governance", "write");
  const [dialog, setDialog] = useState<
    | { kind: "edit"; objective: GovernanceObjective | null }
    | { kind: "progress"; objective: GovernanceObjective }
    | null
  >(null);
  return (
    <GovernanceFrame
      slug={slug}
      title="Objectives"
      actions={
        canWrite && (
          <Button onClick={() => setDialog({ kind: "edit", objective: null })}>
            <Plus data-icon="inline-start" /> New objective
          </Button>
        )
      }
    >
      {objectives.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No objectives yet.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {objectives.map((o) => (
            <Card key={o.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {o.title}
                  <GovernanceObjectiveStatusBadge status={o.status} />
                  {o.latest && o.status === "open" && <GovernanceRagBadge rag={o.latest.rag} />}
                  <GovernanceDueBadge status={o.dueStatus} />
                </CardTitle>
                <CardDescription>
                  {governanceObjectiveCategoryLabels[o.category]}
                  {o.ownerName ? ` · ${o.ownerName}` : ""}
                  {o.dueOn ? ` · by ${formatUkDate(o.dueOn)}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {(o.measure || o.target) && (
                  <div>
                    {o.measure}
                    {o.target && <span className="font-medium"> · Target: {o.target}</span>}
                  </div>
                )}
                {o.progress.length > 0 && (
                  <ul className="flex flex-col gap-1 border-l pl-3">
                    {[...o.progress]
                      .reverse()
                      .slice(0, 4)
                      .map((p) => (
                        <li key={p.at}>
                          <span className="text-muted-foreground">{formatUkDate(p.on)}</span>{" "}
                          <span className="font-medium">{governanceObjectiveRagLabels[p.rag]}</span>
                          {p.value ? ` · ${p.value}` : ""} · {p.note}
                        </li>
                      ))}
                  </ul>
                )}
                {canWrite && (
                  <div className="flex gap-2 pt-1">
                    {o.status === "open" && (
                      <Button size="sm" onClick={() => setDialog({ kind: "progress", objective: o })}>
                        Report progress
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDialog({ kind: "edit", objective: o })}
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {dialog?.kind === "edit" && (
        <ObjectiveDialog slug={slug} objective={dialog.objective} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "progress" && (
        <ProgressDialog slug={slug} objective={dialog.objective} onClose={() => setDialog(null)} />
      )}
    </GovernanceFrame>
  );
}

function ObjectiveDialog({
  slug,
  objective,
  onClose,
}: {
  slug: string;
  objective: GovernanceObjective | null;
  onClose: () => void;
}) {
  const { pending, submit } = useSubmit(onClose);
  const [title, setTitle] = useState(objective?.title ?? "");
  const [category, setCategory] = useState<GovernanceObjectiveCategory>(objective?.category ?? "food_safety");
  const [measure, setMeasure] = useState(objective?.measure ?? "");
  const [target, setTarget] = useState(objective?.target ?? "");
  const [owner, setOwner] = useState<string | null>(objective?.ownerUserId ?? null);
  const [dueOn, setDueOn] = useState(objective?.dueOn ?? "");
  const [status, setStatus] = useState<GovernanceObjectiveStatus>(objective?.status ?? "open");
  return (
    <FormDialog
      title={objective ? "Edit objective" : "New objective"}
      submitLabel="Save"
      pending={pending}
      onClose={onClose}
      onSubmit={() => {
        const json = {
          title: title.trim(),
          category,
          measure: measure.trim() || null,
          target: target.trim() || null,
          ownerUserId: owner,
          dueOn: dueOn || null,
        };
        void submit(
          () =>
            unwrap(
              objective
                ? gov().objectives[":id"].$patch({
                    param: { slug, id: objective.id },
                    json: { ...json, status },
                  })
                : gov().objectives.$post({ param: { slug }, json }),
            ),
          "Objective saved",
        );
      }}
    >
      <Field>
        <FieldLabel htmlFor="obj-title">Objective</FieldLabel>
        <Input
          id="obj-title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Category</FieldLabel>
          <EnumSelect
            label="Category"
            value={category}
            onChange={setCategory}
            options={governanceObjectiveCategories}
            labels={governanceObjectiveCategoryLabels}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="obj-due">Due</FieldLabel>
          <Input id="obj-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="obj-measure">How it is measured</FieldLabel>
        <Textarea
          id="obj-measure"
          maxLength={2000}
          value={measure}
          onChange={(e) => setMeasure(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="obj-target">Target</FieldLabel>
          <Input id="obj-target" maxLength={500} value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel>Owner</FieldLabel>
          <MemberSelect label="Owner" value={owner} onChange={setOwner} />
        </Field>
      </div>
      {objective && (
        <Field>
          <FieldLabel>Status</FieldLabel>
          <EnumSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={governanceObjectiveStatuses}
            labels={governanceObjectiveStatusLabels}
          />
        </Field>
      )}
    </FormDialog>
  );
}

function ProgressDialog({
  slug,
  objective,
  onClose,
}: {
  slug: string;
  objective: GovernanceObjective;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, submit } = useSubmit(onClose);
  const [on, setOn] = useState(today);
  const [rag, setRag] = useState<GovernanceObjectiveRag>("on_track");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  return (
    <FormDialog
      title="Report progress"
      description={`${objective.title}${objective.target ? ` · Target: ${objective.target}` : ""}`}
      submitLabel="Report progress"
      pending={pending}
      onClose={onClose}
      onSubmit={() =>
        void submit(
          () =>
            unwrap(
              gov().objectives[":id"].progress.$post({
                param: { slug, id: objective.id },
                json: { on, rag, value: value.trim() || null, note: note.trim() },
              }),
            ),
          "Progress reported",
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="prog-on">As of</FieldLabel>
          <Input
            id="prog-on"
            type="date"
            required
            max={today}
            value={on}
            onChange={(e) => setOn(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Status</FieldLabel>
          <EnumSelect
            label="Progress status"
            value={rag}
            onChange={setRag}
            options={governanceObjectiveRags}
            labels={governanceObjectiveRagLabels}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="prog-value">Measured value</FieldLabel>
          <Input id="prog-value" maxLength={200} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="prog-note">Note</FieldLabel>
        <Textarea
          id="prog-note"
          required
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
