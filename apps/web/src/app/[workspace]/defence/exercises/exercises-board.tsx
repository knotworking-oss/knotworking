"use client";

import {
  defenceExerciseOutcomeLabels,
  defenceExerciseOutcomes,
  formatUkDate,
  type DefenceExerciseOutcome,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
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
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DefenceExerciseBadge } from "@/components/defence-badges";
import type { DefenceExerciseRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { DefenceFrame } from "../defence-nav";

const NONE = "none";

/** Food defence → exercises: incident scenarios tested, what they showed and what follows. */
export function ExercisesBoard({
  slug,
  exercises,
  assessments,
}: {
  slug: string;
  exercises: DefenceExerciseRow[];
  assessments: { id: string; title: string }[];
}) {
  const canWrite = useWorkspace().can("defence", "write");
  const [creating, setCreating] = useState(false);
  return (
    <DefenceFrame
      slug={slug}
      title="Exercises"
      actions={
        canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> Record exercise
          </Button>
        )
      }
    >
      {exercises.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No exercises yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {exercises.map((e) => (
            <Card key={e.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {e.title} <DefenceExerciseBadge outcome={e.outcome} />
                </CardTitle>
                <CardDescription>
                  {formatUkDate(e.heldOn)}
                  {e.recordedByName ? ` · recorded by ${e.recordedByName}` : ""}
                  {e.assessmentId && e.assessmentTitle ? (
                    <>
                      {" · tests "}
                      <Link href={`/${slug}/defence/assessments/${e.assessmentId}`} className="underline">
                        {e.assessmentTitle}
                      </Link>
                    </>
                  ) : null}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <div>
                  <span className="font-medium">Scenario: </span>
                  {e.scenario}
                </div>
                {e.participants && (
                  <div>
                    <span className="font-medium">Participants: </span>
                    {e.participants}
                  </div>
                )}
                {e.findings && (
                  <div>
                    <span className="font-medium">Findings: </span>
                    {e.findings}
                  </div>
                )}
                {e.actions && (
                  <div>
                    <span className="font-medium">Actions: </span>
                    {e.actions}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {creating && (
        <ExerciseDialog slug={slug} assessments={assessments} onClose={() => setCreating(false)} />
      )}
    </DefenceFrame>
  );
}

function ExerciseDialog({
  slug,
  assessments,
  onClose,
}: {
  slug: string;
  assessments: { id: string; title: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const today = useWorkspaceToday();
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState("");
  const [scenario, setScenario] = useState("");
  const [heldOn, setHeldOn] = useState(today);
  const [assessmentId, setAssessmentId] = useState(NONE);
  const [participants, setParticipants] = useState("");
  const [outcome, setOutcome] = useState<DefenceExerciseOutcome>("effective");
  const [findings, setFindings] = useState("");
  const [actions, setActions] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].defence.exercises.$post({
          param: { slug },
          json: {
            title: title.trim(),
            scenario: scenario.trim(),
            heldOn,
            assessmentId: assessmentId === NONE ? null : assessmentId,
            participants: participants.trim() || null,
            outcome,
            findings: findings.trim() || null,
            actions: actions.trim() || null,
          },
        }),
      );
      toast.success("Exercise recorded");
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
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={(e) => void save(e)}>
          <DialogHeader>
            <DialogTitle>Record exercise</DialogTitle>
            <DialogDescription>Recorded in your name.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field>
                <FieldLabel htmlFor="ex-title">Title</FieldLabel>
                <Input
                  id="ex-title"
                  required
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="ex-date">Held on</FieldLabel>
                <Input
                  id="ex-date"
                  type="date"
                  required
                  max={today}
                  value={heldOn}
                  onChange={(e) => setHeldOn(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="ex-scenario">Scenario</FieldLabel>
              <Textarea
                id="ex-scenario"
                required
                maxLength={4000}
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Tests assessment</FieldLabel>
                <Select value={assessmentId} onValueChange={setAssessmentId}>
                  <SelectTrigger aria-label="Tests assessment">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NONE}>None</SelectItem>
                      {assessments.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Outcome</FieldLabel>
                <Select value={outcome} onValueChange={(v) => setOutcome(v as DefenceExerciseOutcome)}>
                  <SelectTrigger aria-label="Outcome">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {defenceExerciseOutcomes.map((o) => (
                        <SelectItem key={o} value={o}>
                          {defenceExerciseOutcomeLabels[o]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="ex-participants">Participants</FieldLabel>
              <Input
                id="ex-participants"
                maxLength={2000}
                value={participants}
                onChange={(e) => setParticipants(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ex-findings">Findings</FieldLabel>
              <Textarea
                id="ex-findings"
                maxLength={4000}
                value={findings}
                onChange={(e) => setFindings(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ex-actions">Actions</FieldLabel>
              <Textarea
                id="ex-actions"
                maxLength={4000}
                value={actions}
                onChange={(e) => setActions(e.target.value)}
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
              {pending && <Spinner data-icon="inline-start" />} Record exercise
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
