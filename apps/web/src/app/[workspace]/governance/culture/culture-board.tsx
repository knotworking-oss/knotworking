"use client";

import {
  formatUkDate,
  governanceCultureKindLabels,
  governanceCultureKinds,
  type GovernanceCultureKind,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus } from "lucide-react";
import { useState } from "react";
import { GovernanceCultureBadge } from "@/components/governance-badges";
import type { GovernanceCultureActivity } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { FormDialog, useSubmit } from "../governance-forms";
import { EnumSelect, GovernanceFrame, MemberSelect } from "../governance-nav";

const gov = () => browserApi().v1.workspaces[":slug"].governance;
const NONE = "none";

/** Management review → culture plan: activities that build food safety culture, and what they showed. */
export function CultureBoard({
  slug,
  activities,
  objectives,
}: {
  slug: string;
  activities: GovernanceCultureActivity[];
  objectives: { id: string; title: string }[];
}) {
  const canWrite = useWorkspace().can("governance", "write");
  const [dialog, setDialog] = useState<
    | { kind: "plan"; activity: GovernanceCultureActivity | null }
    | { kind: "done"; activity: GovernanceCultureActivity }
    | null
  >(null);
  return (
    <GovernanceFrame
      slug={slug}
      title="Culture plan"
      actions={
        canWrite && (
          <Button onClick={() => setDialog({ kind: "plan", activity: null })}>
            <Plus data-icon="inline-start" /> Plan activity
          </Button>
        )
      }
    >
      {activities.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing planned yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Activity</TableHead>
                <TableHead>Planned</TableHead>
                <TableHead>Measure</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {activities.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{a.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {governanceCultureKindLabels[a.kind]}
                      {a.ownerName ? ` · ${a.ownerName}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>{formatUkDate(a.plannedOn)}</TableCell>
                  <TableCell className="max-w-xs text-sm whitespace-normal">{a.measure ?? "—"}</TableCell>
                  <TableCell className="max-w-xs text-sm whitespace-normal">
                    {a.completedOn ? (
                      <>
                        <span className="text-muted-foreground">
                          {formatUkDate(a.completedOn)}
                          {a.participants != null ? ` · ${a.participants} took part` : ""}
                        </span>
                        {a.result && <div>{a.result}</div>}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <GovernanceCultureBadge state={a.state} />
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canWrite && (
                      <div className="flex justify-end gap-2">
                        {(a.state === "planned" || a.state === "overdue") && (
                          <Button size="sm" onClick={() => setDialog({ kind: "done", activity: a })}>
                            Record done
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "plan", activity: a })}
                        >
                          Edit
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {dialog?.kind === "plan" && (
        <PlanDialog
          slug={slug}
          activity={dialog.activity}
          objectives={objectives}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "done" && (
        <DoneDialog slug={slug} activity={dialog.activity} onClose={() => setDialog(null)} />
      )}
    </GovernanceFrame>
  );
}

function PlanDialog({
  slug,
  activity,
  objectives,
  onClose,
}: {
  slug: string;
  activity: GovernanceCultureActivity | null;
  objectives: { id: string; title: string }[];
  onClose: () => void;
}) {
  const { pending, submit } = useSubmit(onClose);
  const [title, setTitle] = useState(activity?.title ?? "");
  const [kind, setKind] = useState<GovernanceCultureKind>(activity?.kind ?? "survey");
  const [plannedOn, setPlannedOn] = useState(activity?.plannedOn ?? "");
  const [owner, setOwner] = useState<string | null>(activity?.ownerUserId ?? null);
  const [measure, setMeasure] = useState(activity?.measure ?? "");
  const [objectiveId, setObjectiveId] = useState(activity?.objectiveId ?? NONE);
  return (
    <FormDialog
      title={activity ? "Edit activity" : "Plan a culture activity"}
      submitLabel="Save"
      pending={pending}
      onClose={onClose}
      onSubmit={() => {
        const json = {
          title: title.trim(),
          kind,
          plannedOn,
          ownerUserId: owner,
          measure: measure.trim() || null,
          objectiveId: objectiveId === NONE ? null : objectiveId,
        };
        void submit(
          () =>
            unwrap(
              activity
                ? gov().culture[":id"].$patch({ param: { slug, id: activity.id }, json })
                : gov().culture.$post({ param: { slug }, json }),
            ),
          "Activity saved",
        );
      }}
    >
      <Field>
        <FieldLabel htmlFor="cul-title">Activity</FieldLabel>
        <Input
          id="cul-title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Kind</FieldLabel>
          <EnumSelect
            label="Kind"
            value={kind}
            onChange={setKind}
            options={governanceCultureKinds}
            labels={governanceCultureKindLabels}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cul-planned">Planned for</FieldLabel>
          <Input
            id="cul-planned"
            type="date"
            required
            value={plannedOn}
            onChange={(e) => setPlannedOn(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="cul-measure">How its effect is measured</FieldLabel>
        <Textarea
          id="cul-measure"
          maxLength={2000}
          value={measure}
          onChange={(e) => setMeasure(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Owner</FieldLabel>
          <MemberSelect label="Owner" value={owner} onChange={setOwner} />
        </Field>
        <Field>
          <FieldLabel>Supports objective</FieldLabel>
          <Select value={objectiveId} onValueChange={setObjectiveId}>
            <SelectTrigger aria-label="Supports objective">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>None</SelectItem>
                {objectives.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>
    </FormDialog>
  );
}

function DoneDialog({
  slug,
  activity,
  onClose,
}: {
  slug: string;
  activity: GovernanceCultureActivity;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, submit } = useSubmit(onClose);
  const [completedOn, setCompletedOn] = useState(today);
  const [participants, setParticipants] = useState("");
  const [result, setResult] = useState("");
  return (
    <FormDialog
      title="Record activity done"
      description={activity.measure ? `${activity.title} · measured by: ${activity.measure}` : activity.title}
      submitLabel="Record done"
      pending={pending}
      onClose={onClose}
      onSubmit={() =>
        void submit(
          () =>
            unwrap(
              gov().culture[":id"].$patch({
                param: { slug, id: activity.id },
                json: {
                  completedOn,
                  participants: participants ? Number(participants) : null,
                  result: result.trim() || null,
                },
              }),
            ),
          "Activity recorded",
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="done-on">Done on</FieldLabel>
          <Input
            id="done-on"
            type="date"
            required
            max={today}
            value={completedOn}
            onChange={(e) => setCompletedOn(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="done-participants">People taking part</FieldLabel>
          <Input
            id="done-participants"
            type="number"
            min={0}
            value={participants}
            onChange={(e) => setParticipants(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="done-result">What it showed</FieldLabel>
        <Textarea
          id="done-result"
          maxLength={4000}
          value={result}
          onChange={(e) => setResult(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
